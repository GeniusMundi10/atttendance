<!-- PURPOSE: Document access ownership, database provisioning, and feature verification. -->
# Access feature

Apply `migrations/001_access.sql` in the application database before serving kiosk or receipt routes.
The attendance transaction passes its existing `pg` client to
`checkKioskEligibility(client, { employeeId, siteId })` before inserting a punch.
This call holds share locks on the active employee, site, and assignment rows until
the transaction ends. A failure throws `AccessDeniedError`.

After verifying a JWT signature, issuer, audience, expiry, and AAL, the server passes
its trusted claims to `resolveAuthenticatedSubject(client,
{ authProvider, authSubject, aal })`. Active HR/ADMIN operators require `aal2`;
otherwise this call throws `AccessMfaRequiredError`. The returned actor carries
the AAL and is passed to
`authorizeReceiptRead(client, { actor, employeeId })`. Both deny inactive or
unlinked employees. Roles and manager relationships come only from the database.
`listReadableEmployees(client, actor, { limit, offset })` returns a bounded
selector of authorized employees, including the actor. The default limit is 50
and the maximum is 100.
Configure `authProvider` to the verified issuer string; the exact value used in
provisioning must match it.

Provisioning is an offline operator command requiring a privileged database URL
in `ACCESS_DATABASE_URL`; it must never be exposed as an HTTP endpoint. Commands:

```text
node --experimental-strip-types features/access/provision.ts employee UUID DISPLAY_NAME
node --experimental-strip-types features/access/provision.ts site UUID NAME
node --experimental-strip-types features/access/provision.ts assign-site EMPLOYEE_UUID SITE_UUID
node --experimental-strip-types features/access/provision.ts link-subject PROVIDER EMPLOYEE_UUID < SUBJECT_FILE
node --experimental-strip-types features/access/provision.ts operator-role EMPLOYEE_UUID HR|ADMIN
node --experimental-strip-types features/access/provision.ts manager-report MANAGER_UUID REPORT_UUID
node --experimental-strip-types features/access/provision.ts deactivate-employee EMPLOYEE_UUID
```

The link command reads the subject from stdin and rejects duplicate subject or
employee links for a provider. Run
with a database account restricted to provisioning access tables. Do not put
database URLs or subject values in shell history or logs. Restrict the subject
file to the operator and remove it through the organization's secret handling
process after provisioning.

Feature test command: `node --experimental-strip-types --test --experimental-test-isolation=none features/access/access.test.ts`.
Set `ACCESS_TEST_DATABASE_URL` to a dedicated PostgreSQL test database to run
the database tests. Each run creates and drops an isolated schema with synthetic
identities. Without that variable, the database test is reported as skipped.
