// PURPOSE: Keep self-service enrollment's six-digit string validation independent from privileged codes.
package com.elt.attendance.kiosk

internal object EnrollmentPolicy {
    private val codePattern = Regex("[0-9]{6}")

    fun validCode(value: String): Boolean = codePattern.matches(value)
}
