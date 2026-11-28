// PURPOSE: Verify punch response decoding and ensure voice cues require consistent committed server data.
package com.elt.attendance.kiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

class PunchVoiceTest {
    @Test
    fun distinguishesMissingNullTimestampAndMalformedLastRecordedAt() {
        assertEquals(LastRecordedAt.Missing, PunchVoice.decodeLastRecordedAt(present = false, value = null))
        assertEquals(LastRecordedAt.ExplicitNull, PunchVoice.decodeLastRecordedAt(present = true, value = null))
        assertEquals(
            LastRecordedAt.Timestamp(Instant.parse("2026-11-26T12:34:56Z")),
            PunchVoice.decodeLastRecordedAt(present = true, value = "2026-11-26T12:34:56Z"),
        )
        assertEquals(LastRecordedAt.Malformed, PunchVoice.decodeLastRecordedAt(present = true, value = 12))
        assertEquals(LastRecordedAt.Malformed, PunchVoice.decodeLastRecordedAt(present = true, value = "yesterday"))
    }

    @Test
    fun distinguishesAbsentAndMalformedExpectedAction() {
        assertNull(PunchVoice.decodeExpectedAction(false, null))
        assertEquals(Action.IN, PunchVoice.decodeExpectedAction(true, "IN"))
        assertNull(PunchVoice.decodeExpectedAction(true, null))
        assertNull(PunchVoice.decodeExpectedAction(true, "SIDEWAYS"))
    }

    @Test
    fun successfulReceiptCueRequiresSubmittedActionToMatch() {
        val at = Instant.parse("2026-11-26T12:34:56Z")
        assertEquals(VoiceCue.CHECKED_IN, PunchVoice.forReceipt(Action.IN, Receipt(Action.IN, at)))
        assertEquals(VoiceCue.CHECKED_OUT, PunchVoice.forReceipt(Action.OUT, Receipt(Action.OUT, at)))
        assertNull(PunchVoice.forReceipt(Action.IN, Receipt(Action.OUT, at)))
    }

    @Test
    fun orderErrorCueUsesAttemptExpectedActionAndExplicitTimestampState() {
        val recorded = LastRecordedAt.Timestamp(Instant.parse("2026-11-26T12:34:56Z"))
        assertEquals(VoiceCue.ALREADY_IN, PunchVoice.forOrderError("ATTENDANCE_ACTION_ORDER", Action.IN, Action.OUT, recorded))
        assertEquals(VoiceCue.ALREADY_OUT, PunchVoice.forOrderError("ATTENDANCE_ACTION_ORDER", Action.OUT, Action.IN, recorded))
        assertEquals(
            VoiceCue.CHECK_IN_FIRST,
            PunchVoice.forOrderError("ATTENDANCE_ACTION_ORDER", Action.OUT, Action.IN, LastRecordedAt.ExplicitNull),
        )
        assertNull(PunchVoice.forOrderError("ATTENDANCE_ACTION_ORDER", Action.IN, Action.OUT, LastRecordedAt.ExplicitNull))
        assertNull(PunchVoice.forOrderError("ATTENDANCE_ACTION_ORDER", Action.OUT, Action.IN, LastRecordedAt.Missing))
        assertNull(PunchVoice.forOrderError("ATTENDANCE_ACTION_ORDER", Action.OUT, Action.IN, LastRecordedAt.Malformed))
        assertNull(PunchVoice.forOrderError("ATTENDANCE_ACTION_ORDER", Action.OUT, Action.OUT, recorded))
        assertNull(PunchVoice.forOrderError("ATTENDANCE_ACTION_ORDER", Action.OUT, null, recorded))
        assertNull(PunchVoice.forOrderError("OTHER_REJECTION", Action.OUT, Action.IN, recorded))
    }
}
