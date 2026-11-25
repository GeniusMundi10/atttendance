'use client'
// PURPOSE: Sign in a provisioned employee, show server-confirmed punches, and manage account-wide face enrollment.
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { SecondFactor } from './SecondFactor'

type Employee = {employeeId:string, displayName:string}
type Receipt = {punchId:string, action:'IN'|'OUT', recordedAt:string}
type EffectiveTime = {recordedAt:string,source:'PUNCH'|'APPROVED_CORRECTION',punchId?:string,correctionDayId?:string}
type EffectiveDay = {date:string,in:EffectiveTime|null,out:EffectiveTime|null}
type EligibleSite = {siteId:string,siteName:string}
type ActiveCodeRequest = {requestId:string,siteId:string,state:string,expiresAt:string}
type FaceEnrollmentStatus = {
  registered:boolean
  registrationRevision:number
  registrationAvailable:boolean
  eligibleSites:EligibleSite[]
  attendanceReadiness:{activeEmployee:boolean,activeSiteAssignmentCount:number}
  activeCodeRequest:ActiveCodeRequest|null
  notice:{version:string,text:string}|null
  canReset:boolean
}
type IssuedCode = {state:'issued',requestId:string,siteId:string,code:string|null,expiresAt:string,recovered:boolean}
type LocalEnrollmentCode = {code:string,expiresAt:string,siteId:string,requestId:string,ownerToken:string}
const time = new Intl.DateTimeFormat('en-IN',{dateStyle:'medium',timeStyle:'medium',timeZone:'Asia/Kolkata'})
const expiryTime = new Intl.DateTimeFormat('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'})
async function requestJson<T>(path:string, token:string, init:RequestInit={}):Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Authorization','Bearer '+token)
  if (init.body) headers.set('Content-Type','application/json')
  const res = await fetch(path,{...init,cache:'no-store',headers})
  if (!res.ok) {
    const data = await res.json().catch(()=>({})) as {error?:string,waitSeconds?:number}
    if (data.error==='mfa_required') throw Error('mfa_required')
    if (data.error==='KIOSK_ENROLLMENT_RATE_LIMIT') {
      const wait=Number.isInteger(data.waitSeconds) && (data.waitSeconds??0)>0 ? ` Wait ${data.waitSeconds} seconds before retrying.` : ''
      throw Error('Too many enrollment attempts.'+wait)
    }
    throw Error(res.status===403?'You do not have access to this action.':'The request could not be completed. Refresh to retry.')
  }
  return res.json() as Promise<T>
}
function expiryLabel(value:string) {
  const date=new Date(value)
  return Number.isNaN(date.getTime())?'Unavailable':expiryTime.format(date)+' IST'
}
export function ReceiptPortal() {
  const [auth,setAuth] = useState<SupabaseClient>()
  const [session,setSession] = useState<Session|null>(null)
  const [email,setEmail] = useState('')
  const [message,setMessage] = useState('')
  const [mfaRequired,setMfaRequired] = useState(false)
  const [roster,setRoster] = useState<Employee[]>([])
  const [selected,setSelected] = useState('')
  const [receipts,setReceipts] = useState<Receipt[]|null>(null)
  const [days,setDays] = useState<EffectiveDay[]|null>(null)
  const [reload,setReload] = useState(0)
  const [faceReload,setFaceReload] = useState(0)
  const [sending,setSending] = useState(false)
  const [offset,setOffset] = useState(0)
  const [faceStatus,setFaceStatus] = useState<FaceEnrollmentStatus|null>(null)
  const [faceLoading,setFaceLoading] = useState(false)
  const [faceMessage,setFaceMessage] = useState('')
  const [selectedSite,setSelectedSite] = useState('')
  const [enrollmentCode,setEnrollmentCode] = useState<LocalEnrollmentCode|null>(null)
  const [codeUnavailable,setCodeUnavailable] = useState(false)
  const [codeBusy,setCodeBusy] = useState(false)
  const [resetEmployee,setResetEmployee] = useState('')
  const [resetReason,setResetReason] = useState('')
  const [resetConfirmation,setResetConfirmation] = useState(false)
  const [resetBusy,setResetBusy] = useState(false)
  const [hrMessage,setHrMessage] = useState('')
  const currentToken= session?.access_token
  const currentTokenRef=useRef(currentToken)
  currentTokenRef.current=currentToken

  useEffect(()=>{
    const url=process.env.NEXT_PUBLIC_SUPABASE_URL, key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    if (!url || !key) { setMessage('Sign-in has not been configured. Contact HR.'); return }
    const client=createClient(url,key)
    setAuth(client)
    const {data} = client.auth.onAuthStateChange((event,next)=>{setSession(next);if(event==='SIGNED_OUT')setMfaRequired(false)})
    return ()=>data.subscription.unsubscribe()
  },[])
  const token=currentToken
  useEffect(()=>{
    setRoster([]); setSelected(''); setReceipts(null); setDays(null)
    if (!token) return
    const ctl=new AbortController()
    requestJson<{employees:Employee[]}>('/api/employees?offset='+offset,token,{signal:ctl.signal})
      .then(({employees})=>{if (!ctl.signal.aborted) {setRoster(employees);setSelected(employees[0]?.employeeId ?? '');setMessage('')}})
      .catch(e=>{if (!ctl.signal.aborted) {if (e instanceof Error && e.message==='mfa_required') setMfaRequired(true); else setMessage(e instanceof Error?e.message:'Could not load employees.')}})
    return ()=>ctl.abort()
  },[token,reload,offset])
  useEffect(()=>{
    setReceipts(null); setDays(null)
    if (!selected || !token) return
    const ctl=new AbortController()
    let timer:ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const data=await requestJson<{punches:Receipt[],days:EffectiveDay[]}>('/api/employees/'+encodeURIComponent(selected)+'/punches',token!,{signal:ctl.signal})
        if (!ctl.signal.aborted) {setReceipts(data.punches);setDays(data.days);setMessage('')}
      } catch(e) {
        if (!ctl.signal.aborted) {
          if (e instanceof Error && e.message==='mfa_required') setMfaRequired(true)
          else {setReceipts(null);setDays(null);setMessage(e instanceof Error?e.message:'Could not load receipts.')}
        }
      } finally { if (!ctl.signal.aborted) timer=setTimeout(refresh,3000) }
    }
    void refresh()
    return ()=>{ctl.abort();clearTimeout(timer)}
  },[token,selected])
  useEffect(()=>{
    setEnrollmentCode(null)
    setCodeUnavailable(false)
    setFaceStatus(null)
    setFaceMessage('')
    setHrMessage('')
    setSelectedSite('')
    setResetConfirmation(false)
    setResetReason('')
    setResetEmployee('')
  },[token])
  useEffect(()=>{
    if (!token) {setFaceLoading(false);return}
    const ctl=new AbortController()
    setFaceLoading(true)
    requestJson<FaceEnrollmentStatus>('/api/me/face-enrollment',token,{signal:ctl.signal})
      .then(status=>{
        if (ctl.signal.aborted || currentTokenRef.current!==token) return
        const active=status.activeCodeRequest && Date.parse(status.activeCodeRequest.expiresAt)<=Date.now() ? null : status.activeCodeRequest
        setFaceStatus({...status,activeCodeRequest:active})
        setSelectedSite(current=>status.eligibleSites.length===1?status.eligibleSites[0].siteId:status.eligibleSites.some(site=>site.siteId===current)?current:'')
      })
      .catch(e=>{
        if (!ctl.signal.aborted) {
          if (e instanceof Error && e.message==='mfa_required') setMfaRequired(true)
          else setFaceMessage(e instanceof Error?e.message:'Could not load face-enrollment status.')
        }
      })
      .finally(()=>{if (!ctl.signal.aborted) setFaceLoading(false)})
    return ()=>ctl.abort()
  },[token,faceReload])
  const visibleCode=enrollmentCode?.ownerToken===token?enrollmentCode:null
  useEffect(()=>{
    if (!visibleCode) return
    const requestId=visibleCode.requestId
    const expire=()=>{
      setEnrollmentCode(current=>current?.requestId===requestId?null:current)
      setCodeUnavailable(false)
      setFaceStatus(current=>current?.activeCodeRequest?.requestId===requestId?{...current,activeCodeRequest:null}:current)
      setFaceMessage('The enrollment code expired. Issue or reissue a code to continue.')
    }
    const remaining=Date.parse(visibleCode.expiresAt)-Date.now()
    if (!Number.isFinite(remaining) || remaining<=0) {expire();return}
    const timer=setTimeout(expire,remaining)
    const onVisibility=()=>{if (document.visibilityState==='visible' && Date.parse(visibleCode.expiresAt)<=Date.now()) expire()}
    document.addEventListener('visibilitychange',onVisibility)
    return ()=>{clearTimeout(timer);document.removeEventListener('visibilitychange',onVisibility)}
  },[visibleCode])

  async function signIn(event:FormEvent) {
    event.preventDefault()
    if (!auth || sending) return
    setSending(true)
    try {
      const {error}=await auth.auth.signInWithOtp({email:email.trim(),options:{shouldCreateUser:false,emailRedirectTo:location.origin}})
      setMessage(error?'Sign-in link unavailable. Contact HR if your account is pending.':'Check your work email for the sign-in link.')
    } catch {setMessage('Could not reach sign-in. Please retry.')} finally {setSending(false)}
  }
  function signOut() {
    setEnrollmentCode(null)
    setFaceStatus(null)
    void auth?.auth.signOut()
  }
  const sites=faceStatus?.eligibleSites ?? []
  const enrollmentSiteId=sites.length===1?sites[0].siteId:selectedSite
  const enrollmentSite=sites.find(site=>site.siteId===enrollmentSiteId)
  const serverActiveCode=faceStatus?.activeCodeRequest ?? null
  const hasActiveCode=Boolean(visibleCode || serverActiveCode || codeUnavailable)

  async function requestEnrollmentCode(reissue:boolean) {
    if (!token || !faceStatus || faceStatus.registered || !faceStatus.registrationAvailable || !enrollmentSiteId || codeBusy) return
    const requestToken=token
    setEnrollmentCode(null)
    setCodeUnavailable(false)
    setFaceMessage('')
    setCodeBusy(true)
    try {
      const response=await requestJson<IssuedCode>('/api/me/face-enrollment/codes',requestToken,{
        method:'POST',body:JSON.stringify({siteId:enrollmentSiteId,requestId:crypto.randomUUID(),reissue})
      })
      if (currentTokenRef.current!==requestToken) return
      if (response.code && /^\d{6}$/.test(response.code) && Date.parse(response.expiresAt)>Date.now()) {
        setEnrollmentCode({code:response.code,expiresAt:response.expiresAt,siteId:response.siteId,requestId:response.requestId,ownerToken:requestToken})
        setFaceMessage('Your enrollment code is ready. Enter it at the registered kiosk before it expires.')
      } else {
        setCodeUnavailable(true)
        setFaceMessage('A code is active but its digits are not available in this browser session. Explicitly reissue it to display a new code.')
      }
      try {
        const updated=await requestJson<FaceEnrollmentStatus>('/api/me/face-enrollment',requestToken)
        if (currentTokenRef.current===requestToken) {
          const active=updated.activeCodeRequest && Date.parse(updated.activeCodeRequest.expiresAt)>Date.now()?updated.activeCodeRequest:null
          setFaceStatus({...updated,activeCodeRequest:active})
          setSelectedSite(current=>updated.eligibleSites.length===1?updated.eligibleSites[0].siteId:updated.eligibleSites.some(site=>site.siteId===current)?current:'')
          if (!active) setCodeUnavailable(false)
        }
      } catch(e) {
        if (currentTokenRef.current===requestToken && e instanceof Error && e.message==='mfa_required') setMfaRequired(true)
      }
    } catch(e) {
      if (currentTokenRef.current===requestToken) {
        if (e instanceof Error && e.message==='mfa_required') setMfaRequired(true)
        else setFaceMessage(e instanceof Error?e.message:'Could not issue an enrollment code.')
      }
    } finally {if (currentTokenRef.current===requestToken) setCodeBusy(false)}
  }
  function reviewReset(event:FormEvent) {
    event.preventDefault()
    if (!faceStatus?.canReset || !resetEmployee || !resetReason.trim()) return
    setHrMessage('')
    setResetConfirmation(true)
  }
  async function confirmReset() {
    if (!token || !faceStatus?.canReset || !resetEmployee || !resetReason.trim() || resetBusy) return
    const requestToken=token
    const employeeId=resetEmployee
    const revision=faceStatus.registrationRevision
    setResetBusy(true)
    setHrMessage('')
    try {
      await requestJson<unknown>('/api/hr/employees/'+encodeURIComponent(employeeId)+'/face-registration/reset',requestToken,{
        method:'POST',body:JSON.stringify({requestId:crypto.randomUUID(),reason:resetReason.trim()})
      })
      if (currentTokenRef.current!==requestToken) return
      setHrMessage('Face registration reset completed.')
      setResetConfirmation(false)
      setResetEmployee('')
      setResetReason('')
      try {
        const updated=await requestJson<FaceEnrollmentStatus>('/api/me/face-enrollment',requestToken)
        if (currentTokenRef.current===requestToken) {
          if (updated.registrationRevision!==revision || updated.registered) setEnrollmentCode(null)
          setFaceStatus({...updated,activeCodeRequest:updated.activeCodeRequest && Date.parse(updated.activeCodeRequest.expiresAt)>Date.now()?updated.activeCodeRequest:null})
        }
      } catch(e) {
        if (e instanceof Error && e.message==='mfa_required') setMfaRequired(true)
      }
    } catch(e) {
      if (currentTokenRef.current===requestToken) {
        if (e instanceof Error && e.message==='mfa_required') setMfaRequired(true)
        else setHrMessage(e instanceof Error?e.message:'Could not reset face registration.')
      }
    } finally {if (currentTokenRef.current===requestToken) setResetBusy(false)}
  }
  if (!session) return <section><h1>Sign in</h1><form onSubmit={signIn}><label htmlFor="email">Work email</label><input id="email" type="email" autoComplete="email" required value={email} onChange={e=>setEmail(e.target.value)}/><button disabled={!auth || sending}>{sending?'Sending…':'Email sign-in link'}</button></form><p role="status">{message}</p></section>
  if (auth && mfaRequired) return <><SecondFactor auth={auth} onVerified={()=>{setMfaRequired(false);setMessage('');setReload(r=>r+1);setFaceReload(r=>r+1)}}/><button className="secondary" onClick={signOut}>Sign out</button></>
  const showTime=(value:EffectiveTime|null)=>value?<>{time.format(new Date(value.recordedAt))}<span className="tag">{value.source==='PUNCH'?'Kiosk punch':'Approved correction'}</span></>:'—'
  const readiness=faceStatus?.attendanceReadiness
  const attendanceReady=Boolean(readiness?.activeEmployee && readiness.activeSiteAssignmentCount>0)
  const resetEmployeeName=roster.find(employee=>employee.employeeId===resetEmployee)?.displayName ?? resetEmployee
  return <section><header><h1>Attendance</h1><button className="secondary" onClick={signOut}>Sign out</button></header>
    <div className="controls"><label>Employee<select value={selected} onChange={e=>{setReceipts(null);setSelected(e.target.value)}}>{roster.map(e=><option key={e.employeeId} value={e.employeeId}>{e.displayName}</option>)}</select></label><button className="secondary" onClick={()=>{setReload(r=>r+1);setFaceReload(r=>r+1)}}>Refresh</button></div>
    {(offset>0 || roster.length===100) && <nav className="controls" aria-label="Employee pages"><button disabled={offset===0} onClick={()=>setOffset(o=>Math.max(0,o-100))}>Previous employees</button><button disabled={roster.length<100} onClick={()=>setOffset(o=>o+100)}>More employees</button></nav>}

    <section className="face-enrollment" aria-labelledby="face-enrollment-heading">
      <header className="face-heading"><div><h2 id="face-enrollment-heading">Face enrollment</h2><p className="face-intro">Enrollment status is for your signed-in account and is separate from the receipt employee selector.</p></div><button className="secondary" onClick={()=>setFaceReload(value=>value+1)} disabled={!token || faceLoading}>{faceLoading?'Refreshing…':'Refresh status'}</button></header>
      {faceLoading && !faceStatus && <p role="status">Loading face-enrollment status…</p>}
      {faceMessage && <p className="portal-message" role="status">{faceMessage}</p>}
      {faceStatus && <>
        <div className="readiness-panel" aria-label="Attendance readiness">
          <strong>Attendance readiness</strong>
          <span className={attendanceReady?'readiness-ready':'readiness-unavailable'}>{attendanceReady?'Ready':'Not ready'}</span>
          <p>{readiness?.activeEmployee?'Active employee account':'Employee account is not active'} · {readiness?.activeSiteAssignmentCount ?? 0} active site assignment{readiness?.activeSiteAssignmentCount===1?'':'s'}</p>
        </div>
        {faceStatus.registered ? <div className="registered-panel" role="status"><strong>Registered</strong><p>Your account is registered for face enrollment. This status does not change with site transfers or the receipt selector.</p></div> : <>
          {faceStatus.registrationAvailable ? <div className="enrollment-panel">
            {sites.length>1 ? <label htmlFor="enrollment-site">Enrollment site<select id="enrollment-site" value={enrollmentSiteId} onChange={e=>setSelectedSite(e.target.value)} required><option value="">Choose a site</option>{sites.map(site=><option key={site.siteId} value={site.siteId}>{site.siteName}</option>)}</select></label> : enrollmentSite && <p className="selected-site">Enrollment site: <strong>{enrollmentSite.siteName}</strong></p>}
            {faceStatus.notice && <div className="notice-panel"><strong>Employee notice · {faceStatus.notice.version}</strong><p>{faceStatus.notice.text}</p><small>The registered kiosk will show this notice before capture.</small></div>}
            {visibleCode && <div className="issued-code" aria-live="polite" aria-atomic="true">
              <span className="face-code-visual" aria-hidden="true"><span>{visibleCode.code.slice(0,3)}</span><span>{visibleCode.code.slice(3)}</span></span>
              <span className="sr-only">Your enrollment code, individual digits: {Array.from(visibleCode.code).join(', ')}.</span>
              <p>Enter this six-digit code at the registered kiosk.</p>
              <p className="expiry">Expires {expiryLabel(visibleCode.expiresAt)}</p>
            </div>}
            {!visibleCode && serverActiveCode && <p className="active-code-note">An enrollment code is active until {expiryLabel(serverActiveCode.expiresAt)}, but its digits are not available to retrieve. Reissue to display a new code.</p>}
            <div className="code-actions"><button onClick={()=>void requestEnrollmentCode(hasActiveCode)} disabled={codeBusy || !enrollmentSiteId}>{codeBusy?'Requesting…':hasActiveCode?'Reissue enrollment code':'Issue enrollment code'}</button>{hasActiveCode && <span className="tag">Reissue is explicit and invalidates the previous unclaimed code.</span>}</div>
          </div> : <div className="enrollment-unavailable"><strong>Self-service enrollment unavailable</strong><p>{sites.length===0?'No active eligible site is available for enrollment.':'Registration is not currently available for this account.'} Contact HR for assistance.</p></div>}
        </>}
      </>}
    </section>

    {faceStatus?.canReset && <section className="hr-reset" aria-labelledby="hr-reset-heading">
      <h2 id="hr-reset-heading">HR face registration reset</h2>
      <p>This administrative action is available because the server authorized reset capability for this session.</p>
      <form className="wide-form" onSubmit={reviewReset}>
        <label htmlFor="reset-employee">Employee to reset<select id="reset-employee" value={resetEmployee} onChange={e=>{setResetEmployee(e.target.value);setResetConfirmation(false)}} required><option value="">Choose an employee</option>{roster.map(employee=><option key={employee.employeeId} value={employee.employeeId}>{employee.displayName}</option>)}</select></label>
        <label htmlFor="reset-reason">Audit reason<textarea id="reset-reason" rows={3} required value={resetReason} onChange={e=>{setResetReason(e.target.value);setResetConfirmation(false)}}/></label>
        <button type="submit" disabled={!resetEmployee || !resetReason.trim() || resetBusy}>Review reset</button>
      </form>
      {resetConfirmation && <div className="reset-confirmation" aria-labelledby="reset-confirmation-heading">
        <h3 id="reset-confirmation-heading">Confirm face registration reset for {resetEmployeeName}</h3>
        <p>This will retire the employee’s face templates across all sites and invalidate pending enrollment codes and claims. Attendance, corrections, and leave history will remain unchanged.</p>
        <p><strong>Audit reason:</strong> {resetReason.trim()}</p>
        <div className="controls"><button onClick={()=>void confirmReset()} disabled={resetBusy}>{resetBusy?'Resetting…':'Confirm reset'}</button><button className="secondary" onClick={()=>setResetConfirmation(false)} disabled={resetBusy}>Cancel</button></div>
      </div>}
      {hrMessage && <p role="status">{hrMessage}</p>}
    </section>}

    <h2>Effective days</h2><p>Approved corrections replace the shown day time. Original kiosk receipts remain below.</p>
    {days?.length ? <table><thead><tr><th>IST date</th><th>In</th><th>Out</th></tr></thead><tbody>{days.map(day=><tr key={day.date}><td>{day.date}</td><td>{showTime(day.in)}</td><td>{showTime(day.out)}</td></tr>)}</tbody></table> : <p>{days?'No attendance days yet.':''}</p>}
    <h2>Original kiosk receipts</h2><p role="status">{message}</p>
    {receipts?.length ? <table><thead><tr><th>Action</th><th>Time (IST)</th><th>Receipt</th></tr></thead><tbody>{receipts.map(p=><tr key={p.punchId}><td>{p.action==='IN'?'Check in':'Check out'}</td><td>{time.format(new Date(p.recordedAt))}</td><td className="ref">{p.punchId}</td></tr>)}</tbody></table> : <p>{receipts?'No punches recorded.':message?'':selected?'Loading punches…':'Loading employees…'}</p>}
  </section>
}
