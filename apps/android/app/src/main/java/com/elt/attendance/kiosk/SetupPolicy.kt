// PURPOSE: Validate user-entered kiosk origins, project numbers, PINs, and employee UUIDs.
package com.elt.attendance.kiosk

import java.net.URI

internal object SetupPolicy {
    private val pinPattern = Regex("[0-9]{8,12}")

    fun origin(raw: String): String {
        val value = raw.trim()
        val uri = URI(value)
        require(uri.scheme.equals("https", ignoreCase = true) && uri.host != null)
        require(uri.userInfo == null && uri.rawQuery == null && uri.rawFragment == null)
        require(uri.path.isNullOrEmpty() || uri.path == "/")
        require(uri.port == -1 || uri.port in 1..65535)
        return value.trimEnd('/')
    }

    fun cloudProject(raw: String): Long = raw.trim().toLongOrNull()?.takeIf { it > 0 }
        ?: throw IllegalArgumentException("Enter a valid Play Integrity cloud project number.")

    fun validPin(pin: CharSequence): Boolean = pinPattern.matches(pin)

    fun validPin(pin: CharArray): Boolean =
        pin.size in 8..12 && pin.all { it in '0'..'9' }

    fun employeeId(raw: String): String = raw.trim().also {
        require(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}").matches(it))
    }
}
