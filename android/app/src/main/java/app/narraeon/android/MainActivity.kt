package app.narraeon.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private lateinit var container: FrameLayout
    private var webView: WebView? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val poller = Executors.newSingleThreadExecutor()
    private val rendererCrashes = ArrayDeque<Long>()
    private val fileSaver = WebFileSaver(this, BACKEND_ORIGIN)
    private var pendingFileChooser: ValueCallback<Array<Uri>>? = null
    private val fileChooserLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data
        val uris = if (result.resultCode != Activity.RESULT_OK || data == null) {
            null
        } else {
            val clip = data.clipData
            if (clip != null) Array(clip.itemCount) { clip.getItemAt(it).uri } else data.data?.let { arrayOf(it) }
        }
        pendingFileChooser?.onReceiveValue(uris)
        pendingFileChooser = null
    }

    // A notification posted before the grant stays hidden, so starting the service again
    // re-posts it. The Node start guard makes the second start harmless.
    private val notificationPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startNodeService()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        container = FrameLayout(this)
        setContentView(container)
        attachWebView()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = onBack()
        })

        startNodeService()
        if (savedInstanceState == null) requestNotificationPermission()

        waitForBackend()
        if (savedInstanceState == null) offerExportAfterAbnormalExit()
    }

    private fun startNodeService() {
        val intent = Intent(this, NodeService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent)
        else startService(intent)
    }

    // Android 13+ hides the backend's notification, and with it the Exit action, until
    // the user allows notifications. The service runs either way, so a denial is final.
    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    // The page keeps its screens in history entries, so Back walks them. At the first
    // screen the app moves to the background instead of finishing: the Node backend
    // cannot restart in this process, and a stray Back should not end a running play.
    // The native failure screen has no WebView and simply closes.
    private fun onBack() {
        val view = webView
        when {
            view == null -> finish()
            view.canGoBack() -> view.goBack()
            else -> moveTaskToBack(true)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun attachWebView() {
        val view = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webViewClient = object : WebViewClient() {
                @RequiresApi(Build.VERSION_CODES.O)
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    onRendererGone(view, detail)
                    return true
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                    if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                        DiagnosticLog.append(
                            this@MainActivity,
                            "webview-console.log",
                            "${message.sourceId()}:${message.lineNumber()} ${message.message()}",
                        )
                    }
                    return false
                }

                override fun onShowFileChooser(
                    view: WebView,
                    callback: ValueCallback<Array<Uri>>,
                    params: FileChooserParams,
                ): Boolean = showFileChooser(callback, params)
            }
        }
        // Only the local backend page may use the bridge (log export, file saves).
        // Sandboxed extension frames have an opaque origin and do not match this rule.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(view, BRIDGE_NAME, setOf(BACKEND_ORIGIN)) { _, message, _, isMainFrame, reply ->
                val data = message.data ?: return@addWebMessageListener
                if (!isMainFrame) return@addWebMessageListener
                if (data == EXPORT_LOGS_MESSAGE) LogExport.share(this) else fileSaver.handle(data, reply)
            }
        }
        container.removeAllViews()
        container.addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = view
    }

    // Opens the system document picker for <input type="file">. The page's accept list
    // mixes extensions and MIME types, and file managers often report a .zip as
    // application/octet-stream, so the picker shows every file; the backend validates
    // what it receives. The callback must always be answered, or the input stops
    // opening the picker.
    private fun showFileChooser(
        callback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams,
    ): Boolean {
        pendingFileChooser?.onReceiveValue(null)
        pendingFileChooser = callback
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
        }
        return try {
            fileChooserLauncher.launch(intent)
            true
        } catch (error: ActivityNotFoundException) {
            DiagnosticLog.append(this, "webview.log", "no document picker: $error")
            pendingFileChooser = null
            false
        }
    }

    // Without this override Android kills the whole app when the WebView renderer
    // dies, which also stops the Node backend. Rebuild the WebView instead, and stop
    // after repeated crashes so a page that always crashes does not loop.
    @RequiresApi(Build.VERSION_CODES.O)
    private fun onRendererGone(view: WebView, detail: RenderProcessGoneDetail) {
        DiagnosticLog.append(
            this,
            "webview.log",
            "renderer gone didCrash=${detail.didCrash()} priority=${detail.rendererPriorityAtExit()} url=${view.url}",
        )
        container.removeView(view)
        view.destroy()
        if (webView === view) webView = null
        fileSaver.cancelPending()

        val now = System.currentTimeMillis()
        rendererCrashes.addLast(now)
        while (rendererCrashes.isNotEmpty() && now - rendererCrashes.first() > RENDERER_CRASH_WINDOW_MS) {
            rendererCrashes.removeFirst()
        }
        if (rendererCrashes.size >= RENDERER_CRASH_LIMIT) {
            showFailure(getString(R.string.failure_renderer_repeated))
            return
        }
        attachWebView()
        webView?.loadUrl(BACKEND_URL)
    }

    // Polls the local backend until it answers, then loads it. Stops early when
    // the Node thread has already ended, since it cannot restart in this process.
    private fun waitForBackend() {
        poller.execute {
            val deadline = System.currentTimeMillis() + STARTUP_TIMEOUT_MS
            while (System.currentTimeMillis() < deadline) {
                if (isBackendUp()) {
                    mainHandler.post { webView?.loadUrl(BACKEND_URL) }
                    return@execute
                }
                val state = NodeService.nodeState
                if (state is NodeService.NodeState.Exited) {
                    mainHandler.post { showFailure(getString(R.string.failure_backend_exited, state.detail)) }
                    return@execute
                }
                Thread.sleep(POLL_INTERVAL_MS)
            }
            DiagnosticLog.append(this, "node-service.log", "backend did not answer within ${STARTUP_TIMEOUT_MS}ms")
            mainHandler.post { showFailure(getString(R.string.failure_backend_timeout)) }
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

    // A native screen that works without the WebView or the backend.
    private fun showFailure(message: String) {
        if (isFinishing || isDestroyed) return
        webView?.let {
            container.removeView(it)
            it.destroy()
        }
        webView = null
        val padding = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 24f, resources.displayMetrics).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(padding, padding, padding, padding)
            addView(TextView(this@MainActivity).apply {
                text = message
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            })
            addView(Button(this@MainActivity).apply {
                text = getString(R.string.export_logs)
                setOnClickListener { LogExport.share(this@MainActivity) }
            })
            addView(Button(this@MainActivity).apply {
                text = getString(R.string.close_app)
                setOnClickListener { closeApp() }
            })
        }
        container.removeAllViews()
        container.addView(layout)
    }

    // Node cannot be started twice in one process, so recovery needs a fresh process.
    private fun closeApp() {
        stopService(Intent(this, NodeService::class.java))
        finishAndRemoveTask()
        Process.killProcess(Process.myPid())
    }

    private fun offerExportAfterAbnormalExit() {
        Thread({
            val exit = runCatching { ExitHistory.recordNewExits(this) }.getOrNull() ?: return@Thread
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return@Thread
            val reason = ExitHistory.reasonLabel(this, exit)
            mainHandler.post {
                if (isFinishing || isDestroyed) return@post
                AlertDialog.Builder(this)
                    .setTitle(R.string.abnormal_exit_title)
                    .setMessage(getString(R.string.abnormal_exit_message, reason))
                    .setPositiveButton(R.string.export_logs) { _, _ -> LogExport.share(this) }
                    .setNegativeButton(R.string.dismiss, null)
                    .show()
            }
        }, "narraeon-exit-history").start()
    }

    override fun onDestroy() {
        pendingFileChooser?.onReceiveValue(null)
        pendingFileChooser = null
        poller.shutdownNow()
        webView?.destroy()
        super.onDestroy()
    }

    companion object {
        private const val BACKEND_ORIGIN = "http://127.0.0.1:${NodeService.PORT}"
        private const val BACKEND_URL = "$BACKEND_ORIGIN/"
        private const val BRIDGE_NAME = "NarraeonAndroid"
        private const val EXPORT_LOGS_MESSAGE = "export-logs"
        private const val POLL_INTERVAL_MS = 300L
        private const val STARTUP_TIMEOUT_MS = 60_000L
        private const val RENDERER_CRASH_LIMIT = 3
        private const val RENDERER_CRASH_WINDOW_MS = 60_000L
    }
}
