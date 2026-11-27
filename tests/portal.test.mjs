// PURPOSE: Exercise the built Next portal and verify its face-enrollment UI contract over static and loopback checks.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import next from 'next'

const source=name=>readFile(resolve('apps/web/app',name),'utf8')

test('the employee app keeps the account-wide face-enrollment contract',async()=>{
  const [home,admin,shell,styles]=await Promise.all([source('Home.tsx'),source('admin/page.tsx'),source('AppShell.tsx'),source('styles.css')])
  assert.match(home,/api<FaceEnrollmentStatus>\('\/api\/me\/face-enrollment'/)
  assert.match(home,/api<IssuedCode>\('\/api\/me\/face-enrollment\/codes'/)
  assert.doesNotMatch(home,/\/api\/me\/face-enrollment[^'`]*selected/)
  // A new session never inherits a code; an expired code is dropped.
  assert.match(home,/setEnrollmentCode\(null\)\s*\n\s*setFaceStatus\(null\)\s*\n\s*\}, \[token\]\)/)
  assert.match(home,/setEnrollmentCode\(current => current\?\.requestId === requestId \? null : current\)/)
  for (const file of [home,admin,shell]) assert.doesNotMatch(file,/localStorage|sessionStorage/)
  assert.match(home,/className="face-code-visual" aria-hidden="true">\{Array\.from\(visibleCode\.code\)\.map\(\(digit, i\) => <span key=\{i\}>\{digit\}<\/span>\)\}<\/span>/)
  assert.match(home,/Array\.from\(visibleCode\.code\)\.join\(', '\)/)
  assert.match(home,/Valid for <strong>\{countdown\(Date\.parse\(visibleCode\.expiresAt\) - now\)\}<\/strong>/)
  assert.match(admin,/\/api\/hr\/employees\/' \+ .*face-registration\/reset/)
  assert.match(admin,/id="reset-employee"/)
  assert.match(admin,/id="reset-reason"/)
  assert.match(admin,/Confirm reset/)
  assert.match(admin,/across all sites and invalidate pending enrollment codes and claims/)
  assert.match(shell,/SecondFactor auth=\{auth\}/)
  assert.match(shell,/signInWithPassword/)
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
  assert.match(await page.text(),/Attendance · ELT Corporate/)
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
  assert.match(await corrections.text(),/Attendance · ELT Corporate/)
  const correctionApi=await fetch(url+'/api/corrections/requests')
  assert.equal(correctionApi.status,401)
  const leave=await fetch(url+'/leave')
  assert.equal(leave.status,200)
  const leaveApi=await fetch(url+'/api/leave/requests')
  assert.equal(leaveApi.status,401)
  const punch=await fetch(url+'/api/kiosk/punches',{method:'POST',body:'{}'})
  assert.equal(punch.status,415)
  const whatsappPost=await fetch(url+'/api/internal/whatsapp',{method:'POST'})
  assert.equal(whatsappPost.status,401)
  assert.deepEqual(await whatsappPost.json(),{error:'Unauthorized'})
  assert.match(whatsappPost.headers.get('cache-control')??'',/no-store/i)
  const whatsappGet=await fetch(url+'/api/internal/whatsapp')
  assert.equal(whatsappGet.status,405)
})
