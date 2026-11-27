// PURPOSE: Verify correction capacity, decision authorization, concurrency and effective-day provenance on PostgreSQL.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { AccessMfaRequiredError, type Actor } from '../access/access.ts';
import { CorrectionError, createCorrectionRequest, decideCorrectionDay, listCorrectionDays, listEffectiveDays } from './corrections.ts';

const databaseUrl = process.env.CORRECTIONS_TEST_DATABASE_URL;
test('corrections reserve three IST dates and preserve an auditable effective view', {
  skip: databaseUrl ? false : 'Set CORRECTIONS_TEST_DATABASE_URL to a dedicated PostgreSQL test database',
}, async () => {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl });
  const schema = `correction_test_${randomUUID().replaceAll('-', '')}`;
  const issuer = 'https://synthetic.example.invalid/auth/v1';
  const ids = { employee: randomUUID(), manager: randomUUID(), hr: randomUUID(), outsider: randomUUID() };
  const actor = (employeeId: string, aal = 'aal1'): Actor => ({ employeeId, authProvider: issuer, authSubject: employeeId, aal });
  const proposed = (date: string) => ({ date, proposedIn: `${date}T04:00:00Z`, proposedOut: `${date}T12:00:00Z` });
  async function tx<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO ${schema}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    const setup = await pool.connect();
    try {
      await setup.query(`SET search_path TO ${schema}`);
      for (const file of [
        '../access/migrations/001_access.sql',
        '../attendance/migrations/001_punches.sql',
        './migrations/001_corrections.sql',
      ]) await setup.query(await readFile(new URL(file, import.meta.url), 'utf8'));
      for (const [name, id] of Object.entries(ids)) {
        await setup.query('INSERT INTO access_employees(id,display_name) VALUES($1,$2)', [id, name]);
        await setup.query('INSERT INTO access_subject_links(auth_provider,auth_subject,employee_id) VALUES($1,$2,$3)', [issuer, id, id]);
      }
      await setup.query('INSERT INTO access_manager_reports(manager_id,report_id) VALUES($1,$2)', [ids.manager, ids.employee]);
      await setup.query("INSERT INTO access_operator_roles(employee_id,role) VALUES($1,'HR')", [ids.hr]);
    } finally { setup.release(); }

    const first = await tx(client => createCorrectionRequest(client, actor(ids.employee), {
      reason: 'Missed scan', days: [proposed('2026-11-10'), proposed('2026-11-11')],
    }));
    assert.equal(first.length, 2);
    assert.equal(first[0]!.status, 'PENDING');
    assert.equal((await tx(client => listCorrectionDays(client, actor(ids.manager), 'review'))).length, 2);
    assert.equal((await tx(client => listCorrectionDays(client, actor(ids.outsider), 'review'))).length, 0);
    assert.equal((await tx(client => listCorrectionDays(client, actor(ids.employee), 'mine'))).length, 2);
    await assert.rejects(tx(client => listCorrectionDays(client, actor(ids.hr), 'review')), AccessMfaRequiredError);
    await tx(client => createCorrectionRequest(client, actor(ids.employee), {
      reason: 'Missing scan', days: [proposed('2026-11-12')],
    }));
    await assert.rejects(tx(client => createCorrectionRequest(client, actor(ids.employee), {
      reason: 'Extra', days: [proposed('2026-11-13')],
    })), error => error instanceof CorrectionError && error.code === 'monthly_correction_limit');
    await assert.rejects(tx(client => decideCorrectionDay(client, actor(ids.employee), first[0]!.dayId,
      { decision: 'APPROVE', expectedRevision: 1, overrideReason: 'Self' })),
      error => error instanceof CorrectionError && error.code === 'self_approval_denied');
    await assert.rejects(tx(client => decideCorrectionDay(client, actor(ids.outsider), first[0]!.dayId,
      { decision: 'APPROVE', expectedRevision: 1, overrideReason: 'Unassigned' })),
      error => error instanceof CorrectionError && error.code === 'access_denied');

    const rejected = await tx(client => decideCorrectionDay(client, actor(ids.manager), first[0]!.dayId,
      { decision: 'REJECT', expectedRevision: 1, overrideReason: 'Insufficient detail' }));
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.revision, 2);
    await assert.rejects(tx(client => decideCorrectionDay(client, actor(ids.manager), first[0]!.dayId,
      { decision: 'APPROVE', expectedRevision: 1, overrideReason: 'Too late' })),
      error => error instanceof CorrectionError && error.code === 'stale_correction_revision');
    const replacement = await tx(client => createCorrectionRequest(client, actor(ids.employee), {
      reason: 'Revised times', days: [proposed('2026-11-10')],
    }));
    assert.equal(replacement.length, 1);
    const approved = await tx(client => decideCorrectionDay(client, actor(ids.hr, 'aal2'), replacement[0]!.dayId,
      { decision: 'APPROVE', expectedRevision: 1, overrideReason: 'Verified timesheet' }));
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.decidedBy, ids.hr);

    const punchId = randomUUID();
    await tx(async client => {
      await client.query(`INSERT INTO attendance_punches
        (punch_id,request_id,device_id,challenge_id,proof_digest,employee_id,site_id,action,recorded_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'IN',$8)`,
      [punchId, randomUUID(), randomUUID(), randomUUID(), 'a'.repeat(64), ids.employee, randomUUID(), '2026-11-10T05:00:00Z']);
      const effective = await listEffectiveDays(client, ids.employee);
      const day = effective.find(item => item.date === '2026-11-10');
      assert.equal(day?.in?.source, 'APPROVED_CORRECTION');
      assert.equal(day?.in?.recordedAt, '2026-11-10T04:00:00.000Z');
      assert.equal(day?.out?.source, 'APPROVED_CORRECTION');
      const raw = await client.query('SELECT recorded_at FROM attendance_punches WHERE punch_id=$1', [punchId]);
      assert.equal(raw.rows[0]!.recorded_at.toISOString(), '2026-11-10T05:00:00.000Z');
    });

    const raced = await Promise.allSettled(['2026-12-01','2026-12-02','2026-12-03','2026-12-04'].map(date =>
      tx(client => createCorrectionRequest(client, actor(ids.employee), { reason: 'Race', days: [proposed(date)] }))));
    assert.equal(raced.filter(result => result.status === 'fulfilled').length, 3);
    assert.equal(raced.filter(result => result.status === 'rejected').length, 1);
    await tx(async client => {
      const count = await client.query(`SELECT count(*)::int AS count FROM correction_days
        WHERE employee_id=$1 AND work_date >= '2026-12-01' AND work_date < '2027-01-01'
          AND status IN ('PENDING','APPROVED')`, [ids.employee]);
      assert.equal(count.rows[0]!.count, 3);
    });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
});
