// PURPOSE: Let HR/admin create shifts, assign employees, and maintain site holiday calendars with audit.
import { randomUUID } from 'node:crypto'
import { AccessDeniedError, type Actor, type QueryClient } from '../access/access.ts'
import { isoDate, ScheduleError, verifiedActor } from './schedule.ts'
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
function id(value:unknown):string { if (typeof value!=='string' || !UUID.test(value)) throw new ScheduleError('invalid_id'); return value }
function text(value:unknown,max:number,code:string):string {
  if (typeof value!=='string' || !value.trim() || value.trim().length>max) throw new ScheduleError(code)
  return value.trim()
}
function minutes(value:unknown,code:string):number {
  if (typeof value!=='number' || !Number.isInteger(value) || value<1 || value>1440) throw new ScheduleError(code)
  return value
}
async function operator(client:QueryClient,actor:Actor):Promise<string> {
  const current=await verifiedActor(client,actor)
  const role=await client.query("SELECT 1 FROM access_operator_roles WHERE employee_id=$1 AND active AND role IN ('HR','ADMIN') FOR SHARE",[current.employeeId])
  if (!role.rows.length || actor.aal!=='aal2') throw new AccessDeniedError()
  return current.employeeId
}
async function audit(client:QueryClient,actorId:string|null,action:string,subject:string,detail:object) {
  await client.query('INSERT INTO schedule_audit(id,actor_employee_id,action,subject,detail) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(),actorId,action,subject,JSON.stringify(detail)])
}
export type ShiftInput = {id?:unknown,name:unknown,startTime:unknown,requiredMinutes:unknown,halfDayMinutes:unknown,weeklyOffDays:unknown}
/** A shift referenced by any assignment cannot change; create a new shift and assign it from a date instead. */
export async function saveShift(client:QueryClient,actor:Actor,input:ShiftInput):Promise<{id:string}> {
  const actorId=await operator(client,actor)
  const name=text(input.name,80,'invalid_name')
  if (typeof input.startTime!=='string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.startTime)) throw new ScheduleError('invalid_start_time')
  const required=minutes(input.requiredMinutes,'invalid_minutes'), half=minutes(input.halfDayMinutes,'invalid_minutes')
  if (half>required) throw new ScheduleError('invalid_minutes')
  const off=input.weeklyOffDays
  if (!Array.isArray(off) || off.length>7 || new Set(off).size!==off.length || off.some(d=>!Number.isInteger(d) || d<1 || d>7)) throw new ScheduleError('invalid_weekly_off')
  const shiftId=input.id===undefined?randomUUID():id(input.id)
  const values=[shiftId,name,input.startTime,required,half,off]
  try {
    if (input.id===undefined) {
      await client.query('INSERT INTO schedule_shifts(id,name,start_time,required_minutes,half_day_minutes,weekly_off_days) VALUES ($1,$2,$3,$4,$5,$6)',values)
    } else {
      const existing=await client.query('SELECT 1 FROM schedule_shifts WHERE id=$1 FOR UPDATE',[shiftId])
      if (!existing.rows.length) throw new ScheduleError('shift_not_found',404)
      const used=await client.query('SELECT 1 FROM schedule_assignments WHERE shift_id=$1 LIMIT 1',[shiftId])
      if (used.rows.length) throw new ScheduleError('shift_in_use',409)
      await client.query('UPDATE schedule_shifts SET name=$2,start_time=$3,required_minutes=$4,half_day_minutes=$5,weekly_off_days=$6 WHERE id=$1',values)
    }
  } catch (error) {
    if ((error as {code?:string}).code==='23505') throw new ScheduleError('shift_name_exists',409)
    throw error
  }
  await audit(client,actorId,input.id===undefined?'SHIFT_CREATED':'SHIFT_UPDATED',shiftId,{name,startTime:input.startTime,required,half,off})
  return {id:shiftId}
}
/** Append a dated assignment. Past dates are allowed so HR can load joining history; history is never rewritten. */
export async function assignShift(client:QueryClient,actor:Actor,input:{employeeId:unknown,siteId:unknown,shiftId:unknown,effectiveFrom:unknown,reason:unknown}):Promise<{id:string}> {
  const actorId=await operator(client,actor)
  const employeeId=id(input.employeeId), siteId=id(input.siteId), shiftId=id(input.shiftId)
  const effectiveFrom=isoDate(input.effectiveFrom), reason=text(input.reason,1000,'reason_required')
  const refs=await client.query(`SELECT (SELECT active FROM access_employees WHERE id=$1) AS e,
      (SELECT active FROM access_sites WHERE id=$2) AS s, (SELECT true FROM schedule_shifts WHERE id=$3) AS h`,[employeeId,siteId,shiftId])
  const r=refs.rows[0] as {e:boolean|null,s:boolean|null,h:boolean|null}
  if (!r.e) throw new ScheduleError('employee_not_found',404)
  if (!r.s) throw new ScheduleError('site_not_found',404)
  if (!r.h) throw new ScheduleError('shift_not_found',404)
  const assignmentId=randomUUID()
  try {
    await client.query(`INSERT INTO schedule_assignments(id,employee_id,site_id,shift_id,effective_from,actor_employee_id,source,reason)
      VALUES ($1,$2,$3,$4,$5,$6,'portal',$7)`,[assignmentId,employeeId,siteId,shiftId,effectiveFrom,actorId,reason])
  } catch (error) {
    if ((error as {code?:string}).code==='23505') throw new ScheduleError('assignment_exists',409)
    throw error
  }
  await audit(client,actorId,'SHIFT_ASSIGNED',employeeId,{siteId,shiftId,effectiveFrom,reason})
  return {id:assignmentId}
}
export type HolidayInput = {siteId:unknown,shiftId:unknown,date:unknown,name:unknown,classification:unknown,source?:unknown}
/** Add or reclassify one holiday for a site and shift. A prior row for the date is retained in the audit detail. */
export async function saveHoliday(client:QueryClient,actor:Actor,input:HolidayInput):Promise<{id:string,changed:boolean}> {
  return writeHoliday(client,await operator(client,actor),input)
}
/** Shared by the HR route and the provisioning importer, which supplies a null actor. */
export async function writeHoliday(client:QueryClient,actorId:string|null,input:HolidayInput):Promise<{id:string,changed:boolean}> {
  const siteId=id(input.siteId), shiftId=id(input.shiftId), date=isoDate(input.date)
  const name=text(input.name,120,'invalid_name')
  if (input.classification!=='HOLIDAY' && input.classification!=='RESTRICTED') throw new ScheduleError('invalid_classification')
  const source=input.source===undefined?'':text(input.source,200,'invalid_source')
  const refs=await client.query('SELECT (SELECT active FROM access_sites WHERE id=$1) AS s,(SELECT true FROM schedule_shifts WHERE id=$2) AS h',[siteId,shiftId])
  const r=refs.rows[0] as {s:boolean|null,h:boolean|null}
  if (!r.s) throw new ScheduleError('site_not_found',404)
  if (!r.h) throw new ScheduleError('shift_not_found',404)
  const prior=await client.query<{id:string,name:string,classification:string}>(
    'SELECT id,name,classification FROM schedule_holidays WHERE site_id=$1 AND shift_id=$2 AND holiday_date=$3 AND removed_at IS NULL FOR UPDATE',[siteId,shiftId,date])
  const before=prior.rows[0]
  if (before && before.name===name && before.classification===input.classification) return {id:before.id,changed:false}
  if (before) await client.query('UPDATE schedule_holidays SET removed_at=now() WHERE id=$1',[before.id])
  const holidayId=randomUUID()
  try {
    await client.query('INSERT INTO schedule_holidays(id,site_id,shift_id,holiday_date,name,classification,source) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [holidayId,siteId,shiftId,date,name,input.classification,source])
  } catch (error) {
    if ((error as {code?:string}).code==='23505') throw new ScheduleError('holiday_conflict',409)
    throw error
  }
  await audit(client,actorId,before?'HOLIDAY_REPLACED':'HOLIDAY_ADDED',holidayId,{siteId,shiftId,date,name,classification:input.classification,previous:before??null})
  return {id:holidayId,changed:true}
}
export async function removeHoliday(client:QueryClient,actor:Actor,input:{id:unknown,reason:unknown}):Promise<void> {
  const actorId=await operator(client,actor)
  const holidayId=id(input.id), reason=text(input.reason,1000,'reason_required')
  const done=await client.query('UPDATE schedule_holidays SET removed_at=now() WHERE id=$1 AND removed_at IS NULL RETURNING holiday_date',[holidayId])
  if (!done.rows.length) throw new ScheduleError('holiday_not_found',404)
  await audit(client,actorId,'HOLIDAY_REMOVED',holidayId,{reason})
}
export async function listSites(client:QueryClient,actor:Actor):Promise<{id:string,name:string}[]> {
  const current=await verifiedActor(client,actor)
  const role=await client.query("SELECT 1 FROM access_operator_roles WHERE employee_id=$1 AND active AND role IN ('HR','ADMIN')",[current.employeeId])
  if (!role.rows.length) return []
  const result=await client.query<{id:string,name:string}>('SELECT id,name FROM access_sites WHERE active ORDER BY name')
  return result.rows
}
