// PURPOSE: Pick the automatic punch direction for a recognised face from the IST wall clock.
package com.elt.attendance.kiosk

import java.time.LocalTime
import java.time.ZoneId

internal object PunchWindow {
    // ponytail: one company-wide rule; read the employee's shift from the schedule feature when sites differ.
    val IN_BEFORE: LocalTime = LocalTime.NOON
    val OUT_FROM: LocalTime = LocalTime.of(16, 0)
    val ZONE: ZoneId = ZoneId.of("Asia/Kolkata")

    /** IN before noon, OUT from 4 pm; in between the employee taps Check in or Check out. */
    fun action(now: LocalTime = LocalTime.now(ZONE)): Action? = when {
        now.isBefore(IN_BEFORE) -> Action.IN
        !now.isBefore(OUT_FROM) -> Action.OUT
        else -> null
    }
}
