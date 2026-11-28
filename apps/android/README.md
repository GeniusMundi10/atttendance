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
3. In normal **kiosk mode**, tap **Set up biometric**, enter the employee’s six-digit code from their own Attendance account, and select **Continue**. The input is a numeric text field: it accepts paste/edit/delete and preserves leading zeroes. Only a successful signed claim reveals the first name and site. Read the server-provided notice and version; enrollment continues only after the employee explicitly agrees. The camera guide walks through five angles, collects three accepted live samples, and announces progress for accessibility. It then shows **Saving registration…** and **Checking registration…**. **Face registered** appears only after a server completion response or signed status confirms completion. A lost claim/save response is resolved through signed status before another capture is allowed. Cancellation, leaving the screen, timeout and finish clear the visible identity and request server cancellation when a claim exists. The kiosk persists only claim/session UUID references for signed recovery; it never persists the code, camera pixels, sample metrics or embedding.
4. After registration, the employee may choose **Check in**, which starts the ordinary live-face punch flow and displays success only after the committed punch receipt arrives, or **Finish** to clear the shared screen. Enrollment itself does not call the punch endpoint or create attendance records. Existing supervised **employee enrollment** mode remains available to the device administrator for the operator lane; its 43-character operator credential and existing endpoint are separate from the employee’s six-digit self-service code and use the backend’s first-template-only contract. **Face camera self-test (no record)** uses local liveness models only; it does not identify an employee, contact the server, test Play Integrity, or create an attendance record.
5. Existing Android Enterprise managed configuration remains supported. It can supply `deviceId`, `baseUrl`, `cloudProject`, `mode`, and (for supervised operator enrollment) `employeeId` through the declared restrictions. On a normal unmanaged phone the app can be exited and the device is not locked down. It starts lock-task mode only when Android device policy has allowlisted the app; enforced kiosk/lockdown behavior still requires Android Enterprise management.

A debug APK signed with the Android debug key is suitable only for local camera checks and ordinary UI testing. It is not signed by ELT’s upload key and cannot satisfy `PLAY_RECOGNIZED`; server punch and enrollment verification must be tested with the authorized Play test-track build and the real deployed service. Release signing values are build-process variables, not in-app setup values, and the dummy `.env.example` entries are never used for signing.

## Hindi voice prompts

The kiosk plays short, packaged Hindi clips for self-service enrollment, daily camera alignment, and live attendance results. The clips use Android media volume. When touch exploration is active, the existing accessibility announcements provide spoken feedback. The setup and camera self-test screens use their visual and accessibility guidance. Pending punch retries display their result silently.

The no-flag generator uses an authorized Azure Speech resource supplied through `SPEECH_KEY` and `SPEECH_REGION`. Alternatively, the explicit `--elevenlabs` mode uses the authorized ElevenLabs voice named `Monika Sogam - Lively E-Com Support`; set `ELEVENLABS_API_KEY` and optionally `ELEVENLABS_VOICE_ID` in the authoring process environment or the root `.env` / `.env.local`. When the voice ID is omitted, the tool uses the key to search and requires exactly one case and whitespace normalized name match. The kiosk plays the packaged MP3 files offline and needs no speech credentials.

ElevenLabs mode requests `eleven_v4` Hindi speech as `mp3_44100_128`, then locally encodes 24 kHz mono MP3 with FFmpeg's `libmp3lame`. Provide FFmpeg on `PATH` or point `FFMPEG_PATH` at its executable. Before synthesis, the tool checks that FFmpeg and `libmp3lame` are available. Its ignored `build/elevenlabs-voice-cache` keeps each validated source response so a failed local conversion can resume without paying for that cue again. Valid existing clips are skipped. For example, with credentials in the root env files:

```powershell
$env:ELEVENLABS_VOICE_ID = 'ohvvU75FpBEB8fdaLOMh'
node --env-file-if-exists=.env --env-file-if-exists=.env.local apps/android/tools/generate-kiosk-voice.mjs --elevenlabs
```

To use the Azure alternative, run `node tools/generate-kiosk-voice.mjs` from `apps/android`. For local validation and Android checks, run:

```powershell
node tools/generate-kiosk-voice.mjs --check
.\gradlew.bat :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

The last three commands run from `apps/android`. If using the bundled FFmpeg package, install it to ignored build storage and set `FFMPEG_PATH` to the bundled executable before running the root-level ElevenLabs command:

```powershell
python -m pip install --target apps/android/build/voice-tools imageio-ffmpeg
$env:FFMPEG_PATH = (python -c "import sys; sys.path.insert(0, r'apps/android/build/voice-tools'); import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())")
```

`--check` requires all 24 clips and validates their MP3 frame headers, sample rate, channel mode, and duration. UI-only builds can run with missing clips and fall back to the existing on-screen instructions. Before rollout, play all clips on the managed kiosk and check pronunciation, volume and TalkBack behavior. Exercise registration, code rejection, pose changes, capture retry, and live punch results. Leave the app during a request and confirm that its result stays silent when you return. Retry a saved punch and verify that its receipt still appears on screen.

## Model provenance and checks

- YuNet March 2023 detection model under MIT and SFace December 2021 recognition model under Apache 2.0. Both run with OpenCV and are distributed with the [OpenCV Zoo source](https://github.com/opencv/opencv_zoo/tree/48b10fa505aeb51fbd127fc60a5c660040e823b7/models).
- MiniFASNet V2 and V1SE liveness models under Apache 2.0 from [MiniVision Silent-Face](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing/tree/b6d5f04ad78778917853b25c778acef6d5626d15), with pinned [ONNX conversions](https://github.com/QingHeYang/Silent-Face-Anti-Spoofing-onnx/tree/584d4421d7ac42c59e640796f46e886b0095367a) running in ONNX Runtime.
- Redistribution terms ship in the app’s [license assets](app/src/main/assets/licenses). The feature server’s synthetic tests are documented in the [biometric service README](../../features/biometrics/README.md).

Before rollout, verify on the managed front camera that an enrolled employee can record both actions and read the same receipt in the portal. Measure capture and commit latency at the site. Try an unenrolled person, two people in the frame, a photograph, a screen replay, low light, and an interrupted network connection with an unresolved punch. Calibrate the biometric thresholds from observed results before broader deployment.
