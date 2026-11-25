# Kiosk biometric service

The server uses the same PostgreSQL transaction as the punch write. Ordinary punch verification checks the registered kiosk signature, action, nonce, challenge lifetime, canonical employee template, and current employee/site assignment. Play Integrity is independently verified on the server. A committed identical retry can recover its receipt after challenge expiry.

## First-time employee self-service enrollment

`server.ts` publishes the following server-only typed functions from `self-service.ts` for the portal and kiosk route owner:

- `getFaceEnrollmentStatus(tx, { employeeId, actor? }): Promise<FaceEnrollmentStatus>` — employee identity must come from `resolveAuthenticatedSubject`; returns active sites, readiness, account-wide registration/revision, active code metadata (never the code), notice, and server-computed reset eligibility.
- `issueFaceEnrollmentCode(tx, { employeeId, siteId, requestId, reissue }): Promise<IssueEnrollmentResult>` — returns `{ state: 'issued', requestId, siteId, code, expiresAt, recovered }` or a durable `rate_limited` result. A same-ID replay returns `code: null, recovered: true`.
- `claimFaceEnrollment(tx, body, proof): Promise<ClaimEnrollmentResult>` — device ID/site are resolved from the registered device and the signed proof uses `elt-enrollment-claim-v1`; the rejected outcome is intentionally non-identifying.
- `completeFaceEnrollment(tx, body): Promise<{ state: 'completed'; completedAt: string }>` — signature and Play Integrity bind the session, consent version, request ID, normalized embedding and capture metrics; capture metrics are not accepted as a standalone liveness assertion.
- `getFaceEnrollmentSessionStatus(tx, body, proof): Promise<EnrollmentSessionStatus>` and `cancelFaceEnrollment(tx, body, proof)` — signed, kiosk-bound recovery and cancellation operations.
- `resetFaceRegistration(tx, { employeeId, requestId, reason }, actor): Promise<...>` — rechecks HR/ADMIN AAL2 authorization, retires all active templates, invalidates pending operator/self-service enrollments, increments revision and writes an idempotent audit row.

`IssueEnrollmentResult` and `ClaimEnrollmentResult` represent throttled/rejected outcomes as values rather than exceptions so their durable PostgreSQL counters can commit. `platform/api.ts` owns the portal and kiosk routes and commits these outcomes before mapping them to HTTP error responses; throwing inside the transaction would roll back the throttle.

A single encrypted canonical template and revision belong to each employee across all sites. The kiosk roster and punch verification serve that template only to active employees currently assigned to the requesting kiosk's active site. Site transfers do not reopen registration or copy templates. Only an authorized HR reset can retire the canonical template and reopen enrollment. Enrollment never produces a punch, receipt or attendance outbox event.

The old supervised operator `enrollFace` path remains separate from six-digit employee self-service. It uses the same employee registration row lock and revision, rejects an already-registered employee, and performs insert-only template linking. It cannot overwrite an existing canonical template. Only the offline operator may issue the legacy long secret; this is not the employee's six-digit code.

Apply `migrations/001_biometrics.sql` followed by `migrations/002_face_enrollment.sql`. `scripts/migrate.ts` enables RLS and revokes Data API access for the registration, enrollment-request, rate-limit and reset-audit tables. Migration 002 backfills existing templates into employee-wide registrations and retires duplicate legacy rows, retaining one deterministic canonical row.

## Configuration

- `KIOSK_ENROLLMENT_CODE_KEY_HEX`: persistent, server-only 32-byte HMAC key in 64 hexadecimal characters, independent of the encryption key. The code digest is HMAC-SHA-256 over a domain-separated payload including the site ID.
- `KIOSK_FACE_ENROLLMENT_NOTICE_VERSION` and `KIOSK_FACE_ENROLLMENT_NOTICE_TEXT`: approved notice configuration. If absent, issuance/claim is unavailable.
- `KIOSK_TEMPLATE_KEY_HEX`: persistent 32-byte AES-256-GCM key. Templates authenticate their original site, employee and template identifiers; retain this key in secure backups.
- `KIOSK_PLAY_SERVICE_ACCOUNT_JSON` and `KIOSK_PLAY_CERT_SHA256`: server-only Google Play Integrity verifier settings.
- `DATABASE_URL`: required only by offline provisioning. Keep privileged database credentials out of public services and logs.

The employee code is a cryptographically generated six-digit string with leading zeroes preserved, expires after five minutes according to PostgreSQL time, and is returned only on the initial HTTPS response. Do not store it in a URL, browser persistence, analytics, logs, diagnostics, or screenshots. Kiosk retries retain only request/session references, not the code, camera pixels or embedding. Failed claims and issuance limits are persisted in PostgreSQL.

The Android client evidence trust model remains the registered-device P-256 signature, Play Integrity request binding, and existing signed capture-validation metrics. The server does not trust a bare liveness flag. Physical camera, integrity and latency acceptance still require separate real-device verification.

## Provisioning and checks

After migration and access assignment setup, register only supervised device keys with the offline operator command. For legacy supervised enrollment, pipe its high-entropy secret through stdin and never place it in shell history:

Schedule `expire.sql` hourly with database-operator privileges to purge expired legacy codes, old device proof/challenge rows, and enrollment rate-limit buckets older than seven days. Self-service enrollment history and reset audit rows are retained for ELT's configured retention policy.

```powershell
node --experimental-strip-types features/biometrics/provision.ts register DEVICE_UUID SITE_UUID PUBLIC_SPKI
$EltEnrollmentCode = Read-Host 'One-time enrollment code' -MaskInput
$EltEnrollmentCode | node --experimental-strip-types features/biometrics/provision.ts enrollment-code DEVICE_UUID EMPLOYEE_UUID
Remove-Variable EltEnrollmentCode
```

Feature test commands:

```powershell
node --experimental-strip-types --experimental-test-isolation=none --test features/biometrics/biometrics.test.ts features/biometrics/self-service.test.ts
node --experimental-strip-types --test --experimental-test-isolation=none features/access/access.test.ts
```

The biometrics tests use synthetic identities and in-memory SQL fakes for code formatting/digest scope, portal readiness, employee-bound issuance/recovery, same-kiosk claim recovery, signed completion, encrypted first-template-only insertion, no attendance side effects, and HR reset idempotency, in addition to the original evidence tests. Access database tests require `ACCESS_TEST_DATABASE_URL`; the overall feature runner uses a disposable database.
