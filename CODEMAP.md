# ELT Attendance code map

- `contracts/kiosk.md` defines the first online kiosk punch.
- `apps/android` and `features/biometrics` belong to the Android and biometrics agent.
- `features/attendance` belongs to the attendance agent. It owns the authoritative PostgreSQL punch transaction.
- `features/access` belongs to the people agent. It owns employees, account linkage and reader/site authorization.
- The coordinator owns application composition, HTTP endpoints, integration tests and the portal receipt view.
