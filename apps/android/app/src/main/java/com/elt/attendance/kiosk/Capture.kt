// PURPOSE: Require a fresh, consistent single-face sequence before creating enrollment or punch evidence.
package com.elt.attendance.kiosk

import android.os.SystemClock
import androidx.camera.core.ImageProxy
import org.json.JSONArray
import kotlin.math.roundToInt

internal sealed interface CapturePurpose {
    data class Punch(val action: Action, val challenge: Challenge, val roster: List<Template>) : CapturePurpose
    data class Enrollment(val employeeId: String, val code: String) : CapturePurpose
    /** [poses] are the guided-angle embeddings collected before the live check; they are blended into the template. */
    data class SelfServiceEnrollment(val claim: EnrollmentClaim, val poses: List<FloatArray> = emptyList()) : CapturePurpose
    data object Diagnostic : CapturePurpose
}
internal data class CaptureResult(val frames: JSONArray, val template: Template?, val embedding: JSONArray?)

/** Live samples one capture needs; the kiosk shows punch progress as a share of this. */
internal const val PUNCH_SAMPLES = 3

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
        if (frames.size < PUNCH_SAMPLES) return null
        val poses = (purpose as? CapturePurpose.SelfServiceEnrollment)?.poses.orEmpty()
        // The angle sweep is unverified for liveness, so it must be the same person as the live frames.
        if (poses.any { similarity(it, samples.first()) < PoseSweep.SAME_PERSON }) {
            throw CaptureRejected("Keep the same person in view for the whole check.")
        }
        val embedding = if (purpose is CapturePurpose.Enrollment || purpose is CapturePurpose.SelfServiceEnrollment) {
            val blended = samples + poses
            val average = normalized(FloatArray(128) { coordinate -> blended.sumOf { it[coordinate].toDouble() }.toFloat() })
            JSONArray(average.map { (it * 10000).roundToInt() })
        } else null
        return CaptureResult(JSONArray(frames), template, embedding)
    }
}

/**
 * Guided enrollment angles: straight, one side, the other side, chin one way, then the other. Each step needs the face
 * in the oval at that angle for two consecutive frames. Angles are measured against the employee's own straight pose.
 */
/** Thrown when the straight-ahead face already belongs to a registered employee; [firstName] is theirs. */
internal class AlreadyRegistered(val firstName: String) : IllegalStateException("Face already registered")

/**
 * [roster] is this kiosk's registered faces. The enrolling employee has none yet, so any match is someone else;
 * it is checked on the first step so they are stopped early. The server repeats this check on completion.
 */
internal class PoseSweep(val claim: EnrollmentClaim, val flow: Int, private val roster: List<Template> = emptyList()) {
    companion object {
        val prompts = listOf(
            "Look straight",
            "Turn your head left",
            "Now turn right",
            "Tilt your chin up a little",
            "Now lower your chin a little",
        )
        // ponytail: calibration knobs on YuNet landmarks; retune per camera if steps feel too easy or too hard.
        const val TURN = .22f
        const val TILT = .08f
        // The second tilt reverses the first, and a lowered chin shows less on camera, so it needs less travel.
        const val RETURN_TILT = .05f
        const val FACING = .12f
        const val SAME_PERSON = .40
        // Same score as a punch match and the server's DUPLICATE_FACE_SIMILARITY.
        const val ALREADY_REGISTERED = .50
    }

    val embeddings = mutableListOf<FloatArray>()
    var step = 0
        private set
    val done get() = step >= prompts.size
    private var held = 0
    private var baseYaw = 0f
    private var basePitch = 0f
    private var turnSign = 0f
    private var tiltSign = 0f

    /** Tilt steps tolerate the face drifting off-centre or shrinking, since a lowered chin moves it up in the frame. */
    val tilting get() = step >= 3

    /** Returns true when this frame completed a step. */
    fun accept(tracked: Tracked, inOval: Boolean): Boolean {
        val face = tracked.face
        val embedding = tracked.embedding
        if (done || face == null || embedding == null || !inOval) { held = 0; return false }
        val turn = yaw(face) - baseYaw
        val tilt = pitch(face) - basePitch
        val posed = when (step) {
            0 -> kotlin.math.abs(yaw(face)) < FACING
            1 -> kotlin.math.abs(turn) > TURN
            2 -> turn * turnSign < -TURN
            3 -> kotlin.math.abs(tilt) > TILT
            else -> tilt * tiltSign < -RETURN_TILT
        }
        if (!posed) { held = 0; return false }
        if (++held < 2) return false
        // A tilted face (a lowered chin most of all) often reads too poorly to match. Waiting for a clearer frame could
        // stall forever, so the tilt step still counts but its embedding is left out of the template. The sweep is not
        // a liveness proof, and the final live check still requires the same person.
        val clear = embeddings.isEmpty() || similarity(embeddings.first(), embedding) >= SAME_PERSON
        if (!clear && !tilting) throw CaptureRejected("Keep the same person in view for the whole check.")
        if (step == 0) {
            val match = roster.maxByOrNull { similarity(embedding, it.feature) }
            if (match != null && similarity(embedding, match.feature) >= ALREADY_REGISTERED) {
                throw AlreadyRegistered(match.displayName.substringBefore(' ').ifBlank { "there" })
            }
        }
        when (step) {
            0 -> { baseYaw = yaw(face); basePitch = pitch(face) }
            1 -> turnSign = kotlin.math.sign(turn)
            3 -> tiltSign = kotlin.math.sign(tilt)
        }
        if (clear) embeddings += embedding
        held = 0
        step += 1
        return true
    }
}
