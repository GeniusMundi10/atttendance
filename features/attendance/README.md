<!-- PURPOSE: Document the attendance transaction boundary and its PostgreSQL test command. -->
# Attendance transaction

Apply `migrations/001_punches.sql` to the application database. Call `findCommittedPunchRetry` inside the shared transaction before checking or consuming a challenge. It locks the request ID until commit. For a new request, verify evidence, check employee and site eligibility, consume the challenge, then call `recordPunch` in that same transaction. Commit before returning its receipt to the kiosk.

`recordPunch` serializes requests for each employee, requires IN then OUT, and inserts the receipt, audit and outbox row together. The returned `recordedAt` is the database clock instant. Only the owning HTTP layer authorizes `getPunchReceipt` and `listPunchReceipts` callers.

Test command (with `pg` and `embedded-postgres` installed):

```sh
node features/attendance/run-tests.mjs
```

The command creates a disposable database; the suite creates and removes its own schema with synthetic identities. To use an existing dedicated test database instead, set `ATTENDANCE_TEST_DATABASE_URL` and run `node --experimental-strip-types --experimental-test-isolation=none --test features/attendance/attendance.test.ts`.
