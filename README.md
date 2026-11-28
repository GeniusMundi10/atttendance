# ELT attendance kiosk pilot

This slice connects a registered Android kiosk to a PostgreSQL punch ledger and the employee/HR receipt screen. Camera processing runs on the kiosk. The server authenticates the device, verifies a Google Play Integrity verdict and checks its live enrollment and site assignment. It commits the punch, audit row and notification outbox row together. WhatsApp delivery is a subsequent integration.

For a GitHub-connected Vercel staging deployment with Supabase Auth, Postgres and scheduled WhatsApp delivery, follow the [deployment guide](DEPLOYMENT.md).

## Run the software checks

Use Node 22.19 or newer and npm. From the repository root run `npm ci` and `npm run check`. The database tests start an isolated PostgreSQL instance on loopback. They do not require a running Docker daemon, corporate credentials or employee records. The cross-feature test exercises the production request handlers with generated signing keys, synthetic face scores and test-only responses from the external identity providers.

## Configure the pilot

1. Supply the environment in `.env.example` using the deployment's secret store. For local Next development, put web settings in `apps/web/.env.local` and set the database environment for the migration command separately. Build the portal with the public Supabase URL and publishable key available. Keep the database URL, template encryption key and Google service-account credentials on the server.
2. Run `npm run migrate` against a dedicated PostgreSQL database as the table owner. Use a server connection with access to owner-protected tables. The migration enables row security and removes direct browser-role grants. Retain the same encryption key on restarts. Store it in the backup/recovery system.
3. Configure email sign-in, approved redirect origins, TOTP and asymmetric JWT signing in Supabase. Invite the pilot employee and HR reviewer through the auth provider. Follow `features/access/README.md` to provision employee and site IDs, link each verified subject/issuer, and grant the reviewer the HR role. The portal supports existing accounts. An HR/admin reader must complete MFA.
4. Start the web service with `npm run dev` for development or `npm run build` and `npm start` for production. Use HTTPS for the kiosk endpoint. The portal shows the latest 50 confirmed punches for the selected employee, refreshed every three seconds. Report times use India Standard Time.
5. Provision the physical Android kiosk through the Android feature's operator instructions; a normal unmanaged phone can complete first-run setup and display its device key for offline site registration. For real server punches, deploy the recognized, correctly signed app via ELT's Play test track and configure the server-side Play certificate digest, cloud service account and template encryption key. Supervise each employee’s notice/consent and face enrollment. Keep physical-device punching in pilot until ELT verifies face accuracy, liveness and receipt latency on its mounted phone.

## Physical acceptance

Record the device model, app/model versions, site roster size, camera position, lighting, network and date. Have a supervised participant check in and check out, compare the kiosk timestamps and receipt IDs with the employee and HR screens, and confirm that one punch produces one event. Repeat after a full shift with the app open. Measure tap-to-server-confirmed receipt p50/p95/p99, retries, genuine rejections, wrong identities and rejected photo/replay presentations. Keep raw images out of test logs. ELT's target is p95 below two seconds and zero accepted photo/replay trials in the agreed test set.
