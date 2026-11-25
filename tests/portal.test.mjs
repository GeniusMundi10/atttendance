// PURPOSE: Exercise the built Next portal and API routes over a real loopback HTTP connection.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import next from 'next'

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
  const corrections=await fetch(url+'/corrections')
  assert.equal(corrections.status,200)
  assert.match(await corrections.text(),/Attendance corrections/)
  const correctionApi=await fetch(url+'/api/corrections/requests')
  assert.equal(correctionApi.status,401)
  const punch=await fetch(url+'/api/kiosk/punches',{method:'POST',body:'{}'})
  assert.equal(punch.status,415)
})
