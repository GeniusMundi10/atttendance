'use client'
// PURPOSE: Show an employee's monthly shift calendar and holidays; let HR assign shifts.
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useState, type FormEvent } from 'react'
import { SecondFactor } from '../SecondFactor'
type Day={date:string,kind:'WORKING'|'WEEKLY_OFF'|'HOLIDAY'|'UNASSIGNED',holidayName:string|null,restrictedHoliday:string|null,shiftName:string|null,startTime:string|null}
type Shift={id:string,name:string,startTime:string,requiredMinutes:number,weeklyOffDays:number[]}
type Person={employeeId:string,displayName:string}
const kindLabel:Record<Day['kind'],string>={WORKING:'Working day',WEEKLY_OFF:'Weekly off',HOLIDAY:'Holiday',UNASSIGNED:'No shift assigned'}
const labels:Record<string,string>={
  reason_required:'Enter a reason for this change.',assignment_exists:'This employee already has a shift starting on that date.',
  access_denied:'You do not have access to this schedule.',invalid_date:'Choose a valid date.',sign_in_required:'Sign in to continue.',
}
async function call<T>(path:string,token:string,init?:RequestInit):Promise<T> {
  const response=await fetch(path,{...init,cache:'no-store',headers:{Authorization:'Bearer '+token,...init?.headers}})
  const data=await response.json().catch(()=>({}))
  if (!response.ok) throw Error(typeof data.error==='string'?data.error:'service_unavailable')
  return data as T
}
function monthRange(month:string):{from:string,to:string} {
  const [y,m]=month.split('-').map(Number) as [number,number]
  return {from:month+'-01',to:month+'-'+String(new Date(Date.UTC(y,m,0)).getUTCDate()).padStart(2,'0')}
}
export function SchedulePortal() {
  const [auth,setAuth]=useState<SupabaseClient>()
  const [session,setSession]=useState<Session|null>(null)
  const [email,setEmail]=useState('')
  const [people,setPeople]=useState<Person[]>([])
  const [employeeId,setEmployeeId]=useState('')
  const [month,setMonth]=useState(new Date().toISOString().slice(0,7))
  const [days,setDays]=useState<Day[]>([])
  const [shifts,setShifts]=useState<Shift[]>([])
  const [sites,setSites]=useState<{id:string,name:string}[]>([])
  const [form,setForm]=useState({shiftId:'',siteId:'',effectiveFrom:'',reason:''})
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
    if (!token) return
    const controller=new AbortController()
    Promise.all([call<{employees:Person[]}>('/api/employees',token,{signal:controller.signal}),
      call<{shifts:Shift[],sites:{id:string,name:string}[]}>('/api/schedule/setup',token,{signal:controller.signal})])
      .then(([a,b])=>{if (controller.signal.aborted) return;setPeople(a.employees);setShifts(b.shifts);setSites(b.sites);setEmployeeId(old=>old||a.employees[0]?.employeeId||'');setMessage('')})
      .catch(e=>{if (!controller.signal.aborted) setMessage(e instanceof Error?e.message:'service_unavailable')})
    return ()=>controller.abort()
  },[token,reload])
  useEffect(()=>{
    setDays([])
    if (!token || !employeeId) return
    const controller=new AbortController(), {from,to}=monthRange(month)
    call<{days:Day[]}>('/api/schedule/days/'+employeeId+'?from='+from+'&to='+to,token,{signal:controller.signal})
      .then(r=>{if (!controller.signal.aborted) setDays(r.days)})
      .catch(e=>{if (!controller.signal.aborted) setMessage(e instanceof Error?e.message:'service_unavailable')})
    return ()=>controller.abort()
  },[token,employeeId,month,reload])
  async function signIn(event:FormEvent) {
    event.preventDefault()
    if (!auth || busy) return
    setBusy(true)
    try {
      const {error}=await auth.auth.signInWithOtp({email:email.trim(),options:{shouldCreateUser:false,emailRedirectTo:location.origin+'/schedule'}})
      setMessage(error?'Sign-in link unavailable. Contact HR.':'Check your work email for the sign-in link.')
    } catch {setMessage('Could not reach sign-in. Please retry.')} finally {setBusy(false)}
  }
  async function assign(event:FormEvent) {
    event.preventDefault()
    if (!token || busy) return
    setBusy(true)
    try {
      await call('/api/schedule/assignments',token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({employeeId,...form})})
      setForm({shiftId:'',siteId:'',effectiveFrom:'',reason:''});setMessage('Shift assigned.');setReload(x=>x+1)
    } catch(e) {setMessage(e instanceof Error?e.message:'service_unavailable')} finally {setBusy(false)}
  }
  const friendly=labels[message]??(message==='mfa_required'?'Verify your authenticator to continue.':message==='service_unavailable'?'Schedule is temporarily unavailable. Refresh to retry.':message)
  if (!session) return <section><h1>Schedule</h1><form onSubmit={signIn}><label>Work email<input type="email" autoComplete="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label><button disabled={!auth||busy}>Email sign-in link</button></form><p role="status">{friendly}</p></section>
  if (auth && message==='mfa_required') return <section><h1>Schedule</h1><SecondFactor auth={auth} onVerified={()=>{void auth.auth.refreshSession().then(({data})=>{setSession(data.session);setReload(x=>x+1)})}}/><button className="secondary" onClick={()=>void auth.auth.signOut()}>Sign out</button></section>
  const canAssign=sites.length>0
  return <section><header><h1>Schedule</h1><button className="secondary" onClick={()=>void auth?.auth.signOut()}>Sign out</button></header>
    <div className="controls">
      {people.length>1 && <label>Employee<select value={employeeId} onChange={e=>setEmployeeId(e.target.value)}>{people.map(p=><option key={p.employeeId} value={p.employeeId}>{p.displayName}</option>)}</select></label>}
      <label>Month<input type="month" value={month} onChange={e=>e.target.value && setMonth(e.target.value)}/></label>
    </div>
    <p role="status">{friendly}</p>
    {days.length?<table><thead><tr><th>Date</th><th>Day</th><th>Shift</th><th>Note</th></tr></thead><tbody>{days.map(d=><tr key={d.date}>
      <td>{d.date}</td><td>{kindLabel[d.kind]}</td><td>{d.shiftName?d.shiftName+' from '+d.startTime:'-'}</td>
      <td>{d.holidayName??(d.restrictedHoliday?'Restricted holiday: '+d.restrictedHoliday+' (optional holiday may be applied)':'')}</td></tr>)}</tbody></table>:<p>No schedule to show.</p>}
    {canAssign && employeeId && <form className="wide-form" onSubmit={assign}><h2>Assign shift</h2>
      <label>Shift<select required value={form.shiftId} onChange={e=>setForm({...form,shiftId:e.target.value})}><option value="">Choose</option>{shifts.map(s=><option key={s.id} value={s.id}>{s.name} ({s.startTime}, {s.requiredMinutes/60} h)</option>)}</select></label>
      <label>Location<select required value={form.siteId} onChange={e=>setForm({...form,siteId:e.target.value})}><option value="">Choose</option>{sites.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Effective from<input type="date" required value={form.effectiveFrom} onChange={e=>setForm({...form,effectiveFrom:e.target.value})}/></label>
      <label>Reason<input required maxLength={1000} value={form.reason} onChange={e=>setForm({...form,reason:e.target.value})}/></label>
      <button disabled={busy}>Assign shift</button></form>}
  </section>
}
