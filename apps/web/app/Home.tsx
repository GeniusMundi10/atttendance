'use client'
// PURPOSE: Employee home: today's punch status, the step-by-step face registration flow, and the last few days.
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ApiError, Icon, api, useAuth } from './AppShell'
import { DutyStreams } from './DutyStreams'
import { DayRow } from './history/DayRow'

type Receipt = { punchId: string, action: 'IN' | 'OUT', recordedAt: string }
type EffectiveTime = { recordedAt: string, source: 'PUNCH' | 'APPROVED_CORRECTION' }
type EffectiveDay = { date: string, in: EffectiveTime | null, out: EffectiveTime | null }
type FaceEnrollmentStatus = {
  employeeId: string
  displayName: string
  employeeCode: string | null
  registered: boolean
  approvalPending: boolean
  registrationAvailable: boolean
  reregistrationRequested: boolean
  eligibleSites: { siteId: string, siteName: string }[]
  activeCodeRequest: { requestId: string, siteId: string, state: string, expiresAt: string } | null
  notice: { version: string, text: string } | null
}
type IssuedCode = { state: 'issued', requestId: string, siteId: string, code: string | null, expiresAt: string, recovered: boolean }
type LocalEnrollmentCode = { code: string, expiresAt: string, requestId: string }

export const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })
export const dayLabel = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })
const istDate = (value: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(value)
export function duration(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60000))
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}
function countdown(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}
function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(new Date()))
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
}
const codeErrors: Record<string, string> = {
  FACE_ALREADY_REGISTERED: 'Your face is already registered.',
  ACTIVE_ENROLLMENT_SESSION_EXISTS: 'A kiosk is capturing your face with your current code. Finish there, or wait 5 minutes and regenerate.',
  FACE_ENROLLMENT_APPROVAL_PENDING: 'Your face registration is waiting for admin approval.',
  KIOSK_ENROLLMENT_RATE_LIMIT: 'Too many codes this hour. Try again later.',
}

/** Small analog clock showing the device's local time; ticks once a second, aligned to the real second boundary. */
function AnalogClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const tick = () => { setNow(new Date()); timer = setTimeout(tick, 1000 - (Date.now() % 1000)) }
    timer = setTimeout(tick, 1000 - (Date.now() % 1000))
    return () => clearTimeout(timer)
  }, [])
  const s = now.getSeconds(), m = now.getMinutes() + s / 60, h = (now.getHours() % 12) + m / 60
  const hand = (deg: number, length: number, className: string) =>
    <line className={className} x1="20" y1="20" x2="20" y2={20 - length} transform={`rotate(${deg} 20 20)`} />
  return <svg className="analog" viewBox="0 0 40 40" width="44" height="44" aria-hidden="true">
    <circle className="face" cx="20" cy="20" r="18.5" />
    {Array.from({ length: 12 }, (_, i) => <line key={i} className={'tick' + (i % 3 === 0 ? ' major' : '')} x1="20" y1="3.5" x2="20" y2={i % 3 === 0 ? 7 : 5.5} transform={`rotate(${i * 30} 20 20)`} />)}
    {hand(h * 30, 9, 'hand hour')}
    {hand(m * 6, 13, 'hand minute')}
    {hand(s * 6, 14.5, 'hand second')}
    <circle className="pin" cx="20" cy="20" r="1.6" />
  </svg>
}

export function Home() {
  const { token, requireMfa } = useAuth()
  const [faceStatus, setFaceStatus] = useState<FaceEnrollmentStatus | null>(null)
  const [punches, setPunches] = useState<Receipt[] | null>(null)
  const [days, setDays] = useState<EffectiveDay[]>([])
  const [message, setMessage] = useState('')
  const [enrollmentCode, setEnrollmentCode] = useState<LocalEnrollmentCode | null>(null)
  const [codeBusy, setCodeBusy] = useState(false)
  const [codeExpired, setCodeExpired] = useState(false)
  const [codeMessage, setCodeMessage] = useState('')
  const [faceReload, setFaceReload] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const tokenRef = useRef(token)
  tokenRef.current = token

  useEffect(() => {
    // A new session never inherits another session's code.
    setEnrollmentCode(null)
    setFaceStatus(null)
  }, [token])
  useEffect(() => {
    const controller = new AbortController()
    api<FaceEnrollmentStatus>('/api/me/face-enrollment', token, { signal: controller.signal })
      .then(status => { if (!controller.signal.aborted) { setFaceStatus(status); setMessage('') } })
      .catch(error => {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && error.code === 'mfa_required') requireMfa()
        else setMessage('Could not load your account. Pull to refresh.')
      })
    return () => controller.abort()
  }, [token, faceReload])

  const employeeId = faceStatus?.employeeId
  useEffect(() => {
    if (!employeeId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const data = await api<{ punches: Receipt[], days: EffectiveDay[] }>('/api/employees/' + encodeURIComponent(employeeId!) + '/punches', token, { signal: controller.signal })
        if (!controller.signal.aborted) { setPunches(data.punches); setDays(data.days) }
      } catch { /* keep the last good state; the next poll retries */ }
      finally { if (!controller.signal.aborted) timer = setTimeout(refresh, 5000) }
    }
    void refresh()
    const tick = setInterval(() => setNow(Date.now()), 30000)
    return () => { controller.abort(); clearTimeout(timer); clearInterval(tick) }
  }, [token, employeeId])

  const visibleCode = enrollmentCode
  useEffect(() => {
    if (!visibleCode) return
    const requestId = visibleCode.requestId
    const expire = () => {
      setEnrollmentCode(current => current?.requestId === requestId ? null : current)
      setCodeExpired(true)
      setCodeMessage('Your code expired before your face was captured. Get a new one to try again.')
      setFaceReload(n => n + 1)
    }
    const remaining = Date.parse(visibleCode.expiresAt) - Date.now()
    if (!Number.isFinite(remaining) || remaining <= 0) { expire(); return }
    const timer = setTimeout(expire, remaining)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => { clearTimeout(timer); clearInterval(tick) }
  }, [visibleCode])
  // Poll while waiting on someone else: admin approval, or the kiosk saving the face (then the code disappears).
  const waiting = Boolean(visibleCode || faceStatus?.approvalPending)
  useEffect(() => {
    if (!waiting) return
    const poll = setInterval(() => setFaceReload(n => n + 1), 5000)
    return () => clearInterval(poll)
  }, [waiting])
  useEffect(() => { if (faceStatus?.registered) setEnrollmentCode(null) }, [faceStatus?.registered])

  const sites = faceStatus?.eligibleSites ?? []
  const [chosenSite, setChosenSite] = useState('')
  const siteId = sites.length === 1 ? sites[0]!.siteId : chosenSite
  const serverActiveCode = faceStatus?.activeCodeRequest && Date.parse(faceStatus.activeCodeRequest.expiresAt) > now ? faceStatus.activeCodeRequest : null

  async function requestCode() {
    if (!faceStatus || faceStatus.registered || !faceStatus.registrationAvailable || !siteId || codeBusy) return
    const requestToken = token
    const reissue = Boolean(visibleCode || serverActiveCode)
    setEnrollmentCode(null)
    setCodeExpired(false)
    setCodeMessage('')
    setCodeBusy(true)
    try {
      const response = await api<IssuedCode>('/api/me/face-enrollment/codes', requestToken, { method: 'POST', body: JSON.stringify({ siteId, requestId: crypto.randomUUID(), reissue }) })
      if (tokenRef.current !== requestToken) return
      if (response.code && /^\d{6}$/.test(response.code)) setEnrollmentCode({ code: response.code, expiresAt: response.expiresAt, requestId: response.requestId })
      else setCodeMessage('A code is already active but can’t be shown again here. Tap “New code”.')
      setFaceReload(n => n + 1)
    } catch (error) {
      if (tokenRef.current !== requestToken) return
      if (error instanceof ApiError && error.code === 'mfa_required') requireMfa()
      else setCodeMessage(error instanceof ApiError && codeErrors[error.code] ? codeErrors[error.code]! : 'Could not get a code. Try again.')
    } finally { if (tokenRef.current === requestToken) setCodeBusy(false) }
  }

  const today = istDate(new Date(now))
  const todays = (punches ?? []).filter(p => istDate(new Date(p.recordedAt)) === today).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
  const firstIn = todays.find(p => p.action === 'IN')
  const last = todays.at(-1)
  const onDuty = last?.action === 'IN'
  const firstName = faceStatus?.displayName.split(' ')[0] ?? ''

  return <section className="home">
    <header className="hello">
      <div>
        <p className="eyebrow">{greeting()}</p>
        <h1>{firstName || 'Welcome'}</h1>
        {faceStatus?.employeeCode && <p className="id-chip">Employee ID <strong>{faceStatus.employeeCode}</strong></p>}
      </div>
      {firstName && <span className="avatar" aria-hidden="true">{firstName[0]!.toUpperCase()}</span>}
    </header>
    {message && <p className="form-error" role="alert">{message}</p>}

    <div className={'card today-card' + (onDuty ? ' on' : '')} aria-live="polite">
      {onDuty && <><DutyStreams /><span className="duty-shade" aria-hidden="true" /></>}
      <span className="icon-tile clock-tile"><AnalogClock /></span>
      <div>
        <p className="today-label"><span>Today · {dayLabel.format(new Date(now))}</span></p>
        {punches === null ? <strong>Loading…</strong>
          : !last ? <><strong>Not checked in yet</strong><p>Look at the kiosk camera to check in.</p></>
          : onDuty ? <><strong className="duty-title">On Duty<span className="sr-only">, checked in at {clock.format(new Date(last.recordedAt))}</span></strong><p>Worked {duration(now - Date.parse((firstIn ?? last).recordedAt))} today</p></>
          : <><strong><span className="check" aria-hidden="true" />Checked out at {clock.format(new Date(last.recordedAt))}</strong><p>Total worked today: {duration(Date.parse(last.recordedAt) - Date.parse((firstIn ?? last).recordedAt))}</p></>}
      </div>
    </div>

    {faceStatus && !faceStatus.registered && <div className="card setup">
      <div className="setup-head">
        <span className="icon-tile big"><Icon name="face" size={34} /></span>
        <div><h2>Set up Face Check-in</h2><p>Complete the steps below to enable quick and secure check-in/out at the kiosk.</p></div>
      </div>
      <ol className="steps">
        <li className="done"><span>1</span><div><strong>Account approved</strong></div></li>
        <li className={faceStatus.approvalPending ? 'current' : 'done'}><span>2</span><div>
          <strong>Face registration approved</strong>
          {faceStatus.approvalPending && <p>Waiting for an admin. This page updates when they approve.</p>}
        </div></li>
        {!visibleCode && <li className={faceStatus.approvalPending ? '' : 'current'}><span>3</span><div>
          <strong>Get a code and scan your face at the kiosk</strong>
          {!faceStatus.approvalPending && !faceStatus.registrationAvailable && <p>Registration isn’t available yet: {sites.length ? 'ask HR to check your setup.' : 'you are not assigned to a site.'}</p>}
          {faceStatus.registrationAvailable && <>
            {sites.length > 1 && <label>Kiosk site<select value={chosenSite} onChange={e => setChosenSite(e.target.value)}><option value="">Choose a site</option>{sites.map(site => <option key={site.siteId} value={site.siteId}>{site.siteName}</option>)}</select></label>}
            <p>Codes last 5 minutes, so get one when you are at the kiosk.</p>
          </>}
        </div></li>}
      </ol>
      {faceStatus.registrationAvailable && <div className="code-area">
        {visibleCode && <div className="issued-code" aria-live="polite" aria-atomic="true">
          <p className="otp-label">Your Check-in Code (OTP)</p>
          <span className="face-code-visual" aria-hidden="true">{Array.from(visibleCode.code).map((digit, i) => <span key={i}>{digit}</span>)}</span>
          <span className="sr-only">Your enrollment code, individual digits: {Array.from(visibleCode.code).join(', ')}. Type it on the kiosk.</span>
          <p className="expiry"><Icon name="clock" size={18} />Valid for <strong>{countdown(Date.parse(visibleCode.expiresAt) - now)}</strong></p>
        </div>}
        <button onClick={() => void requestCode()} disabled={codeBusy || !siteId}>
          <Icon name={visibleCode || serverActiveCode || codeExpired ? 'refresh' : 'code'} size={22} />{codeBusy ? 'Getting code…' : visibleCode || serverActiveCode || codeExpired ? 'New Code' : 'Get My Code'}
        </button>
      </div>}
      {codeMessage && <p className="form-error code-message" role="status">{codeMessage}</p>}
    </div>}
    {faceStatus?.registered && <div className="card face-card">
      <span className="face-icon"><Icon name="face" size={28} /></span>
      <div><strong>Face recognition enabled</strong><p>{faceStatus.reregistrationRequested ? 'Re-registration requested. HR will reset your face.' : 'Use the kiosk to check in or check out.'}</p></div>
      <Link href="/settings">Need help?</Link>
    </div>}

    <div className="quick">
      <Link href="/leave" className="quick-link"><Icon name="leave" size={24} /><span>Apply for leave</span><Icon name="chevron" size={18} /></Link>
      <Link href="/corrections" className="quick-link"><Icon name="fix" size={24} /><span>Attendance correction</span><Icon name="chevron" size={18} /></Link>
    </div>

    <div className="section-head"><h2>Recent attendance</h2>{days.length > 0 && <Link href="/history">View all<Icon name="chevron" size={16} /></Link>}</div>
    {days.length ? <div className="day-rows">{days.slice(0, 5).map(day => <DayRow key={day.date} day={day} punches={punches ?? []} />)}</div>
      : <p className="muted">{punches === null ? 'Loading…' : 'No attendance yet.'}</p>}
  </section>
}
