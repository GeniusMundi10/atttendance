// PURPOSE: Serve schedule reads and HR schedule changes to verified portal sessions.
import { resolveAuthenticatedSubject } from '../access/access.ts'
import { portalIdentity } from '../../platform/auth.ts'
import { transaction } from '../../platform/db.ts'
import { body, HttpError, json, uuid } from '../../platform/http.ts'
import { assignShift, listSites, removeHoliday, saveHoliday, saveShift } from './manage.ts'
import { listHolidays, listShifts, readSchedule } from './schedule.ts'
/** Routes: GET setup, GET days/:employeeId?from&to, GET holidays/:employeeId?year, POST shifts|assignments|holidays|holidays/:id/remove. */
export async function scheduleApi(request:Request,parts:string[]):Promise<Response> {
  const subject=await portalIdentity(request)
  const query=new URL(request.url).searchParams
  const get=request.method==='GET', post=request.method==='POST'
  if (get && parts.length===1 && parts[0]==='setup') {
    return transaction(async tx=>{
      const actor=await resolveAuthenticatedSubject(tx,subject)
      const shifts=await listShifts(tx,actor)
      // Site names are only disclosed to HR/admin operators.
      const sites=await listSites(tx,actor)
      return json({shifts,sites})
    })
  }
  if (get && parts.length===2 && parts[0]==='days') {
    const employeeId=uuid(parts[1])
    return transaction(async tx=>json({days:await readSchedule(tx,await resolveAuthenticatedSubject(tx,subject),
      {employeeId,from:query.get('from'),to:query.get('to')})}))
  }
  if (get && parts.length===2 && parts[0]==='holidays') {
    const employeeId=uuid(parts[1])
    return transaction(async tx=>json({holidays:await listHolidays(tx,await resolveAuthenticatedSubject(tx,subject),
      {employeeId,year:query.get('year')})}))
  }
  if (post && parts.length===1 && parts[0]==='shifts') {
    const data=await body(request)
    return transaction(async tx=>json(await saveShift(tx,await resolveAuthenticatedSubject(tx,subject),data as never),201))
  }
  if (post && parts.length===1 && parts[0]==='assignments') {
    const data=await body(request)
    return transaction(async tx=>json(await assignShift(tx,await resolveAuthenticatedSubject(tx,subject),data as never),201))
  }
  if (post && parts.length===1 && parts[0]==='holidays') {
    const data=await body(request)
    return transaction(async tx=>json(await saveHoliday(tx,await resolveAuthenticatedSubject(tx,subject),data as never),201))
  }
  if (post && parts.length===3 && parts[0]==='holidays' && parts[2]==='remove') {
    const data=await body(request)
    const holidayId=uuid(parts[1])
    return transaction(async tx=>{
      await removeHoliday(tx,await resolveAuthenticatedSubject(tx,subject),{id:holidayId,reason:data.reason})
      return json({ok:true})
    })
  }
  throw new HttpError(404,'unknown_endpoint')
}
