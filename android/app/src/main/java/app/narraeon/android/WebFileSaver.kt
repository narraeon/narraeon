package app.narraeon.android

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.util.Base64
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.JavaScriptReplyProxy
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.SocketTimeoutException
import java.net.URL

// Saves files the page asks to download. The Android WebView ignores <a download>,
// so src/web/androidBridge.ts sends a "save-file" message instead: either the bytes
// as base64, or a same-origin path to fetch once (world archives, which can be large
// and are deleted after one download). This opens the system save dialog, writes the
// file, and replies {id, outcome: "saved" | "cancelled" | "failed", error?}.
// Must be constructed during Activity initialization, as it registers a result launcher.
internal class WebFileSaver(
    private val activity: AppCompatActivity,
    private val backendIdentity: BackendIdentity,
) {
    private class Request(
        val id: String,
        val fileName: String,
        val base64: String?,
        val endpoint: BackendEndpoint,
        val downloadUrl: URL?,
        val reply: JavaScriptReplyProxy,
    ) {
        var cancelled = false
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var pending: Request? = null
    private val launcher = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val request = pending
        pending = null
        val uri = result.data?.data?.takeIf { result.resultCode == Activity.RESULT_OK }
        if (request == null || request.cancelled) {
            // The picker may return a newly created document after its page was closed.
            if (uri != null) Thread({ deletePartial(uri) }, "narraeon-delete-export").start()
        } else if (uri == null) {
            reply(request, "cancelled")
        } else {
            Thread({ write(request, uri) }, "narraeon-save-file").start()
        }
    }

    /** Returns false when the message is not a save request. */
    fun handle(message: String, reply: JavaScriptReplyProxy, endpoint: BackendEndpoint): Boolean {
        val json = try {
            JSONObject(message)
        } catch (_: Exception) {
            return false
        }
        if (json.optString("type") != "save-file") return false
        val path = json.optString("path").takeIf { json.has("path") }
        val request = Request(
            id = json.optString("id"),
            fileName = json.optString("fileName").ifBlank { "narraeon-export" },
            base64 = json.optString("base64").takeIf { json.has("base64") },
            endpoint = endpoint,
            downloadUrl = path?.let(endpoint::archiveUrl),
            reply = reply,
        )
        if ((path != null && request.downloadUrl == null) || (request.base64 == null) == (path == null)) {
            reply(request, "failed", "Expected file bytes or a local world archive path")
            return true
        }
        if (pending != null) {
            reply(request, "cancelled")
            return true
        }
        pending = request
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = documentType(request.fileName, json.optString("mimeType"))
            putExtra(Intent.EXTRA_TITLE, request.fileName)
        }
        try {
            launcher.launch(intent)
        } catch (error: Exception) {
            pending = null
            reply(request, "failed", "No save dialog is available: $error")
        }
        return true
    }

    /** Answers a save that is still waiting, e.g. when the page goes away. */
    fun cancelPending() {
        pending?.takeUnless { it.cancelled }?.let {
            it.cancelled = true
            reply(it, "cancelled")
        }
    }

    private fun write(request: Request, uri: Uri) {
        try {
            if (request.base64 != null) {
                val bytes = Base64.decode(request.base64, Base64.DEFAULT)
                openDestination(uri).use { it.write(bytes) }
            } else {
                saveArchive(request, uri)
            }
            reply(request, "saved")
        } catch (error: Exception) {
            DiagnosticLog.append(activity, "webview.log", "save ${request.fileName} failed: $error")
            // Do not leave an empty or partial file behind.
            deletePartial(uri)
            reply(request, "failed", error.message ?: error.toString())
        }
    }

    private fun openDestination(uri: Uri): OutputStream =
        activity.contentResolver.openOutputStream(uri, "wt")
            ?: throw IOException("Cannot open the chosen file")

    private fun saveArchive(request: Request, uri: Uri) {
        val staged = File.createTempFile("narraeon-download-", ".part", activity.cacheDir)
        try {
            staged.inputStream().use { input ->
                staged.outputStream().use { output ->
                    // Unlink the cache file while both streams are open so process exit cleans it up.
                    // Leave the selected document unopened until the download is complete.
                    staged.delete()
                    download(request, output)
                }
                openDestination(uri).use { input.copyTo(it) }
            }
        } finally {
            staged.delete()
        }
    }

    private fun download(request: Request, output: OutputStream) {
        val connectionFailure = activity.getString(R.string.download_connection_failed)
        if (NodeService.nodeState != NodeService.NodeState.Ready(request.endpoint)) {
            throw IOException(connectionFailure)
        }
        // Use the verified endpoint and connect directly. Redirects must never carry the credential.
        val connection = checkNotNull(request.downloadUrl).openConnection(Proxy.NO_PROXY) as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.connectTimeout = 10_000
            connection.readTimeout = 30_000
            // Use a new connection so a connection timeout is reported at connect().
            connection.setRequestProperty("Connection", "close")
            connection.setRequestProperty("Accept-Encoding", "identity")
            connection.setRequestProperty("Cookie", backendIdentity.runtimeCookie)
            try {
                connection.connect()
            } catch (error: IOException) {
                throw IOException(connectionFailure, error)
            }
            val status = connection.responseCode
            if (status != HttpURLConnection.HTTP_OK) {
                throw IOException("The download answered HTTP $status")
            }
            val bytes = connection.inputStream.use { it.copyTo(output) }
            val expected = connection.contentLengthLong
            if (expected >= 0 && bytes != expected) {
                throw IOException(activity.getString(R.string.download_incomplete))
            }
        } catch (error: ConnectException) {
            // Android can reconnect a pooled socket while reading headers.
            throw IOException(connectionFailure, error)
        } catch (error: SocketTimeoutException) {
            throw IOException(activity.getString(R.string.download_read_timed_out), error)
        } finally {
            connection.disconnect()
        }
    }

    private fun deletePartial(uri: Uri) {
        val resolver = activity.contentResolver
        val deleted = runCatching { DocumentsContract.deleteDocument(resolver, uri) }.getOrDefault(false)
        if (!deleted) runCatching { resolver.delete(uri, null, null) }
    }

    private fun reply(request: Request, outcome: String, error: String? = null) {
        val body = JSONObject().put("id", request.id).put("outcome", outcome)
        if (error != null) body.put("error", error)
        mainHandler.post { runCatching { request.reply.postMessage(body.toString()) } }
    }

    // The save dialog uses the type to pick an extension, so drop charset parameters
    // and name ZIPs explicitly instead of passing application/octet-stream.
    private fun documentType(fileName: String, mimeType: String): String {
        val base = mimeType.substringBefore(";").trim()
        return when {
            fileName.endsWith(".zip", ignoreCase = true) -> "application/zip"
            base.isNotEmpty() -> base
            else -> "application/octet-stream"
        }
    }
}
