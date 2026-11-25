# ELT Attendance code map

- `contracts/kiosk.md` defines the first online kiosk punch.
- `contracts/face-enrollment.md` defines employee self-service issuance, kiosk claim/consent/capture, recovery, account-wide registration, and HR reset.
- `apps/android` owns the kiosk client. `KioskActivity.kt` handles punch, setup, first-time self-service and supervised enrollment, recovery, local camera self-test and receipts; `EnrollmentPolicy.kt` validates six-digit strings; `EnrollmentRecovery.kt` stores only claim/session references; `Capture.kt` owns multi-frame liveness capture. `LocalDeviceSetup.kt` and `SetupPolicy.kt` own unmanaged setup storage and validation.
- `features/attendance` belongs to the attendance agent. It owns the authoritative PostgreSQL punch transaction.
- `features/access` belongs to the people agent. It owns employees, account linkage and reader/site authorization.
- `features/biometrics` owns device evidence, encrypted face templates, employee-wide registration, self-service enrollment lifecycle, durable limits, HR reset audit, and supervised provisioning; `features/access` publishes active site assignments and HR/MFA reset authorization.
- `features/schedule` owns shifts, effective-dated employee/site assignments, holiday calendars, schedule reads and its audit trail. `schedule.ts` publishes `scheduleDays`, `scheduleDay`, `isWorkingDay`, `readSchedule` and holiday/shift lookups for other features; `manage.ts` owns HR mutations.
- `features/leave` calls the schedule interface when checking work dates and registers the accepted date for its existing request constraints.
- `platform/api.ts` dispatches signed kiosk enrollment/status/cancel/complete calls, authenticated employee issuance/status and HR reset, alongside existing receipt routes. `kiosk.ts` composes the single punch transaction, `auth.ts` verifies the portal token, `http.ts` bounds input and `db.ts` owns the pool.
- `apps/web/app` renders sign-in, privileged second-factor verification, receipt, correction, leave and schedule views. The API route delegates to the platform.
- `scripts/migrate.ts` applies versioned feature SQL with checksums, enables RLS and revokes Data API grants on sensitive tables. `scripts/test-features.ts` runs feature suites on a disposable database.
- `features/biometrics/self-service.test.ts` covers synthetic enrollment codes, employee-bound issuance, same-kiosk claim recovery, signed completion, encrypted first-template-only storage, no attendance side effects and reset idempotency; `tests/kiosk.test.ts` exercises signed device flows, authorization and committed receipts using `tests/database.ts`.
- Follow `README.md` for configuration, acceptance and commands. Each agent's feature README covers its operator steps and checks.
