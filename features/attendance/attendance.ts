// PURPOSE: Record ordered kiosk punches and their receipts in an injected PostgreSQL transaction.
import { createHash, randomUUID } from 'node:crypto';

export type PunchAction = 'IN' | 'OUT';

export interface PunchReceipt {
  punchId: string;
  employeeId: string;
  action: PunchAction;
  recordedAt: string;
}

export interface PunchOrigin {
  deviceId: string;
  requestId: string;
  action: PunchAction;
  challengeId: string;
  proofDigest: string;
}

export interface RecordPunchInput extends PunchOrigin {
  employeeId: string;
  siteId: string;
}

export interface AttendanceTransaction {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export class AttendanceConflictError extends Error {
  readonly code = 'ATTENDANCE_IDEMPOTENCY_CONFLICT';

  constructor() {
    super('Request ID was already used for a different punch');
    this.name = 'AttendanceConflictError';
  }
}

export class AttendanceActionOrderError extends Error {
  readonly code = 'ATTENDANCE_ACTION_ORDER';
  readonly expectedAction: PunchAction;
  /** When the employee's last punch was recorded, so the kiosk can say "you already checked in at …". */
  readonly lastRecordedAt: string | null;

  constructor(expectedAction: PunchAction, lastRecordedAt: string | null = null) {
    super(`Next punch must be ${expectedAction}`);
    this.name = 'AttendanceActionOrderError';
    this.expectedAction = expectedAction;
    this.lastRecordedAt = lastRecordedAt;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;

function requireUuid(value: string): void {
  if (!UUID.test(value)) throw new TypeError('Expected a UUID');
}

function validateOrigin(origin: PunchOrigin): void {
  requireUuid(origin.deviceId);
  requireUuid(origin.requestId);
  requireUuid(origin.challengeId);
  if (origin.action !== 'IN' && origin.action !== 'OUT') throw new TypeError('Expected IN or OUT');
  if (!DIGEST.test(origin.proofDigest)) throw new TypeError('Expected a lowercase SHA-256 digest');
}

function receiptFromRow(row: Record<string, unknown>): PunchReceipt {
  return {
    punchId: String(row.punch_id),
    employeeId: String(row.employee_id),
    action: row.action as PunchAction,
    recordedAt: new Date(row.recorded_at as string | number | Date).toISOString(),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Expected JSON evidence');
  return serialized;
}

/** Hash parsed JSON evidence before checking for an existing request. */
export function digestPunchEvidence(evidence: unknown): string {
  return createHash('sha256').update(canonicalJson(evidence)).digest('hex');
}

/** Call before challenge freshness or consumption in the shared transaction. */
export async function lockPunchRequest(client: AttendanceTransaction, requestId: string): Promise<void> {
  requireUuid(requestId);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('attendance:request:' || $1, 0))", [requestId]);
}

/** Returns the committed receipt only when device, request and proof match exactly. */
export async function findCommittedPunchRetry(
  client: AttendanceTransaction,
  origin: PunchOrigin,
): Promise<PunchReceipt | null> {
  validateOrigin(origin);
  await lockPunchRequest(client, origin.requestId);
  const result = await client.query(
    `SELECT punch_id, employee_id, action, recorded_at, device_id, challenge_id, proof_digest
       FROM attendance_punches WHERE request_id = $1`,
    [origin.requestId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (
    row.device_id !== origin.deviceId ||
    row.action !== origin.action ||
    row.challenge_id !== origin.challengeId ||
    row.proof_digest !== origin.proofDigest
  ) throw new AttendanceConflictError();
  return receiptFromRow(row);
}

/** The caller owns BEGIN/COMMIT and must perform eligibility and challenge checks in this transaction. */
export async function recordPunch(client: AttendanceTransaction, input: RecordPunchInput): Promise<PunchReceipt> {
  validateOrigin(input);
  requireUuid(input.employeeId);
  requireUuid(input.siteId);

  const existing = await findCommittedPunchRetry(client, input);
  if (existing) {
    const result = await client.query(
      'SELECT employee_id, site_id FROM attendance_punches WHERE request_id = $1',
      [input.requestId],
    );
    if (result.rows[0]?.employee_id !== input.employeeId || result.rows[0]?.site_id !== input.siteId) {
      throw new AttendanceConflictError();
    }
    return existing;
  }

  // Requests lock first; employees lock second. Distinct requests for one employee therefore serialize.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('attendance:employee:' || $1, 0))", [input.employeeId]);
  const latest = await client.query(
    `SELECT action, to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at
       FROM attendance_punches WHERE employee_id = $1 ORDER BY sequence DESC LIMIT 1`,
    [input.employeeId],
  );
  const lastAction = latest.rows[0]?.action;
  const expectedAction: PunchAction = lastAction === 'IN' ? 'OUT' : 'IN';
  if (input.action !== expectedAction) throw new AttendanceActionOrderError(expectedAction, latest.rows[0] ? String(latest.rows[0].recorded_at) : null);

  const inserted = await client.query(
    `INSERT INTO attendance_punches
       (punch_id, request_id, device_id, challenge_id, proof_digest, employee_id, site_id, action)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING punch_id, employee_id, action, recorded_at`,
    [randomUUID(), input.requestId, input.deviceId, input.challengeId, input.proofDigest,
      input.employeeId, input.siteId, input.action],
  );
  const receipt = receiptFromRow(inserted.rows[0]);
  await client.query(
    `INSERT INTO attendance_audit (punch_id, employee_id, device_id, site_id, action, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [receipt.punchId, input.employeeId, input.deviceId, input.siteId, input.action, receipt.recordedAt],
  );
  await client.query(
    `INSERT INTO attendance_outbox (punch_id, event_type, payload)
     VALUES ($1, 'attendance.punch.recorded', $2::jsonb)`,
    [receipt.punchId, JSON.stringify({ ...receipt, siteId: input.siteId, deviceId: input.deviceId })],
  );
  return receipt;
}

export async function getPunchReceipt(
  client: AttendanceTransaction,
  punchId: string,
): Promise<PunchReceipt | null> {
  requireUuid(punchId);
  const result = await client.query(
    'SELECT punch_id, employee_id, action, recorded_at FROM attendance_punches WHERE punch_id = $1',
    [punchId],
  );
  return result.rows[0] ? receiptFromRow(result.rows[0]) : null;
}

/** Newest first, with sequence as the ordering key even when server timestamps tie. */
export async function listPunchReceipts(
  client: AttendanceTransaction,
  employeeId: string,
  options: { limit?: number } = {},
): Promise<PunchReceipt[]> {
  requireUuid(employeeId);
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Limit must be 1 to 200');
  const result = await client.query(
    `SELECT punch_id, employee_id, action, recorded_at FROM attendance_punches
     WHERE employee_id = $1 ORDER BY sequence DESC LIMIT $2`,
    [employeeId, limit],
  );
  return result.rows.map(receiptFromRow);
}
