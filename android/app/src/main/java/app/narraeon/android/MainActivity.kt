package app.narraeon.android

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private val mainHandler = Handler(Looper.getMainLooper())
    private val poller = Executors.newSingleThreadExecutor()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webViewClient = WebViewClient()
        }
        setContentView(webView)

        val intent = Intent(this, NodeService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent)
        else startService(intent)

        waitForBackend()
    }

    // Polls the local backend until it answers, then loads it. The Node process logs
    // NARRAEON_READY to logcat, but polling the HTTP port avoids parsing logs.
    private fun waitForBackend() {
        poller.execute {
            val deadline = System.currentTimeMillis() + STARTUP_TIMEOUT_MS
            while (System.currentTimeMillis() < deadline) {
                if (isBackendUp()) {
                    mainHandler.post { webView.loadUrl(BACKEND_URL) }
                    return@execute
                }
                Thread.sleep(POLL_INTERVAL_MS)
            }
            mainHandler.post { webView.loadData("Narraeon backend did not start. See logcat.", "text/plain", "utf-8") }
        }
    }

    private fun isBackendUp(): Boolean {
        val connection = URL(BACKEND_URL).openConnection() as HttpURLConnection
        return try {
            connection.connectTimeout = 500
            connection.readTimeout = 500
            connection.responseCode == 200
        } catch (_: Exception) {
            false
        } finally {
            connection.disconnect()
        }
    }

    override fun onDestroy() {
        poller.shutdownNow()
        super.onDestroy()
    }

    companion object {
        private const val BACKEND_URL = "http://127.0.0.1:${NodeService.PORT}/"
        private const val POLL_INTERVAL_MS = 300L
        private const val STARTUP_TIMEOUT_MS = 60_000L
    }
}
