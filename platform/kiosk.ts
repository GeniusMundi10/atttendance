// PURPOSE: Commit kiosk verification, employee eligibility and the punch in one transaction.
import type { PoolClient } from 'pg'
import { verifyDeviceOrigin, verifyEvidence } from '../features/biometrics/server.ts'
import { punch } from '../features/biometrics/protocol.ts'
import { checkKioskEligibility } from '../features/access/access.ts'
import { digestPunchEvidence, findCommittedPunchRetry, recordPunch } from '../features/attendance/attendance.ts'

export async function submitPunch(client: PoolClient, input: unknown) {
  const request = punch(input)
  await verifyDeviceOrigin(client,request)
  const origin = {deviceId:request.deviceId, action:request.action, requestId:request.requestId,
    challengeId:request.challengeId, proofDigest:digestPunchEvidence(request.evidence)}
  const existing = await findCommittedPunchRetry(client,origin)
  if (existing) return existing
  const verified = await verifyEvidence(client,request)
  await checkKioskEligibility(client,verified)
  return recordPunch(client,{...origin,employeeId:verified.employeeId,siteId:verified.siteId})
}
