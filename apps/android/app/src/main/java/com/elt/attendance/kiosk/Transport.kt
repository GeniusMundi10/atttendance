// PURPOSE: Sign kiosk requests, obtain Play Integrity proofs, and accept committed receipts over HTTPS.
package com.elt.attendance.kiosk

import android.content.Context
import android.content.RestrictionsManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import com.google.android.gms.tasks.Tasks
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URI
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection

internal val uuidPattern = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
internal val secretPattern = Regex("[A-Za-z0-9_-]{43}")
private val formatter = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
internal fun urlBase64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
internal fun canonical(vararg values: Any) = JSONArray(values.toList()).toString()

internal enum class Mode { KIOSK, PROVISION, ENROLL }
internal enum class Action { IN, OUT }

internal data class KioskConfig(val origin: String, val deviceId: String, val cloudProject: Long, val mode: Mode, val employeeId: String?) {
    companion object {
        fun read(context: Context): KioskConfig? {
            val values = context.getSystemService(RestrictionsManager::class.java).applicationRestrictions
            val hasManagedConnection = listOf("deviceId", "baseUrl", "cloudProject").any(values::containsKey)
            if (!hasManagedConnection) return LocalDeviceSetup.read(context)

            val origin = SetupPolicy.origin(values.getString("baseUrl") ?: "")
            val deviceId = values.getString("deviceId") ?: ""
            require(uuidPattern.matches(deviceId))
            val cloudProject = SetupPolicy.cloudProject(values.getString("cloudProject") ?: "")
            val mode = when (values.getString("mode", "kiosk")) {
                "kiosk" -> Mode.KIOSK
                "provision" -> Mode.PROVISION
                "enroll" -> Mode.ENROLL
                else -> error("Unsupported kiosk mode")
            }
            val employeeId = values.getString("employeeId")
            if (mode == Mode.ENROLL) SetupPolicy.employeeId(employeeId ?: "")
            return KioskConfig(origin, deviceId, cloudProject, mode, employeeId)
        }
    }
}

internal class DeviceSigner(deviceId: String, create: Boolean) {
    private val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private val pair: KeyStore.PrivateKeyEntry

    init {
        val alias = "elt-kiosk-signing-$deviceId"
        if (!store.containsAlias(alias) && create) {
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            generator.initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(java.security.spec.ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256).build())
            generator.generateKeyPair()
        }
        pair = store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry ?: error("Kiosk is not provisioned")
        val factory = KeyFactory.getInstance(pair.privateKey.algorithm, "AndroidKeyStore")
        val info = factory.getKeySpec(pair.privateKey, KeyInfo::class.java)
        require(info.securityLevel in listOf(KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT, KeyProperties.SECURITY_LEVEL_STRONGBOX))
    }

    fun publicKey(): String = urlBase64(pair.certificate.publicKey.encoded)

    fun sign(payload: String): String = urlBase64(Signature.getInstance("SHA256withECDSA").run {
        initSign(pair.privateKey)
        update(payload.toByteArray(Charsets.UTF_8))
        sign()
    })
}

internal class PlayProof(context: Context, private val cloudProject: Long) {
    private val manager = IntegrityManagerFactory.createStandard(context.applicationContext)
    private var provider: StandardIntegrityManager.StandardIntegrityTokenProvider? = null

    fun prepare() {
        if (provider != null) return
        provider = Tasks.await(manager.prepareIntegrityToken(
            StandardIntegrityManager.PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(cloudProject).build()
        ), 35, TimeUnit.SECONDS)
    }

    fun token(payload: String): String {
        prepare()
        val hash = urlBase64(MessageDigest.getInstance("SHA-256").digest(payload.toByteArray(Charsets.UTF_8)))
        val request = StandardIntegrityManager.StandardIntegrityTokenRequest.builder().setRequestHash(hash).build()
        return try {
            Tasks.await(checkNotNull(provider).request(request), 12, TimeUnit.SECONDS).token()
        } catch (failure: Exception) {
            // Reprepare on the next attempt if this provider has expired.
            provider = null
            throw failure
        }
    }
}

internal data class Challenge(val challengeId: String, val nonce: String, val expiresAt: Instant)
internal data class Template(val employeeId: String, val templateId: String, val feature: FloatArray, val displayName: String)
internal data class Receipt(val action: Action, val recordedAt: Instant)
internal class ApiRejected(val code: String) : IOException("Kiosk request rejected")

internal class KioskApi(private val config: KioskConfig, private val signer: DeviceSigner, private val play: PlayProof) {
    private var cachedRoster: List<Template> = emptyList()
    private var rosterUntil = 0L

    fun roster(): List<Template> {
        // This class is called on the serialized network executor. The server rechecks site and template on every punch.
        if (android.os.SystemClock.elapsedRealtime() < rosterUntil && cachedRoster.isNotEmpty()) return cachedRoster
        val result = post("roster", JSONObject().put("deviceId", config.deviceId), proof("elt-roster-v1"))
        val templates = result.getJSONArray("templates")
        val roster = List(templates.length()) { index ->
            val item = templates.getJSONObject(index)
            val employee = item.getString("employeeId").also { require(uuidPattern.matches(it)) }
            val template = item.getString("templateId").also { require(uuidPattern.matches(it)) }
            val embedding = item.getJSONArray("embedding")
            require(embedding.length() == 128)
            val feature = FloatArray(128) { embedding.getInt(it).also { value -> require(value in -10000..10000) } / 10000f }
            require(kotlin.math.abs(feature.sumOf { it.toDouble() * it } - 1.0) < .003)
            Template(employee, template, feature, item.optString("displayName").take(100))
        }
        cachedRoster = roster
        rosterUntil = android.os.SystemClock.elapsedRealtime() + 30_000L
        return roster
    }

    fun challenge(action: Action): Challenge {
        val result = post("challenges", JSONObject().put("deviceId", config.deviceId).put("action", action.name),
            proof("elt-challenge-v1", action.name))
        return Challenge(result.getString("challengeId").also { require(uuidPattern.matches(it)) },
            result.getString("nonce").also { require(secretPattern.matches(it)) }, Instant.parse(result.getString("expiresAt")))
    }

    fun preparePunch(action: Action, challenge: Challenge, template: Template, frames: JSONArray): String {
        require(Instant.now().isBefore(challenge.expiresAt))
        val requestId = UUID.randomUUID().toString()
        val payload = canonical("elt-punch-v1", config.deviceId, action.name, requestId, challenge.challengeId,
            1, template.employeeId, template.templateId, challenge.nonce, frames)
        val token = play.token(payload)
        val evidence = JSONObject().put("version", 1).put("employeeId", template.employeeId).put("templateId", template.templateId)
            .put("nonce", challenge.nonce).put("frames", frames).put("integrityToken", token)
            .put("signature", signer.sign(canonical(payload, token)))
        return JSONObject().put("deviceId", config.deviceId).put("action", action.name).put("requestId", requestId)
            .put("challengeId", challenge.challengeId).put("evidence", evidence).toString()
    }

    fun submitPunch(pending: PendingPunch): Receipt {
        require(pending.origin == config.origin && pending.deviceId == config.deviceId)
        val receipt = post("punches", pending.body)
        val submitted = JSONObject(pending.body)
        val action = Action.valueOf(receipt.getString("action"))
        require(action.name == submitted.getString("action") &&
            receipt.getString("employeeId") == submitted.getJSONObject("evidence").getString("employeeId") &&
            uuidPattern.matches(receipt.getString("punchId")))
        return Receipt(action, Instant.parse(receipt.getString("recordedAt")))
    }

    fun enroll(employeeId: String, setupCode: String, embedding: JSONArray, frames: JSONArray) {
        val issuedAt = formatter.format(Instant.now())
        val requestId = UUID.randomUUID().toString()
        val payload = canonical("elt-enroll-v1", config.deviceId, employeeId, requestId, issuedAt, setupCode, embedding, frames)
        val token = play.token(payload)
        val body = JSONObject().put("deviceId", config.deviceId).put("employeeId", employeeId)
            .put("setupCode", setupCode).put("embedding", embedding).put("frames", frames)
            .put("requestId", requestId).put("issuedAt", issuedAt).put("integrityToken", token)
            .put("signature", signer.sign(canonical(payload, token)))
        val result = post("enrollments", body)
        require(result.getString("employeeId") == employeeId && uuidPattern.matches(result.getString("templateId")))
    }

    private fun proof(kind: String, vararg arguments: String): String {
        val requestId = UUID.randomUUID().toString()
        val issuedAt = formatter.format(Instant.now())
        val signature = signer.sign(canonical(kind, config.deviceId, requestId, issuedAt, *arguments))
        return urlBase64(JSONObject().put("requestId", requestId).put("issuedAt", issuedAt)
            .put("signature", signature).toString().toByteArray(Charsets.UTF_8))
    }

    private fun post(endpoint: String, body: JSONObject, proof: String? = null) = post(endpoint, body.toString(), proof)

    private fun post(endpoint: String, body: String, proof: String? = null): JSONObject {
        val connection = URI(config.origin + "/api/kiosk/" + endpoint).toURL().openConnection() as HttpsURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 7000
            connection.readTimeout = 18000
            connection.instanceFollowRedirects = false
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Cache-Control", "no-store")
            if (proof != null) connection.setRequestProperty("X-Kiosk-Proof", proof)
            val bytes = body.toByteArray(Charsets.UTF_8)
            connection.setFixedLengthStreamingMode(bytes.size)
            connection.outputStream.use { it.write(bytes) }
            val status = connection.responseCode
            if (status in 400..499) {
                val error = connection.errorStream?.use { readBounded(it, 8192).toString(Charsets.UTF_8) }
                val code = error?.let { runCatching { JSONObject(it).getString("error") }.getOrNull() }
                // Only a definitive application-level rejection can retire an unresolved request.
                if (code != null && code.matches(Regex("[A-Za-z][A-Za-z0-9_]{2,80}"))) throw ApiRejected(code)
                throw IOException("Kiosk server response was incomplete")
            }
            if (status !in 200..299) throw IOException("Kiosk server unavailable")
            val limit = if (endpoint == "roster") 4 * 1024 * 1024 else 32768
            val response = connection.inputStream.use { readBounded(it, limit) }
            return JSONObject(response.toString(Charsets.UTF_8))
        } finally {
            connection.disconnect()
        }
    }

    private fun readBounded(input: java.io.InputStream, limit: Int): ByteArray {
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) return output.toByteArray()
            if (output.size() + count > limit) throw IOException("Kiosk server response exceeded limit")
            output.write(buffer, 0, count)
        }
    }
}
