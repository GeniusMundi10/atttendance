// PURPOSE: Check the guided enrollment angle sweep advances only on real pose changes and keeps one person.
package com.elt.attendance.kiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class PoseSweepTest {
    private val claim = EnrollmentClaim("c", "s", "Test", "Site", 1, EnrollmentNotice("1", "n"), Instant.MAX)
    private val person = normalized(FloatArray(128) { 1f })
    private val stranger = normalized(FloatArray(128) { if (it % 2 == 0) 1f else -1f })

    /** Eyes at (40,50)/(60,50), mouth line at y=70; the nose position sets yaw and pitch. */
    private fun frame(noseX: Float, noseY: Float, embedding: FloatArray = person) = Tracked(
        floatArrayOf(30f, 30f, 40f, 50f, 40f, 50f, 60f, 50f, noseX, noseY, 42f, 70f, 58f, 70f, .99f), 100, 100, 1, embedding)

    private fun PoseSweep.hold(noseX: Float, noseY: Float) { accept(frame(noseX, noseY), true); accept(frame(noseX, noseY), true) }

    @Test
    fun walksStraightSidesAndTiltsInOrder() {
        val sweep = PoseSweep(claim, 1)
        assertFalse(sweep.accept(frame(50f, 60f), inOval = false))
        sweep.hold(50f, 60f)
        assertEquals(1, sweep.step)
        sweep.hold(51f, 60f) // too small a turn
        assertEquals(1, sweep.step)
        sweep.hold(55f, 60f)
        sweep.hold(55f, 60f) // same side again does not count as the other side
        assertEquals(2, sweep.step)
        sweep.hold(45f, 60f)
        sweep.hold(50f, 57f)
        sweep.hold(50f, 63f)
        assertTrue(sweep.done)
        assertEquals(5, sweep.embeddings.size)
    }

    @Test
    fun rejectsAPersonSwapMidSweep() {
        val sweep = PoseSweep(claim, 1)
        sweep.hold(50f, 60f)
        sweep.accept(frame(55f, 60f, stranger), true)
        assertThrows(CaptureRejected::class.java) { sweep.accept(frame(55f, 60f, stranger), true) }
    }

    @Test
    fun chinDownNeedsLessTravelAndToleratesBlurryTiltFrames() {
        val sweep = PoseSweep(claim, 1)
        sweep.hold(50f, 60f)
        sweep.hold(55f, 60f)
        sweep.hold(45f, 60f)
        sweep.hold(50f, 57f) // chin up: 0.15 of the eye-mouth span
        assertEquals(4, sweep.step)
        // A poorly read chin-down frame still completes the step (no stall), but is not blended into the template.
        assertFalse(sweep.accept(frame(50f, 61.2f, stranger), true))
        assertTrue(sweep.accept(frame(50f, 61.2f, stranger), true)) // only 0.06 past level, below the 0.08 first tilt
        assertTrue(sweep.done)
        assertEquals(4, sweep.embeddings.size)
    }

    @Test
    fun alreadyRegisteredFaceIsStoppedOnTheFirstStep() {
        val registered = Template("e1", "t1", person, "Rumman Alam")
        val sweep = PoseSweep(claim, 1, listOf(registered))
        sweep.accept(frame(50f, 60f), true)
        val stopped = assertThrows(AlreadyRegistered::class.java) { sweep.accept(frame(50f, 60f), true) }
        assertEquals("Rumman", stopped.firstName)
        assertEquals(0, sweep.step)
    }

    @Test
    fun someoneElseOnTheRosterDoesNotBlock() {
        val sweep = PoseSweep(claim, 1, listOf(Template("e2", "t2", stranger, "Asha")))
        sweep.hold(50f, 60f)
        assertEquals(1, sweep.step)
    }

    @Test
    fun clearChinDownFrameIsKept() {
        val sweep = PoseSweep(claim, 1)
        sweep.hold(50f, 60f)
        sweep.hold(55f, 60f)
        sweep.hold(45f, 60f)
        sweep.hold(50f, 57f)
        sweep.hold(50f, 61.2f)
        assertTrue(sweep.done)
        assertEquals(5, sweep.embeddings.size)
    }
}
