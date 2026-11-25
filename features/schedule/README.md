# Schedule and holiday calendar

This feature stores named shifts, dated employee/site assignments, site-and-shift holiday calendars and append-only change audit rows. The seeded **General Shift** follows the supplied policy/workbook: 09:30 start, 540 required working minutes, 270 half-day minutes, Sunday as weekly off. Holidays take precedence over weekly off for day classification; restricted holidays remain working days and are exposed separately so Leave can apply its optional-holiday rules.

`scheduleDays(client, employeeId, from, to)` returns one bounded, ordered row per inclusive calendar date (maximum 366). `scheduleDay` and `isWorkingDay` are convenience reads. Callers performing an employee-facing read must use `readSchedule`, which enforces the same employee/manager/HR scope as attendance receipts. Do not infer pay treatment from `kind`; attendance/payroll owns that rule. Effective assignments are immutable and apply on their effective date; create a new shift rather than editing one already assigned.

## Supplied 2026 calendar

`data/holidays-2026.json` is transcribed from `Holiday_01-Jan-2026_31-Dec-2026.xls`: H-34/7, Sector-3, Rohini, Delhi; General Shift; 9 holidays and 6 restricted holidays. `import-calendar.ts` loads it by exact site and shift name, records audit events, and is idempotent. Before using the CLI, ensure the site and shift exist, set `SCHEDULE_PROVISION_DATABASE_URL` to a restricted server-side PostgreSQL connection, then run:

```sh
node --experimental-strip-types features/schedule/import-calendar.ts features/schedule/data/holidays-2026.json
```

The initial calendar has been loaded into the configured Supabase **HR flow** project. For a first roster assignment, use the HR portal's Schedule page or set `SCHEDULE_PROVISION_DATABASE_URL` and run:

```sh
node --experimental-strip-types features/schedule/provision-assignment.ts EMPLOYEE_UUID SITE_UUID "General Shift" YYYY-MM-DD
```

The provisioning path is for initial migration only; normal changes should use the authenticated HR/admin API, which requires MFA and a reason. API endpoints are `GET /api/schedule/setup`, `GET /api/schedule/days/:employeeId?from=YYYY-MM-DD&to=YYYY-MM-DD`, `GET /api/schedule/holidays/:employeeId?year=YYYY`, and `POST /api/schedule/shifts`, `/assignments`, `/holidays`, or `/holidays/:id/remove`. Readers are scoped; mutations are HR/admin only, server-verified and audited.

No employee roster/shift assignments were supplied, so the calendar is site-ready but has not been mapped to any employees. Public holiday / weekly-off pay treatment and restricted-holiday eligibility must be decided by ELT before payroll behavior is activated. The Leave integration now uses effective schedules instead of relying solely on preloaded work dates.

Feature tests: `node --experimental-strip-types --test features/schedule/schedule.test.ts` with `SCHEDULE_TEST_DATABASE_URL` set to a disposable PostgreSQL database. Repository tests: `npm run check`.
