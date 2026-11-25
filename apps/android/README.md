# ELT Attendance Android kiosk

The kiosk captures a fresh front-camera sequence after an employee selects **Check in (IN)** or **Check out (OUT)**. It verifies liveness, matches one employee in the active roster for this site, signs the evidence with its registered hardware-backed key, and displays the server’s recorded time after a committed receipt arrives. A timeout or lost connection leaves one encrypted request for **Retry pending punch**, including after app restart.

## Build

Use JDK 17 or newer with the Android SDK Platform 36 installed and `ANDROID_HOME` pointing to the SDK. The Gradle wrapper fetches the four pinned model assets and verifies SHA-256 before packaging. The resulting app targets ARM64. Camera testing requires an Android 12 or newer front camera declaring a real-time timestamp source. Complete server punches require a registered device, Play Integrity configuration, and a Play-recognized app installed from an authorized test/release track; a sideloaded debug APK cannot establish Play recognition.

```powershell
Set-Location apps/android
.\gradlew.bat :app:assembleDebug :app:lintDebug
.\gradlew.bat :app:bundleRelease
```

Release packaging uses an ELT-owned upload keystore supplied through the process/CI environment variables `ELT_UPLOAD_KEYSTORE_FILE`, `ELT_UPLOAD_KEYSTORE_PASSWORD`, `ELT_UPLOAD_KEY_ALIAS`, and `ELT_UPLOAD_KEY_PASSWORD`. The `.env.example` entries are dummy placeholders: Gradle does not load that file. Keep the actual keystore outside the repository, provide passwords through a protected build environment, and never commit or print them. Release tasks fail closed when variables or the keystore file are missing. The release bundle needs an authorized Google Play testing/release track before a device can satisfy `PLAY_RECOGNIZED`. Enable Play Integrity for the app, link the Cloud project, enable the optional strong device integrity verdict, and provide the attendance server with the app signing certificate digest and authorized service account. Do not package the Play service-account credential in the app.

## First-run setup: unmanaged or managed phone

1. Install `com.elt.attendance.kiosk`, grant camera access, and keep the phone clock synchronized. On an unmanaged phone, first-run setup asks for the HTTPS attendance-service origin, linked Play Integrity cloud project number, and a new 8–12 digit local admin PIN. The app creates a device UUID and a hardware-backed P-256 key in Android Keystore. The PIN is stored only as a salted PBKDF2 hash in app-private storage; repeated incorrect PINs trigger escalating delays. Do not uninstall or clear app data after registration, because the Android Keystore key is tied to this installation.
2. Under direct supervision, copy the device UUID and public key from the app. An authorized database operator registers them against an active site using the offline [biometric provisioning command](../../features/biometrics/README.md). There is deliberately no unauthenticated public endpoint that can bind a device to a site. The private signing key never leaves Android Keystore. Do not enter a site UUID from an unverified source.
3. After device registration, open **Device administrator setup**, enter the local PIN, and choose kiosk mode or supervised employee enrollment. For enrollment, enter one employee UUID at a time. The employee must have an active assignment to the device’s site, and a supervisor must issue a fresh single-use 15-minute enrollment code using the operator command. Complete ELT’s approved biometric notice/consent process in person before confirming the on-screen checkbox; then enter the code while the employee presents their live face. Three live samples are combined locally; camera frames are not saved or uploaded, and the resulting embedding is sent for encrypted server-side storage. Repeat with a fresh code for each employee.
4. In kiosk mode, the registered phone requests the active site roster, verifies a fresh live face, signs the evidence with its device key, and asks the server to commit a punch. It displays success only after the server receipt arrives. **Face camera self-test (no record)** uses local liveness models only; it does not identify an employee, contact the server, test Play Integrity, or create an attendance record.
5. Existing Android Enterprise managed configuration remains supported. It can supply `deviceId`, `baseUrl`, `cloudProject`, `mode`, and (for enrollment) `employeeId` through the declared restrictions. On a normal unmanaged phone the app can be exited and the device is not locked down. It starts lock-task mode only when Android device policy has allowlisted the app; enforced kiosk/lockdown behavior still requires Android Enterprise management.

A debug APK signed with the Android debug key is suitable only for local camera checks and ordinary UI testing. It is not signed by ELT’s upload key and cannot satisfy `PLAY_RECOGNIZED`; server punch and enrollment verification must be tested with the authorized Play test-track build and the real deployed service. Release signing values are build-process variables, not in-app setup values, and the dummy `.env.example` entries are never used for signing.

## Model provenance and checks

- YuNet March 2023 detection model under MIT and SFace December 2021 recognition model under Apache 2.0. Both run with OpenCV and are distributed with the [OpenCV Zoo source](https://github.com/opencv/opencv_zoo/tree/48b10fa505aeb51fbd127fc60a5c660040e823b7/models).
- MiniFASNet V2 and V1SE liveness models under Apache 2.0 from [MiniVision Silent-Face](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing/tree/b6d5f04ad78778917853b25c778acef6d5626d15), with pinned [ONNX conversions](https://github.com/QingHeYang/Silent-Face-Anti-Spoofing-onnx/tree/584d4421d7ac42c59e640796f46e886b0095367a) running in ONNX Runtime.
- Redistribution terms ship in the app’s [license assets](app/src/main/assets/licenses). The feature server’s synthetic tests are documented in the [biometric service README](../../features/biometrics/README.md).

Before rollout, verify on the managed front camera that an enrolled employee can record both actions and read the same receipt in the portal. Measure capture and commit latency at the site. Try an unenrolled person, two people in the frame, a photograph, a screen replay, low light, and an interrupted network connection with an unresolved punch. Calibrate the biometric thresholds from observed results before broader deployment.
