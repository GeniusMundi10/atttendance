// PURPOSE: Pin the automatic IN-before-noon and OUT-from-4pm boundaries.
package com.elt.attendance.kiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalTime

class PunchWindowTest {
    @Test
    fun choosesInBeforeNoonOutFromFourAndNothingBetween() {
        assertEquals(Action.IN, PunchWindow.action(LocalTime.of(9, 30)))
        assertEquals(Action.IN, PunchWindow.action(LocalTime.of(11, 59, 59)))
        assertNull(PunchWindow.action(LocalTime.NOON))
        assertNull(PunchWindow.action(LocalTime.of(15, 59, 59)))
        assertEquals(Action.OUT, PunchWindow.action(LocalTime.of(16, 0)))
        assertEquals(Action.OUT, PunchWindow.action(LocalTime.of(23, 0)))
    }
}
