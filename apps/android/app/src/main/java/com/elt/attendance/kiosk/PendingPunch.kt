// PURPOSE: Preserve one unresolved signed punch across process restarts in app-private encrypted storage.
package com.elt.attendance.kiosk

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal data class PendingPunch(val origin: String, val deviceId: String, val body: String)

internal class PendingStore(context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "elt-pending-punch"))
    private val alias = "elt-pending-punch-v1"

    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        check(create)
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
            generateKey()
        }
    }

    fun read(): PendingPunch? {
        val bytes = try {
            file.readFully()
        } catch (_: FileNotFoundException) {
            if (file.baseFile.exists()) error("Pending punch storage inaccessible")
            return null
        }
        check(bytes.size in 28..32768)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, bytes, 0, 12))
        val saved = JSONObject(cipher.doFinal(bytes, 12, bytes.size - 12).toString(Charsets.UTF_8))
        return PendingPunch(saved.getString("origin"), saved.getString("deviceId"), saved.getString("body"))
    }

    fun write(punch: PendingPunch) {
        check(read() == null)
        val payload = JSONObject().put("origin", punch.origin).put("deviceId", punch.deviceId).put("body", punch.body)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(true))
        check(cipher.iv.size == 12)
        val encrypted = cipher.iv + cipher.doFinal(payload.toString().toByteArray(Charsets.UTF_8))
        val output = file.startWrite()
        try {
            output.write(encrypted)
            file.finishWrite(output)
        } catch (failure: Exception) {
            file.failWrite(output)
            throw failure
        }
        check(read() == punch)
    }

    fun clear() {
        file.delete()
        check(!file.baseFile.exists())
    }
}
