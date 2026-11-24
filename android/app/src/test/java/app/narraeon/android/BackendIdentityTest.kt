package app.narraeon.android

import java.net.InetAddress
import java.net.ServerSocket
import java.net.URL
import java.util.concurrent.Executors
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class BackendIdentityTest {
    @Test
    fun acceptsProofFromThisLaunch() {
        val identity = BackendIdentity()
        assertEquals(BackendIdentity.Verification.Verified("Narraeon"), request(identity, identity.startupKey))
    }

    @Test
    fun rejectsProofFromADifferentLaunchAndResponsesWithoutProof() {
        val identity = BackendIdentity()
        assertEquals(BackendIdentity.Verification.Unverified, request(identity, BackendIdentity().startupKey))
        assertEquals(BackendIdentity.Verification.Unverified, request(identity, null))
    }

    @Test
    fun runtimeCookieUsesThisLaunchKeyAndIsScopedToTheApi() {
        val identity = BackendIdentity()
        val expected = sign(identity.startupKey, "narraeon-mobile-runtime/v1")
        assertEquals("narraeon_mobile_runtime=$expected", identity.runtimeCookie)
        assertEquals("${identity.runtimeCookie}; Path=/api/runtime/v1; HttpOnly; SameSite=Strict", identity.webViewCookie)
        assertNotEquals(identity.runtimeCookie, BackendIdentity().runtimeCookie)
    }

    private fun request(identity: BackendIdentity, key: String?): BackendIdentity.Verification<String> {
        val worker = Executors.newSingleThreadExecutor()
        try {
            ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { server ->
                server.soTimeout = 2_000
                val response = worker.submit {
                    server.accept().use { socket ->
                        socket.soTimeout = 2_000
                        val headers = socket.getInputStream().bufferedReader()
                        val request = generateSequence { headers.readLine() }.takeWhile { it.isNotEmpty() }.toList()
                        val challenge = request.first { it.startsWith("X-Narraeon-Startup-Challenge:", ignoreCase = true) }
                            .substringAfter(":").trim()
                        val head = if (key == null) {
                            "HTTP/1.1 200 OK"
                        } else {
                            val proof = sign(key, "$challenge\n/")
                            "HTTP/1.1 200 OK\r\nX-Narraeon-Startup-Proof: $proof"
                        }
                        socket.getOutputStream().write("$head\r\nContent-Length: 8\r\nConnection: close\r\n\r\nNarraeon".toByteArray())
                    }
                }
                val result = identity.verify(URL("http://127.0.0.1:${server.localPort}/")) {
                    it.inputStream.bufferedReader().use { body -> body.readText() }
                }
                response.get()
                return result
            }
        } finally {
            worker.shutdownNow()
        }
    }

    private fun sign(key: String, challenge: String): String {
        val secret = key.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(secret, algorithm)) }
        return mac.doFinal(challenge.toByteArray(Charsets.US_ASCII))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }
}
