// PURPOSE: Pin the automatic IN-before-noon boundary and that check-out is never automatic.
package com.elt.attendance.kiosk

import java.time.LocalTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PunchWindowTest {
    @Test
    fun onlyCheckInStartsAutomatically() {
        assertEquals(Action.IN, PunchWindow.action(LocalTime.of(9, 30)))
        assertEquals(Action.IN, PunchWindow.action(LocalTime.of(11, 59, 59)))
        assertNull(PunchWindow.action(LocalTime.NOON))
        assertNull(PunchWindow.action(LocalTime.of(16, 0)))
        assertNull(PunchWindow.action(LocalTime.of(23, 0)))
    }
}
