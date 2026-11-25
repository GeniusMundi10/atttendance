// PURPOSE: Store unmanaged kiosk setup privately and gate configuration changes with a salted PIN hash.
package com.elt.attendance.kiosk

import android.content.Context
import android.util.Base64
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

internal object LocalDeviceSetup {
    private const val preferencesName = "elt-kiosk-local-setup"
    private const val iterations = 210_000
    private const val outputBits = 256

    private fun preferences(context: Context) = context.applicationContext
        .getSharedPreferences(preferencesName, Context.MODE_PRIVATE)

    fun isConfigured(context: Context): Boolean {
        val saved = preferences(context)
        return saved.contains("pinSalt") && saved.contains("pinHash")
    }

    fun read(context: Context): KioskConfig? {
        val saved = preferences(context)
        if (!isConfigured(context)) return null
        return runCatching {
            val origin = SetupPolicy.origin(checkNotNull(saved.getString("origin", null)))
            val deviceId = checkNotNull(saved.getString("deviceId", null)).also {
                require(uuidPattern.matches(it))
            }
            val cloudProject = checkNotNull(saved.getString("cloudProject", null)).toLong().also {
                require(it > 0)
            }
            val mode = Mode.valueOf(checkNotNull(saved.getString("mode", null)))
            val employeeId = saved.getString("employeeId", null)
            if (mode == Mode.ENROLL) SetupPolicy.employeeId(checkNotNull(employeeId))
            KioskConfig(origin, deviceId, cloudProject, mode, employeeId)
        }.getOrNull()
    }

    fun initialize(context: Context, rawOrigin: String, rawProject: String, pin: CharArray, confirmation: CharArray): KioskConfig {
        val origin = SetupPolicy.origin(rawOrigin)
        val project = SetupPolicy.cloudProject(rawProject)
        require(SetupPolicy.validPin(pin) && pin.contentEquals(confirmation))
        require(!isConfigured(context)) { "This device is already configured." }

        val salt = ByteArray(16).also(SecureRandom()::nextBytes)
        val hash = derive(pin, salt)
        val deviceId = UUID.randomUUID().toString()
        val saved = preferences(context).edit()
            .putString("origin", origin)
            .putString("deviceId", deviceId)
            .putString("cloudProject", project.toString())
            .putString("mode", Mode.PROVISION.name)
            .putString("pinSalt", encode(salt))
            .putString("pinHash", encode(hash))
            .commit()
        salt.fill(0)
        hash.fill(0)
        check(saved) { "Device setup could not be saved." }
        return KioskConfig(origin, deviceId, project, Mode.PROVISION, null)
    }

    fun verifyAdmin(context: Context, pin: CharArray): Boolean {
        val saved = preferences(context)
        if (System.currentTimeMillis() < saved.getLong("pinLockedUntil", 0L)) return false
        val salt = saved.getString("pinSalt", null)?.let(::decode) ?: return false
        val expected = saved.getString("pinHash", null)?.let(::decode) ?: return false
        if (salt.size != 16 || expected.size != outputBits / 8) return false
        val actual = derive(pin, salt)
        val accepted = try {
            MessageDigest.isEqual(expected, actual)
        } finally {
            actual.fill(0)
            salt.fill(0)
            expected.fill(0)
        }
        if (accepted) {
            saved.edit().remove("pinFailures").remove("pinLockedUntil").commit()
        } else {
            val failures = saved.getInt("pinFailures", 0) + 1
            val delay = when {
                failures >= 8 -> 15 * 60_000L
                failures >= 5 -> 2 * 60_000L
                failures >= 3 -> 30_000L
                else -> 0L
            }
            val editor = saved.edit().putInt("pinFailures", failures)
            if (delay > 0) editor.putLong("pinLockedUntil", System.currentTimeMillis() + delay)
            editor.commit()
        }
        return accepted
    }

    fun setMode(context: Context, pin: CharArray, mode: Mode, rawEmployeeId: String?) {
        require(mode == Mode.KIOSK || mode == Mode.ENROLL)
        require(verifyAdmin(context, pin)) { "Administrator PIN was not accepted." }
        val employeeId = if (mode == Mode.ENROLL) SetupPolicy.employeeId(checkNotNull(rawEmployeeId)) else null
        val editor = preferences(context).edit().putString("mode", mode.name)
        if (employeeId == null) editor.remove("employeeId") else editor.putString("employeeId", employeeId)
        check(editor.commit()) { "Device mode could not be saved." }
    }

    private fun derive(pin: CharArray, salt: ByteArray): ByteArray {
        val spec = PBEKeySpec(pin, salt, iterations, outputBits)
        return try {
            SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
        }
    }

    private fun encode(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    private fun decode(value: String) = Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
}
