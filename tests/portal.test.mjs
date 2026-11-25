// PURPOSE: Exercise the built Next portal and verify its face-enrollment UI contract over static and loopback checks.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import next from 'next'

const portalSource=()=>readFile(resolve('apps/web/app/ReceiptPortal.tsx'),'utf8')
const portalStyles=()=>readFile(resolve('apps/web/app/styles.css'),'utf8')

test('the employee face-enrollment UI follows the frozen account-wide contract',async()=>{
  const [source,styles]=await Promise.all([portalSource(),portalStyles()])
  assert.match(source,/requestJson<FaceEnrollmentStatus>\('\/api\/me\/face-enrollment'/)
  assert.match(source,/requestJson<IssuedCode>\('\/api\/me\/face-enrollment\/codes'/)
  assert.match(source,/requestJson<FaceEnrollmentStatus>\('\/api\/me\/face-enrollment',requestToken\)/)
  assert.match(source,/\/api\/hr\/employees\/'.*face-registration\/reset/)
  assert.doesNotMatch(source,/\/api\/me\/face-enrollment[^'`]*selected/)
  assert.match(source,/setEnrollmentCode\(null\)[\s\S]*?\},\[token\]\)/)
  assert.match(source,/setEnrollmentCode\(current=>current\?\.requestId===requestId\?null:current\)/)
  assert.match(source,/setEnrollmentCode\(null\)\s*\n\s*setCodeUnavailable\(false\)\s*\n\s*setFaceStatus\(null\)/)
  assert.doesNotMatch(source,/localStorage|sessionStorage/)
  assert.match(source,/faceStatus\.registered\s*\?\s*<div className="registered-panel"/)
  assert.match(source,/faceStatus\?\.canReset/)
  assert.match(source,/id="reset-employee"/)
  assert.match(source,/id="reset-reason"/)
  assert.match(source,/Confirm reset/)
  assert.match(source,/across all sites and invalidate pending enrollment codes and claims/)
  assert.match(source,/face-code-visual" aria-hidden="true"><span>\{visibleCode\.code\.slice\(0,3\)\}<\/span><span>\{visibleCode\.code\.slice\(3\)\}/)
  assert.match(source,/Array\.from\(visibleCode\.code\)\.join\(', '\)/)
  assert.match(source,/Expires \{expiryLabel\(visibleCode\.expiresAt\)\}/)
  assert.match(source,/SecondFactor auth=\{auth\}/)
  assert.match(styles,/\.face-code-visual/)
  assert.match(styles,/@media\(max-width:760px\)/)
})

test('the production portal serves sign-in and protects its API routes',async t=>{
  process.env.NEXT_PUBLIC_SUPABASE_URL='https://elt-auth.example.invalid'
  const app=next({dev:false,dir:resolve('apps/web'),hostname:'127.0.0.1'})
  await app.prepare()
  const server=createServer(app.getRequestHandler())
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve))
    await app.close()
  })
  await new Promise((ready,fail)=>server.listen(0,'127.0.0.1',ready).once('error',fail))
  const url='http://127.0.0.1:'+server.address().port
  const page=await fetch(url)
  assert.equal(page.status,200)
  assert.match(await page.text(),/Email sign-in link/)
  assert.equal((await fetch(url+'/elt.png')).status,200)
  const receipts=await fetch(url+'/api/employees')
  assert.equal(receipts.status,401)
  assert.deepEqual(await receipts.json(),{error:'sign_in_required'})
  const faceStatus=await fetch(url+'/api/me/face-enrollment')
  assert.equal(faceStatus.status,401)
  assert.deepEqual(await faceStatus.json(),{error:'sign_in_required'})
  assert.match(faceStatus.headers.get('cache-control')??'',/private, no-store/)
  const issueCode=await fetch(url+'/api/me/face-enrollment/codes',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
  assert.equal(issueCode.status,401)
  assert.deepEqual(await issueCode.json(),{error:'sign_in_required'})
  const reset=await fetch(url+'/api/hr/employees/00000000-0000-4000-8000-000000000001/face-registration/reset',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
  assert.equal(reset.status,401)
  assert.deepEqual(await reset.json(),{error:'sign_in_required'})
  const corrections=await fetch(url+'/corrections')
  assert.equal(corrections.status,200)
  assert.match(await corrections.text(),/Attendance corrections/)
  const correctionApi=await fetch(url+'/api/corrections/requests')
  assert.equal(correctionApi.status,401)
  const leave=await fetch(url+'/leave')
  assert.equal(leave.status,200)
  const leaveApi=await fetch(url+'/api/leave/requests')
  assert.equal(leaveApi.status,401)
  const punch=await fetch(url+'/api/kiosk/punches',{method:'POST',body:'{}'})
  assert.equal(punch.status,415)
})
