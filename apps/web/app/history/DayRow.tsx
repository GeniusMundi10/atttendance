'use client'
// PURPOSE: One attendance day as an expandable row (check-in, check-out, worked, original kiosk punches); shared by History and Admin.
import { Icon } from '../AppShell'
import { clock, duration } from '../Home'

export type EffectiveTime = { recordedAt: string, source: 'PUNCH' | 'APPROVED_CORRECTION' }
export type EffectiveDay = { date: string, in: EffectiveTime | null, out: EffectiveTime | null }
export type Receipt = { punchId: string, action: 'IN' | 'OUT', recordedAt: string }

const ist = (date: string) => new Date(date + 'T12:00:00+05:30')
const fmt = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-IN', { ...options, timeZone: 'Asia/Kolkata' })
const weekday = fmt({ weekday: 'short' }), dayNum = fmt({ day: 'numeric' }), monthOnly = fmt({ month: 'short' })
export const istDate = (value: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(value))
export const worked = (day: EffectiveDay) => day.in && day.out ? Date.parse(day.out.recordedAt) - Date.parse(day.in.recordedAt) : 0
export const corrected = (day: EffectiveDay) => day.in?.source === 'APPROVED_CORRECTION' || day.out?.source === 'APPROVED_CORRECTION'
const time = (value: EffectiveTime | null) => value ? clock.format(new Date(value.recordedAt)) : '—'

/**
 * `name` swaps the date tile for the employee (Admin's one-day view). `punches` may span many days; only this day's are shown.
 * `slim` puts the day on one line (Admin lists); labels stay for screen readers.
 */
export function DayRow({ day, punches, name, slim = false }: { day: EffectiveDay, punches: Receipt[], name?: string, slim?: boolean }) {
  const dayPunches = punches.filter(p => istDate(p.recordedAt) === day.date).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
  const hours = day.in && day.out ? duration(worked(day)) : '—'
  return <details className={'day-row' + (slim ? ' slim' : '')}>
    {slim ? <summary>
      {name ? <span className="slim-label">{name}</span>
        : <span className="slim-label"><b>{dayNum.format(ist(day.date))}</b>{weekday.format(ist(day.date))}</span>}
      <span className="slim-times">
        <i className="punch-icon in"><Icon name="checkin" size={13} /></i><span className="sr-only">Check-in</span>{time(day.in)}
        <i className="punch-icon out"><Icon name="logout" size={13} /></i><span className="sr-only">Check-out</span>{time(day.out)}
      </span>
      <b className={'slim-hours' + (corrected(day) ? ' corrected' : '')} title={corrected(day) ? 'Corrected' : undefined}>{hours}</b>
    </summary> : <summary>
      {name ? <span className="date-tile name-tile"><strong>{name[0]!.toUpperCase()}</strong><span>{name.split(' ')[0]}</span></span>
        : <span className="date-tile"><span>{weekday.format(ist(day.date))}</span><strong>{dayNum.format(ist(day.date))}</strong><span>{monthOnly.format(ist(day.date))}</span></span>}
      <span className="times">
        <span><i className="punch-icon in"><Icon name="checkin" size={16} /></i><span><b>Check-in</b>{time(day.in)}</span></span>
        <span><i className="punch-icon out"><Icon name="logout" size={16} /></i><span><b>Check-out</b>{time(day.out)}</span></span>
      </span>
      <span className="worked"><span>{corrected(day) ? 'Corrected' : 'Worked'}</span><b>{hours}</b></span>
      <Icon name="down" size={18} />
    </summary>}
    <div className="kiosk-punches">
      <p><Icon name="kiosk" size={18} />Original kiosk punches ({dayPunches.length})</p>
      {dayPunches.length === 0 ? <p className="muted">No kiosk punches this day.</p> : <ul>{dayPunches.map(p => <li key={p.punchId}>
        <i className={'punch-icon ' + (p.action === 'IN' ? 'in' : 'out')}><Icon name={p.action === 'IN' ? 'checkin' : 'logout'} size={14} /></i>
        <span><b>{p.action === 'IN' ? 'Check-in' : 'Check-out'}</b> · Kiosk</span>
        <span>{clock.format(new Date(p.recordedAt))}</span>
      </li>)}</ul>}
    </div>
  </details>
}
