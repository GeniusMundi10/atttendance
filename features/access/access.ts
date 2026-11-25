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
}

export interface Actor {
  employeeId: string;
  authProvider: string;
  authSubject: string;
}

export class AccessDeniedError extends Error {
  constructor(message = 'Access denied') {
    super(message);
    this.name = 'AccessDeniedError';
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

/** The caller must verify the authentication token before passing its issuer and subject. */
export async function resolveAuthenticatedSubject(
  client: QueryClient,
  subject: VerifiedSubject,
): Promise<Actor> {
  if (!nonempty(subject.authProvider) || !nonempty(subject.authSubject)) {
    throw new AccessDeniedError();
  }
  const result = await client.query<{ employee_id: string }>(
    `SELECT l.employee_id
       FROM access_subject_links l
       JOIN access_employees e ON e.id = l.employee_id
      WHERE l.auth_provider = $1 AND l.auth_subject = $2
        AND l.active AND e.active`,
    [subject.authProvider, subject.authSubject],
  );
  if (result.rows.length !== 1) throw new AccessDeniedError();
  return {
    employeeId: result.rows[0]!.employee_id,
    authProvider: subject.authProvider,
    authSubject: subject.authSubject,
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
