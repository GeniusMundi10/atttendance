'use client'
// PURPOSE: Let a signed-in employee apply for one paid day and authorized readers decide it.
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useState, type FormEvent } from 'react'
import { SecondFactor } from '../SecondFactor'

type Balance={month:string,credit:number,available:number,reserved:number,used:number}
type LeaveRequest={id:string,employeeId:string,employeeName:string,workDate:string,status:'PENDING'|'APPROVED'|'REJECTED',note:string,createdAt:string,canDecide:boolean,canOverride:boolean}
const labels:Record<string,string>={
  date_out_of_window:'Choose a future date in the current month.',
  not_scheduled_work_date:'That date is not in your scheduled work dates. Ask HR to confirm your schedule.',
  no_paid_day_available:'Your paid day for this month is already reserved or used.',
  reason_required:'Enter a reason for this decision.',
  self_decision_forbidden:'You cannot decide your own request.',
  manager_cannot_override:'Only HR or an administrator can override a decision.',
  already_decided:'This request has already been decided. Refresh the page.',
  access_denied:'You do not have access to this request.',
  sign_in_required:'Sign in to continue.',
}
async function call<T>(path:string,token:string,init?:RequestInit):Promise<T> {
  const response=await fetch(path,{...init,cache:'no-store',headers:{Authorization:'Bearer '+token,...init?.headers}})
  const data=await response.json().catch(()=>({}))
  if (!response.ok) throw Error(typeof data.error==='string'?data.error:'service_unavailable')
  return data as T
}
export function LeavePortal() {
  const [auth,setAuth]=useState<SupabaseClient>()
  const [session,setSession]=useState<Session|null>(null)
  const [email,setEmail]=useState('')
  const [workDate,setWorkDate]=useState('')
  const [note,setNote]=useState('')
  const [reasons,setReasons]=useState<Record<string,string>>({})
  const [balance,setBalance]=useState<Balance>()
  const [requests,setRequests]=useState<LeaveRequest[]>([])
  const [message,setMessage]=useState('')
  const [busy,setBusy]=useState(false)
  const [reload,setReload]=useState(0)
  useEffect(()=>{
    const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    if (!url || !key) {setMessage('Sign-in has not been configured. Contact HR.');return}
    const client=createClient(url,key)
    setAuth(client)
    void client.auth.getSession().then(({data})=>setSession(data.session))
    const {data}=client.auth.onAuthStateChange((_event,next)=>setSession(next))
    return ()=>data.subscription.unsubscribe()
  },[])
  const token=session?.access_token
  useEffect(()=>{
    setBalance(undefined);setRequests([])
    if (!token) return
    const controller=new AbortController()
    Promise.all([
      call<{balance:Balance}>('/api/leave/balance',token,{signal:controller.signal}),
      call<{requests:LeaveRequest[]}>('/api/leave/requests',token,{signal:controller.signal}),
    ]).then(([a,b])=>{if (!controller.signal.aborted) {setBalance(a.balance);setRequests(b.requests);setMessage('')}})
      .catch(e=>{if (!controller.signal.aborted) setMessage(e instanceof Error?e.message:'service_unavailable')})
    return ()=>controller.abort()
  },[token,reload])
  async function signIn(event:FormEvent) {
    event.preventDefault()
    if (!auth || busy) return
    setBusy(true)
    try {
      const {error}=await auth.auth.signInWithOtp({email:email.trim(),options:{shouldCreateUser:false,emailRedirectTo:location.origin+'/leave'}})
      setMessage(error?'Sign-in link unavailable. Contact HR.':'Check your work email for the sign-in link.')
    } catch {setMessage('Could not reach sign-in. Please retry.')} finally {setBusy(false)}
  }
  async function apply(event:FormEvent) {
    event.preventDefault()
    if (!token || busy) return
    setBusy(true)
    try {
      await call('/api/leave/requests',token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workDate,note})})
      setWorkDate('');setNote('');setMessage('Request submitted for approval.');setReload(x=>x+1)
    } catch(e) {setMessage(e instanceof Error?e.message:'service_unavailable')} finally {setBusy(false)}
  }
  async function decide(id:string,decision:'APPROVE'|'REJECT') {
    if (!token || busy) return
    setBusy(true)
    try {
      await call('/api/leave/requests/'+id+'/decision',token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision,reason:reasons[id]??''})})
      setMessage('Decision recorded.');setReload(x=>x+1)
    } catch(e) {setMessage(e instanceof Error?e.message:'service_unavailable')} finally {setBusy(false)}
  }
  const friendly=labels[message]??(message==='mfa_required'?'Verify your authenticator to continue.':message==='service_unavailable'?'Leave is temporarily unavailable. Refresh to retry.':message)
  if (!session) return <section><h1>Paid leave</h1><form onSubmit={signIn}><label>Work email<input type="email" autoComplete="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label><button disabled={!auth||busy}>Email sign-in link</button></form><p role="status">{friendly}</p></section>
  if (auth && message==='mfa_required') return <section><h1>Paid leave</h1><SecondFactor auth={auth} onVerified={()=>{void auth.auth.refreshSession().then(({data})=>{setSession(data.session);setReload(x=>x+1)})}}/><button className="secondary" onClick={()=>void auth.auth.signOut()}>Sign out</button></section>
  return <section><header><h1>Paid leave</h1><button className="secondary" onClick={()=>void auth?.auth.signOut()}>Sign out</button></header>
    <p>One paid day is credited each month. Unused days do not carry forward. Apply for a scheduled full work date in the current month.</p>
    {balance && <p><strong>{balance.month} balance:</strong> {balance.available} available · {balance.reserved} awaiting decision · {balance.used} used</p>}
    <form onSubmit={apply}><h2>Apply for a paid day</h2><label>Scheduled work date<input type="date" required value={workDate} onChange={e=>setWorkDate(e.target.value)}/></label><label>Note (optional)<textarea maxLength={1000} value={note} onChange={e=>setNote(e.target.value)}/></label><button disabled={busy||balance?.available===0}>Submit request</button></form>
    <div className="controls"><h2>Requests</h2><button className="secondary" onClick={()=>setReload(x=>x+1)}>Refresh</button></div>
    <p role="status">{friendly}</p>
    {requests.length?<table><thead><tr><th>Employee</th><th>Date</th><th>Status</th><th>Decision</th></tr></thead><tbody>{requests.map(request=><tr key={request.id}><td>{request.employeeName}</td><td>{request.workDate}</td><td>{request.status}</td><td>{(request.canDecide||request.canOverride)&&<div><label>Reason<input value={reasons[request.id]??''} maxLength={1000} onChange={e=>setReasons(old=>({...old,[request.id]:e.target.value}))}/></label>{request.status==='PENDING'?<><button disabled={busy} onClick={()=>void decide(request.id,'APPROVE')}>Approve</button> <button disabled={busy} onClick={()=>void decide(request.id,'REJECT')}>Reject</button></>:request.canOverride?<button disabled={busy} onClick={()=>void decide(request.id,request.status==='APPROVED'?'REJECT':'APPROVE')}>Override to {request.status==='APPROVED'?'reject':'approve'}</button>:null}</div>}</td></tr>)}</tbody></table>:<p>No leave requests to show.</p>}
  </section>
}
