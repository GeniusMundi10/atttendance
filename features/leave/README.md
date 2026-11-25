<!-- PURPOSE: Explain bounded paid leave policy, scheduling prerequisite, and feature checks. -->
# Paid leave pilot

This first slice grants exactly one full paid day per employee per month, with no
carry forward. A pending request reserves the day; approval moves it to used;
rejection releases it. Dates must be strictly after today's Asia/Kolkata date and
within the same calendar month. The database holds a single balance row per
employee and month and serializes writes with `FOR UPDATE`.

The kiosk roster has no work calendar or joining date. We therefore require an
explicit `leave_work_dates` row for each eligible employee/date. An operator can
load confirmed dates with `LEAVE_PROVISION_DATABASE_URL` and
`node --experimental-strip-types features/leave/provision-work-date.ts EMPLOYEE_UUID YYYY-MM-DD`.
Use a restricted database account for provisioning. This table is a scheduling
prerequisite, not a payroll entitlement calculation. This slice does not prorate
for joining date, schedule recurring shifts, pay out unused days, or support
other leave categories.

Managers can decide pending requests only for current assigned reports. Rejection
requires a reason. HR and admins can change pending or decided requests with a
reason and verified `aal2` MFA. Nobody can decide their own request. Decision
history is append only. All roles, subject links, and report scope come from the
database; routes use the existing verified portal bearer token.

Apply `migrations/001_paid_leave.sql` after the access migration. The coordinator
migrator must include all `leave_*` tables in its RLS and grant restrictions.
Routes are `GET /api/leave/balance`, `GET|POST /api/leave/requests`, and
`POST /api/leave/requests/:id/decision`. The portal is `/leave`.

Feature test command: `node --experimental-strip-types --test features/leave/leave.test.ts`
with `LEAVE_TEST_DATABASE_URL` set to a disposable PostgreSQL database. Tests
create and drop their own schema with synthetic identities.
