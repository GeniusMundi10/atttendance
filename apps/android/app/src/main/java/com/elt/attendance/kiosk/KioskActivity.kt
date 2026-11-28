// PURPOSE: Drive the managed kiosk camera, explicit IN/OUT flows, supervised enrollment, and receipt display.
package com.elt.attendance.kiosk

import android.Manifest
import android.app.AlertDialog
import android.app.admin.DevicePolicyManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.SpannableStringBuilder
import android.text.style.ForegroundColorSpan
import android.text.style.ImageSpan
import android.content.res.ColorStateList
import android.view.Gravity
import android.hardware.camera2.CameraCharacteristics
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.InputType
import android.text.InputFilter
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import java.util.UUID
import java.time.Instant

internal class KioskActivity : ComponentActivity() {
    private val main = Handler(Looper.getMainLooper())
    private val inference = Executors.newSingleThreadExecutor()
    private val activeCapture = AtomicReference<ActiveCapture?>()
    private val activeSweep = AtomicReference<ActiveSweep?>()
    private val voicePlayer = lazy { KioskVoicePlayer(this) }
    private val voiceVisit = VoiceVisit()
    private val voiceGuidance = VoiceGuidance()
    private var enrollmentVoiceVisit: Int? = null
    @Volatile private var roster: List<Template> = emptyList()
    @Volatile private var trackingEnabled = false
    private var lastTrack = 0L
    private var trackFit = FaceGuideView.Fit.NONE
    private var greetName: String? = null
    private var autoCandidate: String? = null
    private var autoSeenAt = 0L
    private var lastAutoName: String? = null
    private var lastAutoAt = 0L
    private var shownGreeting: String? = null
    private var sweepFit = FaceGuideView.Fit.NONE
    private lateinit var cameraTitle: TextView
    private lateinit var config: KioskConfig
    private lateinit var pendingStore: PendingStore
    private lateinit var api: KioskApi
    private lateinit var play: PlayProof
    private lateinit var root: LinearLayout
    private lateinit var page: LinearLayout
    private lateinit var pageStatus: TextView
    private lateinit var cameraLayer: FrameLayout
    private lateinit var cameraCaption: LinearLayout
    private lateinit var cameraPill: TextView
    private lateinit var pillDot: GradientDrawable
    private lateinit var faceGuide: FaceGuideView
    private lateinit var sheet: LinearLayout
    private lateinit var tools: LinearLayout
    private lateinit var capturePanel: LinearLayout
    private lateinit var captureHeading: TextView
    private var acceptedSamples = 0
    /** Live samples accepted in the running punch scan (of [PUNCH_SAMPLES]). */
    private var punchSamples = 0
    private lateinit var status: TextView
    private lateinit var receiptBanner: TextView
    private lateinit var viewfinder: PreviewView
    private lateinit var actions: LinearLayout
    private lateinit var checkIn: Button
    private lateinit var checkOut: Button
    private lateinit var retry: Button
    private lateinit var enroll: Button
    private lateinit var selfTest: Button
    private lateinit var returnToSetup: Button
    private lateinit var admin: Button
    private lateinit var consent: CheckBox
    private lateinit var codeInput: EditText
    private lateinit var selfCodeInput: EditText
    private lateinit var selfConsent: CheckBox
    private lateinit var enrollmentEntry: LinearLayout
    private lateinit var entryScroll: ScrollView
    private lateinit var enrollmentGuide: LinearLayout
    private lateinit var enrollmentGuideScroll: ScrollView
    private lateinit var enrollmentRecovery: LinearLayout
    private lateinit var enrollmentSuccess: LinearLayout
    private lateinit var enrollmentHeading: TextView
    private lateinit var enrollmentNotice: TextView
    private lateinit var enrollmentInstruction: TextView
    private lateinit var captureProgress: TextView
    private lateinit var recoveryText: TextView
    private lateinit var successText: TextView
    private lateinit var continueEnrollment: Button
    private lateinit var cancelEnrollmentButton: Button
    private lateinit var startEnrollmentCapture: Button
    private lateinit var retryEnrollmentStatus: Button
    private lateinit var cancelRecoveredEnrollment: Button
    private lateinit var checkInAfterEnrollment: Button
    private lateinit var finishEnrollment: Button
    private var firstRunPanel: View? = null
    private var localTestMode = false
    private var camera: ProcessCameraProvider? = null
    private var engine: FaceEngine? = null
    private var pending: PendingPunch? = null
    private lateinit var enrollmentStore: EnrollmentRecoveryStore
    private var enrollmentReference: EnrollmentReference? = null
    private var activeEnrollmentClaim: EnrollmentClaim? = null
    private var ephemeralEnrollmentCode: String? = null
    private var recoveredEmployeeName: String? = null
    private var recoveredSiteName: String? = null
    private var cancellationRequested = false
    private var enrollmentUi = EnrollmentUi.IDLE
    private var visible = false
    private var voiceResumed = false
    private var usable = false
    private var cameraReady = false
    private var busy = false
    private var flow = 0

    private enum class EnrollmentUi { IDLE, ENTRY, CLAIMING, GUIDE, CAPTURING, SAVING, RECOVERING, SUCCESS }
    private data class ActiveCapture(val capture: FaceCapture, val flow: Int, val voiceVisit: Int?) {
        val purpose get() = capture.purpose
    }
    private data class ActiveSweep(val sweep: PoseSweep, val voiceVisit: Int)
    private data class LivePunch(val action: Action, val voiceVisit: Int)

    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        if (allowed) attachCamera() else message("Allow camera access to verify attendance.")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        volumeControlStream = AudioManager.STREAM_MUSIC
        SetupPolicy.allowLoopbackHttp = (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or WindowManager.LayoutParams.FLAG_SECURE)
        drawScreen()
        config = runCatching { KioskConfig.read(this) }.getOrNull() ?: run {
            showFirstRunSetup()
            return
        }
        if (config.mode == Mode.PROVISION) {
            showProvisioning()
            return
        }


        if (config.mode == Mode.ENROLL) enroll.text = "Capture enrollment"
        codeInput.visibility = if (config.mode == Mode.ENROLL) View.VISIBLE else View.GONE
        consent.visibility = if (config.mode == Mode.ENROLL) View.VISIBLE else View.GONE
        pendingStore = PendingStore(applicationContext)
        enrollmentStore = EnrollmentRecoveryStore(applicationContext)
        enrollmentReference = enrollmentStore.read()
        message("Starting kiosk…")
        submit {
            val signer = DeviceSigner(config.deviceId, false)
            play = PlayProof(applicationContext, config.cloudProject)
            api = KioskApi(config, signer, play)
            val saved = pendingStore.read()
            if (saved == null && config.mode == Mode.KIOSK) {
                // A failed warm-up can be retried when an employee starts a punch.
                runCatching { play.prepare(); roster = api.roster() }
            }
            onScreen {
                pending = saved
                usable = true
                if (config.mode == Mode.KIOSK && enrollmentReference != null) {
                    enrollmentUi = EnrollmentUi.RECOVERING
                    message("Checking registration…")
                    recoverEnrollmentStatus(checkNotNull(enrollmentReference), startup = true)
                    if (saved == null) startCamera()
                } else if (saved != null) {
                    message("A punch is awaiting confirmation. Retry to read its receipt.")
                } else {
                    startCamera()
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        visible = true
        if (::config.isInitialized && config.mode == Mode.KIOSK && cameraReady) render()
    }

    override fun onResume() {
        super.onResume()
        voiceVisit.invalidate()
        voiceResumed = true
        if (::config.isInitialized && config.mode == Mode.KIOSK &&
            getSystemService(DevicePolicyManager::class.java).isLockTaskPermitted(packageName)) {
            startLockTask()
        }
    }

    override fun onPause() {
        voiceResumed = false
        resetVoiceVisit()
        super.onPause()
    }

    override fun onStop() {
        visible = false
        trackingEnabled = false
        resetVoiceVisit()
        activeSweep.set(null)
        if (activeCapture.getAndSet(null) != null) finishFlow("Camera capture stopped.")
        if (::enrollmentStore.isInitialized && config.mode == Mode.KIOSK && enrollmentReference != null &&
            enrollmentUi != EnrollmentUi.SUCCESS && enrollmentUi != EnrollmentUi.IDLE) {
            selfCodeInput.setText("")
            requestEnrollmentCancellation("Enrollment was cancelled when the screen left the kiosk.")
        } else if (::selfCodeInput.isInitialized && enrollmentUi == EnrollmentUi.ENTRY) {
            selfCodeInput.setText("")
            enrollmentUi = EnrollmentUi.IDLE
            render()
        }
        super.onStop()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) {
            voiceGuidance.reset()
            if (voicePlayer.isInitialized()) voicePlayer.value.stop()
        }
    }

    override fun onDestroy() {
        if (voicePlayer.isInitialized()) voicePlayer.value.close()
        activeCapture.set(null)
        activeSweep.set(null)
        camera?.unbindAll()
        inference.execute { engine?.close() }
        inference.shutdown()
        main.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun drawScreen() {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(Palette.peachTop, Palette.peachBottom))
        }
        val content = FrameLayout(this)
        root.addView(content, LinearLayout.LayoutParams(-1, 0, 1f))

        // Camera home: full-bleed preview, face oval, camera state pill, and the live status over a scrim.
        cameraLayer = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        viewfinder = PreviewView(this).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        cameraLayer.addView(viewfinder, FrameLayout.LayoutParams(-1, -1))
        faceGuide = FaceGuideView(this)
        cameraLayer.addView(faceGuide, FrameLayout.LayoutParams(-1, -1))
        pillDot = oval(Palette.idleDot, dp(10))
        cameraPill = label(size = 14f, color = Color.WHITE).apply {
            background = rounded(Color.argb(110, 0, 0, 0), dp(18).toFloat())
            setPadding(dp(12), dp(7), dp(14), dp(7))
            compoundDrawablePadding = dp(8)
            setCompoundDrawablesRelativeWithIntrinsicBounds(pillDot, null, null, null)
        }
        cameraLayer.addView(cameraPill, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END).apply { marginEnd = dp(16) })
        cameraCaption = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(Color.argb(175, 0, 0, 0), Color.TRANSPARENT))
            setPadding(dp(24), dp(64), dp(24), dp(48))
        }
        // Committed punch receipt: solid and large so it reads over any camera image.
        receiptBanner = label(size = 18f, color = Color.WHITE, bold = true).apply {
            background = rounded(Palette.green, dp(16).toFloat())
            setPadding(dp(18), dp(12), dp(18), dp(12))
            visibility = View.GONE
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_ASSERTIVE
        }
        cameraCaption.add(receiptBanner)
        cameraTitle = label("Position your face in the frame", 24f, Color.WHITE, bold = true)
        cameraCaption.add(cameraTitle, top = 12)
        status = label(size = 16f, color = Color.WHITE).apply {
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        cameraCaption.add(status, top = 6)
        cameraLayer.addView(cameraCaption, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        content.addView(cameraLayer, FrameLayout.LayoutParams(-1, -1))

        // Page: every non-camera screen (setup, code entry, notice, recovery, success) on the warm background.
        page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            visibility = View.GONE
        }
        page.add(label(size = 20f, bold = true).apply {
            text = SpannableStringBuilder().append("ELT", ForegroundColorSpan(Palette.orange), 0).append(" Attendance")
        })
        pageStatus = label(size = 14f, color = Palette.muted).apply {
            setPadding(0, dp(6), 0, dp(14))
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        page.add(pageStatus)
        content.addView(page, FrameLayout.LayoutParams(-1, -1))

        enrollmentEntry = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            visibility = View.GONE
        }
        enrollmentEntry.add(iconCircle(FingerprintDrawable(Palette.orange, dp(36)), dp(72), Palette.orangeSoft), dp(72), dp(72))
        enrollmentEntry.add(label("Set up biometric", 15f, Palette.muted), top = 8)
        enrollmentEntry.add(label("Enter your six-digit code", 26f, bold = true), top = 4)
        enrollmentEntry.add(label("Get your code in Attendance", 15f, Palette.muted), top = 4)
        selfCodeInput = EditText(this).apply {
            hint = "––––––"
            inputType = InputType.TYPE_CLASS_NUMBER
            filters = arrayOf<InputFilter>(android.text.method.DigitsKeyListener.getInstance("0123456789"), InputFilter.LengthFilter(6))
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            isSaveEnabled = false
            isSingleLine = true
            contentDescription = "Six-digit face enrollment code"
            // The on-screen keypad below replaces the system keyboard; paste and hardware keys still work.
            showSoftInputOnFocus = false
            textSize = 32f
            letterSpacing = .25f
            gravity = Gravity.CENTER
            setTypeface(Typeface.DEFAULT_BOLD)
            setTextColor(Palette.ink)
            setHintTextColor(Palette.line)
            background = rounded(Color.WHITE, dp(18).toFloat(), Palette.line, dp(1))
        }
        enrollmentEntry.add(selfCodeInput, height = dp(68), top = 16)
        continueEnrollment = button("Continue", Look.PRIMARY) { continueSelfServiceEnrollment() }
        cancelEnrollmentButton = button("Cancel") { cancelSelfServiceEnrollment() }
        selfCodeInput.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: android.text.Editable?) {
                continueEnrollment.isEnabled = !busy && EnrollmentPolicy.validCode(s?.toString().orEmpty())
            }
        })
        enrollmentEntry.add(continueEnrollment, top = 12)
        enrollmentEntry.add(cancelEnrollmentButton, top = 8)
        enrollmentEntry.add(keypad(), top = 8)
        entryScroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            addView(enrollmentEntry)
        }
        page.addView(entryScroll, LinearLayout.LayoutParams(-1, 0, 1f))

        enrollmentGuide = card()
        val art = FrameLayout(this)
        art.addView(iconCircle(IconDrawable(Icons.PERSON, Color.rgb(88, 84, 80), dp(72)), dp(136), Palette.orangeSoft),
            FrameLayout.LayoutParams(dp(136), dp(136), Gravity.CENTER))
        art.addView(iconCircle(IconDrawable(Icons.CAMERA_OFF, Palette.orange, dp(26)), dp(52), Palette.orangeSoft).apply {
            background = oval(Palette.orangeSoft).apply { setStroke(dp(4), Color.WHITE) }
        }, FrameLayout.LayoutParams(dp(52), dp(52), Gravity.BOTTOM or Gravity.END))
        enrollmentGuide.add(art, dp(150), dp(150))
        enrollmentHeading = label(size = 26f, bold = true)
        enrollmentGuide.add(enrollmentHeading, top = 18)
        enrollmentGuide.add(label("Used to verify attendance. Camera frames are not saved.", 16f, Palette.muted), top = 8)
        enrollmentGuide.add(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = rounded(Palette.orangeSoft, dp(16).toFloat())
            setPadding(dp(16), dp(14), dp(16), dp(14))
            addView(ImageView(this@KioskActivity).apply {
                setImageDrawable(IconDrawable(Icons.INFO, Palette.orange, dp(24)))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }, LinearLayout.LayoutParams(dp(24), dp(24)))
            addView(label("Registration does not create attendance.", 15f, center = false),
                LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = dp(12) })
        }, top = 18)
        // The server's approved notice must be readable before the employee agrees.
        enrollmentNotice = label(size = 14f, color = Palette.muted, center = false).apply {
            background = rounded(Color.rgb(250, 247, 245), dp(14).toFloat(), Palette.line, dp(1))
            setPadding(dp(14), dp(12), dp(14), dp(12))
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }
        enrollmentGuide.add(enrollmentNotice, top = 12)
        // Agreement is the "Agree and start camera" tap; the box only carries that state into capture.
        selfConsent = CheckBox(this).apply {
            visibility = View.GONE
            setOnCheckedChangeListener { _, _ -> render() }
        }
        enrollmentGuide.add(selfConsent)
        startEnrollmentCapture = button("Agree and start camera", Look.PRIMARY) {
            selfConsent.isChecked = true
            startSelfServiceCapture()
        }
        enrollmentGuide.add(startEnrollmentCapture, top = 20)
        enrollmentGuide.add(button("Cancel") { cancelSelfServiceEnrollment() }, top = 10)
        enrollmentGuideScroll = ScrollView(this).apply {
            visibility = View.GONE
            isVerticalScrollBarEnabled = false
            addView(enrollmentGuide)
        }
        page.addView(enrollmentGuideScroll, LinearLayout.LayoutParams(-1, 0, 1f))

        enrollmentRecovery = card().apply { visibility = View.GONE }
        enrollmentRecovery.add(ProgressBar(this).apply { indeterminateTintList = ColorStateList.valueOf(Palette.orange) }, dp(44), dp(44))
        recoveryText = label(size = 17f)
        enrollmentRecovery.add(recoveryText, top = 16)
        retryEnrollmentStatus = button("Check registration status", Look.PRIMARY) { retryEnrollmentRecovery() }
        cancelRecoveredEnrollment = button("Cancel enrollment") { cancelSelfServiceEnrollment() }
        enrollmentRecovery.add(retryEnrollmentStatus, top = 20)
        enrollmentRecovery.add(cancelRecoveredEnrollment, top = 10)
        page.add(enrollmentRecovery)

        enrollmentSuccess = card().apply { visibility = View.GONE }
        enrollmentSuccess.add(FrameLayout(this).apply {
            background = oval(Palette.orangeSoft)
            addView(ImageView(this@KioskActivity).apply {
                setImageDrawable(IconDrawable(Icons.CHECK, Color.WHITE, dp(44)))
                background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(Palette.orangeLight, Palette.orange))
                    .apply { shape = GradientDrawable.OVAL }
                setPadding(dp(24), dp(24), dp(24), dp(24))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }, FrameLayout.LayoutParams(dp(92), dp(92), Gravity.CENTER))
        }, dp(128), dp(128))
        enrollmentSuccess.add(label("Registered", 14f, Palette.green, bold = true).apply {
            background = rounded(Palette.greenSoft, dp(16).toFloat())
            setPadding(dp(12), dp(6), dp(14), dp(6))
            compoundDrawablePadding = dp(8)
            setCompoundDrawablesRelativeWithIntrinsicBounds(oval(Palette.green, dp(10)), null, null, null)
        }, width = -2, top = 20)
        enrollmentSuccess.add(label("Face registered", 30f, bold = true), top = 12)
        successText = label(size = 16f, color = Palette.muted).apply {
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        enrollmentSuccess.add(successText, top = 6)
        enrollmentSuccess.add(View(this).apply { setBackgroundColor(Palette.line) }, height = dp(1), top = 22)
        enrollmentSuccess.add(label("What would you like to do next?", 17f), top = 20)
        checkInAfterEnrollment = button("Check in  →", Look.PRIMARY) { beginCheckInAfterEnrollment() }
        finishEnrollment = button("Finish") { finishSelfServiceEnrollment() }
        enrollmentSuccess.add(checkInAfterEnrollment, top = 16)
        enrollmentSuccess.add(finishEnrollment, top = 10)
        page.add(enrollmentSuccess)

        // Bottom sheet: punch tiles, biometric setup, capture progress, and the quieter admin links.
        sheet = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val r = dp(28).toFloat()
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
            }
            elevation = dp(8).toFloat()
        }
        actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        checkIn = tile("Check in", Icons.LOGIN) { begin(Action.IN) }
        checkOut = tile("Check out", Icons.LOGOUT) { begin(Action.OUT) }
        actions.addView(checkIn, LinearLayout.LayoutParams(0, dp(118), 1f))
        actions.addView(checkOut, LinearLayout.LayoutParams(0, dp(118), 1f).apply { marginStart = dp(12) })
        sheet.add(actions)
        enroll = button("", Look.OUTLINE) {
            if (::config.isInitialized && config.mode == Mode.KIOSK) openSelfServiceEnrollment() else beginEnrollment()
        }.apply {
            text = SpannableStringBuilder().append("  ", ImageSpan(IconDrawable(Icons.PERSON, Palette.orange, dp(24)).apply {
                setBounds(0, 0, dp(24), dp(24))
            }, ImageSpan.ALIGN_CENTER), 0).append("  Set up biometric")
            contentDescription = "Set up biometric"
        }
        sheet.add(enroll, top = 12)

        capturePanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            visibility = View.GONE
        }
        captureHeading = label(size = 24f, bold = true)
        // The step instruction sits on the camera as a caption pill below the oval, clear of the drawn gestures.
        enrollmentInstruction = label(size = 22f, color = Color.WHITE, bold = true).apply {
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            background = rounded(Color.argb(140, 0, 0, 0), dp(24).toFloat())
            setPadding(dp(20), dp(10), dp(20), dp(10))
            visibility = View.GONE
        }
        cameraLayer.addView(enrollmentInstruction, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL)
            .apply { bottomMargin = dp(52) })
        capturePanel.add(captureHeading)
        captureProgress = label(size = 15f, color = Palette.muted).apply {
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        capturePanel.add(captureProgress, top = 10)
        capturePanel.add(button("Cancel") { cancelSelfServiceEnrollment() }, top = 16)
        sheet.add(capturePanel)

        codeInput = setupField("One-time enrollment code", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD).apply {
            visibility = View.GONE
        }
        sheet.add(codeInput, top = 12)
        consent = CheckBox(this).apply {
            text = "I confirmed the employee completed ELT’s approved biometric notice and consent process."
            visibility = View.GONE
        }
        sheet.add(consent, top = 8)
        retry = button("Retry pending punch", Look.PRIMARY) { retryPunch() }
        sheet.add(retry, top = 12)
        selfTest = button("Test camera", Look.LINK) { beginDiagnostic() }
        returnToSetup = button("Back to device setup", Look.LINK) {
            localTestMode = false
            camera?.unbindAll()
            camera = null
            cameraReady = false
            usable = false
            selfTest.visibility = View.GONE
            returnToSetup.visibility = View.GONE
            firstRunPanel?.visibility = View.VISIBLE
            cameraLayer.visibility = View.GONE
            message("Set up this device to connect attendance, or repeat the local camera test.")
        }.apply { visibility = View.GONE }
        admin = button("Device admin", Look.LINK) { showAdminDialog() }.apply { visibility = View.GONE }
        tools = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_HORIZONTAL
            addView(selfTest)
            addView(returnToSetup)
            addView(admin)
        }
        sheet.add(tools, top = 4)
        root.addView(sheet, LinearLayout.LayoutParams(-1, -2).apply { topMargin = -dp(28) })

        root.setOnApplyWindowInsetsListener { _, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            page.setPadding(dp(20) + bars.left, dp(16) + bars.top, dp(20) + bars.right, dp(36) + bars.bottom)
            (cameraPill.layoutParams as FrameLayout.LayoutParams).topMargin = dp(12) + bars.top
            cameraPill.requestLayout()
            sheet.setPadding(dp(20) + bars.left, dp(22), dp(20) + bars.right, dp(12) + bars.bottom)
            insets
        }
        setContentView(root)
        render()
    }

    private enum class Look { PRIMARY, SECONDARY, OUTLINE, LINK, KEY }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun states(enabled: Int, disabled: Int) =
        ColorStateList(arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()), intArrayOf(disabled, enabled))

    private fun button(label: String, look: Look = Look.SECONDARY, action: () -> Unit): Button = Button(this).apply {
        text = label
        isAllCaps = false
        stateListAnimator = null
        gravity = Gravity.CENTER
        minHeight = dp(if (look == Look.LINK) 44 else 56)
        minimumHeight = minHeight
        textSize = when (look) { Look.LINK -> 14f; Look.KEY -> 26f; else -> 17f }
        setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL))
        val fill = GradientDrawable().apply { cornerRadius = dp(if (look == Look.KEY) 18 else 28).toFloat() }
        when (look) {
            Look.PRIMARY -> {
                fill.setColor(states(Palette.orange, Palette.orangeDisabled))
                setTextColor(Color.WHITE)
                setTypeface(Typeface.DEFAULT_BOLD)
            }
            Look.SECONDARY -> {
                fill.setColor(ColorStateList.valueOf(Color.WHITE))
                fill.setStroke(dp(1), Palette.line)
                setTextColor(states(Palette.ink, Palette.idleDot))
            }
            Look.OUTLINE -> {
                fill.setColor(ColorStateList.valueOf(Color.WHITE))
                fill.setStroke(dp(2), states(Palette.orange, Palette.orangeDisabled))
                setTextColor(states(Palette.orange, Palette.orangeDisabled))
                setTypeface(Typeface.DEFAULT_BOLD)
            }
            Look.KEY -> {
                fill.setColor(ColorStateList.valueOf(Color.argb(200, 255, 255, 255)))
                setTextColor(Palette.ink)
            }
            Look.LINK -> {
                fill.setColor(ColorStateList.valueOf(Color.TRANSPARENT))
                setTextColor(states(Palette.muted, Palette.idleDot))
                setPadding(dp(14), 0, dp(14), 0)
            }
        }
        background = RippleDrawable(ColorStateList.valueOf(Color.argb(34, 0, 0, 0)), fill, null)
        setOnClickListener { action() }
    }

    private fun tile(label: String, icon: String, action: () -> Unit) = button(label, Look.PRIMARY, action).apply {
        textSize = 19f
        setCompoundDrawablesRelativeWithIntrinsicBounds(null, IconDrawable(icon, Color.WHITE, dp(38)), null, null)
        compoundDrawablePadding = dp(8)
        background = RippleDrawable(ColorStateList.valueOf(Color.argb(40, 0, 0, 0)), GradientDrawable().apply {
            cornerRadius = dp(22).toFloat()
            setColor(states(Palette.orange, Palette.orangeDisabled))
        }, null)
    }

    private fun keypad() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        for (row in listOf("123", "456", "789", " 0<")) {
            addView(LinearLayout(this@KioskActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                for (key in row) {
                    val view: View = when (key) {
                        ' ' -> View(this@KioskActivity)
                        '<' -> ImageButton(this@KioskActivity).apply {
                            setImageDrawable(IconDrawable(Icons.BACKSPACE, Palette.ink, dp(26)))
                            background = RippleDrawable(ColorStateList.valueOf(Color.argb(34, 0, 0, 0)),
                                rounded(Color.argb(200, 255, 255, 255), dp(18).toFloat()), null)
                            contentDescription = "Delete last digit"
                            setOnClickListener { selfCodeInput.text.let { if (it.isNotEmpty()) it.delete(it.length - 1, it.length) } }
                        }
                        else -> button(key.toString(), Look.KEY) { selfCodeInput.text.append(key) }
                    }
                    addView(view, LinearLayout.LayoutParams(0, dp(54), 1f).apply { setMargins(dp(5), dp(4), dp(5), dp(4)) })
                }
            }, LinearLayout.LayoutParams(-1, -2))
        }
    }

    private fun label(value: String = "", size: Float, color: Int = Palette.ink, bold: Boolean = false, center: Boolean = true) =
        TextView(this).apply {
            text = value
            textSize = size
            setTextColor(color)
            if (bold) {
                setTypeface(Typeface.DEFAULT_BOLD)
                letterSpacing = -.02f
            }
            if (center) gravity = Gravity.CENTER_HORIZONTAL
        }

    private fun card() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        background = rounded(Color.WHITE, dp(28).toFloat())
        elevation = dp(2).toFloat()
        setPadding(dp(24), dp(28), dp(24), dp(24))
    }

    private fun iconCircle(icon: Drawable, size: Int, fill: Int) = ImageView(this).apply {
        setImageDrawable(icon)
        background = oval(fill)
        val inset = size / 4
        setPadding(inset, inset, inset, inset)
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    private fun LinearLayout.add(view: View, width: Int = -1, height: Int = -2, top: Int = 0) =
        addView(view, LinearLayout.LayoutParams(width, height).apply { topMargin = dp(top) })

    private fun showFirstRunSetup() {
        cameraLayer.visibility = View.GONE
        actions.visibility = View.GONE
        codeInput.visibility = View.GONE
        consent.visibility = View.GONE
        enroll.visibility = View.GONE
        retry.visibility = View.GONE
        selfTest.visibility = View.GONE
        admin.visibility = View.GONE

        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val spacing = (12 * resources.displayMetrics.density).toInt()
            setPadding(0, spacing, 0, spacing)
        }
        panel.add(label("Device setup", 26f, bold = true, center = false))
        panel.add(label("Enter ELT’s HTTPS attendance service and linked Play Integrity project. This phone will create its own hardware-backed device key.",
            15f, Palette.muted, center = false), top = 6)
        val origin = setupField("HTTPS attendance server origin", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        val project = setupField("Play Integrity cloud project number", InputType.TYPE_CLASS_NUMBER)
        val pin = setupField("Create 8–12 digit device admin PIN", InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD)
        val confirmation = setupField("Confirm device admin PIN", InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD)
        panel.add(origin, top = 12)
        panel.add(project, top = 12)
        panel.add(pin, top = 12)
        panel.add(confirmation, top = 12)
        panel.add(button("Save setup and create device key", Look.PRIMARY) {
            val originValue = origin.text.toString()
            val projectValue = project.text.toString()
            val pinValue = pin.text.toString().toCharArray()
            val confirmationValue = confirmation.text.toString().toCharArray()
            pin.text.clear()
            confirmation.text.clear()
            try {
                SetupPolicy.origin(originValue)
                SetupPolicy.cloudProject(projectValue)
                if (!SetupPolicy.validPin(pinValue) || !pinValue.contentEquals(confirmationValue)) {
                    throw IllegalArgumentException("Choose and confirm an 8–12 digit PIN.")
                }
            } catch (failure: Exception) {
                pinValue.fill('\u0000')
                confirmationValue.fill('\u0000')
                message(failure.message ?: "Check the setup fields and try again.")
                return@button
            }
            message("Saving device setup…")
            network.execute {
                try {
                    val saved = LocalDeviceSetup.initialize(applicationContext, originValue, projectValue, pinValue, confirmationValue)
                    onScreen {
                        config = saved
                        firstRunPanel?.visibility = View.GONE
                        showProvisioning()
                    }
                } catch (_: Exception) {
                    onScreen { message("Setup could not be saved. Check the server origin and try again.") }
                } finally {
                    pinValue.fill('\u0000')
                    confirmationValue.fill('\u0000')
                }
            }
        }, top = 20)
        panel.add(button("Test camera and liveness only (no record)") { startLocalCameraTest() }, top = 10)

        val scroll = ScrollView(this).apply {
            isFillViewport = true
            addView(panel)
        }
        firstRunPanel = scroll
        page.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        message("No managed setup is required. Set up the phone here, or run a local camera test first.")
    }

    private fun setupField(hintText: String, type: Int) = EditText(this).apply {
        hint = hintText
        inputType = type
        textSize = 16f
        background = rounded(Color.WHITE, dp(14).toFloat(), Palette.line, dp(1))
        setPadding(dp(16), dp(14), dp(16), dp(14))
        isSaveEnabled = false
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
    }

    private fun startLocalCameraTest() {
        localTestMode = true
        firstRunPanel?.visibility = View.GONE
        cameraLayer.visibility = View.VISIBLE
        selfTest.visibility = View.VISIBLE
        returnToSetup.visibility = View.VISIBLE
        usable = true
        cameraReady = false
        message("Local camera self-test: no attendance data will be sent or recorded.")
        startCamera()
    }

    private fun showAdminDialog() {
        val current = LocalDeviceSetup.read(this) ?: run {
            message("Local administrator setup is unavailable. Contact your system administrator.")
            return
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val spacing = (12 * resources.displayMetrics.density).toInt()
            setPadding(spacing, spacing, spacing, 0)
        }
        content.addView(TextView(this).apply {
            text = "Changing mode requires the local admin PIN. Employee face enrollment also needs an active site assignment and a fresh one-time code from the attendance operator."
        })
        val modes = RadioGroup(this).apply { orientation = RadioGroup.VERTICAL }
        val kioskOption = RadioButton(this).apply { id = View.generateViewId(); text = "Attendance kiosk" }
        val enrollOption = RadioButton(this).apply { id = View.generateViewId(); text = "Supervised employee enrollment" }
        modes.addView(kioskOption)
        modes.addView(enrollOption)
        if (current.mode == Mode.ENROLL) enrollOption.isChecked = true else kioskOption.isChecked = true
        content.addView(modes)
        val employee = setupField("Employee UUID for enrollment", InputType.TYPE_CLASS_TEXT)
        employee.setText(current.employeeId.orEmpty())
        employee.visibility = if (enrollOption.isChecked) View.VISIBLE else View.GONE
        content.addView(employee, LinearLayout.LayoutParams(-1, -2))
        modes.setOnCheckedChangeListener { _, checkedId ->
            employee.visibility = if (checkedId == enrollOption.id) View.VISIBLE else View.GONE
        }
        val pin = setupField("Device admin PIN", InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD)
        content.addView(pin, LinearLayout.LayoutParams(-1, -2))
        val feedback = TextView(this)
        content.addView(feedback)
        val dialog = AlertDialog.Builder(this)
            .setTitle("Device administrator")
            .setView(content)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Save mode", null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val mode = if (enrollOption.isChecked) Mode.ENROLL else Mode.KIOSK
                val employeeId = employee.text.toString()
                val pinValue = pin.text.toString().toCharArray()
                pin.text.clear()
                try {
                    if (!SetupPolicy.validPin(pinValue)) throw IllegalArgumentException("Enter the device admin PIN.")
                    if (mode == Mode.ENROLL) SetupPolicy.employeeId(employeeId)
                } catch (failure: Exception) {
                    pinValue.fill('\u0000')
                    feedback.text = failure.message ?: "Check the employee ID and try again."
                    return@setOnClickListener
                }
                feedback.text = "Saving device mode…"
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
                network.execute {
                    val saved = runCatching {
                        LocalDeviceSetup.setMode(applicationContext, pinValue, mode, employeeId.takeIf { mode == Mode.ENROLL })
                    }.isSuccess
                    pinValue.fill('\u0000')
                    onScreen {
                        if (saved) {
                            dialog.dismiss()
                            recreate()
                        } else {
                            feedback.text = "PIN not accepted or mode could not be saved. Try again."
                            dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = true
                        }
                    }
                }
            }
        }
        dialog.setOnDismissListener { pin.text.clear() }
        dialog.show()
    }

    private fun showProvisioning() {
        cameraLayer.visibility = View.GONE
        actions.visibility = View.GONE
        codeInput.visibility = View.GONE
        consent.visibility = View.GONE
        enroll.visibility = View.GONE
        retry.visibility = View.GONE
        selfTest.visibility = View.GONE
        returnToSetup.visibility = View.GONE
        firstRunPanel?.visibility = View.GONE
        admin.visibility = LocalDeviceSetup.isConfigured(this).let { if (it) View.VISIBLE else View.GONE }
        admin.text = "Configure kiosk or employee enrollment mode"
        submit {
            val key = DeviceSigner(config.deviceId, true).publicKey()
            onScreen {
                page.add(TextView(this).apply {
                    text = "Device ID: ${config.deviceId}\n\nPublic key: $key\n\nRegister this ID and public key against an active ELT site using the trusted operator provisioning command. Do not enter a site ID supplied by an unverified source."
                    textSize = 15f
                }, top = 12)
                page.add(button("Copy this device ID") {
                    getSystemService(ClipboardManager::class.java).setPrimaryClip(
                        ClipData.newPlainText("Kiosk device ID", config.deviceId)
                    )
                    message("Device ID copied. Keep it with the supervised device-registration request.")
                }, top = 12)
                page.add(button("Copy this device’s public key") {
                    val clipboard = getSystemService(ClipboardManager::class.java)
                    clipboard.setPrimaryClip(ClipData.newPlainText("Kiosk public key", key))
                    message("Public key copied. Register it for this device and its assigned site.")
                }, top = 12)
                message("This device key is ready. Site registration is an operator-controlled step; no MDM is needed.")
            }
        }
    }

    private fun startCamera() {
        if (camera != null) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            attachCamera()
        } else permission.launch(Manifest.permission.CAMERA)
    }

    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    private fun attachCamera() {
        if (camera != null) return
        message("Starting front camera…")
        inference.execute {
            try {
                if (engine == null) engine = FaceEngine(applicationContext)
                onScreen {
                    val future = ProcessCameraProvider.getInstance(this)
                    future.addListener({
                        if (isDestroyed) return@addListener
                        try {
                            val provider = future.get()
                            val preview = Preview.Builder().build().also { it.surfaceProvider = viewfinder.surfaceProvider }
                            val analysis = ImageAnalysis.Builder()
                                .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                                .build().also { it.setAnalyzer(inference, ::analyze) }
                            val front = provider.bindToLifecycle(this, CameraSelector.DEFAULT_FRONT_CAMERA, preview, analysis)
                            val timestampSource = Camera2CameraInfo.from(front.cameraInfo)
                                .getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE)
                            if (timestampSource != CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME) {
                                provider.unbindAll()
                                error("Camera clock cannot verify fresh frames")
                            }
                            camera = provider
                            cameraReady = true
                            message(if (::config.isInitialized && config.mode == Mode.ENROLL) "Supervised employee enrollment" else "Select an action or run the local camera test.")
                        } catch (_: Exception) {
                            message("This front camera cannot verify fresh frames.")
                        }
                    }, ContextCompat.getMainExecutor(this))
                }
            } catch (_: Exception) {
                onScreen { message("The face verification models could not start.") }
            } catch (_: LinkageError) {
                onScreen { message("The face verification runtime is unavailable on this device.") }
            }
        }
    }

    private fun begin(action: Action) {
        if (!canCapture()) return
        val currentFlow = startFlow("Connecting to attendance…")
        val visit = voiceVisit.current()
        submit(currentFlow) {
            play.prepare()
            val roster = api.roster().also { this.roster = it }
            if (roster.isEmpty()) throw CaptureRejected("No active faces are enrolled for this site.")
            val challenge = api.challenge(action)
            onScreen { startCapture(currentFlow, CapturePurpose.Punch(action, challenge, roster), visit) }
        }
    }

    private fun beginDiagnostic() {
        if (!usable || !cameraReady || !visible || busy || pending != null) return
        val currentFlow = startFlow("Look at the front camera for the live-face self-test…")
        startCapture(currentFlow, CapturePurpose.Diagnostic)
    }

    private fun beginEnrollment() {
        if (!canCapture()) return
        if (!consent.isChecked) {
            message("Confirm the employee completed ELT’s approved biometric notice and consent process before enrollment.")
            return
        }
        val code = codeInput.text.toString()
        if (!secretPattern.matches(code)) {
            message("Enter the one-time enrollment code issued by your supervisor.")
            return
        }
        val employee = checkNotNull(config.employeeId)
        codeInput.text.clear()
        val currentFlow = startFlow("Preparing supervised enrollment…")
        submit(currentFlow) {
            play.prepare()
            onScreen { startCapture(currentFlow, CapturePurpose.Enrollment(employee, code)) }
        }
    }

    private fun openSelfServiceEnrollment() {
        if (config.mode != Mode.KIOSK || !usable || !visible || busy || pending != null) return
        if (cancellationRequested || enrollmentReference != null || enrollmentUi == EnrollmentUi.RECOVERING) {
            retryEnrollmentRecovery()
            return
        }
        resetVoiceVisit()
        activeEnrollmentClaim = null
        selfCodeInput.setText("")
        enrollmentUi = EnrollmentUi.ENTRY
        cameraLayer.visibility = View.GONE
        message("Enter the six-digit code from the employee’s Attendance app.")
        speak(VoiceCue.REGISTER_START, voiceVisit.current())
        selfCodeInput.requestFocus()
    }

    private fun continueSelfServiceEnrollment() {
        if (config.mode != Mode.KIOSK || enrollmentUi != EnrollmentUi.ENTRY || busy || pending != null || cancellationRequested) return
        val code = selfCodeInput.text.toString()
        if (!EnrollmentPolicy.validCode(code)) {
            message("Enter all six digits, including any zeroes at the beginning.")
            return
        }
        val reference = EnrollmentReference(UUID.randomUUID().toString(), null)
        try {
            enrollmentStore.write(reference)
        } catch (_: Exception) {
            message("Enrollment recovery could not be saved. Try again before claiming the code.")
            return
        }
        enrollmentReference = reference
        ephemeralEnrollmentCode = code
        selfCodeInput.setText("")
        enrollmentUi = EnrollmentUi.CLAIMING
        val currentFlow = startFlow("Checking code…")
        val visit = voiceVisit.current()
        enrollmentVoiceVisit = visit
        network.execute {
            try {
                play.prepare()
                val claim = api.claimEnrollment(reference.claimRequestId, code)
                acceptEnrollmentClaim(claim, currentFlow, visit)
            } catch (failure: Exception) {
                if (failure is ApiRejected && failure.code == "KIOSK_ENROLLMENT_REJECTED") {
                    if (cancellationRequested || flow != currentFlow) return@execute
                    runCatching { enrollmentStore.clear() }
                    onScreen {
                        enrollmentReference = null
                        ephemeralEnrollmentCode = null
                        activeEnrollmentClaim = null
                        cancellationRequested = false
                        clearGuideIdentity()
                        enrollmentUi = EnrollmentUi.ENTRY
                        finishEnrollmentFlow("This code didn’t work. Check the six digits and your site, or tap Regenerate code in the Attendance app.")
                        speak(VoiceCue.CODE_REJECTED, visit)
                    }
                } else {
                    resolveClaimFailure(reference, failure, visit)
                }
            }
        }
    }

    private fun acceptEnrollmentClaim(claim: EnrollmentClaim, currentFlow: Int? = null, visit: Int? = null) {
        val reference = EnrollmentReference(claim.claimRequestId, claim.sessionId)
        enrollmentStore.write(reference)
        enrollmentReference = reference
        ephemeralEnrollmentCode = null
        activeEnrollmentClaim = claim
        onScreen {
            if (!visible) {
                requestEnrollmentCancellation("Enrollment was cancelled when the screen left the kiosk.")
            } else if (currentFlow == null || flow == currentFlow) {
                enrollmentUi = EnrollmentUi.GUIDE
                enrollmentHeading.text = "Register your face for ${claim.employeeFirstName} at ${claim.siteName}"
                enrollmentNotice.text = "Notice · version ${claim.notice.version}\n\n${claim.notice.text}"
                selfConsent.text = "I have read and agree to this notice (version ${claim.notice.version})."
                selfConsent.isChecked = false
                enrollmentInstruction.text = "Read the notice before agreeing to start the camera."
                captureProgress.text = "One live check uses three accepted samples."
                finishEnrollmentFlow("Code accepted. Review the notice and confirm only if you agree.")
                speak(VoiceCue.CONSENT, visit)
            }
        }
    }

    private fun resolveClaimFailure(reference: EnrollmentReference, failure: Exception, visit: Int) {
        try {
            val recovered = api.enrollmentStatus(reference)
            val fallback = if (failure is ApiRejected && failure.code == "KIOSK_ENROLLMENT_RATE_LIMIT") {
                "Too many code attempts. ${failure.waitSeconds?.let { "Wait $it seconds, then retry status." } ?: "Wait before trying again."}"
            } else "Checking registration…"
            handleEnrollmentStatus(reference, recovered, startup = false, fallbackMessage = fallback, visit = visit)
        } catch (_: Exception) {
            onScreen {
                enrollmentUi = EnrollmentUi.RECOVERING
                recoveryText.text = "Checking registration… The result is not confirmed yet. Do not enter another code or retry capture."
                finishEnrollmentFlow("Checking registration…")
                speak(VoiceCue.CHECKING, visit)
            }
        }
    }

    private fun retryEnrollmentRecovery() {
        val reference = enrollmentReference ?: return
        recoverEnrollmentStatus(reference, startup = false)
    }

    private fun recoverEnrollmentStatus(reference: EnrollmentReference, startup: Boolean) {
        val visit = enrollmentVoiceVisit.takeUnless { startup || cancellationRequested }
        enrollmentUi = EnrollmentUi.RECOVERING
        recoveryText.text = "Checking registration…"
        render()
        speak(VoiceCue.CHECKING, visit)
        network.execute {
            try {
                val status = api.enrollmentStatus(reference)
                handleEnrollmentStatus(reference, status, startup, "Checking registration…", visit)
            } catch (_: Exception) {
                onScreen {
                    enrollmentUi = EnrollmentUi.RECOVERING
                    recoveryText.text = "Checking registration… The result is not confirmed yet. Do not start another capture."
                    message("Checking registration…")
                }
            }
        }
    }

    private fun handleEnrollmentStatus(
        reference: EnrollmentReference,
        result: EnrollmentStatus,
        startup: Boolean,
        fallbackMessage: String,
        visit: Int? = null,
    ) {
        when (result.state) {
            "completed" -> {
                enrollmentStore.clear()
                enrollmentReference = null
                ephemeralEnrollmentCode = null
                cancellationRequested = false
                val name = result.employeeFirstName ?: activeEnrollmentClaim?.employeeFirstName ?: recoveredEmployeeName
                val site = result.siteName ?: activeEnrollmentClaim?.siteName ?: recoveredSiteName
                onScreen { showEnrollmentSuccess(name, site, visit) }
            }
            "claimed" -> {
                val sessionId = result.sessionId ?: reference.sessionId
                if (sessionId == null) {
                    onScreen {
                        enrollmentUi = EnrollmentUi.RECOVERING
                        recoveryText.text = "The claim is still being checked. Do not capture again."
                        message("Checking registration…")
                    }
                    return
                }
                val updated = EnrollmentReference(reference.claimRequestId, sessionId)
                enrollmentStore.write(updated)
                enrollmentReference = updated
                val knownClaim = activeEnrollmentClaim?.takeIf {
                    it.claimRequestId == updated.claimRequestId && it.sessionId == sessionId && Instant.now().isBefore(it.captureExpiresAt)
                }
                if (knownClaim != null) {
                    onScreen {
                        activeEnrollmentClaim = knownClaim
                        enrollmentUi = EnrollmentUi.GUIDE
                        enrollmentHeading.text = "Register your face for ${knownClaim.employeeFirstName} at ${knownClaim.siteName}"
                        enrollmentNotice.text = "Notice · version ${knownClaim.notice.version}\n\n${knownClaim.notice.text}"
                        selfConsent.text = "I have read and agree to this notice (version ${knownClaim.notice.version})."
                        selfConsent.isChecked = false
                        enrollmentInstruction.text = "Read the notice before agreeing to start the camera."
                        finishEnrollmentFlow(fallbackMessage)
                        speak(VoiceCue.CAPTURE_RETRY, visit)
                    }
                    return
                }
                val code = ephemeralEnrollmentCode
                if (code != null) {
                    try {
                        acceptEnrollmentClaim(api.claimEnrollment(updated.claimRequestId, code), visit = visit)
                    } catch (_: Exception) {
                        ephemeralEnrollmentCode = null
                        cancelClaimAndResolve(updated, "The claim could not be restored. Ask the employee to tap Regenerate code in the Attendance app.")
                    }
                } else {
                    // Status omits the approved notice, so a recovered claim without in-memory claim details is cancelled.
                    cancelClaimAndResolve(updated, "The saved claim was recovered. Ask the employee to tap Regenerate code in the Attendance app.")
                }
            }
            "issued", "expired", "cancelled", "superseded", "not_found" -> {
                if (cancellationRequested && !startup) return
                enrollmentStore.clear()
                enrollmentReference = null
                ephemeralEnrollmentCode = null
                activeEnrollmentClaim = null
                cancellationRequested = false
                onScreen {
                    clearGuideIdentity()
                    if (startup && pending != null) {
                        enrollmentUi = EnrollmentUi.IDLE
                        message("A punch is awaiting confirmation. Retry to read its receipt.")
                    } else {
                        enrollmentUi = if (startup) EnrollmentUi.IDLE else EnrollmentUi.ENTRY
                        selfCodeInput.setText("")
                        finishEnrollmentFlow(if (result.state == "cancelled" || result.state == "expired" || result.state == "superseded")
                            "Enrollment did not complete. Tap Regenerate code in the Attendance app to start again."
                        else fallbackMessage)
                    }
                }
            }
        }
    }

    private fun cancelClaimAndResolve(reference: EnrollmentReference, messageAfter: String) {
        activeEnrollmentClaim = null
        ephemeralEnrollmentCode = null
        recoveredEmployeeName = null
        recoveredSiteName = null
        cancellationRequested = true
        busy = false
        flow += 1
        onScreen { clearGuideIdentity() }
        try {
            api.cancelEnrollment(reference)
            val status = api.enrollmentStatus(reference)
            if (status.state in setOf("cancelled", "expired", "superseded", "not_found", "issued")) {
                enrollmentStore.clear()
                enrollmentReference = null
                activeEnrollmentClaim = null
                ephemeralEnrollmentCode = null
                cancellationRequested = false
                onScreen {
                    enrollmentUi = if (visible) EnrollmentUi.ENTRY else EnrollmentUi.IDLE
                    selfCodeInput.setText("")
                    finishEnrollmentFlow(messageAfter)
                }
            } else if (status.state == "completed") {
                handleEnrollmentStatus(reference, status, startup = false, fallbackMessage = messageAfter)
            } else {
                onScreen {
                    enrollmentUi = EnrollmentUi.RECOVERING
                    recoveryText.text = "Cancellation is still being confirmed. Do not capture again."
                    finishEnrollmentFlow("Checking registration…")
                }
            }
        } catch (_: Exception) {
            onScreen {
                    enrollmentUi = EnrollmentUi.RECOVERING
                    recoveryText.text = "Cancellation could not be confirmed. Check registration status before continuing."
                    finishEnrollmentFlow("Checking registration…")
            }
        }
    }

    private fun cancelSelfServiceEnrollment() {
        selfCodeInput.setText("")
        activeCapture.set(null)
        activeSweep.set(null)
        ephemeralEnrollmentCode = null
        val reference = enrollmentReference
        if (reference == null) {
            resetVoiceVisit()
            activeEnrollmentClaim = null
            cancellationRequested = false
            clearGuideIdentity()
            enrollmentUi = EnrollmentUi.IDLE
            cameraLayer.visibility = View.VISIBLE
            message("Enrollment cancelled. Select an action or set up biometric.")
        } else {
            requestEnrollmentCancellation("Enrollment cancelled. Tap Regenerate code in the Attendance app to start again.")
        }
    }

    private fun requestEnrollmentCancellation(messageAfter: String) {
        resetVoiceVisit()
        val reference = enrollmentReference ?: run {
            onScreen { activeEnrollmentClaim = null; enrollmentUi = EnrollmentUi.IDLE; message(messageAfter) }
            return
        }
        activeCapture.set(null)
        activeSweep.set(null)
        ephemeralEnrollmentCode = null
        activeEnrollmentClaim = null
        recoveredEmployeeName = null
        recoveredSiteName = null
        clearGuideIdentity()
        cancellationRequested = true
        busy = false
        flow += 1
        enrollmentUi = EnrollmentUi.RECOVERING
        recoveryText.text = "Checking registration…"
        render()
        network.execute {
            try {
                val status = api.enrollmentStatus(reference)
                if (status.state == "completed") {
                    handleEnrollmentStatus(reference, status, startup = false, fallbackMessage = messageAfter)
                } else if (status.state == "claimed") {
                    val sessionId = status.sessionId ?: reference.sessionId
                    if (sessionId == null) error("Claim session is not available for cancellation")
                    val updated = EnrollmentReference(reference.claimRequestId, sessionId)
                    enrollmentStore.write(updated)
                    enrollmentReference = updated
                    cancelClaimAndResolve(updated, messageAfter)
                } else if (status.state in setOf("issued", "expired", "cancelled", "superseded", "not_found")) {
                    enrollmentStore.clear()
                    enrollmentReference = null
                    activeEnrollmentClaim = null
                    cancellationRequested = false
                    onScreen {
                        enrollmentUi = EnrollmentUi.IDLE
                        cameraLayer.visibility = View.VISIBLE
                        message(messageAfter)
                    }
                }
            } catch (_: Exception) {
                onScreen {
                    enrollmentUi = EnrollmentUi.RECOVERING
                    recoveryText.text = "Cancellation could not be confirmed. Check registration status before continuing."
                    message("Checking registration…")
                }
            }
        }
    }

    private fun startSelfServiceCapture() {
        val claim = activeEnrollmentClaim ?: return
        if (enrollmentUi != EnrollmentUi.GUIDE || pending != null || busy || cancellationRequested) return
        if (claim.notice.version.isBlank() || claim.notice.text.isBlank()) {
            message("The approved notice is unavailable. Enrollment cannot continue.")
            cancelSelfServiceEnrollment()
            return
        }
        if (!selfConsent.isChecked) {
            message("Read the notice, then tap Agree and start camera.")
            return
        }
        if (!Instant.now().isBefore(claim.captureExpiresAt)) {
            requestEnrollmentCancellation("The enrollment session expired. Tap Regenerate code in the Attendance app to start again.")
            return
        }
        if (!cameraReady) {
            message("Allow camera access and wait for the front camera to be ready.")
            startCamera()
            return
        }
        val currentFlow = startFlow("Look at the front camera. Keep one face centered.")
        val visit = voiceVisit.current()
        enrollmentVoiceVisit = visit
        enrollmentUi = EnrollmentUi.CAPTURING
        acceptedSamples = 0
        sweepFit = FaceGuideView.Fit.NONE
        enrollmentInstruction.text = PoseSweep.prompts[0]
        captureProgress.text = "Step 1 of ${PoseSweep.prompts.size + 1}"
        render()
        playCameraVoice(voiceGuidance.startPose(SystemClock.elapsedRealtime()), visit)
        startSweep(ActiveSweep(PoseSweep(claim, currentFlow, roster), visit))
    }

    private fun showEnrollmentSuccess(employeeName: String?, siteName: String?, visit: Int?) {
        val enteringSuccess = enrollmentUi != EnrollmentUi.SUCCESS
        network.execute { runCatching { roster = api.roster() } }
        activeCapture.set(null)
        activeSweep.set(null)
        activeEnrollmentClaim = null
        ephemeralEnrollmentCode = null
        selfCodeInput.setText("")
        recoveredEmployeeName = employeeName
        recoveredSiteName = siteName
        clearGuideIdentity()
        val who = listOfNotNull(employeeName, siteName).joinToString(" · ")
        successText.text = listOf(who, "Registration is confirmed.\nNo attendance record was created.")
            .filter { it.isNotEmpty() }.joinToString("\n")
        enrollmentUi = EnrollmentUi.SUCCESS
        if (pending == null) {
            busy = false
            message("Face registered. Registration was confirmed by the server.")
            if (enteringSuccess) speak(VoiceCue.REGISTERED, visit)
        } else message("A punch is awaiting confirmation. Retry to read its receipt.")
    }

    private fun beginCheckInAfterEnrollment() {
        if (pending != null) {
            message("Retry the pending punch before starting another check-in.")
            return
        }
        activeEnrollmentClaim = null
        recoveredEmployeeName = null
        recoveredSiteName = null
        clearGuideIdentity()
        successText.text = ""
        enrollmentUi = EnrollmentUi.IDLE
        render()
        begin(Action.IN)
    }

    private fun finishSelfServiceEnrollment() {
        resetVoiceVisit()
        activeCapture.set(null)
        activeSweep.set(null)
        selfCodeInput.setText("")
        selfConsent.isChecked = false
        clearGuideIdentity()
        successText.text = ""
        activeEnrollmentClaim = null
        recoveredEmployeeName = null
        recoveredSiteName = null
        enrollmentUi = EnrollmentUi.IDLE
        cameraLayer.visibility = View.VISIBLE
        message("Select an action or set up biometric.")
    }

    private fun clearGuideIdentity() {
        enrollmentHeading.text = ""
        enrollmentNotice.text = ""
        selfConsent.text = ""
        selfConsent.isChecked = false
        enrollmentInstruction.text = ""
        captureProgress.text = ""
    }

    private fun startCapture(currentFlow: Int, purpose: CapturePurpose, visit: Int? = null) {
        if (flow != currentFlow) return
        if (!visible) {
            if (purpose is CapturePurpose.SelfServiceEnrollment) {
                requestEnrollmentCancellation("Enrollment was cancelled when the screen left the kiosk.")
            } else finishFlow("Camera capture stopped. Select an action to try again.")
            return
        }
        punchSamples = 0
        val capture = FaceCapture(purpose) { accepted ->
            if (purpose is CapturePurpose.Punch) onScreen {
                if (flow != currentFlow) return@onScreen
                punchSamples = accepted
                render()
            }
            if (purpose is CapturePurpose.SelfServiceEnrollment) onScreen {
                if (flow != currentFlow || !visible || enrollmentUi != EnrollmentUi.CAPTURING) return@onScreen
                val progress = "Final live check: $accepted of 3"
                acceptedSamples = PoseSweep.prompts.size + (if (accepted >= 3) 1 else 0)
                captureProgress.text = progress
                enrollmentInstruction.text = if (accepted < 3) "Hold still" else "Saving…"
                captureProgress.announceForAccessibility(progress)
                render()
            }
        }
        val active = ActiveCapture(capture, currentFlow, visit)
        activeCapture.set(active)
        message("Look at the front camera and keep your face centered.")
        render()
        main.postDelayed({
            if (activeCapture.compareAndSet(active, null)) {
                if (purpose is CapturePurpose.SelfServiceEnrollment) {
                    requestEnrollmentCancellation("Face capture timed out. Tap Regenerate code in the Attendance app to start again.")
                } else finishFlow("Face capture timed out. Try again.")
            }
        }, 9000)
    }

    private fun analyze(image: androidx.camera.core.ImageProxy) {
        activeSweep.get()?.let { sweep ->
            try { stepSweep(sweep, image) } finally { image.close() }
            return
        }
        val active = activeCapture.get()
        if (active == null) {
            try { trackIdle(image) } finally { image.close() }
            return
        }
        try {
            val result = active.capture.accept(image, checkNotNull(engine)) ?: return
            if (activeCapture.compareAndSet(active, null)) onScreen {
                if (flow != active.flow) return@onScreen
                if (visible && busy) completeCapture(active.purpose, result, active.voiceVisit)
                else finishFlow("Camera capture stopped. Select an action to try again.")
            }
        } catch (rejected: CaptureRejected) {
            if (activeCapture.compareAndSet(active, null)) onScreen {
                if (flow != active.flow) return@onScreen
                if (active.purpose is CapturePurpose.SelfServiceEnrollment) {
                    if (rejected.displayMessage.contains("timed out", ignoreCase = true)) {
                        requestEnrollmentCancellation("Face capture timed out. Tap Regenerate code in the Attendance app to start again.")
                    } else {
                        stopCameraVoice()
                        enrollmentUi = EnrollmentUi.GUIDE
                        selfConsent.isChecked = false
                        enrollmentInstruction.text = rejected.displayMessage
                        captureProgress.text = "Capture stopped. Read the notice and agree again to retry."
                        finishFlow(rejected.displayMessage)
                        speak(VoiceCue.CAPTURE_RETRY, active.voiceVisit)
                    }
                } else finishFlow(rejected.displayMessage)
            }
        } catch (_: Exception) {
            if (activeCapture.compareAndSet(active, null)) onScreen {
                if (flow != active.flow) return@onScreen
                if (active.purpose is CapturePurpose.SelfServiceEnrollment) {
                    stopCameraVoice()
                    enrollmentUi = EnrollmentUi.GUIDE
                    selfConsent.isChecked = false
                    enrollmentInstruction.text = "Camera verification failed. Read the notice and agree again to retry."
                    finishFlow("Camera verification failed. Read the notice and agree to try again.")
                    speak(VoiceCue.CAPTURE_RETRY, active.voiceVisit)
                } else finishFlow("Camera verification failed. Try again.")
            }
        } finally {
            image.close()
        }
    }

    private fun completeCapture(purpose: CapturePurpose, result: CaptureResult, visit: Int?) {
        if (purpose is CapturePurpose.Diagnostic) {
            finishFlow("Live-face camera self-test passed. Nothing was recorded or sent.")
            return
        }
        if (purpose is CapturePurpose.SelfServiceEnrollment) stopCameraVoice()
        if (purpose is CapturePurpose.SelfServiceEnrollment && !selfConsent.isChecked) {
            enrollmentUi = EnrollmentUi.GUIDE
            finishFlow("Agreement was withdrawn. Read the notice and agree before trying again.")
            return
        }
        val currentFlow = flow
        if (purpose is CapturePurpose.SelfServiceEnrollment) enrollmentUi = EnrollmentUi.SAVING
        message(if (purpose is CapturePurpose.SelfServiceEnrollment) "Saving registration…" else "Confirming with attendance…")
        submit(currentFlow) {
            when (purpose) {
                is CapturePurpose.Punch -> {
                    val body = api.preparePunch(purpose.action, purpose.challenge, checkNotNull(result.template), result.frames)
                    val saved = PendingPunch(config.origin, config.deviceId, body, checkNotNull(result.template).displayName)
                    pendingStore.write(saved)
                    // The face is verified and the signed punch is stored durably; tell the employee now, confirm below.
                    onScreen { message("✓ ${capturedLabel(saved, purpose.action)} captured · confirming…") }
                    deliver(saved, visit?.let { LivePunch(purpose.action, it) })
                }
                is CapturePurpose.Enrollment -> {
                    api.enroll(purpose.employeeId, purpose.code, checkNotNull(result.embedding), result.frames)
                    onScreen {
                        consent.isChecked = false
                        finishFlow("Face enrollment saved.")
                    }
                }
                is CapturePurpose.SelfServiceEnrollment -> saveSelfServiceEnrollment(purpose.claim, result, visit)
                is CapturePurpose.Diagnostic -> Unit
            }
        }
    }

    private fun saveSelfServiceEnrollment(claim: EnrollmentClaim, result: CaptureResult, visit: Int?) {
        val reference = enrollmentReference ?: return
        enrollmentUi = EnrollmentUi.SAVING
        try {
            api.completeEnrollment(claim, consented = true, embedding = checkNotNull(result.embedding), frames = result.frames)
        } catch (rejected: ApiRejected) {
            if (rejected.code == "FACE_ALREADY_REGISTERED") {
                // The server already cancelled this session; this face belongs to a registered employee.
                onScreen {
                    greetAlreadyRegistered(rejected.registeredName?.substringBefore(' ') ?: "there", cancelOnServer = false, visit = visit)
                }
                return
            }
        } catch (_: Exception) {
            // Resolve the durable server state below before allowing any new capture.
        }
        onScreen {
            enrollmentUi = EnrollmentUi.RECOVERING
            recoveryText.text = "Checking registration…"
            message("Checking registration…")
            speak(VoiceCue.CHECKING, visit)
        }
        try {
            val status = api.enrollmentStatus(reference)
            handleEnrollmentStatus(reference, status, startup = false,
                fallbackMessage = "Registration was not confirmed. Review the notice and agree before trying again.", visit = visit)
        } catch (_: Exception) {
            onScreen {
                enrollmentUi = EnrollmentUi.RECOVERING
                recoveryText.text = "Checking registration… The save result is not confirmed. Do not capture again."
                message("Checking registration…")
            }
        }
    }

    private fun retryPunch() {
        val saved = pending ?: return
        if (saved.origin != config.origin || saved.deviceId != config.deviceId) return
        if (busy) {
            main.postDelayed({ retryPunch() }, 10_000)
            return
        }
        startFlow("Syncing your punch…")
        submit { deliver(saved) }
    }

    private fun deliver(saved: PendingPunch, live: LivePunch? = null) {
        val receipt = try {
            api.submitPunch(saved)
        } catch (rejected: ApiRejected) {
            pendingStore.clear()
            onScreen {
                pending = null
                if (rejected.code == "ATTENDANCE_ACTION_ORDER") {
                    val cue = PunchVoice.forOrderError(rejected, saved)
                    val text = alreadyDone(saved, cue, rejected.lastPunchAt)
                    finishFlow(text)
                    showBanner(text, Palette.orange)
                    speak(cue, live?.voiceVisit)
                } else if (rejected.code == "ATTENDANCE_OUT_TOO_SOON") {
                    val text = outTooSoon(saved, rejected)
                    finishFlow(text)
                    showBanner(text, Palette.orange)
                } else finishFlow(rejectionMessage(rejected.code))
                startCamera()
            }
            return
        } catch (_: Exception) {
            onScreen {
                pending = saved
                finishFlow("✓ Punch captured on this kiosk${saved.displayName.takeIf { it.isNotBlank() }?.let { " for ${it.substringBefore(' ')}" }.orEmpty()}. Syncing automatically…")
                // ponytail: one stored punch at a time, retried every 10 s; a multi-slot queue if offline spells get long.
                main.postDelayed({ retryPunch() }, 10_000)
            }
            return
        }
        pendingStore.clear()
        onScreen {
            pending = null
            startCamera()
            val action = if (receipt.action == Action.IN) "Punched in" else "Punched out"
            val time = java.time.format.DateTimeFormatter.ofPattern("d MMM, h:mm:ss a", java.util.Locale.ENGLISH)
                .withZone(java.time.ZoneId.of("Asia/Kolkata")).format(receipt.recordedAt)
            val name = saved.displayName.takeIf { it.isNotBlank() }?.let { "$it · " }.orEmpty()
            finishFlow("✓ $name$action at $time IST")
            showBanner("✓ $name$action at $time IST", Palette.green)
            if (live != null) speak(PunchVoice.forReceipt(live.action, receipt), live.voiceVisit)
        }
    }

    private fun capturedLabel(saved: PendingPunch, action: Action): String {
        val name = saved.displayName.takeIf { it.isNotBlank() }?.let { "${it.substringBefore(' ')}'s " }.orEmpty()
        return name + if (action == Action.IN) "check-in" else "check-out"
    }

    private fun canCapture() = usable && cameraReady && visible && !busy && pending == null

    private fun canSpeak(visit: Int?) = visit != null && voiceVisit.isCurrent(visit) && voiceResumed && visible && hasWindowFocus() &&
        ::config.isInitialized && config.mode == Mode.KIOSK && !localTestMode

    private fun speak(cue: VoiceCue?, visit: Int?) {
        if (cue != null && canSpeak(visit)) voicePlayer.value.play(cue)
    }

    private fun playCameraVoice(update: CameraVoiceUpdate, visit: Int) {
        if (!canSpeak(visit)) return
        if (update.cancel && voicePlayer.isInitialized()) voicePlayer.value.stopCamera()
        update.cue?.let { voicePlayer.value.play(it, camera = true) }
    }

    private fun stopCameraVoice() {
        voiceGuidance.reset()
        if (voicePlayer.isInitialized()) voicePlayer.value.stopCamera()
    }

    private fun resetVoiceVisit() {
        voiceVisit.invalidate()
        enrollmentVoiceVisit = null
        voiceGuidance.reset()
        if (voicePlayer.isInitialized()) voicePlayer.value.stop()
    }

    private fun startFlow(value: String): Int {
        resetVoiceVisit()
        busy = true
        flow += 1
        message(value)
        return flow
    }

    private fun finishFlow(value: String) {
        busy = false
        flow += 1
        message(value)
    }

    private fun finishEnrollmentFlow(value: String) {
        if (pending != null) message("A punch is awaiting confirmation. Retry to read its receipt.")
        else finishFlow(value)
    }

    private fun message(value: String) {
        status.text = value
        pageStatus.text = value
        render()
    }

    private fun render() {
        val mode = if (::config.isInitialized) config.mode else null
        val selfService = mode == Mode.KIOSK && !localTestMode
        val idle = enrollmentUi == EnrollmentUi.IDLE
        actions.visibility = if (mode == Mode.KIOSK && pending == null && idle) View.VISIBLE else View.GONE
        enroll.visibility = if (((mode == Mode.ENROLL) || (selfService && idle)) && pending == null) View.VISIBLE else View.GONE
        consent.visibility = if (mode == Mode.ENROLL) View.VISIBLE else View.GONE
        retry.visibility = if (pending != null) View.VISIBLE else View.GONE
        selfTest.visibility = if ((mode == Mode.KIOSK && idle) || localTestMode) View.VISIBLE else View.GONE
        returnToSetup.visibility = if (localTestMode && firstRunPanel != null) View.VISIBLE else View.GONE
        admin.visibility = if (LocalDeviceSetup.isConfigured(this) && idle) View.VISIBLE else View.GONE
        entryScroll.visibility = if (selfService && enrollmentUi in setOf(EnrollmentUi.ENTRY, EnrollmentUi.CLAIMING)) View.VISIBLE else View.GONE
        val showGuide = selfService && enrollmentUi in setOf(EnrollmentUi.GUIDE, EnrollmentUi.CAPTURING, EnrollmentUi.SAVING)
        enrollmentEntry.visibility = entryScroll.visibility
        enrollmentGuide.visibility = if (showGuide) View.VISIBLE else View.GONE
        enrollmentGuideScroll.visibility = if (showGuide) View.VISIBLE else View.GONE
        enrollmentRecovery.visibility = if (selfService && enrollmentUi == EnrollmentUi.RECOVERING) View.VISIBLE else View.GONE
        enrollmentSuccess.visibility = if (selfService && enrollmentUi == EnrollmentUi.SUCCESS && pending == null) View.VISIBLE else View.GONE
        cancelEnrollmentButton.isEnabled = enrollmentUi == EnrollmentUi.ENTRY || enrollmentUi == EnrollmentUi.CLAIMING
        continueEnrollment.isEnabled = !busy && !cancellationRequested && EnrollmentPolicy.validCode(selfCodeInput.text.toString())
        startEnrollmentCapture.isEnabled = !busy && !cancellationRequested && cameraReady && activeEnrollmentClaim != null
        selfConsent.isEnabled = enrollmentUi == EnrollmentUi.GUIDE && !busy && activeEnrollmentClaim != null
        retryEnrollmentStatus.isEnabled = !busy
        cancelRecoveredEnrollment.visibility = if (enrollmentReference?.sessionId != null) View.VISIBLE else View.GONE
        cancelRecoveredEnrollment.isEnabled = !busy
        checkInAfterEnrollment.isEnabled = !busy && usable && cameraReady && pending == null
        finishEnrollment.isEnabled = !busy
        if (selfService) {
            cameraLayer.visibility = if (enrollmentUi == EnrollmentUi.IDLE || enrollmentUi == EnrollmentUi.CAPTURING) View.VISIBLE else View.GONE
        }
        val available = usable && cameraReady && !busy && pending == null && (idle || localTestMode)
        checkIn.isEnabled = available
        checkOut.isEnabled = available
        enroll.isEnabled = available
        selfTest.isEnabled = available
        retry.isEnabled = usable && !busy && pending?.origin == (if (mode != null) config.origin else null)
            && pending?.deviceId == (if (mode != null) config.deviceId else null) && pending != null

        val capturing = selfService && enrollmentUi == EnrollmentUi.CAPTURING
        capturePanel.visibility = if (capturing) View.VISIBLE else View.GONE
        cameraCaption.visibility = if (capturing) View.GONE else View.VISIBLE
        captureHeading.text = enrollmentHeading.text
        enrollmentInstruction.visibility = if (capturing) View.VISIBLE else View.GONE
        val punchScan = activeCapture.get()?.capture?.purpose is CapturePurpose.Punch
        faceGuide.steps = if (capturing) PoseSweep.prompts.size + 1 else if (punchScan) PUNCH_SAMPLES else 0
        faceGuide.completed = if (punchScan) punchSamples else acceptedSamples
        if (!capturing) faceGuide.gesture = FaceGuideView.Gesture.NONE
        trackingEnabled = visible && cameraLayer.visibility == View.VISIBLE && cameraReady && idle && !busy && pending == null
        if (!trackingEnabled) {
            trackFit = FaceGuideView.Fit.NONE
            greetName = null
        }
        val placed = if (capturing) sweepFit == FaceGuideView.Fit.OK else trackFit == FaceGuideView.Fit.OK
        faceGuide.searching = !capturing && !placed
        faceGuide.tint = when {
            placed -> Palette.greenGuide
            punchScan -> Palette.scanYellow
            capturing -> Color.WHITE
            else -> Palette.orange
        }
        cameraTitle.text = when {
            punchScan -> "Hold still · ${punchSamples * 100 / PUNCH_SAMPLES}%"
            greetName != null -> "Hello, ${greetName.orEmpty().substringBefore(' ')}"
            trackingEnabled -> fitHint(trackFit)
            else -> "Position your face in the frame"
        }
        if (shownGreeting != greetName) {
            shownGreeting = greetName
            checkIn.text = tileLabel("Check in", greetName)
            checkOut.text = tileLabel("Check out", greetName)
        }
        cameraPill.text = when {
            !cameraReady -> "Camera starting"
            capturing || busy -> "Camera on"
            else -> "Camera ready"
        }
        pillDot.setColor(if (cameraReady) Palette.greenDot else Palette.idleDot)
        val pageShown = cameraLayer.visibility != View.VISIBLE
        page.visibility = if (pageShown) View.VISIBLE else View.GONE
        tools.visibility = if ((0 until tools.childCount).any { tools.getChildAt(it).visibility == View.VISIBLE }) View.VISIBLE else View.GONE
        sheet.visibility = if ((0 until sheet.childCount).any { sheet.getChildAt(it).visibility == View.VISIBLE }) View.VISIBLE else View.GONE
        val lightBars = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        window.insetsController?.setSystemBarsAppearance(
            if (pageShown) lightBars else WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS, lightBars)
    }

    // Assumes the employee follows the arrows; the sweep itself accepts either side first.
    private val sweepGestures = listOf(FaceGuideView.Gesture.STRAIGHT, FaceGuideView.Gesture.LEFT,
        FaceGuideView.Gesture.RIGHT, FaceGuideView.Gesture.UP, FaceGuideView.Gesture.DOWN)

    private fun startSweep(active: ActiveSweep) {
        activeSweep.set(active)
        main.postDelayed({
            if (activeSweep.compareAndSet(active, null)) {
                stopSweep("Registration timed out. Tap Agree and start camera to try again.", active.voiceVisit)
            }
        }, 60_000)
    }

    private fun stopSweep(reason: String, visit: Int) {
        stopCameraVoice()
        enrollmentUi = EnrollmentUi.GUIDE
        selfConsent.isChecked = false
        sweepFit = FaceGuideView.Fit.NONE
        finishFlow(reason)
        speak(VoiceCue.CAPTURE_RETRY, visit)
    }

    /** Camera thread: advance the guided angle sweep, then hand over to the live three-frame check. */
    private fun stepSweep(active: ActiveSweep, image: androidx.camera.core.ImageProxy) {
        val sweep = active.sweep
        val engine = engine ?: return
        val tracked = try { engine.track(image, embed = true) } catch (_: Exception) { return }
        val fit = faceGuide.fit(tracked, loose = sweep.step > 0)
        try {
            val placed = fit == FaceGuideView.Fit.OK ||
                (sweep.tilting && fit != FaceGuideView.Fit.NONE && fit != FaceGuideView.Fit.MANY)
            sweep.accept(tracked, placed)
        } catch (rejected: CaptureRejected) {
            if (activeSweep.compareAndSet(active, null)) onScreen {
                if (flow == sweep.flow) stopSweep(rejected.displayMessage, active.voiceVisit)
            }
            return
        } catch (known: AlreadyRegistered) {
            if (activeSweep.compareAndSet(active, null)) onScreen {
                if (flow == sweep.flow) greetAlreadyRegistered(known.firstName, cancelOnServer = true, visit = active.voiceVisit)
            }
            return
        }
        val step = sweep.step
        val tilting = sweep.tilting
        val finished = sweep.done && activeSweep.compareAndSet(active, null)
        if (sweep.done && !finished) return
        val now = SystemClock.elapsedRealtime()
        onScreen {
            if (flow != sweep.flow || !visible || (!finished && activeSweep.get() !== active)) return@onScreen
            sweepFit = fit
            acceptedSamples = step
            if (finished) {
                enrollmentInstruction.text = "Look straight and hold still"
                faceGuide.gesture = FaceGuideView.Gesture.STRAIGHT
                captureProgress.text = "Final live check"
                render()
                stopCameraVoice()
                playCameraVoice(CameraVoiceUpdate(VoiceCue.HOLD), active.voiceVisit)
                startCapture(sweep.flow, CapturePurpose.SelfServiceEnrollment(sweep.claim, sweep.embeddings.toList()), active.voiceVisit)
            } else {
                // During tilts keep showing the tilt prompt; "centre your face" would just undo the tilt.
                val guiding = fit == FaceGuideView.Fit.OK || (tilting && fit != FaceGuideView.Fit.NONE && fit != FaceGuideView.Fit.MANY)
                enrollmentInstruction.text = if (guiding) PoseSweep.prompts[step] else fitHint(fit)
                faceGuide.gesture = if (guiding) sweepGestures[step] else FaceGuideView.Gesture.NONE
                captureProgress.text = "Step ${step + 1} of ${PoseSweep.prompts.size + 1}"
                if (canSpeak(active.voiceVisit)) playCameraVoice(voiceGuidance.pose(step, fit, now), active.voiceVisit)
                render()
            }
        }
    }

    /** Camera thread, idle home screen: where the face sits and whose it is. Display only; a punch re-verifies. */
    private fun trackIdle(image: androidx.camera.core.ImageProxy) {
        val visit = voiceVisit.current()
        if (!trackingEnabled) return
        val now = SystemClock.elapsedRealtime()
        if (now - lastTrack < 300) return
        lastTrack = now
        val engine = engine ?: return
        val known = roster
        val tracked = try { engine.track(image, embed = known.isNotEmpty()) } catch (_: Exception) { return }
        val fit = faceGuide.fit(tracked)
        val name = tracked.embedding?.takeIf { fit == FaceGuideView.Fit.OK }?.let { embedding ->
            // Same acceptance rule as a punch: a clear best match with a margin over the runner-up.
            val ranked = known.map { it to similarity(embedding, it.feature) }.sortedByDescending { it.second }
            val (candidate, best) = ranked.first()
            val margin = best - (ranked.getOrNull(1)?.second ?: 0.0)
            candidate.displayName.takeIf { best >= .50 && margin >= .10 && it.isNotBlank() }
        }
        onScreen {
            if (!trackingEnabled || !voiceVisit.isCurrent(visit) || autoPunch(name)) return@onScreen
            if (canSpeak(visit)) playCameraVoice(voiceGuidance.daily(fit, now), visit)
            if (fit == trackFit && name == greetName) return@onScreen
            trackFit = fit
            greetName = name
            render()
        }
    }

    /**
     * Starts the IN punch (before noon) once one recognised face has held still for a moment. Check-out always needs a tap.
     * The punch itself still runs the full live capture and server verification. Returns true when it started.
     */
    private fun autoPunch(name: String?): Boolean {
        val now = SystemClock.elapsedRealtime()
        if (name == null || name != autoCandidate) {
            autoCandidate = name
            autoSeenAt = now
            return false
        }
        // ponytail: 0.9 s hold and 60 s per-person cooldown are calibration knobs for the mounted kiosk.
        if (now - autoSeenAt < 900 || (name == lastAutoName && now - lastAutoAt < 60_000)) return false
        val action = PunchWindow.action() ?: return false
        if (localTestMode || !::config.isInitialized || config.mode != Mode.KIOSK || enrollmentUi != EnrollmentUi.IDLE || !canCapture()) return false
        lastAutoName = name
        lastAutoAt = now
        autoCandidate = null
        begin(action)
        return true
    }

    private fun fitHint(fit: FaceGuideView.Fit) = when (fit) {
        FaceGuideView.Fit.NONE -> "Position your face in the oval"
        FaceGuideView.Fit.MANY -> "Only one person at a time"
        FaceGuideView.Fit.OFF_CENTER -> "Center your face in the oval"
        FaceGuideView.Fit.TOO_FAR -> "Move a little closer"
        FaceGuideView.Fit.TOO_CLOSE -> "Move back a little"
        FaceGuideView.Fit.OK -> "Face in position"
    }

    private fun tileLabel(action: String, name: String?): CharSequence {
        if (name == null) return action
        return SpannableStringBuilder()
            .append("Hello, ${name.substringBefore(' ')}\n", android.text.style.RelativeSizeSpan(.72f), 0)
            .append("Tap to ${action.lowercase()}")
    }

    /**
     * Main thread. A face that is already registered: leave enrollment, return to the camera and greet them in the banner.
     * [cancelOnServer] releases the claimed code (early kiosk check); the server's own duplicate check already cancelled it.
     */
    private fun greetAlreadyRegistered(firstName: String, cancelOnServer: Boolean, visit: Int?) {
        stopCameraVoice()
        val reference = enrollmentReference
        enrollmentStore.clear()
        enrollmentReference = null
        ephemeralEnrollmentCode = null
        activeEnrollmentClaim = null
        activeCapture.set(null)
        clearGuideIdentity()
        enrollmentUi = EnrollmentUi.IDLE
        cameraLayer.visibility = View.VISIBLE
        startCamera()
        val text = "Hey $firstName, you're already registered. Please punch in."
        finishEnrollmentFlow(text)
        showBanner(text, Palette.green)
        speak(VoiceCue.ALREADY_REGISTERED, visit)
        // Best effort: if this fails the claim simply expires; the server's completion check still blocks a duplicate.
        if (cancelOnServer && reference != null) network.execute { runCatching { api.cancelEnrollment(reference) } }
    }

    /** Solid banner over the camera for 6 seconds: green for a recorded punch, orange for a notice. */
    private fun showBanner(text: String, color: Int) {
        receiptBanner.text = text
        receiptBanner.background = rounded(color, dp(16).toFloat())
        receiptBanner.visibility = View.VISIBLE
        val shownFlow = flow
        main.postDelayed({
            if (receiptBanner.text == text) receiptBanner.visibility = View.GONE
            if (flow == shownFlow && !busy) message("Select IN or OUT to begin.")
        }, 6000)
    }

    /** The server refuses a check-out within 2 minutes of check-in (false check-out guard); say when it will be allowed. */
    private fun outTooSoon(saved: PendingPunch, rejected: ApiRejected): String {
        val name = saved.displayName.substringBefore(' ').ifBlank { "there" }
        val format = java.time.format.DateTimeFormatter.ofPattern("h:mm a", java.util.Locale.ENGLISH).withZone(java.time.ZoneId.of("Asia/Kolkata"))
        val checkedIn = rejected.lastPunchAt
        val allowed = checkedIn?.plusSeconds(120) ?: rejected.waitSeconds?.let { Instant.now().plusSeconds(it.toLong()) }
        return when {
            checkedIn != null && allowed != null -> "Hi $name, you just checked in at ${format.format(checkedIn)}. You can check out after ${format.format(allowed)}."
            else -> "Hi $name, you just checked in. Wait 2 minutes before checking out."
        }
    }

    /** Plain wording for a punch the server refused as out of order, based on what was tried and the last punch. */
    private fun alreadyDone(saved: PendingPunch, cue: VoiceCue?, lastPunchAt: Instant?): String {
        val name = saved.displayName.substringBefore(' ').ifBlank { "there" }
        val time = lastPunchAt?.let {
            java.time.format.DateTimeFormatter.ofPattern("h:mm a", java.util.Locale.ENGLISH)
                .withZone(java.time.ZoneId.of("Asia/Kolkata")).format(it)
        }
        return when (cue) {
            VoiceCue.ALREADY_IN -> "Hi $name, you already checked in at $time."
            VoiceCue.ALREADY_OUT -> "Hi $name, you already checked out at $time."
            VoiceCue.CHECK_IN_FIRST -> "Hi $name, you haven't checked in yet. Check in first."
            else -> rejectionMessage("ATTENDANCE_ACTION_ORDER")
        }
    }

    private fun rejectionMessage(code: String): String = when (code) {
        "ATTENDANCE_ACTION_ORDER" -> "This punch was declined. Check your attendance history."
        "ATTENDANCE_OUT_TOO_SOON" -> "You just checked in. Wait 2 minutes before checking out."
        "KIOSK_RATE_LIMIT" -> "Too many attempts. Wait a moment and try again."
        "INVALID_KIOSK_CHALLENGE" -> "The camera check expired. Select an action to start again."
        "KIOSK_ENROLLMENT_REJECTED" -> "This code expired or is invalid. Tap Regenerate code in the Attendance app."
        "KIOSK_INTEGRITY_REJECTED", "INVALID_DEVICE_PROOF" -> "The kiosk could not be verified. Contact your supervisor."
        "BIOMETRIC_VERIFICATION_FAILED" -> "Face verification failed. Try again or contact your supervisor."
        "FACE_ALREADY_REGISTERED" -> "This face is already registered. Contact your supervisor if this is wrong."
        else -> "Attendance could not confirm this request. Contact your supervisor."
    }

    private fun submit(currentFlow: Int? = null, work: () -> Unit) {
        network.execute {
            try {
                work()
            } catch (failure: Exception) {
                val value = when (failure) {
                    is CaptureRejected -> failure.displayMessage
                    is ApiRejected -> failure.registeredName?.let { "Hey ${it.substringBefore(' ')}, you're already registered. Please punch in." } ?: rejectionMessage(failure.code)
                    else -> "The kiosk could not complete this request. Check the connection or contact your supervisor."
                }
                val saved = if (::pendingStore.isInitialized) runCatching { pendingStore.read() }.getOrNull() else null
                onScreen {
                    if (currentFlow == null || flow == currentFlow) {
                        pending = saved
                        finishFlow(value)
                    }
                }
            }
        }
    }

    private fun onScreen(update: () -> Unit) = runOnUiThread { if (!isDestroyed) update() }

    private companion object {
        // Serialize the encrypted pending slot even if Android recreates the Activity during a request.
        val network = Executors.newSingleThreadExecutor()
    }
}
