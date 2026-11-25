// PURPOSE: Bind paid leave commands to verified portal sessions and safe HTTP errors.
import { AccessDeniedError, AccessMfaRequiredError, resolveAuthenticatedSubject } from '../access/access.ts'
import { portalIdentity } from '../../platform/auth.ts'
import { transaction } from '../../platform/db.ts'
import { HttpError, body, json } from '../../platform/http.ts'
import { applyForPaidLeave, decidePaidLeave, getLeaveBalance, LeaveError, listLeaveRequests } from './leave.ts'

async function serve(request:Request, action:'balance'|'requests'|'decision', id?:string):Promise<Response> {
  const subject=await portalIdentity(request)
  return transaction(async client=>{
    const actor=await resolveAuthenticatedSubject(client,subject)
    if (action==='balance' && request.method==='GET') return json({balance:await getLeaveBalance(client,actor)})
    if (action==='requests' && request.method==='GET') return json({requests:await listLeaveRequests(client,actor)})
    if (action==='requests' && request.method==='POST') {
      const data=await body(request)
      const result=await applyForPaidLeave(client,actor,{workDate:data.workDate,note:data.note})
      return json(result,201)
    }
    if (action==='decision' && request.method==='POST' && id) {
      const data=await body(request)
      await decidePaidLeave(client,actor,{id,decision:data.decision,reason:data.reason})
      return json({ok:true})
    }
    throw new HttpError(405,'method_not_allowed')
  })
}
export async function leaveHttp(request:Request,action:'balance'|'requests'|'decision',id?:string):Promise<Response> {
  try { return await serve(request,action,id) }
  catch(error) {
    if (error instanceof HttpError) return json({error:error.code},error.status)
    if (error instanceof AccessMfaRequiredError) return json({error:'mfa_required'},403)
    if (error instanceof AccessDeniedError) return json({error:'access_denied'},403)
    if (error instanceof LeaveError) return json({error:error.code},error.status)
    const incident=crypto.randomUUID()
    console.error('Leave request failed',incident,error instanceof Error?error.name:'Error')
    return json({error:'service_unavailable',incident},503)
  }
}
