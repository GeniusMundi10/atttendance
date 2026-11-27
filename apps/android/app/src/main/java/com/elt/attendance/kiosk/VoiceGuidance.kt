// PURPOSE: Select stable camera prompts and guard them against obsolete kiosk visits.
package com.elt.attendance.kiosk

import java.util.concurrent.atomic.AtomicInteger

internal enum class VoiceCue {
    REGISTER_START, CODE_REJECTED, CONSENT, FRAME_FACE, CLOSER, FARTHER, CENTER, SINGLE_FACE,
    RETURN_FACE, STRAIGHT, LEFT, RIGHT, UP, DOWN, HOLD, CAPTURE_RETRY, CHECKING, REGISTERED,
    ALREADY_REGISTERED, CHECKED_IN, CHECKED_OUT, ALREADY_IN, ALREADY_OUT, CHECK_IN_FIRST,
}

internal data class CameraVoiceUpdate(val cue: VoiceCue? = null, val cancel: Boolean = false)

/** A camera callback takes a token before reading a frame and checks it again before offering speech. */
internal class VoiceVisit {
    private val version = AtomicInteger()

    fun current(): Int = version.get()

    fun isCurrent(token: Int): Boolean = token == current()

    fun invalidate() {
        version.incrementAndGet()
    }
}

/** Call on the main thread for every observed frame, using the monotonic kiosk clock. */
internal class VoiceGuidance {
    private var step: Int? = null
    private var sawGuidedFace = false
    private var candidate: VoiceCue? = null
    private var candidateSince = 0L
    private var offered: VoiceCue? = null
    private val lastOffer = mutableMapOf<VoiceCue, Long>()

    fun daily(fit: FaceGuideView.Fit, now: Long): CameraVoiceUpdate = observe(null, fit, now)

    fun startPose(now: Long): CameraVoiceUpdate {
        reset()
        step = 0
        candidate = VoiceCue.FRAME_FACE
        candidateSince = now
        return offer(VoiceCue.FRAME_FACE, now)
    }

    fun pose(step: Int, fit: FaceGuideView.Fit, now: Long): CameraVoiceUpdate = observe(step, fit, now)

    fun reset() {
        step = null
        sawGuidedFace = false
        candidate = null
        candidateSince = 0L
        offered = null
        lastOffer.clear()
    }

    private fun observe(nextStep: Int?, fit: FaceGuideView.Fit, now: Long): CameraVoiceUpdate {
        val changedStep = step != nextStep
        if (changedStep && (step == null || nextStep == null)) sawGuidedFace = false
        step = nextStep
        if (nextStep != null && fit != FaceGuideView.Fit.NONE && fit != FaceGuideView.Fit.MANY) {
            sawGuidedFace = true
        }
        val next = select(nextStep, fit)
        val changed = changedStep || next != candidate
        val cancel = changed && offered != null
        if (changed) {
            candidate = next
            candidateSince = now
        }
        if (cancel) offered = null
        val poseDirection = nextStep != null && next == poseCue(nextStep)
        if (next == null || (!poseDirection && now - candidateSince < STABLE_MS)) {
            return CameraVoiceUpdate(cancel = cancel)
        }
        val previous = lastOffer[next]
        if (previous != null && now - previous < REPEAT_MS) return CameraVoiceUpdate(cancel = cancel)
        return offer(next, now, cancel)
    }

    private fun offer(cue: VoiceCue, now: Long, cancel: Boolean = false): CameraVoiceUpdate {
        lastOffer[cue] = now
        offered = cue
        return CameraVoiceUpdate(cue, cancel)
    }

    private fun select(step: Int?, fit: FaceGuideView.Fit): VoiceCue? {
        if (step != null && (fit == FaceGuideView.Fit.OK ||
                (step >= FIRST_TILT_STEP && fit != FaceGuideView.Fit.NONE && fit != FaceGuideView.Fit.MANY))) {
            return poseCue(step)
        }
        return when (fit) {
            FaceGuideView.Fit.NONE -> when {
                step == null -> null
                sawGuidedFace -> VoiceCue.RETURN_FACE
                else -> VoiceCue.FRAME_FACE
            }
            FaceGuideView.Fit.MANY -> VoiceCue.SINGLE_FACE
            FaceGuideView.Fit.OFF_CENTER -> VoiceCue.CENTER
            FaceGuideView.Fit.TOO_FAR -> VoiceCue.CLOSER
            FaceGuideView.Fit.TOO_CLOSE -> VoiceCue.FARTHER
            FaceGuideView.Fit.OK -> null
        }
    }

    companion object {
        private const val STABLE_MS = 800L
        private const val REPEAT_MS = 5_000L
        private const val FIRST_TILT_STEP = 3
        private val poseCues = listOf(VoiceCue.STRAIGHT, VoiceCue.LEFT, VoiceCue.RIGHT, VoiceCue.UP, VoiceCue.DOWN)

        fun poseCue(step: Int): VoiceCue = poseCues[step]
    }
}
