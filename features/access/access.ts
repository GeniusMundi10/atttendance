// PURPOSE: Enforce employee kiosk eligibility and receipt reading with database owned scope.
export interface QueryClient {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export interface VerifiedSubject {
  authProvider: string;
  authSubject: string;
  aal?: string;
}

export interface Actor {
  employeeId: string;
  authProvider: string;
  authSubject: string;
  aal?: string;
}

export interface ActiveSiteAssignment {
  siteId: string;
  siteName: string;
}

export class AccessDeniedError extends Error {
  constructor(message = 'Access denied') {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

export class AccessMfaRequiredError extends AccessDeniedError {
  constructor() {
    super('MFA required');
    this.name = 'AccessMfaRequiredError';
  }
}

function nonempty(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Call inside the same pg transaction that records the punch. */
export async function checkKioskEligibility(
  client: QueryClient,
  input: { employeeId: string; siteId: string },
): Promise<void> {
  const result = await client.query(
    `SELECT e.id
       FROM access_employees e
       JOIN access_employee_sites es ON es.employee_id = e.id
       JOIN access_sites s ON s.id = es.site_id
      WHERE e.id = $1 AND s.id = $2
        AND e.active AND es.active AND s.active
      FOR SHARE OF e, es, s`,
    [input.employeeId, input.siteId],
  );
  if (result.rows.length !== 1) throw new AccessDeniedError('Employee is not active at this site');
}

/** Return active employee assignments to active sites for enrollment site selection. */
export async function listActiveSiteAssignments(
  client: QueryClient,
  employeeId: string,
): Promise<ActiveSiteAssignment[]> {
  const result = await client.query<{ site_id: string; site_name: string }>(
    `SELECT s.id AS site_id, s.name AS site_name
       FROM access_employees e
       JOIN access_employee_sites es ON es.employee_id = e.id AND es.active
       JOIN access_sites s ON s.id = es.site_id AND s.active
      WHERE e.id = $1 AND e.active
      ORDER BY s.name, s.id`,
    [employeeId],
  );
  return result.rows.map(row => ({ siteId: row.site_id, siteName: row.site_name }));
}

/** The caller must verify the token before passing its issuer, subject, and AAL. */
export async function resolveAuthenticatedSubject(
  client: QueryClient,
  subject: VerifiedSubject,
): Promise<Actor> {
  if (!nonempty(subject.authProvider) || !nonempty(subject.authSubject)) {
    throw new AccessDeniedError();
  }
  const result = await client.query<{ employee_id: string; operator_role: string | null }>(
    `SELECT l.employee_id, r.role AS operator_role
       FROM access_subject_links l
       JOIN access_employees e ON e.id = l.employee_id
       LEFT JOIN access_operator_roles r ON r.employee_id = e.id AND r.active
      WHERE l.auth_provider = $1 AND l.auth_subject = $2
        AND l.active AND e.active
      FOR SHARE OF l, e`,
    [subject.authProvider, subject.authSubject],
  );
  if (result.rows.length !== 1) throw new AccessDeniedError();
  if (result.rows[0]!.operator_role && subject.aal !== 'aal2') {
    throw new AccessMfaRequiredError();
  }
  return {
    employeeId: result.rows[0]!.employee_id,
    authProvider: subject.authProvider,
    authSubject: subject.authSubject,
    aal: subject.aal,
  };
}

/** Resolve the actor first; never accept role or employeeId from an HTTP claim. */
export async function authorizeReceiptRead(
  client: QueryClient,
  input: { actor: Actor; employeeId: string },
): Promise<void> {
  const actor = await resolveAuthenticatedSubject(client, input.actor);
  if (actor.employeeId !== input.actor.employeeId) throw new AccessDeniedError();
  const result = await client.query(
    `SELECT target.id
       FROM access_employees target
      WHERE target.id = $2 AND target.active
        AND (
          target.id = $1
          OR EXISTS (
            SELECT 1 FROM access_operator_roles r
             WHERE r.employee_id = $1 AND r.active AND r.role IN ('HR', 'ADMIN')
          )
          OR EXISTS (
            SELECT 1 FROM access_manager_reports m
             WHERE m.manager_id = $1 AND m.report_id = target.id AND m.active
          )
        )`,
    [actor.employeeId, input.employeeId],
  );
  if (result.rows.length !== 1) throw new AccessDeniedError();
}

/** Verify a linked HR/ADMIN actor with trusted AAL2 before a biometric reset. */
export async function authorizeFaceRegistrationReset(
  client: QueryClient,
  input: { actor: Actor; employeeId: string },
): Promise<void> {
  const actor = await resolveAuthenticatedSubject(client, input.actor);
  if (actor.employeeId !== input.actor.employeeId || actor.aal !== 'aal2') {
    throw new AccessDeniedError();
  }
  const result = await client.query(
    `SELECT target.id
       FROM access_employees target
       JOIN access_operator_roles role ON role.employee_id = $1 AND role.active AND role.role IN ('HR', 'ADMIN')
      WHERE target.id = $2
      FOR SHARE OF target, role`,
    [actor.employeeId, input.employeeId],
  );
  if (result.rows.length !== 1) throw new AccessDeniedError();
}

/** Verify a linked HR/ADMIN actor with trusted AAL2 for HR work queues that have no single target employee. */
export async function authorizeHrOperator(client: QueryClient, actor: Actor): Promise<void> {
  const resolved = await resolveAuthenticatedSubject(client, actor);
  if (resolved.employeeId !== actor.employeeId || actor.aal !== 'aal2') throw new AccessDeniedError();
  const result = await client.query(
    `SELECT 1 FROM access_operator_roles WHERE employee_id = $1 AND active AND role IN ('HR', 'ADMIN')`,
    [actor.employeeId],
  );
  if (result.rows.length !== 1) throw new AccessDeniedError();
}

export interface ReadableEmployee {
  employeeId: string;
  displayName: string;
}

/** A bounded selector using the same database scope as receipt authorization. */
export async function listReadableEmployees(
  client: QueryClient,
  actor: Actor,
  options: { limit?: number; offset?: number } = {},
): Promise<ReadableEmployee[]> {
  const resolved = await resolveAuthenticatedSubject(client, actor);
  if (resolved.employeeId !== actor.employeeId) throw new AccessDeniedError();
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isInteger(offset) || offset < 0 || offset > 1000000) {
    throw new RangeError('Invalid employee page');
  }
  const result = await client.query<{ employee_id: string; display_name: string }>(
    `SELECT target.id AS employee_id, target.display_name
       FROM access_employees target
      WHERE target.active AND (
        target.id = $1
        OR EXISTS (
          SELECT 1 FROM access_operator_roles r
           WHERE r.employee_id = $1 AND r.active AND r.role IN ('HR', 'ADMIN')
        )
        OR EXISTS (
          SELECT 1 FROM access_manager_reports m
           WHERE m.manager_id = $1 AND m.report_id = target.id AND m.active
        )
      )
      ORDER BY target.display_name, target.id
      LIMIT $2 OFFSET $3`,
    [actor.employeeId, limit, offset],
  );
  return result.rows.map(row => ({ employeeId: row.employee_id, displayName: row.display_name }));
}

export interface SignupRequest {
  requestId: string;
  email: string;
  displayName: string;
  createdAt: string;
}

/** Record a signed-in but unlinked account for HR approval. Idempotent; reports whether it is already linked. */
export async function requestSignup(
  client: QueryClient,
  subject: VerifiedSubject & { email: string },
  displayName: unknown,
): Promise<{ state: 'pending' | 'approved'; operator: boolean }> {
  if (!nonempty(subject.authProvider) || !nonempty(subject.authSubject) || !/^[^@\s]+@[^@\s]+$/.test(subject.email)) {
    throw new AccessDeniedError();
  }
  const linked = await client.query<{ role: string | null }>(
    `SELECT r.role FROM access_subject_links l JOIN access_employees e ON e.id = l.employee_id
       LEFT JOIN access_operator_roles r ON r.employee_id = e.id AND r.active
      WHERE l.auth_provider = $1 AND l.auth_subject = $2 AND l.active AND e.active`,
    [subject.authProvider, subject.authSubject],
  );
  // `operator` only decides which tabs the app shows; every HR action re-checks role and MFA on the server.
  if (linked.rows.length) return { state: 'approved', operator: linked.rows[0]!.role !== null };
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (name.length < 1 || name.length > 120) throw new RangeError('Invalid display name');
  await client.query(
    `INSERT INTO access_signup_requests (auth_provider, auth_subject, email, display_name) VALUES ($1, $2, $3, $4)
     ON CONFLICT (auth_provider, auth_subject) DO NOTHING`,
    [subject.authProvider, subject.authSubject, subject.email, name],
  );
  return { state: 'pending', operator: false };
}

export async function listSignupRequests(client: QueryClient, actor: Actor): Promise<SignupRequest[]> {
  await authorizeHrOperator(client, actor);
  const result = await client.query<{ request_id: string; email: string; display_name: string; created_at: Date }>(
    `SELECT request_id, email, display_name, created_at FROM access_signup_requests
      WHERE employee_id IS NULL ORDER BY created_at LIMIT 200`,
  );
  return result.rows.map(row => ({ requestId: row.request_id, email: row.email, displayName: row.display_name,
    createdAt: new Date(row.created_at).toISOString() }));
}

/**
 * Turn a sign-up into an active employee (new ELT code) linked to the account and assigned to a site. Idempotent.
 * ponytail: assigns the first active site by name; add a site picker when ELT runs more than one site.
 */
export async function approveSignup(
  client: QueryClient,
  actor: Actor,
  requestId: string,
): Promise<{ employeeId: string; employeeCode: string }> {
  await authorizeHrOperator(client, actor);
  return linkSignup(client, requestId);
}

/** Unauthenticated core of approveSignup. Only the offline operator CLI (provision.ts) may call it directly. */
export async function linkSignup(client: QueryClient, requestId: string): Promise<{ employeeId: string; employeeCode: string }> {
  const pending = await client.query<{ auth_provider: string; auth_subject: string; display_name: string; employee_id: string | null }>(
    `SELECT auth_provider, auth_subject, display_name, employee_id FROM access_signup_requests WHERE request_id = $1 FOR UPDATE`,
    [requestId],
  );
  const row = pending.rows[0];
  if (!row) throw new AccessDeniedError();
  if (row.employee_id) {
    const code = await client.query<{ employee_code: string }>('SELECT employee_code FROM access_employees WHERE id = $1', [row.employee_id]);
    return { employeeId: row.employee_id, employeeCode: code.rows[0]!.employee_code };
  }
  const site = await client.query<{ id: string }>('SELECT id FROM access_sites WHERE active ORDER BY name, id LIMIT 1');
  if (!site.rows[0]) throw new RangeError('No active site');
  const employeeId = crypto.randomUUID();
  const created = await client.query<{ employee_code: string }>(
    'INSERT INTO access_employees (id, display_name) VALUES ($1, $2) RETURNING employee_code',
    [employeeId, row.display_name],
  );
  await client.query('INSERT INTO access_employee_sites (employee_id, site_id) VALUES ($1, $2)', [employeeId, site.rows[0].id]);
  await client.query('INSERT INTO access_subject_links (auth_provider, auth_subject, employee_id) VALUES ($1, $2, $3)',
    [row.auth_provider, row.auth_subject, employeeId]);
  await client.query('UPDATE access_signup_requests SET employee_id = $2 WHERE request_id = $1', [requestId, employeeId]);
  return { employeeId, employeeCode: created.rows[0]!.employee_code };
}
