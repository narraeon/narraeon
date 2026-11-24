package app.narraeon.android

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.annotation.RequiresApi
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray

/** UI choices for this installation, independent of the Runtime's current port. */
internal class CheckpointPreferences(private val context: Context) {
    private val preferences = context.getSharedPreferences("checkpoint-preferences", Context.MODE_PRIVATE)
    private var legacyView: WebView? = null

    private val handled: Set<String>
        get() = preferences.getStringSet(HANDLED, emptySet()).orEmpty()

    fun install(view: WebView, origin: String) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        val keys = JSONArray(handled.toList())
        WebViewCompat.addDocumentStartJavaScript(
            view, "window.narraeonAndroidHandledCheckpoints = new Set($keys);", setOf(origin),
        )
    }

    fun remember(key: String) {
        if (isCheckpointKey(key)) preferences.edit().putStringSet(HANDLED, handled + key).apply()
    }

    @SuppressLint("SetJavaScriptEnabled")
    fun migrateLegacy(onComplete: () -> Unit) {
        if (preferences.getBoolean(MIGRATED, false)) {
            onComplete()
            return
        }

        // Read the old origin's UI choices from a supplied, inert HTML document.
        // This WebView makes no network requests and has no native bridge.
        val view = WebView(context)
        legacyView = view
        fun finish(result: String?) {
            if (legacyView !== view) return
            cancelMigration()
            val keys = result?.let { runCatching { JSONArray(it) }.getOrNull() }
            if (keys != null) {
                val legacyKeys = (0 until keys.length()).map { keys.optString(it) }.filter(::isCheckpointKey)
                preferences.edit().putStringSet(HANDLED, handled + legacyKeys).putBoolean(MIGRATED, true).apply()
            }
            onComplete()
        }
        view.settings.javaScriptEnabled = true
        view.settings.domStorageEnabled = true
        view.settings.blockNetworkLoads = true
        view.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                view.evaluateJavascript(
                    "Object.keys(localStorage).filter(key => key.startsWith('$KEY_PREFIX') && localStorage.getItem(key) === 'handled')",
                    ::finish,
                )
            }

            @RequiresApi(Build.VERSION_CODES.O)
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                finish(null)
                return true
            }
        }
        Handler(Looper.getMainLooper()).postDelayed({ finish(null) }, 2_000)
        view.loadDataWithBaseURL("http://127.0.0.1:4317/", "<!doctype html><html></html>", "text/html", "UTF-8", null)
    }

    fun cancelMigration() {
        val view = legacyView
        legacyView = null
        view?.destroy()
    }

    private fun isCheckpointKey(key: String) = key.startsWith(KEY_PREFIX) && key.length <= 1_024

    companion object {
        const val REMEMBER = "remember-checkpoint:"
        private const val KEY_PREFIX = "narraeon.checkpoint-context.v1:"
        private const val HANDLED = "handled"
        private const val MIGRATED = "migrated"
    }
}
