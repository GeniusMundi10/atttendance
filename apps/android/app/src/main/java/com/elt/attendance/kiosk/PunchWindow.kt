// PURPOSE: Pick the automatic punch for a recognised face from the IST wall clock (check-in only; check-out is always tapped).
package com.elt.attendance.kiosk

import java.time.LocalTime
import java.time.ZoneId

internal object PunchWindow {
    // ponytail: one company-wide rule; read the employee's shift from the schedule feature when sites differ.
    val IN_BEFORE: LocalTime = LocalTime.NOON
    val ZONE: ZoneId = ZoneId.of("Asia/Kolkata")

    /** IN before noon; otherwise the employee taps Check in or Check out. Check-out never starts on its own. */
    fun action(now: LocalTime = LocalTime.now(ZONE)): Action? = if (now.isBefore(IN_BEFORE)) Action.IN else null
}
