# ELT Attendance code map

- `contracts/kiosk.md` defines the first online kiosk punch.
- `apps/android` owns the kiosk client. `KioskActivity.kt` handles setup, enrollment, local camera self-test and receipts; `LocalDeviceSetup.kt` and `SetupPolicy.kt` own unmanaged setup storage and validation; `Capture.kt` owns multi-frame liveness capture. `features/biometrics` owns server verification, template storage and operator provisioning.
- `features/attendance` belongs to the attendance agent. It owns the authoritative PostgreSQL punch transaction.
- `features/access` belongs to the people agent. It owns employees, account linkage and reader/site authorization.
- `features/schedule` owns shifts, effective-dated employee/site assignments, holiday calendars, schedule reads and its audit trail. `schedule.ts` publishes `scheduleDays`, `scheduleDay`, `isWorkingDay`, `readSchedule` and holiday/shift lookups for other features; `manage.ts` owns HR mutations.
- `features/leave` calls the schedule interface when checking work dates and registers the accepted date for its existing request constraints.
- `platform/api.ts` dispatches the kiosk and portal HTTP calls. `kiosk.ts` composes the single punch transaction, `auth.ts` verifies the portal token, `http.ts` bounds input and `db.ts` owns the pool.
- `apps/web/app` renders sign-in, privileged second-factor verification, receipt, correction, leave and schedule views. The API route delegates to the platform.
- `scripts/migrate.ts` applies versioned feature SQL with checksums and restricts direct database access. `scripts/test-features.ts` runs feature suites on a disposable database.
- `tests/kiosk.test.ts` exercises signed enrollment, duplicate delivery, authorization and receipts using `tests/database.ts`.
- Follow `README.md` for configuration, acceptance and commands. Each agent's feature README covers its operator steps and checks.
