# Kiosk biometric service

The server uses the same PostgreSQL transaction as the punch write. Opening a challenge requires the registered kiosk’s P-256 signature. A new punch must match the device, action, nonce, challenge lifetime, enrolled employee and current template. The server checks the signed multi-frame metrics and independently decodes the Google Play Integrity token. An identical committed retry can recover the receipt with its original valid device signature after challenge expiry.

The on-device engine makes the camera liveness and match decisions. Play Integrity verifies the app and hardware integrity and binds its verdict to the evidence hash. The handset evaluates camera frames and performs liveness inference locally. The pilot requires a supervised registered device, manual enrollment, and observed camera acceptance tests.

## Configuration

- `KIOSK_PLAY_SERVICE_ACCOUNT_JSON` is the server-only credentials object for the Cloud project linked to the Play app.
- `KIOSK_PLAY_CERT_SHA256` is the 64-digit hexadecimal SHA-256 digest of the Play app signing certificate.
- `KIOSK_TEMPLATE_KEY_HEX` is the persistent 32-byte AES key in 64-digit hexadecimal form. Keep it in the server secret store. The server seals embeddings with AES-256-GCM and authenticates their employee, site and template identifiers. Secure backups must retain the key.
- `DATABASE_URL` is the operator database connection for provisioning. Keep the operator command off public services.

After migrating and enabling an employee’s site assignment, follow the [managed kiosk setup](../../apps/android/README.md). The enrollment-code command accepts a supervisor-generated, cryptographically random 32-byte base64url secret on standard input. Store the secret in the operator’s approved vault and share it only within the supervised enrollment. The command stores its hash with a fifteen-minute lifetime and never displays the secret. For Windows PowerShell, retrieve it into a masked prompt or approved secret manager and pipe its exact text to the command.

```powershell
node --experimental-strip-types features/biometrics/provision.ts register DEVICE_UUID SITE_UUID PUBLIC_SPKI
$EltEnrollmentCode = Read-Host 'One-time enrollment code' -MaskInput
$EltEnrollmentCode | node --experimental-strip-types features/biometrics/provision.ts enrollment-code DEVICE_UUID EMPLOYEE_UUID
Remove-Variable EltEnrollmentCode
```

To disable a registered kiosk, set its `kiosk_biometric_devices.active` to false through the operator connection. Rotate device keys by registering a new device UUID and retiring the old one. Run [expire.sql](expire.sql) hourly with the database operator privileges. It purges only expiring enrollment codes, proof identifiers, and challenge rows. Enrollment and attendance records have their own lifecycles.

## Checks

```powershell
node --experimental-strip-types --experimental-test-isolation=none --test features/biometrics/biometrics.test.ts
```

These synthetic tests exercise signature binding, proof replay, frame policy, and failure before challenge consumption with Play Integrity unavailable.
