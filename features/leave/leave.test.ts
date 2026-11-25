// PURPOSE: Exercise monthly credit, concurrent requests, scoped decisions, and overrides on PostgreSQL.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { AccessMfaRequiredError, resolveAuthenticatedSubject } from '../access/access.ts'
import { applyForPaidLeave, decidePaidLeave, getLeaveBalance, LeaveError, listLeaveRequests } from './leave.ts'

test('monthly paid day is reserved once and only scoped actors decide it',{
  skip: !process.env.LEAVE_TEST_DATABASE_URL && 'Set LEAVE_TEST_DATABASE_URL for PostgreSQL test',
},async t=>{
  const pg=await import('pg')
  const schema='leave_test_'+randomUUID().replaceAll('-','')
  const clients=[new pg.default.Client({connectionString:process.env.LEAVE_TEST_DATABASE_URL}),
    new pg.default.Client({connectionString:process.env.LEAVE_TEST_DATABASE_URL})]
  const [a,b]=clients
  await Promise.all(clients.map(c=>c.connect()))
  try {
    await a.query(`CREATE SCHEMA "${schema}"`)
    await Promise.all(clients.map(c=>c.query(`SET search_path TO "${schema}"`)))
    const accessSql=await readFile(fileURLToPath(new URL('../access/migrations/001_access.sql',import.meta.url)),'utf8')
    const leaveSql=await readFile(fileURLToPath(new URL('./migrations/001_paid_leave.sql',import.meta.url)),'utf8')
    const scheduleSql=await readFile(fileURLToPath(new URL('../schedule/migrations/001_schedule.sql',import.meta.url)),'utf8')
    await a.query(accessSql);await a.query(leaveSql);await a.query(scheduleSql)
    const today=(await a.query("SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') AS d")).rows[0].d as string
    const next=new Date(Date.parse(today+'T00:00:00Z')+86400000).toISOString().slice(0,10)
    if (next.slice(0,7)!==today.slice(0,7)) {t.skip('No future date remains in current month');return}
    const employee=randomUUID(),manager=randomUUID(),stranger=randomUUID(),hr=randomUUID()
    for (const [id,name] of [[employee,'Employee'],[manager,'Manager'],[stranger,'Stranger'],[hr,'HR']]) {
      await a.query('INSERT INTO access_employees(id,display_name) VALUES ($1,$2)',[id,name])
      await a.query('INSERT INTO access_subject_links(auth_provider,auth_subject,employee_id) VALUES ($1,$2,$3)',
        ['issuer',id,id])
    }
    await a.query('INSERT INTO access_manager_reports(manager_id,report_id) VALUES ($1,$2)',[manager,employee])
    await a.query("INSERT INTO access_operator_roles(employee_id,role) VALUES ($1,'HR')",[hr])
    await a.query('INSERT INTO leave_work_dates(employee_id,work_date) VALUES ($1,$2)',[employee,next])
    const subject=(id:string,aal?:string)=>({authProvider:'issuer',authSubject:id,aal})
    const employeeActor=await resolveAuthenticatedSubject(a,subject(employee))
    const managerActor=await resolveAuthenticatedSubject(a,subject(manager))
    const strangerActor=await resolveAuthenticatedSubject(a,subject(stranger))
    await assert.rejects(resolveAuthenticatedSubject(a,subject(hr)),AccessMfaRequiredError)
    const hrActor=await resolveAuthenticatedSubject(a,subject(hr,'aal2'))
    async function tx<T>(client:typeof a,work:()=>Promise<T>):Promise<T> {
      await client.query('BEGIN')
      try {const result=await work();await client.query('COMMIT');return result}
      catch(error) {await client.query('ROLLBACK');throw error}
    }
    assert.equal((await getLeaveBalance(a,employeeActor)).available,1)
    await assert.rejects(tx(a,()=>applyForPaidLeave(a,managerActor,{workDate:next})),
      (error:unknown)=>error instanceof LeaveError && error.code==='not_scheduled_work_date')
    const results=await Promise.allSettled([
      tx(a,()=>applyForPaidLeave(a,employeeActor,{workDate:next})),
      tx(b,()=>applyForPaidLeave(b,employeeActor,{workDate:next})),
    ])
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
    assert.equal(results.filter(r=>r.status==='rejected').length,1)
    assert.equal((await getLeaveBalance(a,employeeActor)).reserved,1)
    const requests=await listLeaveRequests(a,managerActor)
    assert.equal(requests.length,1)
    const id=requests[0]!.id
    assert.equal((await listLeaveRequests(a,strangerActor)).length,0)
    await assert.rejects(tx(a,()=>decidePaidLeave(a,employeeActor,{id,decision:'APPROVE'})),
      (error:unknown)=>error instanceof LeaveError && error.code==='self_decision_forbidden')
    await assert.rejects(tx(a,()=>decidePaidLeave(a,strangerActor,{id,decision:'APPROVE'})))
    await assert.rejects(tx(a,()=>decidePaidLeave(a,managerActor,{id,decision:'REJECT'})),
      (error:unknown)=>error instanceof LeaveError && error.code==='reason_required')
    await tx(a,()=>decidePaidLeave(a,managerActor,{id,decision:'APPROVE'}))
    assert.deepEqual(await getLeaveBalance(a,employeeActor),{
      month:today.slice(0,7),credit:1,available:0,reserved:0,used:1})
    await assert.rejects(tx(a,()=>decidePaidLeave(a,managerActor,{id,decision:'REJECT',reason:'Late'})),
      (error:unknown)=>error instanceof LeaveError && error.code==='manager_cannot_override')
    await assert.rejects(tx(a,()=>decidePaidLeave(a,hrActor,{id,decision:'REJECT'})),
      (error:unknown)=>error instanceof LeaveError && error.code==='reason_required')
    await tx(a,()=>decidePaidLeave(a,hrActor,{id,decision:'REJECT',reason:'Schedule correction'}))
    assert.equal((await getLeaveBalance(a,employeeActor)).available,1)
    await tx(a,()=>decidePaidLeave(a,hrActor,{id,decision:'APPROVE',reason:'Verified schedule'}))
    assert.equal((await getLeaveBalance(a,employeeActor)).used,1)
    const history=await a.query('SELECT from_status,to_status,is_override FROM leave_decisions WHERE request_id=$1 ORDER BY decided_at,id',[id])
    assert.equal(history.rows.length,3)
    assert.equal(history.rows.filter(row=>row.is_override).length,2)
  } finally {
    await Promise.all(clients.map(c=>c.query('ROLLBACK').catch(()=>{})))
    await Promise.all(clients.map(c=>c.query('RESET search_path').catch(()=>{})))
    await a.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await Promise.all(clients.map(c=>c.end()))
  }
})
