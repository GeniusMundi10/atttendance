// PURPOSE: Publish each employee's effective shift and day type for leave and attendance calculations.
import { AccessDeniedError, authorizeReceiptRead, resolveAuthenticatedSubject, type Actor, type QueryClient } from '../access/access.ts'
export class ScheduleError extends Error {
  code:string
  status:number
  constructor(code:string,status = 400) { super(code); this.name='ScheduleError'; this.code=code; this.status=status }
}
export type DayKind = 'WORKING'|'WEEKLY_OFF'|'HOLIDAY'|'UNASSIGNED'
/** One calendar day for one employee. Pay treatment of non-working days is decided by Attendance. */
export type ScheduleDay = {
  date:string, kind:DayKind, weeklyOff:boolean, holidayName:string|null,
  /** Name of a restricted holiday that the employee may apply an optional holiday against. */
  restrictedHoliday:string|null,
  siteId:string|null, shiftId:string|null, shiftName:string|null,
  startTime:string|null, requiredMinutes:number|null, halfDayMinutes:number|null
}
export type Shift = {id:string,name:string,startTime:string,requiredMinutes:number,halfDayMinutes:number,weeklyOffDays:number[]}
export type Holiday = {id:string,date:string,name:string,classification:'HOLIDAY'|'RESTRICTED'}
export const MAX_RANGE_DAYS=366
/** The seeded General Shift (9:30–6:00, Sunday off). Everyone without an explicit assignment follows it. */
export const STANDARD_SHIFT_ID='6f1d0c1e-5a52-4f0e-9a39-0a1b8f3c2d01'
export function isoDate(value:unknown):string {
  if (typeof value!=='string' || !/^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) throw new ScheduleError('invalid_date')
  const parsed=new Date(value+'T00:00:00.000Z')
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10)!==value) throw new ScheduleError('invalid_date')
  return value
}
export function daysBetween(from:string,to:string):number { return Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000) }
/**
 * Published interface. Caller must already have authorized access to employeeId.
 * Returns exactly one entry per date from `from` to `to` inclusive, in order.
 * Holiday wins over weekly off; a restricted holiday is a normal working day unless an optional holiday is approved.
 */
export async function scheduleDays(client:QueryClient,employeeId:string,from:string,to:string):Promise<ScheduleDay[]> {
  isoDate(from); isoDate(to)
  const span=daysBetween(from,to)
  if (span<0 || span+1>MAX_RANGE_DAYS) throw new ScheduleError('invalid_range')
  const result=await client.query<{
    date:string,site_id:string|null,shift_id:string|null,shift_name:string|null,start_time:string|null,
    required_minutes:number|null,half_day_minutes:number|null,weekly_off:boolean|null,
    holiday_name:string|null,classification:string|null
  }>(`SELECT to_char(days.day,'YYYY-MM-DD') AS date, x.site_id, s.id AS shift_id, s.name AS shift_name,
        to_char(s.start_time,'HH24:MI') AS start_time, s.required_minutes, s.half_day_minutes,
        (EXTRACT(ISODOW FROM days.day)::smallint = ANY(s.weekly_off_days)) AS weekly_off,
        h.name AS holiday_name, h.classification
      FROM (SELECT d::date AS day FROM generate_series($2::date,$3::date,interval '1 day') d) days
      LEFT JOIN LATERAL (SELECT a.site_id,a.shift_id FROM schedule_assignments a
          WHERE a.employee_id=$1 AND a.effective_from<=days.day ORDER BY a.effective_from DESC LIMIT 1) x ON true
      LEFT JOIN schedule_shifts s ON s.id=COALESCE(x.shift_id,$4::uuid)
      -- ponytail: with no assignment there is no site, so any site's calendar for the shift applies; fine for one office, assign sites once there are several.
      LEFT JOIN LATERAL (SELECT hd.name,hd.classification FROM schedule_holidays hd
          WHERE hd.shift_id=s.id AND hd.holiday_date=days.day AND hd.removed_at IS NULL
            AND (hd.site_id=x.site_id OR x.site_id IS NULL)
          ORDER BY hd.classification='HOLIDAY' DESC LIMIT 1) h ON true
      ORDER BY days.day`,[employeeId,from,to,STANDARD_SHIFT_ID])
  return result.rows.map(row=>{
    const assigned=row.shift_id!==null
    const weeklyOff=assigned && row.weekly_off===true
    const kind:DayKind=!assigned?'UNASSIGNED':row.classification==='HOLIDAY'?'HOLIDAY':weeklyOff?'WEEKLY_OFF':'WORKING'
    return {date:row.date,kind,weeklyOff,
      holidayName:row.classification==='HOLIDAY'?row.holiday_name:null,
      restrictedHoliday:row.classification==='RESTRICTED'?row.holiday_name:null,
      siteId:row.site_id,shiftId:row.shift_id,shiftName:row.shift_name,startTime:row.start_time,
      requiredMinutes:row.required_minutes,halfDayMinutes:row.half_day_minutes}
  })
}
export async function scheduleDay(client:QueryClient,employeeId:string,date:string):Promise<ScheduleDay> {
  return (await scheduleDays(client,employeeId,date,date))[0]!
}
/** True when leave may be applied against this date under the employee's shift (assigned, or the standard one). */
export async function isWorkingDay(client:QueryClient,employeeId:string,date:string):Promise<boolean> {
  return (await scheduleDay(client,employeeId,date)).kind==='WORKING'
}
export async function verifiedActor(client:QueryClient,actor:Actor):Promise<Actor> {
  const current=await resolveAuthenticatedSubject(client,actor)
  if (current.employeeId!==actor.employeeId) throw new AccessDeniedError()
  return current
}
/** Employee, assigned manager, or HR/admin may read a schedule; the same scope as receipts. */
export async function readSchedule(client:QueryClient,actor:Actor,input:{employeeId:string,from:unknown,to:unknown}):Promise<ScheduleDay[]> {
  await authorizeReceiptRead(client,{actor,employeeId:input.employeeId})
  return scheduleDays(client,input.employeeId,isoDate(input.from),isoDate(input.to))
}
export async function listShifts(client:QueryClient,actor:Actor):Promise<Shift[]> {
  await verifiedActor(client,actor)
  const result=await client.query<{id:string,name:string,start_time:string,required_minutes:number,half_day_minutes:number,weekly_off_days:number[]}>(
    `SELECT id,name,to_char(start_time,'HH24:MI') AS start_time,required_minutes,half_day_minutes,weekly_off_days
       FROM schedule_shifts ORDER BY name`)
  return result.rows.map(r=>({id:r.id,name:r.name,startTime:r.start_time,requiredMinutes:r.required_minutes,
    halfDayMinutes:r.half_day_minutes,weeklyOffDays:r.weekly_off_days}))
}
/** Holidays and restricted holidays from the employee's effective shift assignment on each date. */
export async function listHolidays(client:QueryClient,actor:Actor,input:{employeeId:string,year:unknown}):Promise<Holiday[]> {
  await authorizeReceiptRead(client,{actor,employeeId:input.employeeId})
  const year=Number(input.year)
  if (!Number.isInteger(year) || year<2020 || year>2100) throw new ScheduleError('invalid_year')
  const result=await client.query<{id:string,date:string,name:string,classification:'HOLIDAY'|'RESTRICTED'}>(
    `SELECT h.id,to_char(h.holiday_date,'YYYY-MM-DD') AS date,h.name,h.classification
       FROM schedule_holidays h
       JOIN LATERAL (SELECT a.site_id,a.shift_id FROM schedule_assignments a
          WHERE a.employee_id=$1 AND a.effective_from<=h.holiday_date ORDER BY a.effective_from DESC LIMIT 1) x
         ON x.site_id=h.site_id AND x.shift_id=h.shift_id
      WHERE h.removed_at IS NULL AND h.holiday_date>=make_date($2,1,1) AND h.holiday_date<=make_date($2,12,31)
      ORDER BY h.holiday_date`,[input.employeeId,year])
  return result.rows
}
