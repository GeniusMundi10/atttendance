// PURPOSE: Verify attendance transaction, retry, ordering and receipt behavior against PostgreSQL.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AttendanceActionOrderError,
  AttendanceConflictError,
  AttendanceOutTooSoonError,
  MIN_SECONDS_BEFORE_OUT,
  digestPunchEvidence,
  findCommittedPunchRetry,
  getPunchReceipt,
  listPunchReceipts,
  recordPunch,
  type AttendanceTransaction,
  type RecordPunchInput,
} from './attendance.ts';

const databaseUrl = process.env.ATTENDANCE_TEST_DATABASE_URL;

test('attendance records, retries and serializes punches in an isolated PostgreSQL schema', {
  skip: databaseUrl ? false : 'Set ATTENDANCE_TEST_DATABASE_URL to a dedicated test database',
}, async () => {
  assert.equal(digestPunchEvidence({ a: 1, b: [2, 3] }), digestPunchEvidence({ b: [2, 3], a: 1 }));
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl });
  const schema = `attendance_test_${randomUUID().replaceAll('-', '')}`;
  const migration = await readFile(new URL('./migrations/001_punches.sql', import.meta.url), 'utf8');

  async function withTransaction<T>(work: (client: AttendanceTransaction) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO ${schema}`);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  function input(employeeId: string, action: 'IN' | 'OUT' = 'IN'): RecordPunchInput {
    return {
      employeeId,
      siteId: randomUUID(),
      deviceId: randomUUID(),
      challengeId: randomUUID(),
      requestId: randomUUID(),
      action,
      proofDigest: digestPunchEvidence({ synthetic: randomUUID() }),
    };
  }

  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    const setup = await pool.connect();
    try {
      await setup.query(`SET search_path TO ${schema}`);
      await setup.query(migration);
    } finally {
      setup.release();
    }

    const employeeId = randomUUID();
    const first = input(employeeId);
    await assert.rejects(
      withTransaction(client => recordPunch(client, { ...first, action: 'OUT' })),
      error => error instanceof AttendanceActionOrderError && error.expectedAction === 'IN',
    );

    const receipt = await withTransaction(client => recordPunch(client, first));
    assert.equal(receipt.employeeId, employeeId);
    assert.equal(receipt.action, 'IN');
    assert.equal(new Date(receipt.recordedAt).toISOString(), receipt.recordedAt);

    const replay = await withTransaction(client => findCommittedPunchRetry(client, first));
    assert.deepEqual(replay, receipt);
    const replayViaRecord = await withTransaction(client => recordPunch(client, first));
    assert.deepEqual(replayViaRecord, receipt);
    await assert.rejects(
      withTransaction(client => findCommittedPunchRetry(client, { ...first, deviceId: randomUUID() })),
      AttendanceConflictError,
    );
    await assert.rejects(
      withTransaction(client => findCommittedPunchRetry(client, { ...first, proofDigest: digestPunchEvidence({ synthetic: 'changed' }) })),
      AttendanceConflictError,
    );
    await assert.rejects(
      withTransaction(client => findCommittedPunchRetry(client, { ...first, action: 'OUT' })),
      AttendanceConflictError,
    );

    // False check-out guard: an OUT within MIN_SECONDS_BEFORE_OUT of the IN is refused.
    await assert.rejects(
      withTransaction(client => recordPunch(client, input(employeeId, 'OUT'))),
      error => error instanceof AttendanceOutTooSoonError && error.lastRecordedAt === receipt.recordedAt
        && error.retryAfterSeconds > 0 && error.retryAfterSeconds <= MIN_SECONDS_BEFORE_OUT,
    );
    // Simulate time passing by moving the check-in back past the guard.
    await withTransaction(client => client.query(
      `UPDATE attendance_punches SET recorded_at = recorded_at - make_interval(secs => $2) WHERE punch_id = $1`,
      [receipt.punchId, MIN_SECONDS_BEFORE_OUT + 60]));
    const inReceipt = await withTransaction(client => getPunchReceipt(client, receipt.punchId));
    assert.ok(inReceipt);

    const second = input(employeeId, 'OUT');
    const secondReceipt = await withTransaction(client => recordPunch(client, second));
    await withTransaction(async client => {
      assert.deepEqual(await getPunchReceipt(client, receipt.punchId), inReceipt);
      assert.deepEqual(await listPunchReceipts(client, employeeId), [secondReceipt, inReceipt]);
      assert.deepEqual(await listPunchReceipts(client, employeeId, { limit: 1 }), [secondReceipt]);
      const counts = await client.query(
        `SELECT (SELECT count(*)::int FROM attendance_punches) AS punches,
                (SELECT count(*)::int FROM attendance_audit) AS audits,
                (SELECT count(*)::int FROM attendance_outbox) AS events`,
      );
      assert.deepEqual(counts.rows[0], { punches: 2, audits: 2, events: 2 });
      const outbox = await client.query('SELECT payload FROM attendance_outbox WHERE punch_id = $1', [receipt.punchId]);
      assert.equal((outbox.rows[0]?.payload as { recordedAt: string }).recordedAt, receipt.recordedAt);
    });

    const raceEmployee = randomUUID();
    const left = input(raceEmployee);
    const right = input(raceEmployee);
    const outcomes = await Promise.allSettled([
      withTransaction(client => recordPunch(client, left)),
      withTransaction(client => recordPunch(client, right)),
    ]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = outcomes.find(result => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.ok(rejected.reason instanceof AttendanceActionOrderError);

    const retryEmployee = randomUUID();
    const concurrent = input(retryEmployee);
    let releaseFirst!: () => void;
    let signalWritten!: () => void;
    const held = new Promise<void>(resolve => { releaseFirst = resolve; });
    const written = new Promise<void>(resolve => { signalWritten = resolve; });
    const firstRequest = withTransaction(async client => {
      const result = await recordPunch(client, concurrent);
      signalWritten();
      await held;
      return result;
    });
    await written;
    const secondRequest = withTransaction(client => findCommittedPunchRetry(client, concurrent));
    releaseFirst();
    const sameRequest = await Promise.all([
      firstRequest,
      secondRequest,
    ]);
    assert.deepEqual(sameRequest[0], sameRequest[1]);
    await withTransaction(async client => {
      const result = await client.query('SELECT count(*)::int AS count FROM attendance_punches WHERE request_id = $1', [concurrent.requestId]);
      assert.equal(result.rows[0]?.count, 1);
    });

    const rollbackInput = input(randomUUID());
    await assert.rejects(withTransaction(async client => {
      await recordPunch(client, rollbackInput);
      throw new Error('synthetic rollback');
    }), /synthetic rollback/);
    await withTransaction(async client => {
      assert.equal(await findCommittedPunchRetry(client, rollbackInput), null);
    });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
});
