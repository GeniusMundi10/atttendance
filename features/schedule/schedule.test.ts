// PURPOSE: Verify the 2026 calendar, effective-dated shifts, authorization, audit, and leave integration on PostgreSQL.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { AccessDeniedError, AccessMfaRequiredError, resolveAuthenticatedSubject } from '../access/access.ts'
import { applyForPaidLeave, LeaveError } from '../leave/leave.ts'
import { assignShift, removeHoliday, saveHoliday, saveShift, writeHoliday } from './manage.ts'
import { isWorkingDay, listHolidays, listShifts, readSchedule, ScheduleError, scheduleDays } from './schedule.ts'
const read=(path:string)=>readFile(fileURLToPath(new URL(path,import.meta.url)),'utf8')
test('2026 calendar, effective-dated shifts, scope, audit and leave use one schedule',{
  skip: !process.env.SCHEDULE_TEST_DATABASE_URL && 'Set SCHEDULE_TEST_DATABASE_URL for PostgreSQL test',
},async t=>{
  const pg=await import('pg')
  const schema='schedule_test_'+randomUUID().replaceAll('-','')
  const db=new pg.default.Client({connectionString:process.env.SCHEDULE_TEST_DATABASE_URL})
  await db.connect()
  try {
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.query(`SET search_path TO "${schema}"`)
    for (const f of ['../access/migrations/001_access.sql','../leave/migrations/001_paid_leave.sql','../leave/migrations/002_leave_type.sql','./migrations/001_schedule.sql']) await db.query(await read(f))
    const calendar=JSON.parse(await read('./data/holidays-2026.json')) as {location:string,shift:string,holidays:{date:string,name:string,classification:string}[]}
    const site=randomUUID(), otherSite=randomUUID()
    await db.query('INSERT INTO access_sites(id,name) VALUES ($1,$2),($3,$4)',[site,calendar.location,otherSite,'Other site'])
    const [employee,manager,stranger,hr]=[randomUUID(),randomUUID(),randomUUID(),randomUUID()]
    for (const [id,name] of [[employee,'Employee'],[manager,'Manager'],[stranger,'Stranger'],[hr,'HR']]) {
      await db.query('INSERT INTO access_employees(id,display_name) VALUES ($1,$2)',[id,name])
      await db.query('INSERT INTO access_subject_links(auth_provider,auth_subject,employee_id) VALUES ($1,$2,$3)',['issuer',id,id])
    }
    await db.query('INSERT INTO access_manager_reports(manager_id,report_id) VALUES ($1,$2)',[manager,employee])
    await db.query("INSERT INTO access_operator_roles(employee_id,role) VALUES ($1,'HR')",[hr])
    const subject=(id:string,aal?:string)=>({authProvider:'issuer',authSubject:id,aal})
    const employeeActor=await resolveAuthenticatedSubject(db,subject(employee))
    const managerActor=await resolveAuthenticatedSubject(db,subject(manager))
    const strangerActor=await resolveAuthenticatedSubject(db,subject(stranger))
    await assert.rejects(resolveAuthenticatedSubject(db,subject(hr)),AccessMfaRequiredError)
    const hrActor=await resolveAuthenticatedSubject(db,subject(hr,'aal2'))
    const general=(await db.query<{id:string}>("SELECT id FROM schedule_shifts WHERE name='General Shift'")).rows[0]!.id
    // Import is idempotent and holds the file's stated site, shift and classification.
    const importAll=async()=>{let changed=0;for (const h of calendar.holidays) if ((await writeHoliday(db,null,{siteId:site,shiftId:general,date:h.date,name:h.name,classification:h.classification,source:'test'})).changed) changed++;return changed}
    assert.equal(await importAll(),15)
    assert.equal(await importAll(),0)
    assert.equal((await db.query("SELECT count(*)::int AS n FROM schedule_holidays WHERE classification='RESTRICTED'")).rows[0].n,6)
    // Before any assignment the employee follows the standard General Shift and its holidays.
    const unassigned=await scheduleDays(db,employee,'2026-11-15','2026-11-16')
    assert.deepEqual(unassigned.map(d=>[d.kind,d.shiftName]),[['WEEKLY_OFF','General Shift'],['WORKING','General Shift']])
    const holiday=calendar.holidays.find((h:{classification:string})=>h.classification==='HOLIDAY')!
    assert.equal((await scheduleDays(db,employee,holiday.date,holiday.date))[0]!.kind,'HOLIDAY')
    await assert.rejects(assignShift(db,employeeActor,{employeeId:employee,siteId:site,shiftId:general,effectiveFrom:'2026-01-01',reason:'self'}),AccessDeniedError)
    await assert.rejects(assignShift(db,managerActor,{employeeId:employee,siteId:site,shiftId:general,effectiveFrom:'2026-01-01',reason:'mgr'}),AccessDeniedError)
    await assert.rejects(assignShift(db,{...hrActor,aal:'aal1'},{employeeId:employee,siteId:site,shiftId:general,effectiveFrom:'2026-01-01',reason:'x'}),AccessDeniedError)
    await assert.rejects(assignShift(db,hrActor,{employeeId:employee,siteId:site,shiftId:general,effectiveFrom:'2026-01-01',reason:' '}),(e:unknown)=>e instanceof ScheduleError && e.code==='reason_required')
    await assignShift(db,hrActor,{employeeId:employee,siteId:site,shiftId:general,effectiveFrom:'2026-01-01',reason:'Joined'})
    await assert.rejects(assignShift(db,hrActor,{employeeId:employee,siteId:site,shiftId:general,effectiveFrom:'2026-01-01',reason:'dup'}),(e:unknown)=>e instanceof ScheduleError && e.status===409)
    // Worked examples: Diwali falls on a Sunday; Independence Day on a Saturday; RH days stay working days.
    const days=await scheduleDays(db,employee,'2026-08-15','2026-11-16')
    const day=(d:string)=>days.find(x=>x.date===d)!
    assert.equal(days.length,94)
    assert.deepEqual([day('2026-11-08').kind,day('2026-11-08').weeklyOff,day('2026-11-08').holidayName],['HOLIDAY',true,'Diwali/Deepavali'])
    assert.deepEqual([day('2026-08-15').kind,day('2026-08-15').weeklyOff],['HOLIDAY',false])
    assert.deepEqual([day('2026-11-10').kind,day('2026-11-10').restrictedHoliday],['WORKING','Govardhan Puja'])
    assert.deepEqual([day('2026-11-15').kind,day('2026-11-15').restrictedHoliday],['WEEKLY_OFF','Chhath Puja'])
    assert.deepEqual([day('2026-11-09').kind,day('2026-11-09').startTime,day('2026-11-09').requiredMinutes,day('2026-11-09').halfDayMinutes],['WORKING','09:30',540,270])
    assert.equal(day('2026-11-14').kind,'WORKING') // Saturday is a working day under the supplied General Shift rules
    // Effective dating: a later shift changes only later dates.
    const sat=await saveShift(db,hrActor,{name:'Mon-Fri',startTime:'10:00',requiredMinutes:480,halfDayMinutes:240,weeklyOffDays:[6,7]})
    await assignShift(db,hrActor,{employeeId:employee,siteId:site,shiftId:sat.id,effectiveFrom:'2026-12-01',reason:'Roster change'})
    const dec=await scheduleDays(db,employee,'2026-11-28','2026-12-05')
    assert.equal(dec.find(x=>x.date==='2026-11-28')!.kind,'WORKING')
    assert.equal(dec.find(x=>x.date==='2026-12-05')!.kind,'WEEKLY_OFF')
    assert.equal(dec.find(x=>x.date==='2026-12-05')!.shiftName,'Mon-Fri')
    assert.equal((await scheduleDays(db,employee,'2026-12-25','2026-12-25'))[0]!.kind,'WORKING') // no calendar for the new shift yet
    // Shifts in use are immutable; duplicate names are rejected.
    await assert.rejects(saveShift(db,hrActor,{id:sat.id,name:'Mon-Fri',startTime:'11:00',requiredMinutes:480,halfDayMinutes:240,weeklyOffDays:[7]}),(e:unknown)=>e instanceof ScheduleError && e.code==='shift_in_use')
    await assert.rejects(saveShift(db,hrActor,{name:'Mon-Fri',startTime:'10:00',requiredMinutes:480,halfDayMinutes:240,weeklyOffDays:[7]}),(e:unknown)=>e instanceof ScheduleError && e.code==='shift_name_exists')
    await assert.rejects(saveShift(db,hrActor,{name:'Bad',startTime:'25:00',requiredMinutes:480,halfDayMinutes:240,weeklyOffDays:[7]}),(e:unknown)=>e instanceof ScheduleError && e.code==='invalid_start_time')
    assert.equal((await listShifts(db,employeeActor)).length,2)
    // Scope matches receipts: self, assigned manager and HR may read; a stranger may not.
    await readSchedule(db,employeeActor,{employeeId:employee,from:'2026-11-01',to:'2026-11-30'})
    await readSchedule(db,managerActor,{employeeId:employee,from:'2026-11-01',to:'2026-11-30'})
    await readSchedule(db,hrActor,{employeeId:employee,from:'2026-11-01',to:'2026-11-30'})
    await assert.rejects(readSchedule(db,strangerActor,{employeeId:employee,from:'2026-11-01',to:'2026-11-30'}),AccessDeniedError)
    await assert.rejects(readSchedule(db,employeeActor,{employeeId:employee,from:'2026-11-30',to:'2026-11-01'}),(e:unknown)=>e instanceof ScheduleError && e.code==='invalid_range')
    await assert.rejects(readSchedule(db,employeeActor,{employeeId:employee,from:'2026-02-30',to:'2026-03-01'}),(e:unknown)=>e instanceof ScheduleError && e.code==='invalid_date')
    const maxRange=await readSchedule(db,employeeActor,{employeeId:employee,from:'2026-01-01',to:'2027-01-01'})
    assert.equal(maxRange.length,366) // Maximum includes both endpoints, so a non-leap full year is valid.
    await assert.rejects(readSchedule(db,employeeActor,{employeeId:employee,from:'2026-01-01',to:'2027-01-02'}),(e:unknown)=>e instanceof ScheduleError && e.code==='invalid_range')
    // Calendar list follows the employee's site and effective shift for each holiday date.
    assert.equal((await listHolidays(db,employeeActor,{employeeId:employee,year:2026})).length,14) // Dec 25 falls under the new shift
    assert.equal((await listHolidays(db,employeeActor,{employeeId:employee,year:2025})).length,0)
    // HR corrections to the calendar keep the original row and audit it.
    const christmas=(await db.query<{id:string}>("SELECT id FROM schedule_holidays WHERE holiday_date='2026-12-25'")).rows[0]!.id
    await assert.rejects(saveHoliday(db,hrActor,{siteId:'bad',shiftId:general,date:'2026-12-25',name:'Christmas',classification:'RESTRICTED'}),(e:unknown)=>e instanceof ScheduleError && e.code==='invalid_id')
    const done=await saveHoliday(db,hrActor,{siteId:site,shiftId:general,date:'2026-12-25',name:'Christmas',classification:'RESTRICTED'})
    assert.equal(done.id!==christmas,true)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM schedule_holidays WHERE holiday_date=\'2026-12-25\'')).rows[0].n,2)
    await removeHoliday(db,hrActor,{id:done.id,reason:'Entered by mistake'})
    await assert.rejects(removeHoliday(db,hrActor,{id:done.id,reason:'again'}),(e:unknown)=>e instanceof ScheduleError && e.status===404)
    await assert.rejects(removeHoliday(db,employeeActor,{id:done.id,reason:'no'}),AccessDeniedError)
    const actions=(await db.query<{action:string}>('SELECT action FROM schedule_audit ORDER BY created_at,id')).rows.map(r=>r.action)
    assert.ok(['SHIFT_CREATED','SHIFT_ASSIGNED','HOLIDAY_ADDED','HOLIDAY_REPLACED','HOLIDAY_REMOVED'].every(a=>actions.includes(a)))
    // Leave integration: only dates the assigned shift treats as working can be applied for.
    const today=(await db.query<{d:string}>("SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') AS d")).rows[0]!.d
    const next=new Date(Date.parse(today+'T00:00:00Z')+86400000).toISOString().slice(0,10)
    if (next.slice(0,7)!==today.slice(0,7)) {t.diagnostic('No future date remains in the current month; leave integration skipped');return}
    const allOff=await saveShift(db,hrActor,{name:'Always off',startTime:'09:00',requiredMinutes:60,halfDayMinutes:30,weeklyOffDays:[1,2,3,4,5,6,7]})
    const always=await saveShift(db,hrActor,{name:'Always on',startTime:'09:00',requiredMinutes:60,halfDayMinutes:30,weeklyOffDays:[]})
    const worker=randomUUID()
    await db.query('INSERT INTO access_employees(id,display_name) VALUES ($1,$2)',[worker,'Worker'])
    await db.query('INSERT INTO access_subject_links(auth_provider,auth_subject,employee_id) VALUES ($1,$2,$3)',['issuer',worker,worker])
    await assignShift(db,hrActor,{employeeId:worker,siteId:site,shiftId:allOff.id,effectiveFrom:'2026-01-01',reason:'Test'})
    const workerActor=await resolveAuthenticatedSubject(db,subject(worker))
    assert.equal(await isWorkingDay(db,worker,next),false)
    await assert.rejects(applyForPaidLeave(db,workerActor,{workDate:next,note:'Schedule integration test'}),(e:unknown)=>e instanceof LeaveError && e.code==='not_scheduled_work_date')
    await assignShift(db,hrActor,{employeeId:worker,siteId:site,shiftId:always.id,effectiveFrom:'2026-01-02',reason:'Test'})
    assert.equal(await isWorkingDay(db,worker,next),true)
    await applyForPaidLeave(db,workerActor,{workDate:next,note:'Schedule integration test'})
    assert.equal((await db.query('SELECT 1 FROM leave_work_dates WHERE employee_id=$1 AND work_date=$2',[worker,next])).rows.length,1)
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(()=>{})
    await db.end()
  }
})
