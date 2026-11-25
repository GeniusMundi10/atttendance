# ELT Attendance code map

- `contracts/kiosk.md` defines the first online kiosk punch.
- `apps/android` and `features/biometrics` belong to the Android and biometrics agent.
- `features/attendance` belongs to the attendance agent. It owns the authoritative PostgreSQL punch transaction.
- `features/access` belongs to the people agent. It owns employees, account linkage and reader/site authorization.
- `platform/api.ts` dispatches the kiosk and portal HTTP calls. `kiosk.ts` composes the single punch transaction, `auth.ts` verifies the portal token, `http.ts` bounds input and `db.ts` owns the pool.
- `apps/web/app` renders sign-in, privileged second-factor verification and the receipt list. The API route delegates to the platform.
- `scripts/migrate.ts` applies versioned feature SQL with checksums and restricts direct database access. `scripts/test-features.ts` runs feature suites on a disposable database.
- `tests/kiosk.test.ts` exercises signed enrollment, duplicate delivery, authorization and receipts using `tests/database.ts`.
- Follow `README.md` for configuration, acceptance and commands. Each agent's feature README covers its operator steps and checks.
