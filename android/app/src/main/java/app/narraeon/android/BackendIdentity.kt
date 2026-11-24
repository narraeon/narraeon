package app.narraeon.android

import java.io.IOException
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** One key for the lifetime of the embedded Node instance. The key itself stays in the app process. */
internal class BackendIdentity {
    private val random = SecureRandom()
    private val key = ByteArray(32).also(random::nextBytes)
    val startupKey: String get() = key.hex()
    val runtimeCookie = "narraeon_mobile_runtime=${sign("narraeon-mobile-runtime/v1")}"
    val webViewCookie: String get() = "$runtimeCookie; Path=/api/runtime/v1; HttpOnly; SameSite=Strict"

    sealed interface Verification<out T> {
        data object Unavailable : Verification<Nothing>
        data object Unverified : Verification<Nothing>
        data class Verified<T>(val value: T) : Verification<T>
    }

    fun <T> verify(url: URL, read: (HttpURLConnection) -> T): Verification<T> {
        val challenge = ByteArray(32).also(random::nextBytes).hex()
        val expected = sign("$challenge\n${url.file}")
        val connection = url.openConnection(Proxy.NO_PROXY) as HttpURLConnection
        return try {
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.connectTimeout = 500
            connection.readTimeout = 500
            connection.setRequestProperty("Accept-Encoding", "identity")
            connection.setRequestProperty("X-Narraeon-Startup-Challenge", challenge)
            val status = connection.responseCode
            val proof = connection.getHeaderField("X-Narraeon-Startup-Proof")
            when {
                status < 0 -> Verification.Unavailable
                status == HttpURLConnection.HTTP_OK && proof != null &&
                    MessageDigest.isEqual(expected.toByteArray(Charsets.US_ASCII), proof.toByteArray(Charsets.US_ASCII)) ->
                    Verification.Verified(read(connection))
                else -> Verification.Unverified
            }
        } catch (_: IOException) {
            Verification.Unavailable
        } finally {
            connection.disconnect()
        }
    }

    private fun sign(message: String): String {
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, algorithm)) }
        return mac.doFinal(message.toByteArray(Charsets.US_ASCII)).hex()
    }

    private fun ByteArray.hex(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
