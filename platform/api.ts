// PURPOSE: Expose production kiosk commands and role-scoped, read-only portal receipts.
import { AccessDeniedError, AccessMfaRequiredError, authorizeReceiptRead, listReadableEmployees, resolveAuthenticatedSubject } from '../features/access/access.ts'
import { AttendanceActionOrderError, AttendanceConflictError, listPunchReceipts } from '../features/attendance/attendance.ts'
import { BiometricsError, cancelFaceEnrollment, claimFaceEnrollment, completeFaceEnrollment, enrollFace, fetchRoster, getFaceEnrollmentSessionStatus, getFaceEnrollmentStatus, issueChallenge, issueFaceEnrollmentCode, resetFaceRegistration } from '../features/biometrics/server.ts'
import { CorrectionError, listEffectiveDays } from '../features/corrections/corrections.ts'
import { correctionsApi } from '../features/corrections/http.ts'
import { scheduleApi } from '../features/schedule/http.ts'
import { ScheduleError } from '../features/schedule/schedule.ts'
import { portalIdentity } from './auth.ts'
import { transaction } from './db.ts'
import { HttpError, body, json, uuid } from './http.ts'
import { submitPunch } from './kiosk.ts'

type EnrollmentResult = Awaited<ReturnType<typeof issueFaceEnrollmentCode>> | Awaited<ReturnType<typeof claimFaceEnrollment>>
function exactKeys(data: Record<string, unknown>, keys: string[]) {
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) throw new HttpError(400,'invalid_request')
}
function enrollmentResponse(result: EnrollmentResult) {
  if (result.state === 'rate_limited') return json({error:'KIOSK_ENROLLMENT_RATE_LIMIT',waitSeconds:result.waitSeconds},429)
  if (result.state === 'rejected') throw new BiometricsError('KIOSK_ENROLLMENT_REJECTED',403)
  return json(result)
}

async function dispatch(request:Request, parts:string[]) {
  if (parts[0] === 'corrections') return correctionsApi(request, parts.slice(1))
  if (parts[0] === 'schedule') return scheduleApi(request, parts.slice(1))
  if (request.method === 'GET' && parts.length === 2 && parts[0] === 'me' && parts[1] === 'face-enrollment') {
    const subject = await portalIdentity(request)
    return transaction(async tx=>{
      const actor = await resolveAuthenticatedSubject(tx,subject)
      return json(await getFaceEnrollmentStatus(tx,{employeeId:actor.employeeId,actor}))
    })
  }
  if (request.method === 'POST' && parts.length === 3 && parts[0] === 'me' && parts[1] === 'face-enrollment' && parts[2] === 'codes') {
    const subject = await portalIdentity(request)
    const data = await body(request)
    exactKeys(data,['siteId','requestId','reissue'])
    const result = await transaction(async tx=>{
      const actor = await resolveAuthenticatedSubject(tx,subject)
      return issueFaceEnrollmentCode(tx,{employeeId:actor.employeeId,siteId:uuid(data.siteId),requestId:uuid(data.requestId),reissue:data.reissue as boolean})
    })
    return enrollmentResponse(result)
  }
  if (request.method === 'POST' && parts.length === 5 && parts[0] === 'hr' && parts[1] === 'employees' && parts[3] === 'face-registration' && parts[4] === 'reset') {
    const employeeId = uuid(parts[2])
    const subject = await portalIdentity(request)
    const data = await body(request)
    exactKeys(data,['requestId','reason'])
    return transaction(async tx=>{
      const actor = await resolveAuthenticatedSubject(tx,subject)
      return json(await resetFaceRegistration(tx,{employeeId,requestId:uuid(data.requestId),reason:data.reason as string},actor))
    })
  }
  if (request.method === 'POST' && parts.length === 2 && parts[0] === 'kiosk') {
    const data = await body(request)
    const proof = request.headers.get('x-kiosk-proof')
    switch (parts[1]) {
      case 'challenges': return json(await transaction(tx=>issueChallenge(tx,data,proof)))
      case 'roster': return json(await transaction(tx=>fetchRoster(tx,data,proof)))
      case 'enrollments': return json(await transaction(tx=>enrollFace(tx,data)))
      case 'enrollment-claim': {
        const result = await transaction(tx=>claimFaceEnrollment(tx,data,proof))
        return enrollmentResponse(result)
      }
      case 'enrollment-complete': return json(await transaction(tx=>completeFaceEnrollment(tx,data)))
      case 'enrollment-status': return json(await transaction(tx=>getFaceEnrollmentSessionStatus(tx,data,proof)))
      case 'enrollment-cancel': return json(await transaction(tx=>cancelFaceEnrollment(tx,data,proof)))
      case 'punches': return json(await transaction(tx=>submitPunch(tx,data)))
    }
  }
  if (request.method === 'GET' && parts[0] === 'employees' && (parts.length === 1 || (parts.length === 3 && parts[2] === 'punches'))) {
    const subject = await portalIdentity(request)
    return transaction(async tx=>{
      const actor=await resolveAuthenticatedSubject(tx,subject)
      if (parts.length===1) {
        const offset=Number(new URL(request.url).searchParams.get('offset') || 0)
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new HttpError(400,'invalid_offset')
        return json({employees:await listReadableEmployees(tx,actor,{limit:100,offset})})
      }
      const employeeId=uuid(parts[1])
      await authorizeReceiptRead(tx,{actor,employeeId})
      return json({punches:await listPunchReceipts(tx,employeeId),days:await listEffectiveDays(tx,employeeId)})
    })
  }
  throw new HttpError(404,'unknown_endpoint')
}
export async function api(request:Request, parts:string[]) {
  try { return await dispatch(request,parts) }
  catch (err) {
    if (err instanceof HttpError || err instanceof BiometricsError) return json({error:err.code},err.status)
    if (err instanceof AccessMfaRequiredError) return json({error:'mfa_required'},403)
    if (err instanceof AccessDeniedError) return json({error:'access_denied'},403)
    if (err instanceof AttendanceActionOrderError) return json({error:err.code,expectedAction:err.expectedAction},409)
    if (err instanceof AttendanceConflictError) return json({error:err.code},409)
    if (err instanceof CorrectionError) return json({error:err.code},err.status)
    if (err instanceof ScheduleError) return json({error:err.code},err.status)
    // Report only a diagnostic identifier; database errors may contain personal data.
    const incident=crypto.randomUUID()
    console.error('Attendance request failed',incident,err instanceof Error?err.name:'Error')
    return json({error:'service_unavailable',incident},503)
  }
}
