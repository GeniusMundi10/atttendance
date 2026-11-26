'use client'
// PURPOSE: Let a signed-in employee apply for paid or unpaid leave and see their requests; LeaveRequests also serves Admin for decisions.
import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../AppShell'
import { dayLabel } from '../Home'

type Balance={month:string,credit:number,available:number,reserved:number,used:number}
type LeaveType='PAID'|'UNPAID'
type LeaveRequest={id:string,employeeId:string,employeeName:string,workDate:string,leaveType:LeaveType,status:'PENDING'|'APPROVED'|'REJECTED',note:string,decisionReason:string,createdAt:string,canDecide:boolean,canOverride:boolean}
const labels:Record<string,string>={
  date_out_of_window:'Choose a future date in the current month.',
  not_scheduled_work_date:'That day is already off (Sunday or a holiday). Pick a working day.',
  no_paid_day_available:'Your paid day for this month is already reserved or used. You can apply for unpaid leave instead.',
  date_already_requested:'You already have a leave request for that date.',
  note_required:'Add a reason for your leave.',
  reason_required:'Enter a reason for this decision.',
  self_decision_forbidden:'You cannot decide your own request.',
  manager_cannot_override:'Only HR or an administrator can override a decision.',
  already_decided:'This request has already been decided. Refresh the page.',
  access_denied:'You do not have access to this request.',
  sign_in_required:'Sign in to continue.',
}
const statusText={PENDING:'Pending',APPROVED:'Approved',REJECTED:'Rejected'}
const done=['Request submitted for approval.','Decision recorded.']
async function call<T>(path:string,token:string,init?:RequestInit):Promise<T> {
  const response=await fetch(path,{...init,cache:'no-store',headers:{Authorization:'Bearer '+token,...init?.headers}})
  const data=await response.json().catch(()=>({}))
  if (!response.ok) throw Error(typeof data.error==='string'?data.error:'service_unavailable')
  return data as T
}
function Message({message}:{message:string}) {
  const {requireMfa}=useAuth()
  useEffect(()=>{if (message==='mfa_required') requireMfa()},[message])
  const friendly=labels[message]??(message==='mfa_required'?'Verify your authenticator to continue.':message==='service_unavailable'?'Leave is temporarily unavailable. Refresh to retry.':message)
  return friendly?<p role="status" className={done.includes(message)?'notice':'form-error'}>{friendly}</p>:null
}

/** Own requests (`mine`), or requests this reader may decide (Admin). `refresh` reloads when it changes. */
export function LeaveRequests({mine,refresh=0}:{mine:boolean,refresh?:number}) {
  const {token}=useAuth()
  const [requests,setRequests]=useState<LeaveRequest[]|null>(null)
  const [reasons,setReasons]=useState<Record<string,string>>({})
  const [message,setMessage]=useState('')
  const [busy,setBusy]=useState(false)
  const [reload,setReload]=useState(0)
  useEffect(()=>{
    if (!token) return
    const controller=new AbortController()
    call<{requests:LeaveRequest[]}>('/api/leave/requests',token,{signal:controller.signal})
      .then(data=>{if (!controller.signal.aborted) setRequests(data.requests)})
      .catch(e=>{if (!controller.signal.aborted) setMessage(e instanceof Error?e.message:'service_unavailable')})
    return ()=>controller.abort()
  },[token,reload,refresh])
  async function decide(id:string,decision:'APPROVE'|'REJECT') {
    if (!token || busy) return
    setBusy(true)
    try {
      await call('/api/leave/requests/'+id+'/decision',token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision,reason:reasons[id]??''})})
      setMessage('Decision recorded.');setReload(x=>x+1)
    } catch(e) {setMessage(e instanceof Error?e.message:'service_unavailable')} finally {setBusy(false)}
  }
  // Admin lists everything it can see, own requests included (read-only: nobody decides their own leave).
  const shown=(requests??[]).filter(r=>!mine||!(r.canDecide||r.canOverride))
    .sort((a,b)=>Number(b.status==='PENDING')-Number(a.status==='PENDING'))
  return <>
    <Message message={message}/>
    {requests===null?<p className="muted">Loading…</p>:shown.length?<ul className="leave-requests">{shown.map(request=><li key={request.id} className="card">
      <div className="leave-row">
        <div>
          <strong>{mine?'':request.employeeName+' · '}{dayLabel.format(new Date(request.workDate+'T12:00:00+05:30'))}</strong>
          <p>{request.leaveType==='PAID'?'Paid leave':'Unpaid leave'}</p>
        </div>
        <span className={'status '+request.status.toLowerCase()}>{statusText[request.status]}</span>
      </div>
      {request.note && <p className="leave-note"><b>Reason</b>{request.note}</p>}
      {request.decisionReason && <p className={'leave-note '+request.status.toLowerCase()}><b>{request.status==='REJECTED'?'Rejection reason':'Decision note'}</b>{request.decisionReason}</p>}
      {!mine&&!(request.canDecide||request.canOverride)&&<p className="muted small own-note">Your request · needs another HR or admin to decide</p>}
      {(request.canDecide||request.canOverride)&&!mine&&(()=>{
        // Rejections and HR overrides must carry a message; a manager approving a pending request need not.
        const reason=(reasons[request.id]??'').trim()
        return <div className="decide">
          <label>Message to employee<input value={reasons[request.id]??''} maxLength={1000} placeholder="Required to reject" onChange={e=>setReasons(old=>({...old,[request.id]:e.target.value}))}/></label>
          <div className="decide-buttons">{request.status==='PENDING'?<><button disabled={busy||(request.canOverride&&!reason)} onClick={()=>void decide(request.id,'APPROVE')}>Approve</button><button className="secondary" disabled={busy||!reason} onClick={()=>void decide(request.id,'REJECT')}>Reject</button></>
            :request.canOverride?<button className="secondary" disabled={busy||!reason} onClick={()=>void decide(request.id,request.status==='APPROVED'?'REJECT':'APPROVE')}>Override to {request.status==='APPROVED'?'reject':'approve'}</button>:null}</div>
        </div>
      })()}
    </li>)}</ul>:<p className="muted">{mine?'No leave requests yet.':'No leave requests to handle.'}</p>}
  </>
}

export function LeavePortal() {
  const {token}=useAuth()
  const [leaveType,setLeaveType]=useState<LeaveType>('PAID')
  const [workDate,setWorkDate]=useState('')
  const [note,setNote]=useState('')
  const [balance,setBalance]=useState<Balance>()
  const [message,setMessage]=useState('')
  const [busy,setBusy]=useState(false)
  const [reload,setReload]=useState(0)
  useEffect(()=>{
    setBalance(undefined)
    if (!token) return
    const controller=new AbortController()
    call<{balance:Balance}>('/api/leave/balance',token,{signal:controller.signal})
      .then(a=>{if (!controller.signal.aborted) setBalance(a.balance)})
      .catch(e=>{if (!controller.signal.aborted) setMessage(e instanceof Error?e.message:'service_unavailable')})
    return ()=>controller.abort()
  },[token,reload])
  // No paid day left: default to unpaid so the form stays usable.
  useEffect(()=>{if (balance?.available===0) setLeaveType('UNPAID')},[balance?.available])
  async function apply(event:FormEvent) {
    event.preventDefault()
    if (!token || busy) return
    setBusy(true)
    try {
      await call('/api/leave/requests',token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workDate,note,leaveType})})
      setWorkDate('');setNote('');setMessage('Request submitted for approval.');setReload(x=>x+1)
    } catch(e) {setMessage(e instanceof Error?e.message:'service_unavailable')} finally {setBusy(false)}
  }
  const paidLeft=balance?.available??0
  return <section className="leave">
    <h1>Leave</h1>
    <p className="page-lead">Take a full working day off this month. Sundays and holidays are already off.</p>

    <form onSubmit={apply} className="card leave-form">
      <fieldset className="leave-types">
        <legend>Leave type</legend>
        <label className={leaveType==='PAID'?'on':undefined}>
          <input type="radio" name="leaveType" value="PAID" checked={leaveType==='PAID'} disabled={paidLeft===0} onChange={()=>setLeaveType('PAID')}/>
          <strong>Paid leave</strong>
          <span>{balance?`${paidLeft} of ${balance.credit} left this month`:'Loading…'}</span>
        </label>
        <label className={leaveType==='UNPAID'?'on':undefined}>
          <input type="radio" name="leaveType" value="UNPAID" checked={leaveType==='UNPAID'} onChange={()=>setLeaveType('UNPAID')}/>
          <strong>Unpaid leave</strong>
          <span>No pay for the day</span>
        </label>
      </fieldset>
      <label>Date<input type="date" required value={workDate} onChange={e=>setWorkDate(e.target.value)}/></label>
      <label>Reason for leave<textarea required maxLength={1000} rows={3} placeholder="e.g. Family function, medical appointment" value={note} onChange={e=>setNote(e.target.value)}/></label>
      <button disabled={busy||(leaveType==='PAID'&&paidLeft===0)}>{busy?'Submitting…':`Apply for ${leaveType==='PAID'?'paid':'unpaid'} leave`}</button>
      <Message message={message}/>
    </form>
    <p className="muted small">One paid day is credited each month and does not carry forward.</p>

    <div className="section-head"><h2>My requests</h2><button className="link-button" onClick={()=>setReload(x=>x+1)}>Refresh</button></div>
    <LeaveRequests mine refresh={reload}/>
  </section>
}
