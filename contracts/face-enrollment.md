# First-time face enrollment contract

<!-- PURPOSE: Freeze the self-service face-enrollment API, durable states, and authorization boundary shared by the portal, kiosk, biometrics, and access features. -->

## Scope and invariants

First-time self-service enrollment is separate from the existing privileged operator code and from attendance punches. A verified employee account issues a short-lived code; a registered kiosk at the code’s site claims it; the kiosk presents the employee-specific notice and captures live evidence; the server commits exactly one first template. Registration itself creates no punch, receipt, correction, or attendance outbox event. A later check-in uses the ordinary punch challenge and receipt flow.

Identity comes from trusted records only: portal employee identity from the verified Supabase subject link; kiosk site from its registered device; claimed employee from the code record; and HR actor/role/MFA from the verified session and access database. Never accept employee or site identity from a client as authority. Invalid, expired, used, or wrong-site code claims use the same non-identifying error.

Maintain one durable registration record and revision per employee across all sites. Backfill it as registered for employees with any existing face template. A site transfer, site change, client upgrade, sign-out, expiry, or kiosk change never reopens registration. The record points to one canonical encrypted template. A roster request may return that template only for employees currently active and assigned to the registered kiosk’s site; do not copy templates to other site rows. Thus registration is account-wide while punch eligibility remains site-specific.

Every issuance, reissue, claim, completion, cancellation, and HR reset serializes against the same employee registration row and validates its revision. Existing template rows are never overwritten. Only an authorized HR reset may retire them and reopen registration. Completion rechecks employee, assignment, kiosk, session expiry, and revision in its commit transaction.

## Employee portal API

All portal routes require a valid, non-anonymous Supabase bearer session. Use the linked active employee returned by `resolveAuthenticatedSubject`; do not use the receipt selector, a client-supplied employee ID, or a query parameter to determine the employee. Responses are JSON, `Cache-Control: private, no-store`, and served only over HTTPS.

### `GET /api/me/face-enrollment`

Return current account-wide state:

```json
{
  "registered": false,
  "registrationRevision": 1,
  "registrationAvailable": true,
  "eligibleSites": [{ "siteId": "<uuid>", "siteName": "<name>" }],
  "attendanceReadiness": { "activeEmployee": true, "activeSiteAssignmentCount": 1 },
  "activeCodeRequest": null,
  "notice": { "version": "<version>", "text": "<approved employee notice>" },
  "canReset": false
}
```

`eligibleSites` contains active assignments to active sites. The portal selects the sole eligible site automatically and asks only when there are multiple. `registrationAvailable` is false if the employee is already registered, has no eligible assignment, or the required notice configuration is missing. `attendanceReadiness` reports active employee/site-assignment readiness separately from registration availability. `activeCodeRequest`, when present, contains only the non-secret request ID, site ID, state, and expiry—never the code. `canReset` is computed server-side and is true only for a verified HR/ADMIN actor with AAL2.

### `POST /api/me/face-enrollment/codes`

Request:

```json
{ "siteId": "<uuid>", "requestId": "<uuid>", "reissue": false }
```

Issue a uniformly random six-digit **string**, preserving leading zeroes. Expire it five minutes after issuance according to PostgreSQL server time. Store only a keyed, site-scoped digest for claim lookup. Enforce live-code uniqueness within the site and retry cryptographic collisions. The HMAC key is a server-only 32-byte setting, separate by domain from the biometric template key. Enforce durable shared issuance limits per employee.

A first successful response is:

```json
{ "state": "issued", "requestId": "<uuid>", "siteId": "<uuid>", "code": "005194", "expiresAt": "<UTC ISO instant>", "recovered": false }
```

The code is returned only in this HTTPS response and held in the initiating browser session’s memory. Never write it to URLs, browser storage, logs, analytics, diagnostics, or screenshots. Repeating the same request ID is idempotent and never mints another code; because plaintext is not stored, an idempotent recovery response has `"code": null` and `"recovered": true`. The employee must explicitly reissue if the original response was lost. Reissue uses a new request ID and `reissue: true`; it atomically supersedes the prior unclaimed code. A different request ID without explicit reissue cannot silently replace an active code.

## Registered kiosk API

Kiosk routes require an active registered device, HTTPS, and a fresh P-256 device signature. The signed canonical payload includes the operation domain, device ID, request ID, issue time, and every operation-specific field; validate proof freshness and reject altered payloads. The server derives site from the registered device. A kiosk keeps only non-secret request/session references for recovery; it never persists the six digits, camera pixels, capture metrics, or embedding for retry.

### `POST /api/kiosk/enrollment-claim`

Body: `{ "deviceId": "<uuid>", "requestId": "<stable claim UUID>", "code": "005194" }` and `X-Kiosk-Proof` signed under `elt-enrollment-claim-v1`, binding the exact code and request ID.

Atomically verify the device, site, site-scoped keyed digest, code expiry, employee activity/assignment, employee registration lock/revision, and rate limit. Consume one code and bind a five-minute capture session to that kiosk. An equivalent retry using the same stable claim request ID, same code digest, and same kiosk returns the original claimed session; changed payloads or a second kiosk cannot take over. A rejected claim reveals no identity and is counted against a durable device/site failed-claim limit. Return `KIOSK_ENROLLMENT_REJECTED` for incorrect, expired, used, superseded, or wrong-site codes; use `KIOSK_ENROLLMENT_RATE_LIMIT` with a wait duration when throttled.

Successful response:

```json
{
  "state": "claimed",
  "sessionId": "<uuid>",
  "claimRequestId": "<uuid>",
  "employeeFirstName": "<first name>",
  "siteName": "<site name>",
  "registrationRevision": 1,
  "notice": { "version": "<version>", "text": "<approved employee notice>" },
  "captureExpiresAt": "<UTC ISO instant>"
}
```

Only a successful code claim may reveal the employee name, and only to the kiosk bound to the session. The notice version/text is deployment-configured and must be shown before capture; never claim consent if the notice is absent.

### `POST /api/kiosk/enrollment-complete`

Body: `{ "deviceId", "claimRequestId", "sessionId", "requestId", "issuedAt", "consentVersion", "consented": true, "embedding": [128 normalized integers], "frames": [three signed sample-metric tuples], "integrityToken", "signature" }`. The signature and Play Integrity request hash bind the session, consent version, request ID, embedding, and sample metrics. Do not accept a client-provided liveness-pass flag as proof. Reuse the existing device signing, Play Integrity, capture, encryption, and evidence-verification components.

In one database transaction, lock/recheck the employee registration row and the kiosk-bound session; verify active employee, active assignment, active registered kiosk, unexpired capture window, unchanged registration revision, consent version, affirmative consent, and signed live evidence; insert the first encrypted template; link it as the canonical employee template; and mark the session completed. Use insert-only template writes. The committed result is recoverable through status after a timeout or restart. A failed/uncertain client response must never prompt a second capture until status establishes that no commit occurred and the session remains valid.

### `POST /api/kiosk/enrollment-status`

Require a fresh signed device proof binding `claimRequestId` and optional `sessionId`. Return only the durable state (`issued`, `claimed`, `completed`, `expired`, `cancelled`, `superseded`, or `not_found`), with employee first name/site and completion time only when the requesting active device is bound to that session. A fresh status read is the authoritative recovery path after lost claim or save responses.

### `POST /api/kiosk/enrollment-cancel`

Require a fresh signed proof binding `claimRequestId` and `sessionId`. Atomically cancel an uncompleted session. A cancelled, expired, superseded, or stale-revision session can never commit. A repeated cancellation is harmless; status resolves a lost cancellation response.

## HR reset API

### `POST /api/hr/employees/:employeeId/face-registration/reset`

Require a verified, linked HR or ADMIN actor with AAL2. Managers and receipt access never grant this permission. Body: `{ "requestId": "<uuid>", "reason": "<required audit reason>" }`. Before submission, the portal names the employee, states that templates across sites will be retired and pending codes/claims invalidated, and requires a separate confirmation. The server repeats all authorization checks; UI visibility is not authorization.

In one serialized transaction, record HR actor, employee, reason, time, and old/new revision; retire every active template for the employee; invalidate operator codes and all active self-service sessions; increment the employee registration revision; and reopen registration. Preserve all attendance, corrections, and leave history. Idempotent request replay returns the original reset result; a changed payload under the same request ID is rejected.

## Data, privacy, and operational constraints

Append a versioned biometric migration; never edit `001_biometrics.sql`. Add the employee registration/revision, self-service session lifecycle, durable rate-limit, and reset-audit data. Backfill registration locks for every employee with an existing template. Include every new sensitive table in the migration runner’s RLS enablement and Data API grant revocation. Keep reset audit metadata, consent version, and completion time according to ELT’s retention policy; do not store raw camera frames or plaintext codes. Expire/cancel sessions with database server time. Persist failed-claim and issuance limits in PostgreSQL so restarts and multiple service instances do not reset them.

Use the existing encrypted template store; template access through a kiosk roster is limited to active employees currently assigned to that kiosk’s site. A single employee-wide registration remains registered after site transfer without copying or re-enrolling a template. HR reset is the only re-enrollment path.

Required server settings: `KIOSK_ENROLLMENT_CODE_KEY_HEX` (persistent 32-byte keyed-digest secret), `KIOSK_FACE_ENROLLMENT_NOTICE_VERSION`, and `KIOSK_FACE_ENROLLMENT_NOTICE_TEXT` (ELT-approved copy; if absent, self-service issuance/claim is unavailable). The existing `KIOSK_TEMPLATE_KEY_HEX`, Play Integrity configuration, and registered-device keys remain server-side. Never print configuration values.

## Minimum verification cases

Test six digits including leading zeroes; duplicate issuance taps and explicit reissue; collision retry; expiry; wrong site, wrong, used, expired, and superseded codes; durable issuance/claim throttles; two simultaneous kiosk claims; same-kiosk claim recovery; session-bound status/cancel; lost completion response; capture/cancel/expiry/reset races; revoked assignments/devices; existing-template backfill; existing-template first-write protection; cross-site transfer without registration reopening; HR-only AAL2 reset and audit; legacy operator-path lock enforcement; no enrollment punch/receipt/outbox side effects; and one separate successful check-in after registration. Use synthetic identities and disposable databases only.
