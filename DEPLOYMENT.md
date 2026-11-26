<!-- PURPOSE: What ELT Attendance deploys where, in which order, with which settings, and how to check a release. -->
# ELT Attendance deployment plan

## What runs where

| Piece | Code | Deploy to | Why |
|---|---|---|---|
| Sign-in (accounts, passwords, admin authenticator) | Supabase Auth | Supabase project **HR flow** (`ap-south-1`, Mumbai) | Already in use; issues the tokens the server verifies. |
| Database | `features/*/migrations` | Postgres of the same Supabase project | One managed, backed-up Postgres close to the server. |
| Portal + API | `apps/web` + `platform/` + `features/` (one Next.js server) | A small always-on Node 22 server in Mumbai (VM such as AWS Lightsail/EC2 `ap-south-1`), behind HTTPS on `attendance.eltcorporate.com` | Needs a long-running Node process with a Postgres pool, server-only secrets and HTTPS for the kiosk. |
| WhatsApp sender | `platform/whatsapp.ts` (`npm run whatsapp`) | Same server, second process | Endless loop that drains the punch outbox; serverless hosts cannot run it. |
| Kiosk app | `apps/android` (`com.elt.attendance.kiosk`) | Google Play **internal testing** track → the mounted kiosk phone | Play Integrity only trusts Play-installed, ELT-signed builds. |
| Employee app | `apps/mobile` (`com.elt.attendance.portal`, Capacitor shell) | Google Play internal/closed track, or a signed APK shared with staff | It loads the live portal, so screen changes ship with the server; the app only changes when its URL or icon does. |

Not deployed: ngrok, the local embedded Postgres, `KIOSK_INTEGRITY_DEV_BYPASS`, and debug APKs. They were for the local trial only.

## Server settings

Set these in the server's environment (systemd/PM2 env file readable only by the service user). Never commit or print them.

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase Postgres **direct** or **session-mode pooler (port 5432)** connection. Not the transaction pooler (6543): the app relies on transactions and advisory locks. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | HR flow project URL and publishable key. Needed at **build** time too. |
| `KIOSK_TEMPLATE_KEY_HEX` | 32-byte hex key that encrypts face templates. **Back it up**; losing it makes every registered face unreadable. |
| `KIOSK_ENROLLMENT_CODE_KEY_HEX` | Separate 32-byte hex key for enrollment-code digests. |
| `KIOSK_FACE_ENROLLMENT_NOTICE_VERSION`, `KIOSK_FACE_ENROLLMENT_NOTICE_TEXT` | ELT-approved biometric notice; registration is unavailable without it. |
| `KIOSK_PLAY_CERT_SHA256`, `KIOSK_PLAY_SERVICE_ACCOUNT_JSON` | Play app-signing certificate digest and the service account allowed to decode Play Integrity tokens. |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE`, `WHATSAPP_TEMPLATE_LANGUAGE` | WhatsApp Cloud API; template body takes `{{1}}` first name, `{{2}}` checked in/out, `{{3}}` IST time. |
| `NODE_ENV=production` | Set by `npm start`; it also makes the server refuse the integrity dev bypass. |

## Supabase Auth settings (dashboard, HR flow project)

1. Authentication → Sign In / Providers → Email: enabled, **password sign-in on**. Either keep **Confirm email off**, or turn it on only after adding a custom SMTP sender (Authentication → SMTP) — the built-in sender allows only a few emails per hour.
2. URL Configuration: Site URL `https://attendance.eltcorporate.com`; remove `localhost` and ngrok entries.
3. Multi-factor: TOTP enabled (required for HR/ADMIN accounts).
4. JWT signing: asymmetric keys (the server verifies tokens against the project JWKS).

## Release order

1. **Back up** the database and the two key variables.
2. **Migrate**: `npm ci && DATABASE_URL=… npm run migrate`. Migrations are versioned and checksummed; it also enables row security and removes Data API access on every attendance table.
3. **Build and start the portal**: `npm ci && npm run build`, then run `npm start` (port 3000) under PM2/systemd with restart-on-failure, behind Caddy or Nginx for HTTPS.
4. **Start the WhatsApp sender**: `npm run whatsapp` as a second PM2/systemd service.
5. **Kiosk app**: build the release bundle with the ELT upload key (`ELT_UPLOAD_*` variables, see `apps/android/README.md`), upload to the Play internal track, enable Play Integrity for the app and link the cloud project. Install on the kiosk phone from Play.
6. **Register each kiosk**: on first launch enter `https://attendance.eltcorporate.com`, the real Play cloud project number and an admin PIN; then on the server run
   `node --experimental-strip-types features/biometrics/provision.ts register DEVICE_ID SITE_ID PUBLIC_KEY` with the ID and key the kiosk shows.
7. **Employee app**: `ELT_PORTAL_URL=https://attendance.eltcorporate.com npm run mobile:sync`, then build a signed release in `apps/mobile/android` and publish it.
8. **First admin**: sign up in the app, then on the server
   `ACCESS_DATABASE_URL=… node --experimental-strip-types features/access/provision.ts approve-signup EMAIL` and `… operator-role EMPLOYEE_UUID ADMIN`. Everyone after that is approved from the app's **Admin** tab.
9. **Sites and people**: create sites with `features/access/provision.ts site …`; staff sign up in the app and an admin approves them (approval assigns the first active site — see the note below). Add WhatsApp numbers with `provision.ts whatsapp EMPLOYEE_UUID +91…`.

## Release check (about 15 minutes)

- `https://attendance.eltcorporate.com` shows the sign-in screen; `/api/employees` without a token returns 401.
- A new account shows **Pending approval**; Admin → New accounts → Approve gives it an `ELT000xx` ID.
- Home → **Get my code** → enter it on the kiosk → face captured → Home shows **Face registered**.
- Look at the kiosk before noon: it checks in by itself and shows **✓ Punched in**; Home shows **Checked in at …** within 5 seconds; a WhatsApp message arrives if a number is set.
- A second person trying to register an already-registered face sees **"Hey <name>, you are already registered"**.
- Pull the kiosk's network, punch, restore it: the punch syncs automatically.

## Before real employees use it

- Run the physical acceptance in `README.md` on the mounted kiosk (lighting, photo/screen spoof attempts, latency) and calibrate the match thresholds; the duplicate-face check uses the same 0.50 score as a punch.
- Get the WhatsApp message template approved by Meta.
- New sign-ups are assigned to the first active site by name. Add a site picker to the approval step before a second site goes live.
- The automatic IN-before-noon / OUT-from-4pm rule is one company-wide setting in `apps/android/.../PunchWindow.kt`.
- One existing schedule test (`features/schedule/schedule.test.ts:83`) fails independently of this work; fix it before relying on `npm run check` in CI.
