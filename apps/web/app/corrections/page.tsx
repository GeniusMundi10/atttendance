'use client'
// PURPOSE: Let employees request attendance date corrections and authorized reviewers decide each date.
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useState, type FormEvent } from 'react'
import { SecondFactor } from '../SecondFactor'

type Day = {dayId:string,requestId:string,employeeId:string,date:string,proposedIn:string|null,proposedOut:string|null,
  reason:string,status:'PENDING'|'APPROVED'|'REJECTED',revision:number,overrideReason:string|null,decidedAt:string|null}
type Draft = {date:string,proposedIn:string,proposedOut:string}
const empty = ():Draft => ({date:'',proposedIn:'',proposedOut:''})
const ist = new Intl.DateTimeFormat('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'})
function toUtc(date:string,time:string) {return time?new Date(`${date}T${time}:00+05:30`).toISOString():null}
async function call<T>(path:string,token:string,method='GET',value?:unknown):Promise<T> {
  const response=await fetch(path,{method,cache:'no-store',headers:{Authorization:'Bearer '+token,...(value?{'content-type':'application/json'}:{})},
    body:value?JSON.stringify(value):undefined})
  const result=await response.json()
  if (!response.ok) throw Error(result.error || 'request_failed')
  return result
}
const errors:Record<string,string>={monthly_correction_limit:'Only three dates per IST calendar month can be pending or approved.',
  correction_date_unavailable:'This date already has a pending or approved correction.',
  stale_correction_revision:'This date was already decided. Refresh to see its latest status.',
  mfa_required:'mfa_required',access_denied:'You cannot review this date.',
  proposed_time_wrong_date:'Proposed times must fall on the selected IST date.',
  override_reason_required:'Enter a reason for the decision.'}
function explain(error:unknown) {const code=error instanceof Error?error.message:'request_failed';return errors[code]||'The request could not be completed. Please retry.'}

export default function CorrectionsPage() {
  const [auth,setAuth]=useState<SupabaseClient>()
  const [session,setSession]=useState<Session|null>(null)
  const [email,setEmail]=useState('')
  const [mine,setMine]=useState<Day[]>([])
  const [review,setReview]=useState<Day[]>([])
  const [reason,setReason]=useState('')
  const [drafts,setDrafts]=useState<Draft[]>([empty()])
  const [decisionReasons,setDecisionReasons]=useState<Record<string,string>>({})
  const [message,setMessage]=useState('')
  const [busy,setBusy]=useState(false)
  const [needMfa,setNeedMfa]=useState(false)
  const [reload,setReload]=useState(0)
  useEffect(()=>{
    const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    if (!url || !key) {setMessage('Sign-in has not been configured. Contact HR.');return}
    const client=createClient(url,key)
    setAuth(client)
    const {data}=client.auth.onAuthStateChange((_event,next)=>setSession(next))
    return ()=>data.subscription.unsubscribe()
  },[])
  const token=session?.access_token
  useEffect(()=>{
    setMine([]);setReview([]);setNeedMfa(false)
    if (!token) return
    let active=true
    Promise.all([call<{days:Day[]}>('/api/corrections/requests?scope=mine',token),
      call<{days:Day[]}>('/api/corrections/requests?scope=review',token)]).then(([owned,queue])=>{
        if (active) {setMine(owned.days);setReview(queue.days);setMessage('')}
      }).catch(error=>{if (active) {setNeedMfa(error instanceof Error && error.message==='mfa_required');setMessage(explain(error))}})
    return ()=>{active=false}
  },[token,reload])
  async function signIn(event:FormEvent) {
    event.preventDefault()
    if (!auth || busy) return
    setBusy(true)
    try {
      const {error}=await auth.auth.signInWithOtp({email:email.trim(),options:{shouldCreateUser:false,emailRedirectTo:location.origin+'/corrections'}})
      setMessage(error?'Sign-in link unavailable. Contact HR.':'Check your work email for the sign-in link.')
    } catch {setMessage('Could not reach sign-in. Please retry.')} finally {setBusy(false)}
  }
  async function submit(event:FormEvent) {
    event.preventDefault()
    if (!token || busy) return
    setBusy(true)
    try {
      await call('/api/corrections/requests',token,'POST',{reason,days:drafts.map(day=>({date:day.date,
        proposedIn:toUtc(day.date,day.proposedIn),proposedOut:toUtc(day.date,day.proposedOut)}))})
      setReason('');setDrafts([empty()]);setMessage('Correction request submitted.');setReload(value=>value+1)
    } catch(error) {setMessage(explain(error))} finally {setBusy(false)}
  }
  async function decide(day:Day,decision:'APPROVE'|'REJECT') {
    if (!token || busy) return
    setBusy(true)
    try {
      await call(`/api/corrections/days/${day.dayId}/decision`,token,'POST',
        {decision,expectedRevision:day.revision,overrideReason:decisionReasons[day.dayId]||''})
      setMessage(`${day.date} ${decision==='APPROVE'?'approved':'rejected'}.`);setReload(value=>value+1)
    } catch(error) {setMessage(explain(error));setReload(value=>value+1)} finally {setBusy(false)}
  }
  const change=(index:number,field:keyof Draft,value:string)=>setDrafts(current=>current.map((item,i)=>i===index?{...item,[field]:value}:item))
  if (!session) return <section><h1>Attendance corrections</h1><form onSubmit={signIn}><label>Work email<input type="email" required autoComplete="email" value={email} onChange={event=>setEmail(event.target.value)}/></label><button disabled={!auth||busy}>Email sign-in link</button></form><p role="status">{message}</p></section>
  if (needMfa && auth) return <section><h1>Verify to review corrections</h1><SecondFactor auth={auth} onVerified={()=>setReload(value=>value+1)}/><button className="secondary" onClick={()=>void auth.auth.signOut()}>Sign out</button></section>
  return <section><header><h1>Attendance corrections</h1><button className="secondary" onClick={()=>void auth?.auth.signOut()}>Sign out</button></header>
    <p>Select up to three distinct IST dates per calendar month. Pending and approved dates use a slot; rejected dates release it.</p>
    <form className="wide-form" onSubmit={submit}><h2>Request a correction</h2>
      {drafts.map((day,index)=><div className="date-row" key={index}>
        <label>IST date<input type="date" required value={day.date} onChange={event=>change(index,'date',event.target.value)}/></label>
        <label>Proposed in (IST)<input type="time" value={day.proposedIn} onChange={event=>change(index,'proposedIn',event.target.value)}/></label>
        <label>Proposed out (IST)<input type="time" value={day.proposedOut} onChange={event=>change(index,'proposedOut',event.target.value)}/></label>
        {drafts.length>1&&<button className="secondary" type="button" onClick={()=>setDrafts(current=>current.filter((_,i)=>i!==index))}>Remove</button>}
      </div>)}
      <button type="button" className="secondary" disabled={drafts.length>=31} onClick={()=>setDrafts(current=>[...current,empty()])}>Add date</button>
      <label>Reason<textarea required maxLength={1000} value={reason} onChange={event=>setReason(event.target.value)}/></label>
      <button disabled={busy||drafts.some(day=>!day.proposedIn&&!day.proposedOut)}>Submit correction</button>
    </form>
    <p role="status">{message}</p>
    <h2>Your requested dates</h2>{mine.length?mine.map(day=><article className="status-card" key={day.dayId}>
      <strong>{day.date} · {day.status.toLowerCase()}</strong><p>{day.reason}</p>
      <p>In: {day.proposedIn?ist.format(new Date(day.proposedIn)):'No change'} · Out: {day.proposedOut?ist.format(new Date(day.proposedOut)):'No change'}</p>
      {day.overrideReason&&<p>Decision reason: {day.overrideReason}</p>}
    </article>):<p>No correction dates requested.</p>}
    <h2>Dates awaiting your review</h2>{review.length?review.map(day=><article className="status-card" key={day.dayId}>
      <strong>{day.date}</strong><p>Employee: <span className="ref">{day.employeeId}</span></p><p>Request: {day.reason}</p>
      <p>Proposed in: {day.proposedIn?ist.format(new Date(day.proposedIn)):'No change'} · Proposed out: {day.proposedOut?ist.format(new Date(day.proposedOut)):'No change'}</p>
      <label>Decision reason<input maxLength={1000} value={decisionReasons[day.dayId]||''} onChange={event=>setDecisionReasons(current=>({...current,[day.dayId]:event.target.value}))}/></label>
      <div className="controls"><button disabled={busy||!decisionReasons[day.dayId]?.trim()} onClick={()=>void decide(day,'APPROVE')}>Approve</button><button className="secondary" disabled={busy||!decisionReasons[day.dayId]?.trim()} onClick={()=>void decide(day,'REJECT')}>Reject</button></div>
    </article>):<p>No dates await your review.</p>}
  </section>
}
