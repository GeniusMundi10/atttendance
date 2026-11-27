// PURPOSE: Verify authenticated correction API paths, reviewer scope and browser-role isolation.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';
import { exportJWK, SignJWT } from 'jose';
import { api } from '../platform/api.ts';
import { database } from '../platform/db.ts';
import { migrate } from '../scripts/migrate.ts';
import { startDatabase } from './database.ts';

test('correction HTTP flow requires employee ownership and scoped, MFA protected review', async t => {
  const cluster = await startDatabase();
  process.env.DATABASE_URL = cluster.url;
  const pool = database();
  t.after(async () => { await pool.end(); await cluster.stop(); });
  await pool.query('CREATE ROLE authenticated');
  await migrate(pool);
  const ids = { employee: randomUUID(), manager: randomUUID(), hr: randomUUID(), outsider: randomUUID() };
  const issuer = 'https://corrections-auth.example.invalid/auth/v1';
  process.env.NEXT_PUBLIC_SUPABASE_URL = issuer.slice(0, -8);
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = { ...await exportJWK(key.publicKey), kid: 'corrections', alg: 'ES256' };
  t.mock.method(globalThis, 'fetch', async (target: RequestInfo | URL) => {
    assert.equal(String(target), issuer + '/.well-known/jwks.json');
    return Response.json({ keys: [jwk] });
  });
  for (const [name, id] of Object.entries(ids)) {
    await pool.query('INSERT INTO access_employees(id,display_name) VALUES($1,$2)', [id, name]);
    await pool.query('INSERT INTO access_subject_links(auth_provider,auth_subject,employee_id) VALUES($1,$2,$3)', [issuer, id, id]);
  }
  await pool.query('INSERT INTO access_manager_reports(manager_id,report_id) VALUES($1,$2)', [ids.manager, ids.employee]);
  await pool.query("INSERT INTO access_operator_roles(employee_id,role) VALUES($1,'HR')", [ids.hr]);
  async function request(as: string | undefined, path: string, method = 'GET', data?: unknown, aal = 'aal1') {
    const authorization = as ? 'Bearer ' + await new SignJWT({ role: 'authenticated', aal })
      .setProtectedHeader({ alg: 'ES256', kid: 'corrections' }).setIssuer(issuer).setAudience('authenticated')
      .setSubject(as).setExpirationTime('5m').sign(key.privateKey) : undefined;
    const parts = path.split('?')[0]!.split('/').filter(Boolean).slice(1);
    return api(new Request('https://elt.example.invalid' + path, { method,
      headers: { ...(authorization ? { authorization } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
      body: data ? JSON.stringify(data) : undefined }), parts);
  }
  const proposed = { date: '2026-11-10', proposedIn: '2026-11-10T04:00:00Z', proposedOut: '2026-11-10T12:00:00Z' };
  assert.equal((await request(undefined, '/api/corrections/requests')).status, 401);
  assert.equal((await request(ids.manager, '/api/corrections/requests', 'POST', { reason: 'Not mine', days: [proposed] })).status, 201);
  // A requester owns only their own dates; a manager cannot submit on behalf of a report.
  const created = await request(ids.employee, '/api/corrections/requests', 'POST',
    { reason: 'Missed kiosk scan', days: [proposed] });
  assert.equal(created.status, 201);
  const { days } = await created.json() as { days: { dayId: string; revision: number }[] };
  const dayId = days[0]!.dayId;
  assert.equal((await request(ids.outsider, '/api/corrections/requests?scope=review')).status, 200);
  const decision = { decision: 'APPROVE', expectedRevision: 1, overrideReason: 'Verified schedule' };
  assert.equal((await request(ids.employee, `/api/corrections/days/${dayId}/decision`, 'POST', decision)).status, 403);
  assert.equal((await request(ids.outsider, `/api/corrections/days/${dayId}/decision`, 'POST', decision)).status, 403);
  assert.equal((await request(ids.hr, `/api/corrections/days/${dayId}/decision`, 'POST', decision)).status, 403);
  const approved = await request(ids.manager, `/api/corrections/days/${dayId}/decision`, 'POST', decision);
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).day.status, 'APPROVED');
  assert.equal((await request(ids.manager, `/api/corrections/days/${dayId}/decision`, 'POST', decision)).status, 409);
  const view = await request(ids.employee, `/api/employees/${ids.employee}/punches`);
  assert.equal(view.status, 200);
  const record = await view.json();
  assert.deepEqual(record.punches, []);
  assert.equal(record.days[0].in.source, 'APPROVED_CORRECTION');
  assert.equal(record.days[0].out.recordedAt, '2026-11-10T12:00:00.000Z');
  const hrQueue = await request(ids.hr, '/api/corrections/requests?scope=review', 'GET', undefined, 'aal2');
  assert.equal(hrQueue.status, 200);
  for (const table of ['correction_requests', 'correction_days']) {
    const grants = await pool.query(`SELECT has_table_privilege('authenticated',$1,'SELECT') AS read,
      has_table_privilege('authenticated',$1,'INSERT') AS create,
      has_table_privilege('authenticated',$1,'UPDATE') AS modify`, [table]);
    assert.deepEqual(grants.rows[0], { read: false, create: false, modify: false });
    const rls = await pool.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass', [table]);
    assert.equal(rls.rows[0]!.relrowsecurity, true);
  }
});
