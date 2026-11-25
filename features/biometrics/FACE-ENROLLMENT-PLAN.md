# First day face enrollment

**Execution plan for Manas and the ELT Attendance team**

The employee opens Attendance and taps **Register my face**. Their app shows a six-digit code. At their site's Android kiosk, they tap **Set up biometric**, enter the code, and follow the camera guide. The kiosk confirms when their face is registered. They can then check in or finish.

[Try the interactive enrollment preview](face-enrollment-storyboard.html) · [Copy the Manas prompt](#manas-execution-prompt)

## Employee experience

| Step | Employee sees | Interaction |
| --- | --- | --- |
| 1. Get a code in Attendance | **Register my face** in their own account. Tapping it shows six large digits, the site, and “At the kiosk, tap Set up biometric and enter this code.” | Use the employee's active site automatically. Ask for a site only if they have several eligible sites. Show the expiry time and **Get a new code** when needed. |
| 2. Enter it at the kiosk | **Set up biometric** beside the normal check-in and check-out actions. Tapping it opens **Enter your six-digit code**. | Show one labeled numeric field, a number keypad, **Continue**, and **Cancel**. Preserve leading zeros. Hide the entry when the employee leaves this screen. |
| 3. Follow the guide | After a successful claim, show “Register your face for [first name] at [site]”, the biometric notice, **Agree and start camera**, and **Cancel**. | Display a face outline and a single instruction at a time. Collect three accepted samples automatically in one capture. Show **Saving…**, then **Face registered** only after the server confirms. |
| Finish | **Check in** and **Finish**. The employee app shows **Registered**. | Check in starts the ordinary punch flow and gets its own receipt. Finish clears the shared screen. Enrollment itself creates no punch. |

The employee completes registration independently. Their signed-in account and possession of the code connect the person at the kiosk to their staff record. A shared code could enroll the person holding it, so the app tells the employee to keep it private. HR can help with an unlinked account or missing assignment. Once an employee registers, registration closes across all sites for that employee until HR explicitly resets it. Other employees can keep using the shared kiosk.

## UI and recovery

Keep ELT's warm paper, dark buttons and orange accents. Use a readable serif display face for headings, a humanist sans serif for instructions and labels, and clearly spaced tabular numerals for the registration code. Provide local font fallbacks. The linked preview uses Georgia, Segoe UI and Bahnschrift. On the app, place the registration card above receipts and keep it tied to the signed-in person when a manager switches the receipt selector. Render the code in two groups of three visually and expose it as six individual digits to screen readers. Offer **Do this later** before issuance. Existing enrollees see **Registered** immediately. Hide code generation, reissue and self-reset actions for them. In the kiosk, use a single real text input with numeric keyboard support, paste, selection, deletion, leading zeros and an inline error message.

On Android, place **Set up biometric** on the idle home screen. Keep an in-progress punch or pending retry intact. Use 48 dp touch targets, high contrast, large text and TalkBack labels. Keep progress outside the preview, announce accepted samples and avoid flashing or forced head movements. Clear digits after a claim and clear identity and camera state on cancel, timeout, background or finish.

| Situation | Recovery |
| --- | --- |
| Incorrect, expired, used or wrong-site code | Show “This code didn’t work. Check the six digits and your site, or get a new code in Attendance.” A rejected claim reveals no identity. If the kiosk is temporarily rate-limited, give the wait time. |
| App closed before code entry | On return, show current status. If the employee can no longer see the digits, **Get a new code** replaces the old unclaimed code. |
| Wrong name or declined notice | **Cancel** clears the kiosk and releases the session. The employee starts again from their own signed-in app. |
| Poor light, multiple people or denied camera access | Give one specific next action, such as “One person at a time” or “Allow camera access”. Allow another capture within a valid session. |
| Connection drops while saving | Show **Checking registration…**. Use a fresh signed status request to recover a committed result. Ask for another capture only after the server confirms there was no save and the session is still valid. |
| Already registered | Show **Registered** across the employee’s account, including after refresh, sign-in, transfer or site change. Only an explicit HR reset reopens it. |

## Account, code and kiosk contract

**Scope.** An invited employee must be signed in and linked to an active employee with a current site assignment. Only a registered, active kiosk at that site can claim a code. Keep the six-digit employee code separate from the existing privileged operator credential. Add dedicated first-enrollment endpoints and reuse the existing signing, liveness, Play Integrity, encryption and capture components.

| Caller | Proposed API | Contract |
| --- | --- | --- |
| Employee app | `GET /api/me/face-enrollment` | Return account-wide registration availability plus eligible sites and attendance readiness. Derive identity from the verified session, never from the receipt selector. |
| Employee app | `POST /api/me/face-enrollment/codes` | Validate site and eligibility. Issue a uniformly random six-digit string over HTTPS with `no-store`, expiry and a non-secret request reference. Display it only in the initiating session. Make duplicate taps idempotent. A deliberate reissue invalidates the old unclaimed code atomically. |
| Registered kiosk | `POST /api/kiosk/enrollment-claim` | Verify a fresh device signature that binds the code and claim request ID. Derive site from the registered device. Atomically consume one unexpired code at that site and bind its session to this kiosk. An equivalent retry from that kiosk recovers a lost claim response. |
| Registered kiosk | `POST /api/kiosk/enrollment-complete` | Bind consent notice version, session and fresh signed capture evidence. Verify Play Integrity and live samples. Recheck active employee, kiosk and assignment. Insert the first template and completion record in one transaction. An existing site/employee template cannot be replaced. |
| Registered kiosk | `POST /api/kiosk/enrollment-status` and `POST /api/kiosk/enrollment-cancel` | Authenticate the bound device. A committed result remains recoverable after timeout or restart. A cancelled or expired session cannot subsequently commit. |

**Defaults for the pilot.** Codes expire five minutes after issue, using server time. Use a separate five-minute capture window after a successful claim. Keep one active enrollment per employee across sites. Serialize claims, reissues, cancellation and completion. A second kiosk cannot take over a claimed session. On loss of an issuance response, return status for the same request and allow an explicit reissue. Keep one non-secret recovery reference on the kiosk if needed. Never persist camera frames for retry.

**Protect short codes.** Generate digits with a cryptographic random source, enforce uniqueness among live codes at each site and retry collisions. Store a keyed digest scoped to the site. Apply shared server-side limits per employee for issuance and per device and site for failed claims, with cooldown and expiry. Rate limits must count failed transactions and survive service restarts. Mask code input in diagnostics and exclude codes, credentials, identifiers paired with codes, biometrics and request bodies from logs, analytics, URLs and real employee screenshots.

**Data changes.** Add a versioned migration for enrollment sessions and the data needed to enforce limits. Keep earlier migrations immutable. Include new tables in the migrator's row security and grant restrictions. Record consent version and completion time under ELT's retention policy. Use the existing encrypted template store and apply a first-enrollment-only write rule. Model the durable states as issued → claimed → completed, with expired, cancelled or superseded as applicable. Backfill the employee-level lock for anyone with an existing template at any site. Keep site eligibility for punching distinct from availability for registration.

## HR reset and repeat registration

- Keep a durable employee-level registration record with a revision. Issuance, reissue, claim, and completion must check the same record on the server. A committed registration closes all four paths, including attempts from another site or an older client. Preserve authenticated receipt/status recovery for an already completed request.
- Add a dedicated HR mutation, proposed as `POST /api/hr/employees/:id/face-registration/reset`. Require verified HR permission and MFA. Show the employee and effect before confirmation. On commit, record the HR actor, employee, reason and time, retire active templates at every site, invalidate existing codes and claims, increment the revision, and reopen this employee’s registration. Preserve attendance history. Serialize reset and completion on the employee record and verify revisions to reject stale operations.
- Apply the same lock to the existing operator enrollment-code and template-replacement paths. The existing template upsert must not bypass HR reset. A site transfer, expiry, sign-out, restart, or second device never opens registration. Do not grant reset permission through manager/receipt access.
- Verify duplicate enrollment across sites and clients, old-code and in-flight submission after reset, denied employee/manager reset, cancelled HR confirmation, and one successful fresh enrollment after an authorized reset. The shared kiosk must still serve a different eligible employee.
- The interactive preview uses a fictional employee, a local registered flag and an explicitly labeled HR role simulation. Production authorization and the durable registration lock belong on the server.

## Multi-agent execution

| Owner | Scope | Deliverable |
| --- | --- | --- |
| Manas · coordinator | Shared contracts, platform routes, migrations runner and integration tests | Freeze the request/response examples, state transitions and errors. Assign one writer per shared file. Own integration, verification and GitHub handoff. |
| Agent A · backend | Access and biometrics features and their tests | Own the employee-level lock, audited HR reset, employee/site eligibility, code issuance, rate limits, signed claim, consent, atomic completion and recovery. Publish typed interfaces before client integration. |
| Agent B · employee app | Existing employee web portal and UI tests | Deliver **Register my face**, code display, expiry, reissue, site selection when needed, and registered status. Build the HR-only reset screen with an explicit confirmation. Check mobile width, keyboard navigation and accessible digits. |
| Agent C · Android | Android kiosk and feature tests | Deliver **Set up biometric**, numeric entry, consent, capture guidance, confirmation, first check-in and session cleanup. Reuse the existing device keys, capture engine and transport. |

Start with the shared contract and storyboard. Build all three lanes against the same synthetic cases. Integrate the backend before testing both clients together. Each agent reports changed files, the commands actually run, results and remaining external checks.

## Sanity checks and delivery

1. Read the repository instructions and establish a baseline. Preserve existing work. Inspect the diff and run type checks, tests and migration checks on a disposable database.
2. Exercise leading zeros, duplicate taps, random code collisions, expired and replaced codes, wrong sites, two simultaneous kiosk claims, throttling across restarts, lost claim/save responses, cancellation races, revoked assignments and existing templates. Check that retries create at most one enrollment and enrollment creates no attendance event.
3. Run `npm run check`, the new browser journeys and the Android unit, lint and debug assembly tasks. The prior review found a schedule test expecting a valid 366-day range to fail. Report the current baseline and run any later suites separately if the chain stops. Review code and staged diffs, run `git diff --check` and `git diff --cached --check`, and inspect staged content for secrets or real biometric data.
4. On a registered Play test-track phone, have a first-time employee get a code, enter it independently, register and check in. Verify the same receipt in the portal. Exercise expiry and recovery after a network interruption. Capture sanitized results and distinguish physical checks from synthetic tests.
5. Verify the Genius Mundi GitHub owner, exact Attendance repository, default branch, push access and relationship to local history. The earlier checkout had no Git remote. Confirm the URL if ambiguous. Push the reviewed feature branch, open a pull request, verify its remote SHA and report CI. Keep a draft while required checks are pending. Merge and production rollout stay with the repository owner.

## Manas execution prompt

**Role:** Act as Manas, lead engineer and release coordinator for ELT Attendance. Coordinate one backend agent, one employee app agent and one Android agent.

**Context:** Work in the existing Attendance checkout. Read AGENTS.md, CODEMAP.md, contracts/kiosk.md, this plan and the linked storyboard. Employees already sign in to linked accounts, and registered Android kiosks already support live face capture.

**Task:** Deliver first-time self-service face registration. (1) Baseline the checkout and agree on the shared contract. (2) Build **Register my face** in the employee app to issue a six-digit code. (3) Build **Set up biometric** on the Android kiosk to accept that code and guide the employee through consent and one live capture. (4) Confirm the save, close registration across sites until an explicit HR reset, and offer a separate check-in. (5) Review the complete code diff and run the sanity checks, browser, Android and physical tests listed above. (6) Verify the Genius Mundi Attendance repository, push the reviewed feature branch and open a PR.

**Constraints:** Preserve existing edits and apply the same HR-reset requirement to every enrollment entry point. Require an authenticated employee and an eligible site kiosk. Keep codes short-lived, single-use and rate-limited. Use synthetic fixtures and keep secrets and biometric data out of logs and Git. Never force-push.

**Output Format:** Report employee experience, changes by agent, sanity checks and test results, GitHub repository/branch/SHA/PR/CI, and remaining physical pilot checks.
