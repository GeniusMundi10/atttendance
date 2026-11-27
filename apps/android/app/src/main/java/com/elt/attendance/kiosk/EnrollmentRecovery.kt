// PURPOSE: Persist only non-secret enrollment claim/session references for signed status recovery.
package com.elt.attendance.kiosk

import android.content.Context

internal data class EnrollmentReference(val claimRequestId: String, val sessionId: String?)

internal class EnrollmentRecoveryStore(context: Context) {
    private val preferences = context.applicationContext
        .getSharedPreferences("elt-enrollment-recovery", Context.MODE_PRIVATE)

    fun read(): EnrollmentReference? {
        val claimRequestId = preferences.getString("claimRequestId", null) ?: return null
        if (!uuidPattern.matches(claimRequestId)) {
            clear()
            return null
        }
        val sessionId = preferences.getString("sessionId", null)
        if (sessionId != null && !uuidPattern.matches(sessionId)) {
            clear()
            return null
        }
        return EnrollmentReference(claimRequestId, sessionId)
    }

    fun write(reference: EnrollmentReference) {
        require(uuidPattern.matches(reference.claimRequestId))
        require(reference.sessionId == null || uuidPattern.matches(reference.sessionId))
        check(preferences.edit().putString("claimRequestId", reference.claimRequestId)
            .putString("sessionId", reference.sessionId).commit())
    }

    fun clear() {
        check(preferences.edit().remove("claimRequestId").remove("sessionId").commit())
    }
}
