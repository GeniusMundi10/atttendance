// PURPOSE: Drive the managed kiosk camera, explicit IN/OUT flows, supervised enrollment, and receipt display.
package com.elt.attendance.kiosk

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.pm.PackageManager
import android.graphics.Color
import android.hardware.camera2.CameraCharacteristics
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
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
    private lateinit var codeInput: EditText
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
        config = runCatching { KioskConfig.read(this) }.getOrElse {
            message("This kiosk needs company management configuration.")
            return
        }
        if (config.mode == Mode.PROVISION) {
            showProvisioning()
            return
        }
        if (config.mode == Mode.KIOSK &&
            !getSystemService(DevicePolicyManager::class.java).isLockTaskPermitted(packageName)) {
            message("This kiosk must be in the company’s managed lock task allowlist.")
            return
        }


        codeInput.visibility = if (config.mode == Mode.ENROLL) View.VISIBLE else View.GONE
        pendingStore = PendingStore(applicationContext)
        message("Starting kiosk…")
        submit {
            val signer = DeviceSigner(config.deviceId, false)
            play = PlayProof(applicationContext, config.cloudProject)
            api = KioskApi(config, signer, play)
            val saved = pendingStore.read()
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
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(spacing, spacing, spacing, spacing)
            setOnApplyWindowInsetsListener { view, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                view.setPadding(spacing + bars.left, spacing + bars.top, spacing + bars.right, spacing + bars.bottom)
                insets
            }
        }
        root.addView(TextView(this).apply { text = "ELT Attendance"; textSize = 28f })
        status = TextView(this).apply {
            textSize = 17f
            setPadding(0, spacing, 0, spacing)
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        root.addView(status, LinearLayout.LayoutParams(-1, -2))
        viewfinder = PreviewView(this).apply {
            setBackgroundColor(Color.BLACK)
            scaleType = PreviewView.ScaleType.FIT_CENTER
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        root.addView(viewfinder, LinearLayout.LayoutParams(-1, 0, 1f))
        actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        checkIn = button("Check in (IN)") { begin(Action.IN) }
        checkOut = button("Check out (OUT)") { begin(Action.OUT) }
        actions.addView(checkIn, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(checkOut, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(actions)
        codeInput = EditText(this).apply {
            hint = "One-time enrollment code"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            isSaveEnabled = false
            visibility = View.GONE
        }
        root.addView(codeInput, LinearLayout.LayoutParams(-1, -2))
        enroll = button("Capture enrollment") { beginEnrollment() }
        retry = button("Retry pending punch") { retryPunch() }
        root.addView(enroll, LinearLayout.LayoutParams(-1, -2))
        root.addView(retry, LinearLayout.LayoutParams(-1, -2))
        setContentView(root)
        render()
    }

    private fun button(label: String, action: () -> Unit): Button = Button(this).apply {
        text = label
        setOnClickListener { action() }
    }

    private fun showProvisioning() {
        viewfinder.visibility = View.GONE
        submit {
            val key = DeviceSigner(config.deviceId, create = true).publicKey()
            onScreen {
                root.addView(button("Copy this device’s public key") {
                    val clipboard = getSystemService(ClipboardManager::class.java)
                    clipboard.setPrimaryClip(ClipData.newPlainText("Kiosk public key", key))
                    message("Public key copied. Register it for this device in the attendance service.")
                })
                message("Register this device’s public key, then return it to managed kiosk mode.")
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
                            message(if (config.mode == Mode.ENROLL) "Supervisor enrollment" else "Select IN or OUT to begin.")
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

    private fun beginEnrollment() {
        if (!canCapture()) return
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
        val currentFlow = flow
        message("Confirming with attendance…")
        submit(currentFlow) {
            when (purpose) {
                is CapturePurpose.Punch -> {
                    val body = api.preparePunch(purpose.action, purpose.challenge, checkNotNull(result.template), result.frames)
                    val saved = PendingPunch(config.origin, config.deviceId, body)
                    pendingStore.write(saved)
                    deliver(saved)
                }
                is CapturePurpose.Enrollment -> {
                    api.enroll(purpose.employeeId, purpose.code, checkNotNull(result.embedding), result.frames)
                    onScreen { finishFlow("Face enrollment saved.") }
                }
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
            finishFlow("${receipt.action} recorded at ${receipt.recordedAt} UTC")
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
        retry.visibility = if (pending != null) View.VISIBLE else View.GONE
        val available = usable && cameraReady && !busy && pending == null
        checkIn.isEnabled = available
        checkOut.isEnabled = available
        enroll.isEnabled = available
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
