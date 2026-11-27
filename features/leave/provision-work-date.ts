// PURPOSE: Register an employee's verified scheduled work date for the paid leave pilot.
import pg from 'pg'

const [employeeId,workDate]=process.argv.slice(2)
if (!process.env.LEAVE_PROVISION_DATABASE_URL ||
    !employeeId || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(employeeId) ||
    !workDate || !/^20\d\d-\d\d-\d\d$/.test(workDate) ||
    Number.isNaN(new Date(workDate+'T00:00:00Z').getTime()) ||
    new Date(workDate+'T00:00:00Z').toISOString().slice(0,10)!==workDate) {
  process.stderr.write('Provisioning input invalid\n')
  process.exitCode=1
} else {
  const client=new pg.Client({connectionString:process.env.LEAVE_PROVISION_DATABASE_URL})
  try {
    await client.connect()
    await client.query('INSERT INTO leave_work_dates(employee_id,work_date) VALUES ($1,$2) ON CONFLICT DO NOTHING',[employeeId,workDate])
    process.stdout.write('Work date registered\n')
  } catch {
    // Database errors can include private connection details; keep output generic.
    process.stderr.write('Work date provisioning failed\n')
    process.exitCode=1
  } finally { await client.end().catch(()=>{}) }
}
