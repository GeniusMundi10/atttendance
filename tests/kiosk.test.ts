// PURPOSE: Verify production HTTP handlers through signed enrollment, punch, retry and scoped receipts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { exportJWK, SignJWT } from 'jose'
import { startDatabase } from './database.ts'
import { api } from '../platform/api.ts'
import { database } from '../platform/db.ts'
import { migrate } from '../scripts/migrate.ts'
import { enrollmentPayload, hash, punchPayload, signedIntegrityPayload, signedRequest } from '../features/biometrics/protocol.ts'
import type { Enrollment, Frame, Punch } from '../features/biometrics/protocol.ts'

test('signed kiosk punch is committed once and readable only within the employee scope',async t=>{
  const cluster=await startDatabase()
  process.env.DATABASE_URL=cluster.url
  const pool=database()
  t.after(async()=>{await pool.end();await cluster.stop()})
  await pool.query('CREATE ROLE authenticated')
  await migrate(pool)
  await migrate(pool)
  const ids={device:randomUUID(),site:randomUUID(),employee:randomUUID(),other:randomUUID(),hr:randomUUID()}
  const url='https://elt-auth.example.invalid'
  const issuer=url+'/auth/v1'
  process.env.NEXT_PUBLIC_SUPABASE_URL=url
  process.env.KIOSK_TEMPLATE_KEY_HEX=randomBytes(32).toString('hex')
  const cert=randomBytes(32)
  process.env.KIOSK_PLAY_CERT_SHA256=cert.toString('hex')
  const signing=generateKeyPairSync('ec',{namedCurve:'prime256v1'})
  const service=generateKeyPairSync('rsa',{modulusLength:2048})
  process.env.KIOSK_PLAY_SERVICE_ACCOUNT_JSON=JSON.stringify({client_email:'integration@example.invalid',private_key:service.privateKey.export({format:'pem',type:'pkcs8'})})
  const publicKey=signing.publicKey.export({format:'der',type:'spki'}).toString('base64url')
  const jwk={...await exportJWK(signing.publicKey),kid:'integration',alg:'ES256'}
  const pkg='com.elt.attendance.kiosk', payloads=new Map<string,string>()
  let decodes=0
  // Only external Google and identity-provider responses are substituted inside this test process.
  t.mock.method(globalThis,'fetch',async (target:RequestInfo|URL,opts?:RequestInit)=>{
    const endpoint=String(target)
    if (endpoint===issuer+'/.well-known/jwks.json') return Response.json({keys:[jwk]})
    if (endpoint==='https://oauth2.googleapis.com/token') return Response.json({access_token:'test-google-session',expires_in:3600})
    assert.equal(endpoint,'https://playintegrity.googleapis.com/v1/'+pkg+':decodeIntegrityToken')
    decodes++
    const payload=payloads.get(JSON.parse(String(opts?.body)).integrity_token)
    if (!payload) return new Response(null,{status:400})
    return Response.json({tokenPayloadExternal:{
      requestDetails:{requestPackageName:pkg,requestHash:hash(payload),timestampMillis:String(Date.now())},
      appIntegrity:{appRecognitionVerdict:'PLAY_RECOGNIZED',packageName:pkg,certificateSha256Digest:[cert.toString('base64url')]},
      deviceIntegrity:{deviceRecognitionVerdict:['MEETS_STRONG_INTEGRITY']}
    }})
  })
  const rawPost=(path:string,data:unknown,headers:Record<string,string>={})=>api(
    new Request('https://elt.example.invalid/api/kiosk/'+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(data)}),
    ['kiosk',path])
  async function ok(res:Response) {
    const value=await res.json()
    assert.equal(res.status,200,JSON.stringify(value))
    return value
  }
  const signature=(value:string)=>sign('sha256',Buffer.from(value),signing.privateKey).toString('base64url')
  function proof(kind:string,extra:string[]=[]) {
    const data={requestId:randomUUID(),issuedAt:new Date().toISOString(),signature:''}
    data.signature=signature(signedRequest(kind,ids.device,data,extra))
    return {'x-kiosk-proof':Buffer.from(JSON.stringify(data)).toString('base64url')}
  }
  for (const [id,name] of [[ids.employee,'Employee'],[ids.other,'Other employee'],[ids.hr,'HR reviewer']]) {
    await pool.query('INSERT INTO access_employees(id,display_name) VALUES($1,$2)',[id,name])
    await pool.query('INSERT INTO access_subject_links(auth_provider,auth_subject,employee_id) VALUES($1,$2,$3)',[issuer,id,id])
  }
  await pool.query("INSERT INTO access_operator_roles(employee_id,role) VALUES($1,'HR')",[ids.hr])
  await pool.query("INSERT INTO access_sites(id,name) VALUES($1,'Pilot')",[ids.site])
  await pool.query('INSERT INTO access_employee_sites(employee_id,site_id) VALUES($1,$2)',[ids.employee,ids.site])
  await pool.query('INSERT INTO kiosk_biometric_devices(device_id,site_id,public_key) VALUES($1,$2,$3)',[ids.device,ids.site,publicKey])
  const setupCode=randomBytes(32).toString('base64url')
  await pool.query("INSERT INTO kiosk_face_enrollment_codes(code_hash,device_id,employee_id,expires_at) VALUES($1,$2,$3,now()+interval '1 minute')",[hash(setupCode),ids.device,ids.employee])
  const frames:Frame[]=[[0,9900,9500,4000],[350,9900,9500,4000],[700,9900,9500,4000]]
  const token=()=>randomBytes(64).toString('base64url')
  const enrollment:Enrollment={deviceId:ids.device,employeeId:ids.employee,requestId:randomUUID(),issuedAt:new Date().toISOString(),
    setupCode,embedding:[10000,...Array(127).fill(0)],frames,integrityToken:token(),signature:''}
  const ep=enrollmentPayload(enrollment)
  payloads.set(enrollment.integrityToken,ep)
  enrollment.signature=signature(signedIntegrityPayload(ep,enrollment.integrityToken))
  const {templateId}=await ok(await rawPost('enrollments',enrollment))
  const {templates}=await ok(await rawPost('roster',{deviceId:ids.device},proof('elt-roster-v1')))
  assert.equal(templates[0].templateId,templateId)
  async function makePunch(action:'IN'|'OUT'):Promise<Punch> {
    const challenge=await ok(await rawPost('challenges',{deviceId:ids.device,action},proof('elt-challenge-v1',[action])))
    const data:Punch={deviceId:ids.device,action,requestId:randomUUID(),challengeId:challenge.challengeId,evidence:{
      version:1,employeeId:ids.employee,templateId,nonce:challenge.nonce,frames,integrityToken:token(),signature:''}}
    const payload=punchPayload(data)
    payloads.set(data.evidence.integrityToken,payload)
    data.evidence.signature=signature(signedIntegrityPayload(payload,data.evidence.integrityToken))
    return data
  }
  const first=await makePunch('IN')
  const before=decodes
  const [receipt,retry]=await Promise.all([1,2].map(async()=>ok(await rawPost('punches',first))))
  assert.deepEqual(receipt,retry)
  assert.equal(decodes,before+1)
  assert.equal(receipt.employeeId,ids.employee)
  assert.equal(receipt.action,'IN')
  assert.ok(Number.isFinite(Date.parse(receipt.recordedAt)))
  const altered=structuredClone(first)
  altered.action='OUT'
  assert.equal((await rawPost('punches',altered)).status,401)
  const badToken=await makePunch('OUT')
  payloads.delete(badToken.evidence.integrityToken)
  assert.equal((await rawPost('punches',badToken)).status,403)
  assert.equal((await rawPost('punches',await makePunch('IN'))).status,409)
  for (const table of ['attendance_punches','attendance_audit','attendance_outbox']) {
    assert.equal((await pool.query('SELECT count(*) FROM '+table)).rows[0].count,'1')
    assert.equal((await pool.query("SELECT has_table_privilege('authenticated',$1,'INSERT') AS allowed",[table])).rows[0].allowed,false)
  }
  async function view(as:string|undefined,aal='aal1') {
    const headers:Record<string,string>={}
    if (as) {
      const jwt=await new SignJWT({role:'authenticated',aal}).setProtectedHeader({alg:'ES256',kid:'integration'})
        .setIssuer(issuer).setAudience('authenticated').setSubject(as).setExpirationTime('5m').sign(signing.privateKey)
      headers.authorization='Bearer '+jwt
    }
    return api(new Request('https://elt.example.invalid/api/employees/'+ids.employee+'/punches',{headers}),['employees',ids.employee,'punches'])
  }
  assert.deepEqual((await ok(await view(ids.employee))).punches,[receipt])
  assert.equal((await view(ids.hr)).status,403)
  assert.deepEqual((await ok(await view(ids.hr,'aal2'))).punches,[receipt])
  assert.equal((await view(ids.other)).status,403)
  assert.equal((await view(undefined)).status,401)
  // False check-out guard: an immediate OUT is refused with when the IN was recorded and how long to wait.
  const tooSoon=await rawPost('punches',await makePunch('OUT'))
  assert.equal(tooSoon.status,409)
  const tooSoonBody=await tooSoon.json()
  assert.equal(tooSoonBody.error,'ATTENDANCE_OUT_TOO_SOON')
  assert.equal(tooSoonBody.lastRecordedAt,receipt.recordedAt)
  assert.ok(tooSoonBody.waitSeconds>0)
  await pool.query("UPDATE attendance_punches SET recorded_at = recorded_at - interval '3 minutes' WHERE punch_id = $1",[receipt.punchId])
  assert.equal((await ok(await rawPost('punches',await makePunch('OUT')))).action,'OUT')
})
