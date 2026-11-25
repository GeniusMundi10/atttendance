// PURPOSE: Require a fresh, consistent single-face sequence before creating enrollment or punch evidence.
package com.elt.attendance.kiosk

import android.os.SystemClock
import androidx.camera.core.ImageProxy
import org.json.JSONArray
import kotlin.math.roundToInt

internal sealed interface CapturePurpose {
    data class Punch(val action: Action, val challenge: Challenge, val roster: List<Template>) : CapturePurpose
    data class Enrollment(val employeeId: String, val code: String) : CapturePurpose
    data class SelfServiceEnrollment(val claim: EnrollmentClaim) : CapturePurpose
    data object Diagnostic : CapturePurpose
}
internal data class CaptureResult(val frames: JSONArray, val template: Template?, val embedding: JSONArray?)

internal class FaceCapture(val purpose: CapturePurpose, private val onSampleAccepted: (Int) -> Unit = {}) {
    private val started = SystemClock.elapsedRealtimeNanos()
    private val frames = mutableListOf<JSONArray>()
    private val samples = mutableListOf<FloatArray>()
    private var template: Template? = null
    private var first = 0L
    private var previous = 0L

    fun accept(image: ImageProxy, engine: FaceEngine): CaptureResult? {
        // A kiosk is enabled only on a front camera with the same clock source as elapsedRealtimeNanos.
        val elapsed = (image.imageInfo.timestamp - started) / 1_000_000
        if (image.imageInfo.timestamp <= started || (frames.isNotEmpty() && elapsed - previous < 250)) return null
        if (frames.size == 2 && elapsed - first < 650) return null
        if (elapsed > 8500 || (frames.isEmpty() && elapsed > 3500)) {
            throw CaptureRejected("Face capture timed out. Try again.")
        }

        val sample = engine.inspect(image)
        if (sample == null) {
            if (frames.isNotEmpty()) throw CaptureRejected("Keep your face in view for the whole check.")
            return null
        }
        if (samples.isNotEmpty() && similarity(samples.first(), sample.embedding) < .60) {
            throw CaptureRejected("Keep the same person in view for the whole check.")
        }

        var score = 0
        var margin = 0
        if (purpose is CapturePurpose.Punch) {
            val ranked = purpose.roster.map { it to similarity(sample.embedding, it.feature) }.sortedByDescending { it.second }
            val (candidate, best) = ranked.firstOrNull() ?: throw CaptureRejected("No active faces are enrolled for this site.")
            val difference = best - (ranked.getOrNull(1)?.second ?: 0.0)
            if (best < .50 || difference < .10 || (template != null && template != candidate)) {
                throw CaptureRejected("No single enrolled face matched. Try again or contact your supervisor.")
            }
            template = candidate
            score = (best * 10000).roundToInt()
            margin = (difference * 10000).roundToInt().coerceIn(0, 10000)
        }

        if (frames.isEmpty()) first = elapsed
        previous = elapsed
        frames += JSONArray(listOf(elapsed.toInt(), sample.liveness, score, margin))
        samples += sample.embedding
        onSampleAccepted(frames.size)
        if (frames.size < 3) return null
        val embedding = if (purpose is CapturePurpose.Enrollment || purpose is CapturePurpose.SelfServiceEnrollment) {
            val average = normalized(FloatArray(128) { coordinate -> samples.sumOf { it[coordinate].toDouble() }.toFloat() })
            JSONArray(average.map { (it * 10000).roundToInt() })
        } else null
        return CaptureResult(JSONArray(frames), template, embedding)
    }
}
