// PURPOSE: Reserve correction dates, authorize per-date decisions, and derive effective attendance without rewriting punches.
import { randomUUID } from 'node:crypto';
import { resolveAuthenticatedSubject, type Actor, type QueryClient } from '../access/access.ts';

export class CorrectionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = 'CorrectionError';
    this.status = status;
    this.code = code;
  }
}

export type CorrectionDecision = 'APPROVE' | 'REJECT';
export type CorrectionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type CorrectionDay = {
  dayId: string; requestId: string; employeeId: string; date: string;
  proposedIn: string | null; proposedOut: string | null;
  reason: string; status: CorrectionStatus; revision: number;
  overrideReason: string | null; decidedBy: string | null; decidedAt: string | null;
};
export type EffectiveTime = { recordedAt: string; source: 'PUNCH'; punchId: string } |
  { recordedAt: string; source: 'APPROVED_CORRECTION'; correctionDayId: string };
export type EffectiveDay = { date: string; in: EffectiveTime | null; out: EffectiveTime | null };

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const dateParts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });

function istDate(value: Date): string {
  const parts = Object.fromEntries(dateParts.formatToParts(value).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function instant(value: unknown, date: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !ISO.test(value)) throw new CorrectionError(400, 'invalid_proposed_time');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || istDate(parsed) !== date) throw new CorrectionError(400, 'proposed_time_wrong_date');
  return parsed.toISOString();
}
function text(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 1000) {
    throw new CorrectionError(400, code);
  }
  return value.trim();
}
function fromRow(row: Record<string, unknown>): CorrectionDay {
  const iso = (value: unknown) => value == null ? null : new Date(value as string | Date).toISOString();
  return {
    dayId: String(row.day_id), requestId: String(row.request_id), employeeId: String(row.employee_id),
    date: String(row.work_date).slice(0, 10), proposedIn: iso(row.proposed_in_at), proposedOut: iso(row.proposed_out_at),
    reason: String(row.reason), status: row.status as CorrectionStatus, revision: Number(row.revision),
    overrideReason: row.decision_reason == null ? null : String(row.decision_reason),
    decidedBy: row.decided_by == null ? null : String(row.decided_by), decidedAt: iso(row.decided_at),
  };
}
const daySelect = `SELECT d.day_id,d.request_id,d.employee_id,d.work_date::text AS work_date,d.proposed_in_at,d.proposed_out_at,
  d.status,d.revision,d.decision_reason,d.decided_by,d.decided_at,r.reason
  FROM correction_days d JOIN correction_requests r ON r.request_id=d.request_id`;

async function checkedActor(client: QueryClient, actor: Actor): Promise<Actor> {
  const resolved = await resolveAuthenticatedSubject(client, actor);
  if (resolved.employeeId !== actor.employeeId) throw new CorrectionError(403, 'access_denied');
  return resolved;
}

export async function createCorrectionRequest(client: QueryClient, actor: Actor, raw: Record<string, unknown>): Promise<CorrectionDay[]> {
  const employee = await checkedActor(client, actor);
  const reason = text(raw.reason, 'invalid_reason');
  if (!Array.isArray(raw.days) || raw.days.length < 1 || raw.days.length > 31) throw new CorrectionError(400, 'invalid_dates');
  const days = raw.days.map((rawDay: unknown) => {
    if (!rawDay || typeof rawDay !== 'object' || Array.isArray(rawDay)) throw new CorrectionError(400, 'invalid_dates');
    const item = rawDay as Record<string, unknown>;
    if (!validDate(item.date)) throw new CorrectionError(400, 'invalid_dates');
    const proposedIn = instant(item.proposedIn, item.date);
    const proposedOut = instant(item.proposedOut, item.date);
    if (!proposedIn && !proposedOut) throw new CorrectionError(400, 'proposed_time_required');
    if (proposedIn && proposedOut && proposedIn >= proposedOut) throw new CorrectionError(400, 'invalid_proposed_order');
    return { date: item.date, proposedIn, proposedOut };
  });
  if (new Set(days.map(day => day.date)).size !== days.length) throw new CorrectionError(400, 'duplicate_dates');
  const months = [...new Set(days.map(day => `${day.date.slice(0, 7)}-01`))].sort();
  for (const month of months) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('correction:month:' || $1 || ':' || $2, 0))", [employee.employeeId, month]);
    const count = await client.query<{ count: number }>(
      `SELECT count(DISTINCT work_date)::int AS count FROM correction_days
       WHERE employee_id=$1 AND work_date >= $2::date AND work_date < ($2::date + interval '1 month')
         AND status IN ('PENDING','APPROVED')`, [employee.employeeId, month]);
    if (count.rows[0]!.count + days.filter(day => day.date.startsWith(month.slice(0, 7))).length > 3) {
      throw new CorrectionError(409, 'monthly_correction_limit');
    }
  }
  const occupied = await client.query(
    `SELECT work_date FROM correction_days WHERE employee_id=$1 AND work_date=ANY($2::date[])
      AND status IN ('PENDING','APPROVED')`, [employee.employeeId, days.map(day => day.date)]);
  if (occupied.rows.length) throw new CorrectionError(409, 'correction_date_unavailable');

  const requestId = randomUUID();
  await client.query('INSERT INTO correction_requests(request_id,employee_id,reason) VALUES($1,$2,$3)',
    [requestId, employee.employeeId, reason]);
  const created: CorrectionDay[] = [];
  for (const day of days) {
    const dayId = randomUUID();
    const result = await client.query(
      `INSERT INTO correction_days(day_id,request_id,employee_id,work_date,proposed_in_at,proposed_out_at)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING day_id`,
      [dayId, requestId, employee.employeeId, day.date, day.proposedIn, day.proposedOut]);
    if (result.rows.length !== 1) throw new Error('Correction insert failed');
    created.push({ dayId, requestId, employeeId: employee.employeeId, date: day.date,
      proposedIn: day.proposedIn, proposedOut: day.proposedOut, reason, status: 'PENDING', revision: 1,
      overrideReason: null, decidedBy: null, decidedAt: null });
  }
  return created;
}

export async function listCorrectionDays(client: QueryClient, actor: Actor, scope: 'mine' | 'review'): Promise<CorrectionDay[]> {
  const viewer = await checkedActor(client, actor);
  if (scope !== 'mine' && scope !== 'review') throw new CorrectionError(400, 'invalid_scope');
  const condition = scope === 'mine' ? 'd.employee_id=$1' : `d.status='PENDING' AND d.employee_id<>$1 AND (
    EXISTS(SELECT 1 FROM access_operator_roles o WHERE o.employee_id=$1 AND o.active AND o.role IN ('HR','ADMIN'))
    OR EXISTS(SELECT 1 FROM access_manager_reports m WHERE m.manager_id=$1 AND m.report_id=d.employee_id AND m.active))`;
  const result = await client.query(`${daySelect} WHERE ${condition} ORDER BY d.work_date DESC,d.day_id LIMIT 100`, [viewer.employeeId]);
  return result.rows.map(fromRow);
}

export async function decideCorrectionDay(client: QueryClient, actor: Actor, dayId: string, raw: Record<string, unknown>): Promise<CorrectionDay> {
  const reviewer = await checkedActor(client, actor);
  if (!UUID.test(dayId)) throw new CorrectionError(400, 'invalid_day_id');
  const decision = raw.decision;
  if (decision !== 'APPROVE' && decision !== 'REJECT') throw new CorrectionError(400, 'invalid_decision');
  const expectedRevision = raw.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1) throw new CorrectionError(400, 'invalid_revision');
  const overrideReason = text(raw.overrideReason, 'override_reason_required');
  const initial = await client.query('SELECT employee_id,work_date::text AS work_date FROM correction_days WHERE day_id=$1', [dayId]);
  if (!initial.rows[0]) throw new CorrectionError(404, 'correction_day_not_found');
  const owner = String(initial.rows[0].employee_id);
  const date = String(initial.rows[0].work_date).slice(0, 10);
  if (reviewer.employeeId === owner) throw new CorrectionError(403, 'self_approval_denied');
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('correction:month:' || $1 || ':' || $2, 0))",
    [owner, `${date.slice(0, 7)}-01`]);
  const authorized = await client.query<{ allowed: boolean }>(`SELECT (
    EXISTS(SELECT 1 FROM access_operator_roles o WHERE o.employee_id=$1 AND o.active AND o.role IN ('HR','ADMIN'))
    OR EXISTS(SELECT 1 FROM access_manager_reports m WHERE m.manager_id=$1 AND m.report_id=$2 AND m.active)) AS allowed`,
  [reviewer.employeeId, owner]);
  if (!authorized.rows[0]?.allowed) throw new CorrectionError(403, 'access_denied');
  const current = await client.query('SELECT revision,status FROM correction_days WHERE day_id=$1 FOR UPDATE', [dayId]);
  if (current.rows[0]?.status !== 'PENDING' || current.rows[0]?.revision !== expectedRevision) {
    throw new CorrectionError(409, 'stale_correction_revision');
  }
  await client.query(
    `UPDATE correction_days SET status=$2,revision=revision+1,decided_by=$3,decision_reason=$4,decided_at=clock_timestamp()
      WHERE day_id=$1`, [dayId, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', reviewer.employeeId, overrideReason]);
  const updated = await client.query(`${daySelect} WHERE d.day_id=$1`, [dayId]);
  return fromRow(updated.rows[0]!);
}

export async function listEffectiveDays(client: QueryClient, employeeId: string): Promise<EffectiveDay[]> {
  if (!UUID.test(employeeId)) throw new CorrectionError(400, 'invalid_employee_id');
  const punches = await client.query(
    `SELECT punch_id,action,recorded_at,(recorded_at AT TIME ZONE 'Asia/Kolkata')::date::text AS work_date
      FROM attendance_punches WHERE employee_id=$1 ORDER BY sequence DESC LIMIT 500`, [employeeId]);
  const approved = await client.query(
    `SELECT day_id,work_date::text AS work_date,proposed_in_at,proposed_out_at FROM correction_days
      WHERE employee_id=$1 AND status='APPROVED' ORDER BY work_date DESC LIMIT 100`, [employeeId]);
  const days = new Map<string, EffectiveDay>();
  const entry = (date: string) => {
    let day = days.get(date);
    if (!day) { day = { date, in: null, out: null }; days.set(date, day); }
    return day;
  };
  for (const row of punches.rows) {
    const date = String(row.work_date).slice(0, 10);
    const target = entry(date);
    const time: EffectiveTime = { recordedAt: new Date(row.recorded_at as string | Date).toISOString(),
      source: 'PUNCH', punchId: String(row.punch_id) };
    if (row.action === 'IN' && (!target.in || time.recordedAt < target.in.recordedAt)) target.in = time;
    if (row.action === 'OUT' && (!target.out || time.recordedAt > target.out.recordedAt)) target.out = time;
  }
  for (const row of approved.rows) {
    const target = entry(String(row.work_date).slice(0, 10));
    if (row.proposed_in_at) target.in = { recordedAt: new Date(row.proposed_in_at as string | Date).toISOString(),
      source: 'APPROVED_CORRECTION', correctionDayId: String(row.day_id) };
    if (row.proposed_out_at) target.out = { recordedAt: new Date(row.proposed_out_at as string | Date).toISOString(),
      source: 'APPROVED_CORRECTION', correctionDayId: String(row.day_id) };
  }
  return [...days.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 50);
}
