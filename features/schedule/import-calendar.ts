// PURPOSE: Import a reviewed holiday calendar JSON file for one named site and shift, idempotently.
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { writeHoliday } from './manage.ts'
const [file]=process.argv.slice(2)
if (!process.env.SCHEDULE_PROVISION_DATABASE_URL || !file) {
  process.stderr.write('Usage: SCHEDULE_PROVISION_DATABASE_URL=... node --experimental-strip-types features/schedule/import-calendar.ts FILE.json\n')
  process.exitCode=1
} else {
  const calendar=JSON.parse(await readFile(file,'utf8')) as {source:string,year:number,location:string,shift:string,
    holidays:{date:string,name:string,classification:string}[]}
  const client=new pg.Client({connectionString:process.env.SCHEDULE_PROVISION_DATABASE_URL})
  try {
    await client.connect()
    await client.query('BEGIN')
    const site=await client.query<{id:string}>('SELECT id FROM access_sites WHERE name=$1 AND active',[calendar.location])
    if (site.rows.length!==1) throw new Error('Site "'+calendar.location+'" must exist exactly once in access_sites')
    const shift=await client.query<{id:string}>('SELECT id FROM schedule_shifts WHERE name=$1',[calendar.shift])
    if (shift.rows.length!==1) throw new Error('Shift "'+calendar.shift+'" does not exist')
    let added=0, unchanged=0
    for (const h of calendar.holidays) {
      if (!h.date.startsWith(String(calendar.year)+'-')) throw new Error('Holiday '+h.date+' is outside '+calendar.year)
      const done=await writeHoliday(client,null,{siteId:site.rows[0]!.id,shiftId:shift.rows[0]!.id,date:h.date,name:h.name,
        classification:h.classification,source:calendar.source})
      if (done.changed) added++; else unchanged++
    }
    await client.query('COMMIT')
    process.stdout.write('Calendar imported: '+added+' written, '+unchanged+' unchanged\n')
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>{})
    process.stderr.write('Calendar import failed: '+(error instanceof Error?error.message:'error')+'\n')
    process.exitCode=1
  } finally { await client.end().catch(()=>{}) }
}
