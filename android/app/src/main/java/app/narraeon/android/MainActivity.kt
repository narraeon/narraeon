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
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
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
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : AppCompatActivity() {
    private lateinit var container: FrameLayout
    private var webView: WebView? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val poller = Executors.newSingleThreadExecutor()
    private val rendererCrashes = ArrayDeque<Long>()
    private val fileSaver = WebFileSaver(this, BACKEND_ORIGIN, NodeService.backendIdentity)
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

    // Back first goes to the page, which closes its open dialog or menu
    // (narraeonAndroidBack in src/web/androidBridge.ts). Otherwise the page keeps its
    // screens in history entries, so Back walks them. At the first screen the app
    // moves to the background instead of finishing: the Node backend cannot restart
    // in this process, and a stray Back should not end a running play. The native
    // failure screen has no WebView and simply closes.
    private fun onBack() {
        val view = webView ?: return finish()
        view.evaluateJavascript(PAGE_BACK_SCRIPT) { handled ->
            if (handled == "true" || webView !== view) return@evaluateJavascript
            if (view.canGoBack()) view.goBack() else moveTaskToBack(true)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun attachWebView() {
        val verifiedDocument = AtomicBoolean(false)
        val view = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    val url = request.url
                    val isLocal = url.scheme == "http" && url.encodedAuthority == BACKEND_AUTHORITY
                    // Cookies are scoped to a host, so block requests to other ports on this host.
                    if (url.host == "127.0.0.1" && !isLocal) return blockedResource()
                    val isMainFrame = request.isForMainFrame
                    val path = url.encodedPath
                    if (isMainFrame) {
                        verifiedDocument.set(false)
                        if (!isLocal || request.method != "GET" || (path != "/" && path != "/index.html")) {
                            return blockedResource()
                        }
                    } else if (!isLocal || request.method != "GET" || path?.startsWith("/assets/") != true) {
                        return null
                    }

                    // The page and its executable assets are handed to WebView from the same
                    // connections on which they were verified. A failed check cannot fall back to HTTP.
                    val result = NodeService.backendIdentity.verify(URL(url.toString()), ::verifiedResource)
                    if (result is BackendIdentity.Verification.Verified && NodeService.nodeState == NodeService.NodeState.Running) {
                        if (isMainFrame) verifiedDocument.set(true)
                        return result.value
                    }
                    if (isMainFrame) mainHandler.post {
                        if (webView === view) showUnverifiedBackend()
                    }
                    return blockedResource()
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (!request.isForMainFrame) return false
                    return request.url.scheme != "http" || request.url.encodedAuthority != BACKEND_AUTHORITY
                }

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
                if (!isMainFrame || !verifiedDocument.get() || webView !== view ||
                    NodeService.nodeState != NodeService.NodeState.Running
                ) {
                    return@addWebMessageListener
                }
                if (data == EXPORT_LOGS_MESSAGE) LogExport.share(this) else fileSaver.handle(data, reply)
            }
        }
        container.removeAllViews()
        container.addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = view
    }

    private fun verifiedResource(connection: HttpURLConnection): WebResourceResponse {
        val contentType = connection.contentType.orEmpty()
        val charset = contentType.substringAfter("charset=", "").trim().ifEmpty { null }
        val headers = connection.headerFields.mapNotNull { (name, values) ->
            if (name == null || name.equals("X-Narraeon-Startup-Proof", true)) null
            else name to values.joinToString(", ")
        }.toMap()
        val content = connection.inputStream.use { it.readBytes() }
        return WebResourceResponse(contentType.substringBefore(';'), charset, 200, "OK", headers, content.inputStream())
    }

    private fun blockedResource() = WebResourceResponse(
        "text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArray(0).inputStream(),
    )

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
        waitForBackend()
    }

    // A WebView and its bridge are created only after the current Node instance proves
    // it owns the listening endpoint. Apply the same check after a renderer restart.
    private fun waitForBackend() {
        poller.execute {
            val deadline = SystemClock.elapsedRealtime() + STARTUP_TIMEOUT_MS
            while (!Thread.currentThread().isInterrupted && SystemClock.elapsedRealtime() < deadline) {
                when (val state = NodeService.nodeState) {
                    is NodeService.NodeState.Exited -> {
                        mainHandler.post { showFailure(getString(R.string.failure_backend_exited, state.detail)) }
                        return@execute
                    }
                    NodeService.NodeState.Running -> when (NodeService.backendIdentity.verify(URL(BACKEND_URL)) {}) {
                        is BackendIdentity.Verification.Verified -> {
                            mainHandler.post { loadVerifiedBackend() }
                            return@execute
                        }
                        BackendIdentity.Verification.Unverified -> {
                            mainHandler.post { showUnverifiedBackend() }
                            return@execute
                        }
                        BackendIdentity.Verification.Unavailable -> Unit
                    }
                    else -> Unit
                }
                try {
                    Thread.sleep(POLL_INTERVAL_MS)
                } catch (_: InterruptedException) {
                    return@execute
                }
            }
            if (Thread.currentThread().isInterrupted) return@execute
            DiagnosticLog.append(this, "node-service.log", "backend did not answer within ${STARTUP_TIMEOUT_MS}ms")
            mainHandler.post { showFailure(getString(R.string.failure_backend_timeout)) }
        }
    }

    private fun loadVerifiedBackend() {
        if (isFinishing || isDestroyed) return
        // Install the cookie before loading the verified document. WebView then
        // sends it for same-origin fetch and EventSource without exposing it to page JS.
        CookieManager.getInstance().setCookie(BACKEND_URL, NodeService.backendIdentity.webViewCookie) { accepted ->
            if (isFinishing || isDestroyed) return@setCookie
            val state = NodeService.nodeState
            when {
                state is NodeService.NodeState.Exited -> showFailure(getString(R.string.failure_backend_exited, state.detail))
                !accepted -> showFailure(getString(R.string.failure_runtime_access))
                else -> {
                    attachWebView()
                    webView?.loadUrl(BACKEND_URL)
                }
            }
        }
    }

    private fun showUnverifiedBackend() {
        DiagnosticLog.append(this, "node-service.log", "backend startup proof did not match")
        showFailure(getString(R.string.failure_backend_unverified, NodeService.PORT))
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
        private const val BACKEND_AUTHORITY = "127.0.0.1:${NodeService.PORT}"
        private const val BACKEND_ORIGIN = "http://$BACKEND_AUTHORITY"
        private const val BACKEND_URL = "$BACKEND_ORIGIN/"
        private const val BRIDGE_NAME = "NarraeonAndroid"
        private const val EXPORT_LOGS_MESSAGE = "export-logs"
        private const val PAGE_BACK_SCRIPT = "window.narraeonAndroidBack?.() === true"
        private const val POLL_INTERVAL_MS = 300L
        private const val STARTUP_TIMEOUT_MS = 60_000L
        private const val RENDERER_CRASH_LIMIT = 3
        private const val RENDERER_CRASH_WINDOW_MS = 60_000L
    }
}
