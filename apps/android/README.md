# ELT Attendance Android kiosk

The kiosk captures a fresh front-camera sequence after an employee selects **Check in (IN)** or **Check out (OUT)**. It verifies liveness, matches one employee in the active roster for this site, signs the evidence with its registered hardware-backed key, and displays the server’s recorded time after a committed receipt arrives. A timeout or lost connection leaves one encrypted request for **Retry pending punch**, including after app restart.

## Build

Use JDK 17 or newer with the Android SDK Platform 36 installed and `ANDROID_HOME` pointing to the SDK. The Gradle wrapper fetches the four pinned model assets and verifies SHA-256 before packaging. The resulting app targets ARM64. Camera and integrity verification require a company-managed Android 12 or newer handset with a front camera declaring a real-time timestamp source. Check support for `MEETS_STRONG_INTEGRITY` on the pilot handset.

```powershell
Set-Location apps/android
.\gradlew.bat :app:assembleDebug :app:lintDebug
.\gradlew.bat :app:bundleRelease
```

Release packaging uses an ELT-owned upload keystore supplied through the process/CI environment variables `ELT_UPLOAD_KEYSTORE_FILE`, `ELT_UPLOAD_KEYSTORE_PASSWORD`, `ELT_UPLOAD_KEY_ALIAS`, and `ELT_UPLOAD_KEY_PASSWORD`. The `.env.example` entries are dummy placeholders: Gradle does not load that file. Keep the actual keystore outside the repository, provide passwords through a protected build environment, and never commit or print them. Release tasks fail closed when variables or the keystore file are missing. The release bundle needs an authorized Google Play testing/release track before a device can satisfy `PLAY_RECOGNIZED`. Enable Play Integrity for the app, link the Cloud project, enable the optional strong device integrity verdict, and provide the attendance server with the app signing certificate digest and authorized service account. Do not package the Play service-account credential in the app.

## Managed provisioning

1. In the company’s device management system, install `com.elt.attendance.kiosk`, grant camera access and add the package to the dedicated device’s lock task allowlist. Set `deviceId` to a fresh device UUID, `baseUrl` to the HTTPS attendance service origin, `cloudProject` to the linked Play Integrity project number, and `mode` to `provision`. Keep the device clock synchronized.
2. Launch the release app under supervision. Use **Copy this device’s public key**, transfer that public key directly to the operator, and register it against the assigned site using the [biometric provisioning command](../../features/biometrics/README.md). Registration binds the directly supervised device key to the site. The app’s private signing key stays in Android Keystore.
3. Ensure the employee has an active assignment to the site. Set `mode` to `enroll` and configure their `employeeId` in the device management system. Issue a single-use enrollment code, restart the app through management after applying the configuration, and enter the code in person while the employee presents their live face. The camera creates three liveness-checked samples and combines them into one template. Frames are processed in memory and only the embedding is uploaded for encrypted template storage.
4. Set `mode` to `kiosk`, clear `employeeId`, and restart the app through management. Run the first check-in, check-out and receipt comparisons with the assigned staff member. Resolve any pending punch before changing the assigned device UUID or origin.

## Model provenance and checks

- YuNet March 2023 detection model under MIT and SFace December 2021 recognition model under Apache 2.0. Both run with OpenCV and are distributed with the [OpenCV Zoo source](https://github.com/opencv/opencv_zoo/tree/48b10fa505aeb51fbd127fc60a5c660040e823b7/models).
- MiniFASNet V2 and V1SE liveness models under Apache 2.0 from [MiniVision Silent-Face](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing/tree/b6d5f04ad78778917853b25c778acef6d5626d15), with pinned [ONNX conversions](https://github.com/QingHeYang/Silent-Face-Anti-Spoofing-onnx/tree/584d4421d7ac42c59e640796f46e886b0095367a) running in ONNX Runtime.
- Redistribution terms ship in the app’s [license assets](app/src/main/assets/licenses). The feature server’s synthetic tests are documented in the [biometric service README](../../features/biometrics/README.md).

Before rollout, verify on the managed front camera that an enrolled employee can record both actions and read the same receipt in the portal. Measure capture and commit latency at the site. Try an unenrolled person, two people in the frame, a photograph, a screen replay, low light, and an interrupted network connection with an unresolved punch. Calibrate the biometric thresholds from observed results before broader deployment.
