'use client'
// PURPOSE: The signed-in employee's full attendance: month summary, effective days (corrections applied) by month, and each day's original kiosk punches.
import { useEffect, useState } from 'react'
import { ApiError, Icon, api, useAuth } from '../AppShell'
import { duration } from '../Home'
import { DayRow, corrected, worked, type EffectiveDay, type Receipt } from './DayRow'

type Filter = 'all' | 'corrected' | 'incomplete'

const ist = (date: string) => new Date(date + 'T12:00:00+05:30')
const fmt = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-IN', { ...options, timeZone: 'Asia/Kolkata' })
const monthLong = fmt({ month: 'long', year: 'numeric' })
const monthShort = fmt({ month: 'short', year: 'numeric' })
const dayShort = fmt({ day: 'numeric', month: 'short' })
const filters: Record<Filter, (day: EffectiveDay) => boolean> = {
  all: () => true,
  corrected,
  incomplete: day => !day.in || !day.out,
}

export default function HistoryPage() {
  const { token, requireMfa } = useAuth()
  const [days, setDays] = useState<EffectiveDay[] | null>(null)
  const [punches, setPunches] = useState<Receipt[]>([])
  const [message, setMessage] = useState('')
  const [chosenMonth, setChosenMonth] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  useEffect(() => {
    const controller = new AbortController()
    api<{ employeeId: string }>('/api/me/face-enrollment', token, { signal: controller.signal })
      .then(me => api<{ punches: Receipt[], days: EffectiveDay[] }>('/api/employees/' + encodeURIComponent(me.employeeId) + '/punches', token, { signal: controller.signal }))
      .then(data => { if (!controller.signal.aborted) { setDays(data.days); setPunches(data.punches) } })
      .catch(error => {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && error.code === 'mfa_required') requireMfa()
        else setMessage('Could not load your history. Try again.')
      })
    return () => controller.abort()
  }, [token])

  // Days arrive newest first; group them by IST month, keeping that order.
  const months = new Map<string, EffectiveDay[]>()
  for (const day of days ?? []) months.set(day.date.slice(0, 7), [...(months.get(day.date.slice(0, 7)) ?? []), day])
  const month = chosenMonth || [...months.keys()][0] || ''
  const monthDays = months.get(month) ?? []

  return <section className="history">
    <h1>History</h1>
    <p className="page-lead">View your check-in, check-out and work records</p>
    {message && <p className="form-error" role="alert">{message}</p>}
    {days === null ? <p className="muted">Loading…</p> : days.length === 0 ? <p className="muted">No attendance yet.</p> : <>
      <div className="filters">
        <label className="picker"><Icon name="leave" size={20} /><span className="sr-only">Month</span>
          <select value={month} onChange={e => setChosenMonth(e.target.value)}>
            {[...months.keys()].map(key => <option key={key} value={key}>{monthShort.format(ist(key + '-15'))}</option>)}
          </select>
        </label>
        <label className="picker"><Icon name="filter" size={20} /><span className="sr-only">Show</span>
          <select value={filter} onChange={e => setFilter(e.target.value as Filter)}>
            <option value="all">All Records</option>
            <option value="corrected">Corrected</option>
            <option value="incomplete">Missing punch</option>
          </select>
        </label>
      </div>

      <div className="month-summary">
        <Icon name="leave" size={30} />
        <div><strong>{monthShort.format(ist(month + '-15'))}</strong><p>Till {dayShort.format(ist(monthDays[0]!.date))}</p></div>
        <div><p>Total Worked</p><strong>{duration(monthDays.reduce((sum, day) => sum + worked(day), 0))}</strong></div>
      </div>

      {[...months].map(([key, list]) => {
        const shown = list.filter(filters[filter])
        return <details key={key + month} className="month" open={key === month}>
          <summary>
            {key !== month && <Icon name="leave" size={20} />}
            <span><strong>{monthLong.format(ist(key + '-15'))}</strong> ({list.length} {list.length === 1 ? 'Record' : 'Records'})</span>
            <Icon name="down" size={20} />
          </summary>
          {shown.length === 0 ? <p className="muted empty">No matching records.</p> : shown.map(day => <DayRow key={day.date} day={day} punches={punches} />)}
        </details>
      })}
    </>}
  </section>
}
