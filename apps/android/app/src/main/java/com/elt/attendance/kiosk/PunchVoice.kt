// PURPOSE: Decode punch responses into safe voice cues without guessing from malformed server data.
package com.elt.attendance.kiosk

import org.json.JSONObject
import java.time.Instant

internal sealed interface LastRecordedAt {
    data object Missing : LastRecordedAt
    data object ExplicitNull : LastRecordedAt
    data class Timestamp(val instant: Instant) : LastRecordedAt
    data object Malformed : LastRecordedAt
}

internal object PunchVoice {
    fun decodeLastRecordedAt(error: JSONObject): LastRecordedAt {
        if (!error.has("lastRecordedAt")) return LastRecordedAt.Missing
        val value = error.opt("lastRecordedAt")
        return decodeLastRecordedAt(present = true, value = if (value === JSONObject.NULL) null else value)
    }

    /** Pure decoder used by host unit tests; null means an explicitly present JSON null. */
    fun decodeLastRecordedAt(present: Boolean, value: Any?): LastRecordedAt {
        if (!present) return LastRecordedAt.Missing
        if (value == null) return LastRecordedAt.ExplicitNull
        if (value !is String || value.isBlank()) return LastRecordedAt.Malformed
        return runCatching { LastRecordedAt.Timestamp(Instant.parse(value)) }
            .getOrElse { LastRecordedAt.Malformed }
    }

    fun decodeExpectedAction(error: JSONObject): Action? {
        val present = error.has("expectedAction")
        val value = error.opt("expectedAction")
        return decodeExpectedAction(present, if (value === JSONObject.NULL) null else value)
    }

    fun decodeExpectedAction(present: Boolean, value: Any?): Action? {
        if (!present) return null
        return when (value) {
            "IN" -> Action.IN
            "OUT" -> Action.OUT
            else -> null
        }
    }

    /** A successful receipt can speak only when its action matches the action this flow submitted. */
    fun forReceipt(expectedAction: Action, receipt: Receipt): VoiceCue? = when {
        receipt.action != expectedAction -> null
        receipt.action == Action.IN -> VoiceCue.CHECKED_IN
        receipt.action == Action.OUT -> VoiceCue.CHECKED_OUT
        else -> null
    }

    /** Classifies only a validated action-order rejection; all inconsistent or incomplete data stays silent. */
    fun forOrderError(
        errorCode: String,
        attemptedAction: Action,
        expectedAction: Action?,
        lastRecordedAt: LastRecordedAt,
    ): VoiceCue? {
        if (errorCode != "ATTENDANCE_ACTION_ORDER") return null
        if (expectedAction != attemptedAction.opposite()) return null
        return when {
            attemptedAction == Action.IN && lastRecordedAt is LastRecordedAt.Timestamp -> VoiceCue.ALREADY_IN
            attemptedAction == Action.OUT && lastRecordedAt is LastRecordedAt.Timestamp -> VoiceCue.ALREADY_OUT
            attemptedAction == Action.OUT && lastRecordedAt == LastRecordedAt.ExplicitNull && expectedAction == Action.IN -> VoiceCue.CHECK_IN_FIRST
            else -> null
        }
    }

    /** Derives the attempted action from a stored request before classifying a retry rejection. */
    fun forOrderError(error: ApiRejected, attemptedAction: Action): VoiceCue? =
        forOrderError(error.code, attemptedAction, error.expectedAction, error.lastRecordedAt)

    fun forOrderError(error: ApiRejected, pending: PendingPunch): VoiceCue? {
        val attempted = runCatching { Action.valueOf(JSONObject(pending.body).getString("action")) }.getOrNull() ?: return null
        return forOrderError(error, attempted)
    }

    private fun Action.opposite(): Action = if (this == Action.IN) Action.OUT else Action.IN
}
