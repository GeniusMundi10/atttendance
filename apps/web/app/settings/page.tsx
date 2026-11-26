'use client'
// PURPOSE: Account details, biometric issues (ask HR to reset the registered face), and sign out.
import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, api, useAuth } from '../AppShell'

type Status = { displayName: string, registered: boolean, approvalPending: boolean, reregistrationRequested: boolean, employeeCode: string | null }
const labels: Record<string, string> = {
  FACE_NOT_REGISTERED: 'Your face is not registered yet, so there is nothing to reset.',
  INVALID_REREGISTRATION_REASON: 'Describe the problem in up to 1000 characters.',
}

export default function SettingsPage() {
  const { token, email, signOut, requireMfa } = useAuth()
  const [status, setStatus] = useState<Status>()
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    api<Status>('/api/me/face-enrollment', token, { signal: controller.signal })
      .then(next => { if (!controller.signal.aborted) setStatus(next) })
      .catch(error => {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && error.code === 'mfa_required') requireMfa()
        else setMessage('Settings are temporarily unavailable. Try again.')
      })
    return () => controller.abort()
  }, [token, reload])
  async function requestReregistration(event: FormEvent) {
    event.preventDefault()
    if (busy || !reason.trim()) return
    setBusy(true)
    try {
      await api('/api/me/face-enrollment/reregistration', token, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID(), reason: reason.trim() }) })
      setReason(''); setMessage('Request sent. Once HR resets your face, get a new code on the Home screen.'); setReload(n => n + 1)
    } catch (error) { setMessage(error instanceof ApiError && labels[error.code] ? labels[error.code]! : 'Could not send the request. Try again.') } finally { setBusy(false) }
  }
  return <section>
    <h1>Settings</h1>
    <div className="card account">
      <div><span className="muted">Name</span><strong>{status?.displayName ?? '…'}</strong></div>
      <div><span className="muted">Employee ID</span><strong className="employee-code">{status?.employeeCode ?? '…'}</strong></div>
      <div><span className="muted">Email</span><strong>{email}</strong></div>
    </div>

    <div className="card">
      <h2>Biometric issues</h2>
      <p className="muted">Kiosk not recognising you (new glasses, beard, injury, or a wrong registration)? Ask HR to reset your face so you can register again.</p>
      {!status ? <p className="muted">Loading…</p>
        : status.reregistrationRequested ? <p className="notice" role="status">Re-registration requested. HR will reset your face, then get a new code on the Home screen.</p>
        : !status.registered ? <p className="muted">{status.approvalPending ? 'Your face registration is waiting for admin approval.' : 'Your face is not registered yet. Start from the Home screen.'}</p>
        : <form className="wide-form" onSubmit={requestReregistration}>
            <label>What is going wrong?<textarea rows={3} maxLength={1000} required value={reason} onChange={e => setReason(e.target.value)} /></label>
            <button disabled={busy || !reason.trim()}>{busy ? 'Sending…' : 'Request face re-registration'}</button>
          </form>}
      {message && <p className="notice" role="status">{message}</p>}
    </div>

    <button className="secondary full" onClick={signOut}>Sign out</button>
  </section>
}
