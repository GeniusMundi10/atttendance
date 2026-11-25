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
import android.graphics.drawable.GradientDrawable
import android.content.res.ColorStateList
import android.view.Gravity
import android.hardware.camera2.CameraCharacteristics
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
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

internal class KioskActivity : ComponentActivity() {
    private val main = Handler(Looper.getMainLooper())
    private val inference = Executors.newSingleThreadExecutor()
    private val activeCapture = AtomicReference<FaceCapture?>()
    private lateinit var config: KioskConfig
    private lateinit var pendingStore: PendingStore
    private lateinit var api: KioskApi
    private lateinit var play: PlayProof
    private lateinit var root: LinearLayout
    private lateinit var status: TextView
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
    private var firstRunPanel: View? = null
    private var localTestMode = false
    private var camera: ProcessCameraProvider? = null
    private var engine: FaceEngine? = null
    private var pending: PendingPunch? = null
    private var visible = false
    private var usable = false
    private var cameraReady = false
    private var busy = false
    private var flow = 0

    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        if (allowed) attachCamera() else message("Allow camera access to verify attendance.")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
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


        codeInput.visibility = if (config.mode == Mode.ENROLL) View.VISIBLE else View.GONE
        consent.visibility = if (config.mode == Mode.ENROLL) View.VISIBLE else View.GONE
        pendingStore = PendingStore(applicationContext)
        message("Starting kiosk…")
        submit {
            val signer = DeviceSigner(config.deviceId, false)
            play = PlayProof(applicationContext, config.cloudProject)
            api = KioskApi(config, signer, play)
            val saved = pendingStore.read()
            if (saved == null && config.mode == Mode.KIOSK) {
                // A failed warm-up can be retried when an employee starts a punch.
                runCatching { play.prepare(); api.roster() }
            }
            onScreen {
                pending = saved
                usable = true
                if (saved != null) {
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
    }

    override fun onResume() {
        super.onResume()
        if (::config.isInitialized && config.mode == Mode.KIOSK &&
            getSystemService(DevicePolicyManager::class.java).isLockTaskPermitted(packageName)) {
            startLockTask()
        }
    }

    override fun onStop() {
        visible = false
        if (activeCapture.getAndSet(null) != null) finishFlow("Camera capture stopped. Select an action to try again.")
        super.onStop()
    }

    override fun onDestroy() {
        activeCapture.set(null)
        camera?.unbindAll()
        inference.execute { engine?.close() }
        inference.shutdown()
        main.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun drawScreen() {
        val spacing = (16 * resources.displayMetrics.density).toInt()
        val ink = Color.rgb(26, 25, 23)
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(spacing, spacing, spacing, spacing)
            setOnApplyWindowInsetsListener { view, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                view.setPadding(spacing + bars.left, spacing + bars.top, spacing + bars.right, spacing + bars.bottom)
                insets
            }
        }
        root.addView(ImageView(this).apply {
            setImageResource(com.elt.attendance.kiosk.R.drawable.elt_logo)
            scaleType = ImageView.ScaleType.FIT_START
            contentDescription = "ELT Corporate"
        }, LinearLayout.LayoutParams(-1, (72 * resources.displayMetrics.density).toInt()))
        root.addView(TextView(this).apply {
            text = "Attendance"
            textSize = 31f
            setTextColor(ink)
            setTypeface(typeface, Typeface.BOLD)
            letterSpacing = -.035f
        })
        status = TextView(this).apply {
            textSize = 15f
            setTextColor(Color.rgb(102, 97, 90))
            setPadding(0, spacing / 2, 0, spacing)
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        root.addView(status, LinearLayout.LayoutParams(-1, -2))
        viewfinder = PreviewView(this).apply {
            setBackgroundColor(Color.BLACK)
            scaleType = PreviewView.ScaleType.FIT_CENTER
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            background = GradientDrawable().apply {
                setColor(Color.BLACK)
                cornerRadius = spacing.toFloat()
            }
            clipToOutline = true
        }
        root.addView(viewfinder, LinearLayout.LayoutParams(-1, 0, 1f).apply { bottomMargin = spacing })
        actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        checkIn = button("Check in") { begin(Action.IN) }.apply {
            backgroundTintList = ColorStateList.valueOf(ink)
            setTextColor(Color.WHITE)
        }
        checkOut = button("Check out") { begin(Action.OUT) }.apply {
            backgroundTintList = ColorStateList.valueOf(Color.rgb(234, 230, 222))
            setTextColor(ink)
        }
        actions.addView(checkIn, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(checkOut, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = spacing / 2 })
        root.addView(actions)
        codeInput = EditText(this).apply {
            hint = "One-time enrollment code"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            isSaveEnabled = false
            visibility = View.GONE
        }
        root.addView(codeInput, LinearLayout.LayoutParams(-1, -2))
        consent = CheckBox(this).apply {
            text = "I confirmed the employee completed ELT’s approved biometric notice and consent process."
            visibility = View.GONE
        }
        root.addView(consent, LinearLayout.LayoutParams(-1, -2))
        enroll = button("Capture enrollment") { beginEnrollment() }
        retry = button("Retry pending punch") { retryPunch() }
        selfTest = button("Test camera") { beginDiagnostic() }
        returnToSetup = button("Back to device setup") {
            localTestMode = false
            camera?.unbindAll()
            camera = null
            cameraReady = false
            usable = false
            selfTest.visibility = View.GONE
            returnToSetup.visibility = View.GONE
            firstRunPanel?.visibility = View.VISIBLE
            viewfinder.visibility = View.GONE
            message("Set up this device to connect attendance, or repeat the local camera test.")
        }.apply { visibility = View.GONE }
        admin = button("Device administrator setup") { showAdminDialog() }.apply { visibility = View.GONE }
        root.addView(enroll, LinearLayout.LayoutParams(-1, -2))
        root.addView(retry, LinearLayout.LayoutParams(-1, -2))
        root.addView(selfTest, LinearLayout.LayoutParams(-1, -2))
        root.addView(returnToSetup, LinearLayout.LayoutParams(-1, -2))
        root.addView(admin, LinearLayout.LayoutParams(-1, -2))
        setContentView(root)
        render()
    }

    private fun button(label: String, action: () -> Unit): Button = Button(this).apply {
        text = label
        textSize = 15f
        isAllCaps = false
        minHeight = (52 * resources.displayMetrics.density).toInt()
        gravity = Gravity.CENTER
        setOnClickListener { action() }
    }

    private fun showFirstRunSetup() {
        viewfinder.visibility = View.GONE
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
        panel.addView(TextView(this).apply {
            text = "Unmanaged device setup"
            textSize = 20f
        })
        panel.addView(TextView(this).apply {
            text = "Enter ELT’s HTTPS attendance service and linked Play Integrity project. This phone will create its own hardware-backed device key."
            textSize = 15f
        })
        val origin = setupField("HTTPS attendance server origin", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        val project = setupField("Play Integrity cloud project number", InputType.TYPE_CLASS_NUMBER)
        val pin = setupField("Create 8–12 digit device admin PIN", InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD)
        val confirmation = setupField("Confirm device admin PIN", InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD)
        panel.addView(origin, LinearLayout.LayoutParams(-1, -2))
        panel.addView(project, LinearLayout.LayoutParams(-1, -2))
        panel.addView(pin, LinearLayout.LayoutParams(-1, -2))
        panel.addView(confirmation, LinearLayout.LayoutParams(-1, -2))
        panel.addView(button("Save setup and create device key") {
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
        }, LinearLayout.LayoutParams(-1, -2))
        panel.addView(button("Test camera and liveness only (no record)") { startLocalCameraTest() }, LinearLayout.LayoutParams(-1, -2))

        val scroll = ScrollView(this).apply {
            isFillViewport = true
            addView(panel)
        }
        firstRunPanel = scroll
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        message("No managed setup is required. Set up the phone here, or run a local camera test first.")
    }

    private fun setupField(hintText: String, type: Int) = EditText(this).apply {
        hint = hintText
        inputType = type
        isSaveEnabled = false
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
    }

    private fun startLocalCameraTest() {
        localTestMode = true
        firstRunPanel?.visibility = View.GONE
        viewfinder.visibility = View.VISIBLE
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
        viewfinder.visibility = View.GONE
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
                root.addView(TextView(this).apply {
                    text = "Device ID: ${config.deviceId}\n\nRegister this ID and public key against an active ELT site using the trusted operator provisioning command. Do not enter a site ID supplied by an unverified source."
                    textSize = 15f
                }, LinearLayout.LayoutParams(-1, -2))
                root.addView(button("Copy this device ID") {
                    getSystemService(ClipboardManager::class.java).setPrimaryClip(
                        ClipData.newPlainText("Kiosk device ID", config.deviceId)
                    )
                    message("Device ID copied. Keep it with the supervised device-registration request.")
                }, LinearLayout.LayoutParams(-1, -2))
                root.addView(button("Copy this device’s public key") {
                    val clipboard = getSystemService(ClipboardManager::class.java)
                    clipboard.setPrimaryClip(ClipData.newPlainText("Kiosk public key", key))
                    message("Public key copied. Register it for this device and its assigned site.")
                }, LinearLayout.LayoutParams(-1, -2))
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
        submit(currentFlow) {
            play.prepare()
            val roster = api.roster()
            if (roster.isEmpty()) throw CaptureRejected("No active faces are enrolled for this site.")
            val challenge = api.challenge(action)
            onScreen { startCapture(currentFlow, CapturePurpose.Punch(action, challenge, roster)) }
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

    private fun startCapture(currentFlow: Int, purpose: CapturePurpose) {
        if (flow != currentFlow) return
        if (!visible) {
            finishFlow("Camera capture stopped. Select an action to try again.")
            return
        }
        val capture = FaceCapture(purpose)
        activeCapture.set(capture)
        message("Look at the front camera and keep your face centered.")
        main.postDelayed({
            if (activeCapture.compareAndSet(capture, null)) finishFlow("Face capture timed out. Try again.")
        }, 9000)
    }

    private fun analyze(image: androidx.camera.core.ImageProxy) {
        val capture = activeCapture.get()
        try {
            if (capture == null) return
            val result = capture.accept(image, checkNotNull(engine)) ?: return
            if (activeCapture.compareAndSet(capture, null)) onScreen {
                if (visible && busy) completeCapture(capture.purpose, result)
                else finishFlow("Camera capture stopped. Select an action to try again.")
            }
        } catch (rejected: CaptureRejected) {
            if (capture != null && activeCapture.compareAndSet(capture, null)) onScreen { finishFlow(rejected.displayMessage) }
        } catch (_: Exception) {
            if (capture != null && activeCapture.compareAndSet(capture, null)) onScreen { finishFlow("Camera verification failed. Try again.") }
        } finally {
            image.close()
        }
    }

    private fun completeCapture(purpose: CapturePurpose, result: CaptureResult) {
        if (purpose is CapturePurpose.Diagnostic) {
            finishFlow("Live-face camera self-test passed. Nothing was recorded or sent.")
            return
        }
        val currentFlow = flow
        message("Confirming with attendance…")
        submit(currentFlow) {
            when (purpose) {
                is CapturePurpose.Punch -> {
                    val body = api.preparePunch(purpose.action, purpose.challenge, checkNotNull(result.template), result.frames)
                    val saved = PendingPunch(config.origin, config.deviceId, body, checkNotNull(result.template).displayName)
                    pendingStore.write(saved)
                    deliver(saved)
                }
                is CapturePurpose.Enrollment -> {
                    api.enroll(purpose.employeeId, purpose.code, checkNotNull(result.embedding), result.frames)
                    onScreen {
                        consent.isChecked = false
                        finishFlow("Face enrollment saved.")
                    }
                }
                is CapturePurpose.Diagnostic -> Unit
            }
        }
    }

    private fun retryPunch() {
        val saved = pending ?: return
        if (busy || saved.origin != config.origin || saved.deviceId != config.deviceId) return
        startFlow("Looking up your punch…")
        submit { deliver(saved) }
    }

    private fun deliver(saved: PendingPunch) {
        val receipt = try {
            api.submitPunch(saved)
        } catch (rejected: ApiRejected) {
            pendingStore.clear()
            onScreen {
                pending = null
                finishFlow(rejectionMessage(rejected.code))
                startCamera()
            }
            return
        } catch (_: Exception) {
            onScreen {
                pending = saved
                finishFlow("Punch confirmation is unavailable. Retry to read its receipt.")
            }
            return
        }
        pendingStore.clear()
        onScreen {
            pending = null
            startCamera()
            val action = if (receipt.action == Action.IN) "Check-in" else "Check-out"
            val time = java.time.format.DateTimeFormatter.ofPattern("d MMM, h:mm:ss a", java.util.Locale.ENGLISH)
                .withZone(java.time.ZoneId.of("Asia/Kolkata")).format(receipt.recordedAt)
            val name = saved.displayName.takeIf { it.isNotBlank() }?.let { "$it · " }.orEmpty()
            finishFlow("$name$action recorded at $time IST")
            val receiptFlow = flow
            main.postDelayed({ if (flow == receiptFlow && !busy) message("Select IN or OUT to begin.") }, 4000)
        }
    }

    private fun canCapture() = usable && cameraReady && visible && !busy && pending == null

    private fun startFlow(value: String): Int {
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

    private fun message(value: String) {
        status.text = value
        render()
    }

    private fun render() {
        val mode = if (::config.isInitialized) config.mode else null
        actions.visibility = if (mode == Mode.KIOSK && pending == null) View.VISIBLE else View.GONE
        enroll.visibility = if (mode == Mode.ENROLL && pending == null) View.VISIBLE else View.GONE
        consent.visibility = if (mode == Mode.ENROLL) View.VISIBLE else View.GONE
        retry.visibility = if (pending != null) View.VISIBLE else View.GONE
        selfTest.visibility = if (mode == Mode.KIOSK || localTestMode) View.VISIBLE else View.GONE
        returnToSetup.visibility = if (localTestMode && firstRunPanel != null) View.VISIBLE else View.GONE
        admin.visibility = if (LocalDeviceSetup.isConfigured(this)) View.VISIBLE else View.GONE
        val available = usable && cameraReady && !busy && pending == null
        checkIn.isEnabled = available
        checkOut.isEnabled = available
        enroll.isEnabled = available
        selfTest.isEnabled = available
        retry.isEnabled = usable && !busy && pending?.origin == (if (mode != null) config.origin else null)
            && pending?.deviceId == (if (mode != null) config.deviceId else null) && pending != null
    }

    private fun rejectionMessage(code: String): String = when (code) {
        "ATTENDANCE_ACTION_ORDER" -> "That action is out of order. Check your last recorded punch."
        "KIOSK_RATE_LIMIT" -> "Too many attempts. Wait a moment and try again."
        "INVALID_KIOSK_CHALLENGE" -> "The camera check expired. Select an action to start again."
        "KIOSK_ENROLLMENT_REJECTED" -> "Enrollment authorization expired or is invalid. Contact your supervisor."
        "KIOSK_INTEGRITY_REJECTED", "INVALID_DEVICE_PROOF" -> "The kiosk could not be verified. Contact your supervisor."
        "BIOMETRIC_VERIFICATION_FAILED" -> "Face verification failed. Try again or contact your supervisor."
        else -> "Attendance could not confirm this request. Contact your supervisor."
    }

    private fun submit(currentFlow: Int? = null, work: () -> Unit) {
        network.execute {
            try {
                work()
            } catch (failure: Exception) {
                val value = when (failure) {
                    is CaptureRejected -> failure.displayMessage
                    is ApiRejected -> rejectionMessage(failure.code)
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
