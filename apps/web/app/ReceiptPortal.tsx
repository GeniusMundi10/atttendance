'use client'
// PURPOSE: Sign in a provisioned employee and show recent server-confirmed punches.
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useState, type FormEvent } from 'react'
import { SecondFactor } from './SecondFactor'

type Employee = {employeeId:string, displayName:string}
type Receipt = {punchId:string, action:'IN'|'OUT', recordedAt:string}
const time = new Intl.DateTimeFormat('en-IN',{dateStyle:'medium',timeStyle:'medium',timeZone:'Asia/Kolkata'})
async function load<T>(path:string, token:string, signal:AbortSignal):Promise<T> {
  const res = await fetch(path,{signal,cache:'no-store',headers:{Authorization:'Bearer '+token}})
  if (!res.ok) {
    const data=await res.json().catch(()=>({}))
    if (data.error==='mfa_required') throw Error('mfa_required')
    throw Error(res.status === 403 ? 'You do not have access to these records.' : 'Attendance is temporarily unavailable. Refresh to retry.')
  }
  return res.json()
}
export function ReceiptPortal() {
  const [auth,setAuth] = useState<SupabaseClient>()
  const [session,setSession] = useState<Session|null>(null)
  const [email,setEmail] = useState('')
  const [message,setMessage] = useState('')
  const [roster,setRoster] = useState<Employee[]>([])
  const [selected,setSelected] = useState('')
  const [receipts,setReceipts] = useState<Receipt[]|null>(null)
  const [reload,setReload] = useState(0)
  const [sending,setSending] = useState(false)
  const [offset,setOffset] = useState(0)
  useEffect(()=>{
    const url=process.env.NEXT_PUBLIC_SUPABASE_URL, key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    if (!url || !key) { setMessage('Sign-in has not been configured. Contact HR.'); return }
    const client=createClient(url,key)
    setAuth(client)
    const {data} = client.auth.onAuthStateChange((_event,next)=>setSession(next))
    return ()=>data.subscription.unsubscribe()
  },[])
  const token=session?.access_token
  useEffect(()=>{
    setRoster([]); setSelected(''); setReceipts(null)
    if (!token) return
    const ctl=new AbortController()
    load<{employees:Employee[]}>('/api/employees?offset='+offset,token,ctl.signal)
      .then(({employees})=>{if (!ctl.signal.aborted) {setRoster(employees);setSelected(employees[0]?.employeeId ?? '');setMessage('')}})
      .catch(e=>{if (!ctl.signal.aborted) setMessage(e.message)})
    return ()=>ctl.abort()
  },[token,reload,offset])
  useEffect(()=>{
    setReceipts(null)
    if (!selected || !token) return
    const ctl=new AbortController()
    let timer:ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const data=await load<{punches:Receipt[]}>('/api/employees/'+selected+'/punches',token!,ctl.signal)
        if (!ctl.signal.aborted) {setReceipts(data.punches);setMessage('')}
      } catch(e) {
        if (!ctl.signal.aborted) {setReceipts(null);setMessage(e instanceof Error?e.message:'Could not load receipts.')}
      } finally { if (!ctl.signal.aborted) timer=setTimeout(refresh,3000) }
    }
    void refresh()
    return ()=>{ctl.abort();clearTimeout(timer)}
  },[token,selected])
  async function signIn(event:FormEvent) {
    event.preventDefault()
    if (!auth || sending) return
    setSending(true)
    try {
      const {error}=await auth.auth.signInWithOtp({email:email.trim(),options:{shouldCreateUser:false,emailRedirectTo:location.origin}})
      setMessage(error?'Sign-in link unavailable. Contact HR if your account is pending.':'Check your work email for the sign-in link.')
    } catch {setMessage('Could not reach sign-in. Please retry.')} finally {setSending(false)}
  }
  if (!session) return <section><h1>Sign in</h1><form onSubmit={signIn}><label htmlFor="email">Work email</label><input id="email" type="email" autoComplete="email" required value={email} onChange={e=>setEmail(e.target.value)}/><button disabled={!auth || sending}>{sending?'Sending…':'Email sign-in link'}</button></form><p role="status">{message}</p></section>
  if (auth && message==='mfa_required') return <><SecondFactor auth={auth} onVerified={()=>setReload(r=>r+1)}/><button className="secondary" onClick={()=>void auth.auth.signOut()}>Sign out</button></>
  return <section><header><h1>Attendance</h1><button className="secondary" onClick={()=>void auth?.auth.signOut()}>Sign out</button></header>
    <div className="controls"><label>Employee<select value={selected} onChange={e=>{setReceipts(null);setSelected(e.target.value)}}>{roster.map(e=><option key={e.employeeId} value={e.employeeId}>{e.displayName}</option>)}</select></label><button className="secondary" onClick={()=>setReload(r=>r+1)}>Refresh</button></div>
    {(offset>0 || roster.length===100) && <nav className="controls" aria-label="Employee pages"><button disabled={offset===0} onClick={()=>setOffset(o=>Math.max(0,o-100))}>Previous employees</button><button disabled={roster.length<100} onClick={()=>setOffset(o=>o+100)}>More employees</button></nav>}
    <h2>Recent punches</h2><p role="status">{message}</p>
    {receipts?.length ? <table><thead><tr><th>Action</th><th>Time (IST)</th><th>Receipt</th></tr></thead><tbody>{receipts.map(p=><tr key={p.punchId}><td>{p.action==='IN'?'Check in':'Check out'}</td><td>{time.format(new Date(p.recordedAt))}</td><td className="ref">{p.punchId}</td></tr>)}</tbody></table> : <p>{receipts?'No punches recorded.':message?'':selected?'Loading punches…':'Loading employees…'}</p>}
  </section>
}
