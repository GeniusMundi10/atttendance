// PURPOSE: Assign one employee to a site and shift from a date, for initial roster loading.
import { randomUUID } from 'node:crypto'
import pg from 'pg'
const [employeeId,siteId,shiftName,effectiveFrom]=process.argv.slice(2)
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
if (!process.env.SCHEDULE_PROVISION_DATABASE_URL || !employeeId || !uuid.test(employeeId) || !siteId || !uuid.test(siteId) ||
    !shiftName || !effectiveFrom || !/^20\d\d-\d\d-\d\d$/.test(effectiveFrom) ||
    new Date(effectiveFrom+'T00:00:00Z').toISOString().slice(0,10)!==effectiveFrom) {
  process.stderr.write('Usage: SCHEDULE_PROVISION_DATABASE_URL=... node --experimental-strip-types features/schedule/provision-assignment.ts EMPLOYEE_UUID SITE_UUID "Shift name" YYYY-MM-DD\n')
  process.exitCode=1
} else {
  const client=new pg.Client({connectionString:process.env.SCHEDULE_PROVISION_DATABASE_URL})
  try {
    await client.connect()
    await client.query('BEGIN')
    const shift=await client.query<{id:string}>('SELECT id FROM schedule_shifts WHERE name=$1',[shiftName])
    if (shift.rows.length!==1) throw new Error('Shift not found')
    const id=randomUUID()
    const inserted=await client.query(`INSERT INTO schedule_assignments(id,employee_id,site_id,shift_id,effective_from,source,reason)
      VALUES ($1,$2,$3,$4,$5,'provision','Initial roster load') ON CONFLICT (employee_id,effective_from) DO NOTHING RETURNING id`,
      [id,employeeId,siteId,shift.rows[0]!.id,effectiveFrom])
    if (inserted.rows.length) await client.query("INSERT INTO schedule_audit(id,action,subject,detail) VALUES ($1,'SHIFT_ASSIGNED',$2,$3)",
      [randomUUID(),employeeId,JSON.stringify({siteId,shiftId:shift.rows[0]!.id,effectiveFrom,source:'provision'})])
    await client.query('COMMIT')
    process.stdout.write(inserted.rows.length?'Assignment recorded\n':'Assignment already exists\n')
  } catch {
    await client.query('ROLLBACK').catch(()=>{})
    process.stderr.write('Assignment provisioning failed\n')
    process.exitCode=1
  } finally { await client.end().catch(()=>{}) }
}
