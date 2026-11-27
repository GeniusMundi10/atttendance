// PURPOSE: Cover camera prompt timing, pose guidance, and stale visit invalidation.
package com.elt.attendance.kiosk

import com.elt.attendance.kiosk.FaceGuideView.Fit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceGuidanceTest {
    private val guidance = VoiceGuidance()
    private val silent = CameraVoiceUpdate()
    private val cancel = CameraVoiceUpdate(cancel = true)

    @Test
    fun idleAndWellFramedFacesStaySilent() {
        assertEquals(silent, guidance.daily(Fit.NONE, 0))
        assertEquals(silent, guidance.daily(Fit.NONE, 5_000))
        assertEquals(silent, guidance.daily(Fit.OK, 5_001))
        assertEquals(silent, guidance.daily(Fit.OK, 10_001))
        assertEquals(silent, guidance.daily(Fit.NONE, 10_002))
        assertEquals(silent, guidance.daily(Fit.NONE, 15_002))
    }

    @Test
    fun changingFitMustSettleBeforeOfferingAnotherCue() {
        assertEquals(silent, guidance.daily(Fit.TOO_FAR, 0))
        assertEquals(silent, guidance.daily(Fit.OFF_CENTER, 500))
        assertEquals(silent, guidance.daily(Fit.TOO_FAR, 700))
        assertEquals(silent, guidance.daily(Fit.TOO_FAR, 1_499))
        assertEquals(CameraVoiceUpdate(VoiceCue.CLOSER), guidance.daily(Fit.TOO_FAR, 1_500))
        assertEquals(cancel, guidance.daily(Fit.TOO_CLOSE, 1_501))
        assertEquals(silent, guidance.daily(Fit.TOO_CLOSE, 2_300))
        assertEquals(CameraVoiceUpdate(VoiceCue.FARTHER), guidance.daily(Fit.TOO_CLOSE, 2_301))
        assertEquals(cancel, guidance.daily(Fit.NONE, 2_302))
        assertEquals(silent, guidance.daily(Fit.NONE, 3_102))
    }

    @Test
    fun aCueKeepsItsRepeatLimitAcrossFitJitter() {
        guidance.daily(Fit.OFF_CENTER, 0)
        assertEquals(CameraVoiceUpdate(VoiceCue.CENTER), guidance.daily(Fit.OFF_CENTER, 800))
        assertEquals(cancel, guidance.daily(Fit.OK, 1_100))
        assertEquals(silent, guidance.daily(Fit.OFF_CENTER, 1_400))
        assertEquals(silent, guidance.daily(Fit.OFF_CENTER, 2_200))
        assertEquals(silent, guidance.daily(Fit.OFF_CENTER, 5_799))
        assertEquals(CameraVoiceUpdate(VoiceCue.CENTER), guidance.daily(Fit.OFF_CENTER, 5_800))
        assertEquals(silent, guidance.daily(Fit.OFF_CENTER, 10_799))
        assertEquals(CameraVoiceUpdate(VoiceCue.CENTER), guidance.daily(Fit.OFF_CENTER, 10_800))
    }

    @Test
    fun guidedLossRequiresPreviousSingleFaceInThisSession() {
        assertEquals(silent, guidance.pose(0, Fit.NONE, 0))
        assertEquals(CameraVoiceUpdate(VoiceCue.FRAME_FACE), guidance.pose(0, Fit.NONE, 800))
        assertEquals(cancel, guidance.pose(0, Fit.MANY, 1_000))
        assertEquals(CameraVoiceUpdate(VoiceCue.SINGLE_FACE), guidance.pose(0, Fit.MANY, 1_800))
        assertEquals(cancel, guidance.pose(0, Fit.NONE, 6_000))
        assertEquals(CameraVoiceUpdate(VoiceCue.FRAME_FACE), guidance.pose(0, Fit.NONE, 6_800))
        assertEquals(cancel, guidance.pose(0, Fit.TOO_FAR, 7_000))
        assertEquals(silent, guidance.pose(0, Fit.NONE, 7_001))
        assertEquals(CameraVoiceUpdate(VoiceCue.RETURN_FACE), guidance.pose(0, Fit.NONE, 7_801))

        guidance.reset()
        assertEquals(silent, guidance.pose(0, Fit.NONE, 8_000))
        assertEquals(CameraVoiceUpdate(VoiceCue.FRAME_FACE), guidance.pose(0, Fit.NONE, 8_800))
    }

    @Test
    fun tiltedFaceKeepsThePoseCueThroughFramingChanges() {
        guidance.pose(2, Fit.OFF_CENTER, 0)
        assertEquals(CameraVoiceUpdate(VoiceCue.CENTER), guidance.pose(2, Fit.OFF_CENTER, 800))
        assertEquals(CameraVoiceUpdate(VoiceCue.UP, cancel = true), guidance.pose(3, Fit.OFF_CENTER, 1_000))
        assertEquals(silent, guidance.pose(3, Fit.TOO_FAR, 1_700))
        assertEquals(silent, guidance.pose(3, Fit.TOO_CLOSE, 1_800))
        assertEquals(CameraVoiceUpdate(VoiceCue.DOWN, cancel = true), guidance.pose(4, Fit.TOO_CLOSE, 2_000))
        assertEquals(silent, guidance.pose(4, Fit.OK, 2_800))
        assertEquals(cancel, guidance.pose(4, Fit.MANY, 2_801))
        assertEquals(CameraVoiceUpdate(VoiceCue.SINGLE_FACE), guidance.pose(4, Fit.MANY, 3_601))
    }

    @Test
    fun advancingStepsImmediatelyReplacesThePreviousDirection() {
        val cues = listOf(VoiceCue.STRAIGHT, VoiceCue.LEFT, VoiceCue.RIGHT, VoiceCue.UP, VoiceCue.DOWN)
        cues.forEachIndexed { step, cue ->
            val now = step * 200L
            assertEquals(CameraVoiceUpdate(cue, cancel = step > 0), guidance.pose(step, Fit.OK, now))
            assertEquals(silent, guidance.pose(step, Fit.OK, now + 100))
        }
    }

    @Test
    fun startingPosePromptsForFramingOnceAndReacquisitionImmediatelyGivesDirection() {
        assertEquals(CameraVoiceUpdate(VoiceCue.FRAME_FACE), guidance.startPose(0))
        assertEquals(silent, guidance.pose(0, Fit.NONE, 800))
        assertEquals(silent, guidance.pose(0, Fit.NONE, 4_999))
        assertEquals(CameraVoiceUpdate(VoiceCue.FRAME_FACE), guidance.pose(0, Fit.NONE, 5_000))
        assertEquals(CameraVoiceUpdate(VoiceCue.STRAIGHT, cancel = true), guidance.pose(0, Fit.OK, 5_001))
        assertEquals(cancel, guidance.pose(0, Fit.NONE, 5_002))
        assertEquals(CameraVoiceUpdate(VoiceCue.RETURN_FACE), guidance.pose(0, Fit.NONE, 5_802))
        assertEquals(cancel, guidance.pose(0, Fit.OK, 5_803))
        assertEquals(CameraVoiceUpdate(VoiceCue.STRAIGHT), guidance.pose(0, Fit.OK, 10_001))
    }

    @Test
    fun queuedFramesAreInvalidAfterLeavingAndReturningToTheSameScreen() {
        val visit = VoiceVisit()
        val first = visit.current()
        assertTrue(visit.isCurrent(first))
        visit.invalidate()
        val next = visit.current()
        assertFalse(visit.isCurrent(first))
        assertTrue(visit.isCurrent(next))
        visit.invalidate()
        assertFalse(visit.isCurrent(first))
        assertFalse(visit.isCurrent(next))
        assertTrue(visit.isCurrent(visit.current()))
    }
}
