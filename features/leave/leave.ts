// PURPOSE: Apply for paid leave (one monthly paid day, locked PostgreSQL balance) or unpaid leave, and decide requests.
import { randomUUID } from 'node:crypto'
import { AccessDeniedError, resolveAuthenticatedSubject, type Actor, type QueryClient } from '../access/access.ts'
import { isWorkingDay } from '../schedule/schedule.ts'

export class LeaveError extends Error {
  code:string
  status:number
  constructor(code:string,status = 400) { super(code); this.name='LeaveError'; this.code=code; this.status=status }
}

export type LeaveStatus = 'PENDING'|'APPROVED'|'REJECTED'
export type LeaveType = 'PAID'|'UNPAID'
export type LeaveBalance = {month:string,credit:number,available:number,reserved:number,used:number}
export type LeaveRequest = {
  id:string,employeeId:string,employeeName:string,workDate:string,leaveType:LeaveType,status:LeaveStatus,
  note:string,decisionReason:string,createdAt:string,updatedAt:string,canDecide:boolean,canOverride:boolean
}

function date(value:unknown):string {
  if (typeof value!=='string' || !/^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) throw new LeaveError('invalid_date')
  const parsed=new Date(value+'T00:00:00.000Z')
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10)!==value) throw new LeaveError('invalid_date')
  return value
}
function note(value:unknown):string {
  if (value === undefined) return ''
  if (typeof value!=='string' || value.length>1000) throw new LeaveError('invalid_note')
  return value.trim()
}
async function verified(client:QueryClient, actor:Actor):Promise<string> {
  const current=await resolveAuthenticatedSubject(client,actor)
  if (current.employeeId!==actor.employeeId) throw new AccessDeniedError()
  return current.employeeId
}
async function businessDay(client:QueryClient):Promise<string> {
  const result=await client.query<{today:string}>("SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS today")
  return result.rows[0]!.today
}
function month(today:string):string { return today.slice(0,7)+'-01' }
function number(value:unknown):number { return Number(value) }
function balance(monthStart:string, row?:{credit:unknown,reserved:unknown,used:unknown}):LeaveBalance {
  const credit=row?number(row.credit):1, reserved=row?number(row.reserved):0, used=row?number(row.used):0
  return {month:monthStart.slice(0,7),credit,available:credit-reserved-used,reserved,used}
}

/** The caller supplies a pg transaction for every write. */
export async function getLeaveBalance(client:QueryClient,actor:Actor):Promise<LeaveBalance> {
  const employeeId=await verified(client,actor)
  const monthStart=month(await businessDay(client))
  const result=await client.query<{credit:unknown,reserved:unknown,used:unknown}>(
    'SELECT credit,reserved,used FROM leave_balances WHERE employee_id=$1 AND month_start=$2',
    [employeeId,monthStart])
  return balance(monthStart,result.rows[0])
}

/** Unpaid leave follows the same date and approval rules but never touches the paid-day balance. */
export async function applyForPaidLeave(client:QueryClient,actor:Actor,input:{workDate:unknown,note?:unknown,leaveType?:unknown}):Promise<{id:string}> {
  const employeeId=await verified(client,actor)
  const workDate=date(input.workDate), requestNote=note(input.note)
  const leaveType=input.leaveType===undefined?'PAID':input.leaveType
  if (leaveType!=='PAID' && leaveType!=='UNPAID') throw new LeaveError('invalid_leave_type')
  if (!requestNote) throw new LeaveError('note_required')
  const today=await businessDay(client), monthStart=month(today)
  if (workDate<=today || workDate.slice(0,7)!==today.slice(0,7)) throw new LeaveError('date_out_of_window')
  const scheduled=await client.query(
    'SELECT 1 FROM leave_work_dates WHERE employee_id=$1 AND work_date=$2 FOR SHARE',
    [employeeId,workDate])
  if (!scheduled.rows.length) {
    // No explicit date: fall back to the employee's assigned shift, which excludes weekly offs and holidays.
    if (!await isWorkingDay(client,employeeId,workDate)) throw new LeaveError('not_scheduled_work_date')
    await client.query('INSERT INTO leave_work_dates(employee_id,work_date) VALUES ($1,$2) ON CONFLICT DO NOTHING',[employeeId,workDate])
  }
  await client.query('INSERT INTO leave_balances(employee_id,month_start) VALUES ($1,$2) ON CONFLICT DO NOTHING',[employeeId,monthStart])
  const locked=await client.query<{credit:unknown,reserved:unknown,used:unknown}>(
    'SELECT credit,reserved,used FROM leave_balances WHERE employee_id=$1 AND month_start=$2 FOR UPDATE',
    [employeeId,monthStart])
  // The balance lock above serializes this employee's writers, so this check cannot race.
  const taken=await client.query("SELECT 1 FROM leave_requests WHERE employee_id=$1 AND work_date=$2 AND status<>'REJECTED'",[employeeId,workDate])
  if (taken.rows.length) throw new LeaveError('date_already_requested',409)
  const id=randomUUID()
  if (leaveType==='PAID') {
    if (balance(monthStart,locked.rows[0]).available<1) throw new LeaveError('no_paid_day_available',409)
    await client.query('UPDATE leave_balances SET reserved=reserved+1 WHERE employee_id=$1 AND month_start=$2',[employeeId,monthStart])
  }
  await client.query(`INSERT INTO leave_requests(id,employee_id,month_start,work_date,status,note,leave_type)
    VALUES ($1,$2,$3,$4,'PENDING',$5,$6)`,[id,employeeId,monthStart,workDate,requestNote,leaveType])
  return {id}
}

export async function decidePaidLeave(client:QueryClient,actor:Actor,input:{id:string,decision:unknown,reason?:unknown}):Promise<void> {
  const actorId=await verified(client,actor)
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(input.id)) throw new LeaveError('invalid_id')
  if (input.decision!=='APPROVE' && input.decision!=='REJECT') throw new LeaveError('invalid_decision')
  const reason=note(input.reason)
  const initial=await client.query<{employee_id:string,month_start:string}>(
    "SELECT employee_id,to_char(month_start,'YYYY-MM-DD') AS month_start FROM leave_requests WHERE id=$1",[input.id])
  if (!initial.rows.length) throw new LeaveError('request_not_found',404)
  const {employee_id:employeeId,month_start:monthStart}=initial.rows[0]!
  if (actorId===employeeId) throw new LeaveError('self_decision_forbidden',403)
  // All writers lock balance first, then request, so submissions and decisions serialize.
  const balanceRow=await client.query<{credit:unknown,reserved:unknown,used:unknown}>(
    'SELECT credit,reserved,used FROM leave_balances WHERE employee_id=$1 AND month_start=$2 FOR UPDATE',
    [employeeId,monthStart])
  if (!balanceRow.rows.length) throw new LeaveError('request_not_found',404)
  const locked=await client.query<{status:LeaveStatus,leave_type:LeaveType,work_date:string}>(
    "SELECT status,leave_type,to_char(work_date,'YYYY-MM-DD') AS work_date FROM leave_requests WHERE id=$1 FOR UPDATE",[input.id])
  if (!locked.rows.length) throw new LeaveError('request_not_found',404)
  const from=locked.rows[0]!.status, to=input.decision==='APPROVE'?'APPROVED':'REJECTED'
  const {leave_type:leaveType,work_date:workDate}=locked.rows[0]!
  if (from===to) throw new LeaveError('already_decided',409)
  const operator=await client.query<{role:string}>(
    "SELECT role FROM access_operator_roles WHERE employee_id=$1 AND active AND role IN ('HR','ADMIN') FOR SHARE",[actorId])
  const override=operator.rows.length>0
  if (override && actor.aal!=='aal2') throw new AccessDeniedError()
  if (!override) {
    const manager=await client.query(
      'SELECT 1 FROM access_manager_reports WHERE manager_id=$1 AND report_id=$2 AND active FOR SHARE',
      [actorId,employeeId])
    if (!manager.rows.length) throw new AccessDeniedError()
    if (from!=='PENDING') throw new LeaveError('manager_cannot_override',403)
  }
  if ((to==='REJECTED' || override) && !reason) throw new LeaveError('reason_required')
  if (from==='REJECTED') {
    // Reviving a rejected request must not double-book a date that was requested again since.
    const taken=await client.query("SELECT 1 FROM leave_requests WHERE employee_id=$1 AND work_date=$2 AND status<>'REJECTED' AND id<>$3",[employeeId,workDate,input.id])
    if (taken.rows.length) throw new LeaveError('date_already_requested',409)
  }
  if (leaveType==='PAID') {
    const before=balance(monthStart,balanceRow.rows[0])
    let reserved=before.reserved, used=before.used
    if (from==='PENDING') reserved--
    else if (from==='APPROVED') used--
    if (to==='APPROVED') used++
    if (reserved<0 || used<0 || reserved+used>before.credit) throw new LeaveError('no_paid_day_available',409)
    await client.query('UPDATE leave_balances SET reserved=$3,used=$4 WHERE employee_id=$1 AND month_start=$2',
      [employeeId,monthStart,reserved,used])
  }
  await client.query('UPDATE leave_requests SET status=$2,updated_at=now() WHERE id=$1',[input.id,to])
  await client.query(`INSERT INTO leave_decisions(id,request_id,actor_employee_id,from_status,to_status,reason,is_override)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),input.id,actorId,from,to,reason,override])
}

export async function listLeaveRequests(client:QueryClient,actor:Actor):Promise<LeaveRequest[]> {
  const actorId=await verified(client,actor)
  const result=await client.query<{
    id:string,employee_id:string,display_name:string,work_date:string,leave_type:LeaveType,status:LeaveStatus,
    note:string,decision_reason:string|null,created_at:string,updated_at:string,can_decide:boolean,can_override:boolean
  }>(`SELECT q.id,q.employee_id,e.display_name,
      to_char(q.work_date,'YYYY-MM-DD') AS work_date,q.leave_type,q.status,q.note,d.reason AS decision_reason,
      to_char(q.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
      to_char(q.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
      (q.employee_id<>$1 AND q.status='PENDING' AND (op.employee_id IS NOT NULL OR mr.manager_id IS NOT NULL)) AS can_decide,
      (q.employee_id<>$1 AND op.employee_id IS NOT NULL) AS can_override
     FROM leave_requests q JOIN access_employees e ON e.id=q.employee_id
     LEFT JOIN LATERAL (SELECT reason FROM leave_decisions WHERE request_id=q.id ORDER BY decided_at DESC,id DESC LIMIT 1) d ON true
     LEFT JOIN access_operator_roles op ON op.employee_id=$1 AND op.active AND op.role IN ('HR','ADMIN')
     LEFT JOIN access_manager_reports mr ON mr.manager_id=$1 AND mr.report_id=q.employee_id AND mr.active
    WHERE q.employee_id=$1 OR op.employee_id IS NOT NULL OR mr.manager_id IS NOT NULL
    ORDER BY q.created_at DESC,q.id DESC LIMIT 100`,[actorId])
  return result.rows.map(row=>({id:row.id,employeeId:row.employee_id,employeeName:row.display_name,
    workDate:row.work_date,leaveType:row.leave_type,status:row.status,note:row.note,decisionReason:row.decision_reason??'',createdAt:row.created_at,
    updatedAt:row.updated_at,canDecide:row.can_decide,canOverride:row.can_override}))
}
