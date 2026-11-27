// PURPOSE: Verify access decisions against isolated PostgreSQL rows with synthetic identities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  AccessDeniedError,
  AccessMfaRequiredError,
  approveSignup,
  authorizeFaceRegistrationReset,
  authorizeReceiptRead,
  checkKioskEligibility,
  listActiveSiteAssignments,
  listReadableEmployees,
  listSignupRequests,
  requestSignup,
  resolveAuthenticatedSubject,
} from './access.ts';
import type { QueryClient } from './access.ts';

test('unverified or mismatched subjects cannot select another employee', async () => {
  const employeeId = randomUUID();
  const otherId = randomUUID();
  const client = {
    async query(sql: string) {
      if (sql.includes('access_subject_links')) return { rows: [{ employee_id: employeeId }] };
      throw new Error('Reader query must not run for a mismatched actor');
    },
  } as unknown as QueryClient;
  await assert.rejects(
    resolveAuthenticatedSubject(client, { authProvider: '', authSubject: 'subject' }),
    AccessDeniedError,
  );
  await assert.rejects(
    authorizeReceiptRead(client, {
      actor: { employeeId: otherId, authProvider: 'issuer', authSubject: 'subject' },
      employeeId: otherId,
    }),
    AccessDeniedError,
  );
});

test('active operator role requires trusted aal2 even for own receipt access', async () => {
  const employeeId = randomUUID();
  const client = {
    async query(sql: string) {
      if (sql.includes('access_subject_links')) {
        return { rows: [{ employee_id: employeeId, operator_role: 'HR' }] };
      }
      throw new Error('Reader query must not run before MFA');
    },
  } as unknown as QueryClient;
  const subject = { authProvider: 'issuer', authSubject: 'subject' };
  await assert.rejects(resolveAuthenticatedSubject(client, subject), AccessMfaRequiredError);
  await assert.rejects(resolveAuthenticatedSubject(client, { ...subject, aal: 'aal1' }), AccessMfaRequiredError);
  const actor = await resolveAuthenticatedSubject(client, { ...subject, aal: 'aal2' });
  assert.equal(actor.aal, 'aal2');
  await assert.rejects(
    authorizeReceiptRead(client, { actor: { ...actor, aal: 'aal1' }, employeeId }),
    AccessMfaRequiredError,
  );
});

test('face reset authorization rejects non-HR actors', async () => {
  const actorId = randomUUID();
  const client = {
    async query(sql: string) {
      if (sql.includes('access_subject_links')) return { rows: [{ employee_id: actorId, operator_role: null }] };
      if (sql.includes('access_operator_roles role')) return { rows: [] };
      throw new Error('Unexpected access query');
    },
  } as unknown as QueryClient;
  await assert.rejects(authorizeFaceRegistrationReset(client, {
    actor: { employeeId: actorId, authProvider: 'issuer', authSubject: 'subject', aal: 'aal2' },
    employeeId: randomUUID(),
  }), AccessDeniedError);
});

test('access decisions use active mapping and database reader scope', {
  skip: !process.env.ACCESS_TEST_DATABASE_URL && 'Set ACCESS_TEST_DATABASE_URL for PostgreSQL test',
}, async () => {
  const pg = await import('pg');
  const client = new pg.default.Client({ connectionString: process.env.ACCESS_TEST_DATABASE_URL });
  const schema = `access_test_${randomUUID().replaceAll('-', '')}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const migration = await readFile(fileURLToPath(new URL('./migrations/001_access.sql', import.meta.url)), 'utf8');
    await client.query(migration);
    for (const file of ['002_employee_code.sql', '003_signup_requests.sql']) {
      await client.query(await readFile(fileURLToPath(new URL('./migrations/' + file, import.meta.url)), 'utf8'));
    }

    const employee = randomUUID();
    const manager = randomUUID();
    const outsider = randomUUID();
    const hr = randomUUID();
    const site = randomUUID();
    const otherSite = randomUUID();
    const provider = 'test-issuer';
    for (const [id, name] of [[employee, 'Employee'], [manager, 'Manager'], [outsider, 'Outsider'], [hr, 'HR']]) {
      await client.query('INSERT INTO access_employees (id, display_name) VALUES ($1, $2)', [id, name]);
      await client.query('INSERT INTO access_subject_links (auth_provider, auth_subject, employee_id) VALUES ($1, $2, $3)', [provider, id, id]);
    }
    await client.query('INSERT INTO access_sites (id, name) VALUES ($1, $2), ($3, $4)', [site, 'Site', otherSite, 'Other']);
    await client.query('INSERT INTO access_employee_sites (employee_id, site_id) VALUES ($1, $2)', [employee, site]);
    await client.query('INSERT INTO access_manager_reports (manager_id, report_id) VALUES ($1, $2)', [manager, employee]);
    await client.query("INSERT INTO access_operator_roles (employee_id, role) VALUES ($1, 'HR')", [hr]);

    await client.query('BEGIN');
    await checkKioskEligibility(client, { employeeId: employee, siteId: site });
    assert.deepEqual(await listActiveSiteAssignments(client, employee), [{ siteId: site, siteName: 'Site' }]);
    await client.query('COMMIT');
    await assert.rejects(checkKioskEligibility(client, { employeeId: employee, siteId: otherSite }), AccessDeniedError);

    const employeeActor = await resolveAuthenticatedSubject(client, { authProvider: provider, authSubject: employee });
    const managerActor = await resolveAuthenticatedSubject(client, { authProvider: provider, authSubject: manager });
    const outsiderActor = await resolveAuthenticatedSubject(client, { authProvider: provider, authSubject: outsider });
    await assert.rejects(resolveAuthenticatedSubject(client, { authProvider: provider, authSubject: hr }), AccessMfaRequiredError);
    await assert.rejects(resolveAuthenticatedSubject(client, { authProvider: provider, authSubject: hr, aal: 'aal1' }), AccessMfaRequiredError);
    const hrActor = await resolveAuthenticatedSubject(client, { authProvider: provider, authSubject: hr, aal: 'aal2' });
    await authorizeFaceRegistrationReset(client, { actor: hrActor, employeeId: employee });
    await assert.rejects(authorizeFaceRegistrationReset(client, { actor: managerActor, employeeId: employee }), AccessDeniedError);
    await assert.rejects(authorizeFaceRegistrationReset(client, { actor: { ...hrActor, aal: 'aal1' }, employeeId: employee }), AccessMfaRequiredError);
    await authorizeReceiptRead(client, { actor: employeeActor, employeeId: employee });
    await authorizeReceiptRead(client, { actor: managerActor, employeeId: employee });
    await authorizeReceiptRead(client, { actor: hrActor, employeeId: employee });
    await assert.rejects(authorizeReceiptRead(client, { actor: outsiderActor, employeeId: employee }), AccessDeniedError);
    await assert.rejects(authorizeReceiptRead(client, { actor: { ...employeeActor, employeeId: hr }, employeeId: employee }), AccessDeniedError);
    assert.deepEqual((await listReadableEmployees(client, employeeActor)).map(e => e.employeeId), [employee]);
    assert.deepEqual((await listReadableEmployees(client, managerActor)).map(e => e.employeeId).sort(), [employee, manager].sort());
    assert.equal((await listReadableEmployees(client, hrActor)).length, 4);
    await assert.rejects(resolveAuthenticatedSubject(client, { authProvider: 'wrong', authSubject: employee }), AccessDeniedError);

    // Password sign-up: pending until HR approves, then a linked employee with a generated ELT code.
    const newcomer = { authProvider: provider, authSubject: 'newcomer', email: 'new@example.invalid' };
    assert.deepEqual(await requestSignup(client, newcomer, 'New Person'), { state: 'pending', operator: false });
    await assert.rejects(resolveAuthenticatedSubject(client, newcomer), AccessDeniedError);
    const [signup] = await listSignupRequests(client, hrActor);
    assert.equal(signup?.displayName, 'New Person');
    await assert.rejects(listSignupRequests(client, employeeActor), AccessDeniedError);
    await assert.rejects(approveSignup(client, employeeActor, signup!.requestId), AccessDeniedError);
    const approved = await approveSignup(client, hrActor, signup!.requestId);
    assert.match(approved.employeeCode, /^ELT\d{5}$/);
    assert.deepEqual(await approveSignup(client, hrActor, signup!.requestId), approved);
    assert.equal((await resolveAuthenticatedSubject(client, newcomer)).employeeId, approved.employeeId);
    assert.deepEqual(await requestSignup(client, newcomer, 'Ignored'), { state: 'approved', operator: false });
    assert.deepEqual(await requestSignup(client, { authProvider: provider, authSubject: hr, email: 'hr@example.invalid' }, 'HR'), { state: 'approved', operator: true });
    assert.deepEqual(await listSignupRequests(client, hrActor), []);

    await client.query('UPDATE access_employee_sites SET active = false WHERE employee_id = $1 AND site_id = $2', [employee, site]);
    await assert.rejects(checkKioskEligibility(client, { employeeId: employee, siteId: site }), AccessDeniedError);
    await client.query('UPDATE access_employees SET active = false WHERE id = $1', [employee]);
    await assert.rejects(resolveAuthenticatedSubject(client, { authProvider: provider, authSubject: employee }), AccessDeniedError);
    await assert.rejects(authorizeReceiptRead(client, { actor: hrActor, employeeId: employee }), AccessDeniedError);
  } finally {
    await client.query('RESET search_path');
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});
