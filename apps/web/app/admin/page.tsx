'use client'
// PURPOSE: HR/ADMIN workspace: attendance lookup (month, employee, day), new accounts, leave decisions, face registration approvals and resets.
import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, api, useAuth } from '../AppShell'
import { duration } from '../Home'
import { LeaveRequests } from '../leave/LeavePortal'
import { DayRow, worked, type EffectiveDay, type Receipt } from '../history/DayRow'

type Person = { employeeId: string, employeeCode: string, displayName: string }
type Queue = { pendingApprovals: Person[], reregistrationRequests: (Person & { requestId: string, reason: string, createdAt: string })[] }
type Signup = { requestId: string, email: string, displayName: string, createdAt: string }
type Employee = { employeeId: string, displayName: string }
type Mode = 'month' | 'employee' | 'day'
type Attendance = Record<string, { days: EffectiveDay[], punches: Receipt[] }>

const monthShort = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
const present = (days: EffectiveDay[]) => { const n = days.filter(d => d.in).length; return `${n} ${n === 1 ? 'day' : 'days'} present` }

function AttendanceLookup({ roster, attendance }: { roster: Employee[], attendance: Attendance | null }) {
  const [mode, setMode] = useState<Mode>('month')
  const [month, setMonth] = useState(() => istToday().slice(0, 7))
  const [day, setDay] = useState(istToday)
  const [selected, setSelected] = useState('')
  const employee = selected || roster[0]?.employeeId || ''
  const inMonth = (id: string) => (attendance?.[id]?.days ?? []).filter(d => d.date.startsWith(month))
  // Months that have any attendance, plus the current one, newest first.
  const months = [...new Set([istToday().slice(0, 7), ...Object.values(attendance ?? {}).flatMap(a => a.days.map(d => d.date.slice(0, 7)))])].sort().reverse()
  const total = (days: EffectiveDay[]) => duration(days.reduce((sum, d) => sum + worked(d), 0))

  return <>
    <div className="segmented" role="tablist" aria-label="Lookup by">
      {(['month', 'employee', 'day'] as const).map(m => <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'on' : undefined} onClick={() => setMode(m)}>
        {m === 'month' ? 'Month' : m === 'employee' ? 'Employee' : 'Day'}</button>)}
    </div>
    <div className="lookup-controls">
      {mode === 'employee' && <label>Employee<select value={employee} onChange={e => setSelected(e.target.value)}>{roster.map(e => <option key={e.employeeId} value={e.employeeId}>{e.displayName}</option>)}</select></label>}
      {mode !== 'day' ? <label>Month<select value={month} onChange={e => setMonth(e.target.value)}>
        {months.map(m => <option key={m} value={m}>{monthShort.format(new Date(m + '-15T12:00:00+05:30'))}</option>)}
      </select></label>
        : <label>Day<input type="date" value={day} onChange={e => setDay(e.target.value)} /></label>}
    </div>
    {attendance === null ? <p className="muted">Loading…</p> : roster.length === 0 ? <p className="muted">No employees yet.</p>
      : mode === 'month' ? <ul className="recent">{roster.map(e => {
        const days = inMonth(e.employeeId)
        return <li key={e.employeeId} className="tappable"><button type="button" onClick={() => { setSelected(e.employeeId); setMode('employee') }}>
          <span className="day">{e.displayName}</span>
          <span className="range">{present(days)}</span>
          <span className="hours">{total(days)}</span>
        </button></li>
      })}</ul>
      : mode === 'employee' ? (() => {
        const days = inMonth(employee)
        return days.length ? <>
          <p className="muted small">{present(days)} · {total(days)} worked</p>
          <div className="day-rows">{days.map(d => <DayRow key={d.date} slim day={d} punches={attendance[employee]?.punches ?? []} />)}</div>
        </> : <p className="muted">No attendance this month.</p>
      })()
      : <div className="day-rows">{roster.map(e => {
        const d = attendance[e.employeeId]?.days.find(x => x.date === day)
        return d ? <DayRow key={e.employeeId} slim day={d} punches={attendance[e.employeeId]!.punches} name={e.displayName} />
          : <div key={e.employeeId} className="day-row slim absent-row">
            <span className="slim-label">{e.displayName}</span>
            <span className="slim-times muted">No punch</span>
            <b className="slim-hours absent">Absent</b>
          </div>
      })}</div>}
  </>
}

export default function AdminPage() {
  const { token, operator, requireMfa } = useAuth()
  const [signups, setSignups] = useState<Signup[]>([])
  const [queue, setQueue] = useState<Queue | null>(null)
  const [roster, setRoster] = useState<Employee[]>([])
  const [attendance, setAttendance] = useState<Attendance | null>(null)
  const [resetEmployee, setResetEmployee] = useState('')
  const [resetReason, setResetReason] = useState('')
  const [resetConfirmation, setResetConfirmation] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [reload, setReload] = useState(0)

  function fail(error: unknown, fallback: string) {
    if (error instanceof ApiError && error.code === 'mfa_required') requireMfa()
    else setMessage(error instanceof ApiError && error.code === 'access_denied' ? 'This needs an HR or admin account.' : fallback)
  }
  useEffect(() => {
    if (!operator) return
    const controller = new AbortController()
    const signal = controller.signal
    Promise.all([
      api<{ signups: Signup[] }>('/api/hr/signups', token, { signal }),
      api<Queue>('/api/hr/face-enrollment/queue', token, { signal }),
      api<{ employees: Employee[] }>('/api/employees', token, { signal }),
    ]).then(([s, q, e]) => {
      if (signal.aborted) return
      setSignups(s.signups); setQueue(q); setRoster(e.employees)
    }).catch(error => { if (!signal.aborted) fail(error, 'Could not load the admin queues.') })
    return () => controller.abort()
  }, [token, operator, reload])
  useEffect(() => {
    if (!roster.length) return
    const controller = new AbortController()
    // ponytail: one request per employee (roster is capped at 100); add a bulk endpoint if the team outgrows that.
    Promise.all(roster.map(e => api<{ days: EffectiveDay[], punches: Receipt[] }>('/api/employees/' + encodeURIComponent(e.employeeId) + '/punches', token, { signal: controller.signal })
      .then(data => [e.employeeId, { days: data.days, punches: data.punches }] as const)))
      .then(entries => { if (!controller.signal.aborted) setAttendance(Object.fromEntries(entries)) })
      .catch(error => { if (!controller.signal.aborted) fail(error, 'Could not load attendance.') })
    return () => controller.abort()
  }, [token, roster])

  async function act(path: string, done: (result: Record<string, unknown>) => string, body?: unknown) {
    if (busy) return
    setBusy(true)
    setMessage('')
    try {
      const result = await api<Record<string, unknown>>(path, token, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
      setMessage(done(result))
      setReload(n => n + 1)
    } catch (error) { fail(error, 'That action did not go through. Try again.') } finally { setBusy(false) }
  }
  function reviewReset(event: FormEvent) {
    event.preventDefault()
    if (resetEmployee && resetReason.trim()) setResetConfirmation(true)
  }
  async function confirmReset() {
    await act('/api/hr/employees/' + encodeURIComponent(resetEmployee) + '/face-registration/reset', () => 'Face registration reset. The employee can get a new code on their Home screen.',
      { requestId: crypto.randomUUID(), reason: resetReason.trim() })
    setResetConfirmation(false); setResetEmployee(''); setResetReason('')
  }
  if (!operator) return <section><h1>Admin</h1><p className="muted">This area is for HR and admin accounts.</p></section>
  const resetEmployeeName = roster.find(e => e.employeeId === resetEmployee)?.displayName
    ?? queue?.reregistrationRequests.find(r => r.employeeId === resetEmployee)?.displayName ?? resetEmployee
  const faceCount = (queue?.pendingApprovals.length ?? 0) + (queue?.reregistrationRequests.length ?? 0)

  return <section className="admin">
    <h1>Admin</h1>
    <p className="page-lead">Attendance, approvals and requests for your team.</p>
    {message && <p className="notice" role="status">{message}</p>}

    <div className="card">
      <h2>Attendance lookup</h2>
      <AttendanceLookup roster={roster} attendance={attendance} />
    </div>

    <div className="card">
      <h2>New accounts <span className="count">{signups.length}</span></h2>
      {signups.length ? <ul className="action-list">{signups.map(s => <li key={s.requestId}>
        <div><strong>{s.displayName}</strong><span className="muted">{s.email}</span></div>
        <button disabled={busy} onClick={() => void act('/api/hr/signups/' + encodeURIComponent(s.requestId) + '/approve', r => `${s.displayName} approved as ${String(r.employeeCode)}. They can register their face now.`)}>Approve</button>
      </li>)}</ul> : <p className="muted">No one is waiting.</p>}
    </div>

    <div className="admin-block">
      <h2>Leave requests</h2>
      <LeaveRequests mine={false} />
    </div>

    <div className="card">
      <h2>Face registration <span className="count">{faceCount}</span></h2>
      {queue && queue.pendingApprovals.length > 0 && <>
        <h3>Waiting for approval</h3>
        <ul className="action-list">{queue.pendingApprovals.map(p => <li key={p.employeeId}>
          <div><strong>{p.displayName}</strong><span className="muted">{p.employeeCode}</span></div>
          <button disabled={busy} onClick={() => void act('/api/hr/employees/' + encodeURIComponent(p.employeeId) + '/face-enrollment/approve', () => `${p.displayName} can now get an enrollment code.`)}>Approve</button>
        </li>)}</ul>
      </>}
      <h3>Re-registration requests</h3>
      {queue?.reregistrationRequests.length ? <ul className="action-list">{queue.reregistrationRequests.map(r => <li key={r.requestId}>
        <div><strong>{r.displayName} · {r.employeeCode}</strong><span className="muted">{r.reason}</span></div>
        <button className="secondary" onClick={() => { setResetEmployee(r.employeeId); setResetReason('Employee request: ' + r.reason); setResetConfirmation(false) }}>Prepare reset</button>
      </li>)}</ul> : <p className="muted">No open requests.</p>}
      <form className="wide-form" onSubmit={reviewReset}>
        <label htmlFor="reset-employee">Reset face for<select id="reset-employee" value={resetEmployee} onChange={e => { setResetEmployee(e.target.value); setResetConfirmation(false) }} required>
          <option value="">Choose an employee</option>
          {roster.map(e => <option key={e.employeeId} value={e.employeeId}>{e.displayName}</option>)}
          {resetEmployee && !roster.some(e => e.employeeId === resetEmployee) && <option value={resetEmployee}>{resetEmployeeName}</option>}
        </select></label>
        <label htmlFor="reset-reason">Reason (kept for audit)<textarea id="reset-reason" rows={2} required value={resetReason} onChange={e => { setResetReason(e.target.value); setResetConfirmation(false) }} /></label>
        <button type="submit" className="secondary" disabled={!resetEmployee || !resetReason.trim() || busy}>Review reset</button>
      </form>
      {resetConfirmation && <div className="reset-confirmation">
        <h3>Reset face registration for {resetEmployeeName}?</h3>
        <p>This will retire the employee’s face templates across all sites and invalidate pending enrollment codes and claims. Attendance, corrections, and leave history stay unchanged.</p>
        <div className="controls"><button onClick={() => void confirmReset()} disabled={busy}>{busy ? 'Resetting…' : 'Confirm reset'}</button><button className="secondary" onClick={() => setResetConfirmation(false)} disabled={busy}>Cancel</button></div>
      </div>}
    </div>
  </section>
}
