<!-- PURPOSE: What ELT Attendance deploys where, in which order, with which settings, and how to check a release. -->
# ELT Attendance deployment plan

## What runs where

| Piece | Code | Deploy to | Why |
|---|---|---|---|
| Sign-in (accounts, passwords, admin authenticator) | Supabase Auth | Supabase project **HR flow** (`ap-south-1`, Mumbai) | Already in use; issues the tokens the server verifies. |
| Database | `features/*/migrations` | Postgres of the same Supabase project | One managed, backed-up Postgres close to the server. |
| Portal + API | `apps/web`, `platform/`, `features/` | Next.js on Vercel, Node 22 functions in Mumbai, HTTPS on `attendance.eltcorporate.com` | Keeps API requests close to Supabase and reuses the existing signed kiosk routes. |
| WhatsApp sender | `POST /api/internal/whatsapp` | Supabase Cron invokes a Vercel function every minute | Each call processes a bounded batch of committed punches. |
| Kiosk app | `apps/android` (`com.elt.attendance.kiosk`) | Google Play **internal testing** track → the mounted kiosk phone | Play Integrity only trusts Play-installed, ELT-signed builds. |
| Employee app | `apps/mobile` (`com.elt.attendance.portal`, Capacitor shell) | Google Play internal/closed track, or a signed APK shared with staff | It loads the live portal, so screen changes ship with the server; the app only changes when its URL or icon does. |

Not deployed: ngrok, the local embedded Postgres, `KIOSK_INTEGRITY_DEV_BYPASS`, and debug APKs. They were for the local trial only.

## Server settings

Set these in the Vercel project settings. Scope Preview and Production separately. Preview uses a dedicated staging Supabase project, test employee accounts, staging encryption keys, and Meta test recipients. Keep production secrets out of preview builds. Never commit or print them.

| Variable | Value |
|---|---|
| `DATABASE_URL` | Privileged PostgreSQL runtime connection from the environment's Supabase Connect dialog. Use the Supavisor transaction pooler for serverless traffic. For the migration operator use the direct connection or session pooler. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | HR flow project URL and publishable key. Needed at **build** time too. |
| `KIOSK_TEMPLATE_KEY_HEX` | 32-byte hex key that encrypts face templates. **Back it up**; losing it makes every registered face unreadable. |
| `KIOSK_ENROLLMENT_CODE_KEY_HEX` | Separate 32-byte hex key for enrollment-code digests. |
| `KIOSK_FACE_ENROLLMENT_NOTICE_VERSION`, `KIOSK_FACE_ENROLLMENT_NOTICE_TEXT` | ELT-approved biometric notice; registration is unavailable without it. |
| `KIOSK_PLAY_CERT_SHA256`, `KIOSK_PLAY_SERVICE_ACCOUNT_JSON` | Play app-signing certificate digest and the service account allowed to decode Play Integrity tokens. |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE`, `WHATSAPP_TEMPLATE_LANGUAGE` | WhatsApp Cloud API; template body takes `{{1}}` first name, `{{2}}` checked in/out, `{{3}}` IST time. |
| `WHATSAPP_CRON_SECRET` | A random secret per environment. Store the same value in that environment's Supabase Vault as `elt_whatsapp_cron_secret`. |
| `NODE_ENV=production` | Supplied by the Next.js production build/runtime. Leave the kiosk integrity dev bypass unset on all hosted environments. |

## Vercel project settings

Connect the repository through Vercel's Git integration. Select **Next.js**, set the **Root Directory** to `apps/web`, enable **Include source files outside of the Root Directory in the Build Step**, and select **Node.js 22.x**. The lockfile and shared server modules live at the repository root. Use the checked-in install and build commands and the default Next.js output directory. Set the production branch explicitly. Feature branches receive previews.

Use a stable staging branch URL in Supabase Vault so a new preview deployment on that branch receives subsequent calls. Keep WhatsApp Cloud API tokens, Play service account JSON, database credentials and encryption keys in server-only variables. The Android signing key and ElevenLabs key are unnecessary for the hosted application.

## Supabase Auth settings (dashboard, HR flow project)

1. Authentication → Sign In / Providers → Email: enabled, **password sign-in on**. Either keep **Confirm email off**, or turn it on only after adding a custom SMTP sender (Authentication → SMTP) — the built-in sender allows only a few emails per hour.
2. URL Configuration: Site URL `https://attendance.eltcorporate.com`; remove `localhost` and ngrok entries.
3. Multi-factor: TOTP enabled (required for HR/ADMIN accounts).
4. JWT signing: asymmetric keys (the server verifies tokens against the project JWKS).

## Release order

1. **Back up** the database and the two key variables.
2. **Migrate**: `npm ci && DATABASE_URL=… npm run migrate`. Migrations are versioned and checksummed; it also enables row security and removes Data API access on every attendance table.
3. **Deploy staging first.** Import the GitHub repository into Vercel using the Vercel project settings above. Push a staging branch, verify its preview build, and run the acceptance checks on its stable HTTPS hostname. Point the staging kiosk at a host it can reach with its existing device authentication. Vercel's interactive preview login blocks native kiosk requests; use a dedicated staging hostname with suitable deployment-protection settings. Keep production data isolated.
4. **Schedule WhatsApp in staging.** Enable Cron (`pg_cron`), `pg_net`, and Vault in the staging Supabase project. In Vault create `elt_attendance_origin` with the stable HTTPS origin and `elt_whatsapp_cron_secret` with the matching function secret. For a Vercel-protected endpoint also store its automation bypass token as `elt_vercel_protection_bypass`. Run [the schedule SQL](scripts/schedule-whatsapp.sql) as the scheduler administrator. The named job is safe to reapply. Stop any standalone sender for this environment. Check Vercel function status and outbox progress as well as the cron log: an HTTP request queued by Cron can still fail at its destination.
5. **Kiosk app**: build the release bundle with the ELT upload key (`ELT_UPLOAD_*` variables, see `apps/android/README.md`), upload to the Play internal track, enable Play Integrity for the app and link the cloud project. Install on the kiosk phone from Play.
6. **Register each kiosk**: on first launch enter `https://attendance.eltcorporate.com`, the real Play cloud project number and an admin PIN; then on the server run
   `node --experimental-strip-types features/biometrics/provision.ts register DEVICE_ID SITE_ID PUBLIC_KEY` with the ID and key the kiosk shows.
7. **Employee app**: `ELT_PORTAL_URL=https://attendance.eltcorporate.com npm run mobile:sync`, then build a signed release in `apps/mobile/android` and publish it.
8. **First admin**: sign up in the app, then on the server
   `ACCESS_DATABASE_URL=… node --experimental-strip-types features/access/provision.ts approve-signup EMAIL` and `… operator-role EMPLOYEE_UUID ADMIN`. Everyone after that is approved from the app's **Admin** tab.
9. **Sites and people**: create sites with `features/access/provision.ts site …`; staff sign up in the app and an admin approves them (approval assigns the first active site — see the note below). Add WhatsApp numbers with `provision.ts whatsapp EMPLOYEE_UUID +91…`.

## Production promotion

The sender attempts up to 20 due rows per invocation, admits new work for 20 seconds, and gives a Cloud API request five seconds. Failed sends become eligible after one minute. Monitor the count and age of unpublished rows and the endpoint's `published` and `deferred` counts. Sustained intake above the scheduled throughput requires adjusting capacity.

Require the GitHub `Attendance checks` pull-request check on your production branch. After staging passes, back up production, apply the versioned migrations using the production migration connection, then merge the tested commit to the Vercel production branch. Run migrations once from a trusted operator shell with `DATABASE_URL` in its environment; Vercel builds and previews do not run them. Point the existing attendance domain at the verified production deployment, configure the production schedule, then repeat the acceptance checks. A kiosk already registered to that domain and database retains its identity.

To pause notification delivery, run `SELECT cron.unschedule('elt-whatsapp-outbox');` in the affected Supabase project. Pending rows stay in the database. Reapply the schedule SQL to resume. To roll back application code, promote the previous compatible Vercel deployment. Keep additive database migrations in place.

## Release check (about 15 minutes)

- `https://attendance.eltcorporate.com` shows the sign-in screen; `/api/employees` without a token returns 401.
- A new account shows **Pending approval**; Admin → New accounts → Approve gives it an `ELT000xx` ID.
- Home → **Get my code** → enter it on the kiosk → face captured → Home shows **Face registered**.
- Look at the kiosk before noon: it checks in by itself and shows **✓ Punched in**; Home shows **Checked in at …** within 5 seconds; a WhatsApp message arrives if a number is set.
- A second person trying to register an already-registered face sees **"Hey <name>, you are already registered"**.
- Pull the kiosk's network, punch, restore it: the punch syncs automatically.
- Submit simultaneous punches on staging and retry the same signed request after a dropped response. Verify one receipt per original request and record cold and warm latency and database connection counts.
- Check in, attempt OUT within two minutes and verify the wait notice, then check out after the guard expires. Listen to the Hindi prompts on the mounted kiosk.
- Verify the WhatsApp endpoint rejects a POST with no bearer secret. Exercise a delivery outage with staging credentials, confirm the punch commits, then restore delivery and verify the queue drains. A provider acceptance followed by a database commit failure can result in a duplicate notification.

## Before real employees use it

- Run the physical acceptance in `README.md` on the mounted kiosk (lighting, photo/screen spoof attempts, latency) and calibrate the match thresholds; the duplicate-face check uses the same 0.50 score as a punch.
- Get the WhatsApp message template approved by Meta.
- New sign-ups are assigned to the first active site by name. Add a site picker to the approval step before a second site goes live.
- The automatic IN-before-noon rule (check-out is always a tap) is one company-wide setting in `apps/android/.../PunchWindow.kt`.
- The full `npm run check` passed, including feature, integration, portal checks and the production build. Run it again for each release candidate; Vercel, Supabase, Play Console, Meta configuration, and hosted acceptance still require the operator steps above.
