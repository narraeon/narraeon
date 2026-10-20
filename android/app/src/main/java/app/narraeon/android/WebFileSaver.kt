package app.narraeon.android

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.JavaScriptReplyProxy
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

// Saves files the page asks to download. The Android WebView ignores <a download>,
// so src/web/androidBridge.ts sends a "save-file" message instead: either the bytes
// as base64, or a same-origin path to fetch once (world archives, which can be large
// and are deleted after one download). This opens the system save dialog, writes the
// file, and replies {id, outcome: "saved" | "cancelled" | "failed", error?}.
// Must be constructed during Activity initialization, as it registers a result launcher.
class WebFileSaver(private val activity: AppCompatActivity, private val backendOrigin: String) {
    private class Request(
        val id: String,
        val fileName: String,
        val base64: String?,
        val path: String?,
        val reply: JavaScriptReplyProxy,
    )

    private val mainHandler = Handler(Looper.getMainLooper())
    private var pending: Request? = null
    private val launcher = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val request = pending ?: return@registerForActivityResult
        pending = null
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            reply(request, "cancelled")
        } else {
            Thread({ write(request, uri) }, "narraeon-save-file").start()
        }
    }

    /** Returns false when the message is not a save request. */
    fun handle(message: String, reply: JavaScriptReplyProxy): Boolean {
        val json = try {
            JSONObject(message)
        } catch (_: Exception) {
            return false
        }
        if (json.optString("type") != "save-file") return false
        val request = Request(
            id = json.optString("id"),
            fileName = json.optString("fileName").ifBlank { "narraeon-export" },
            base64 = json.optString("base64").takeIf { json.has("base64") },
            path = json.optString("path").takeIf { json.has("path") },
            reply = reply,
        )
        if (request.path != null && !(request.path.startsWith("/") && !request.path.startsWith("//"))) {
            reply(request, "failed", "Only same-origin paths can be saved")
            return true
        }
        pending?.let { reply(it, "cancelled") }
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
        pending?.let { reply(it, "cancelled") }
        pending = null
    }

    private fun write(request: Request, uri: Uri) {
        try {
            val output = activity.contentResolver.openOutputStream(uri, "wt")
                ?: throw IOException("Cannot open the chosen file")
            output.use { out ->
                if (request.base64 != null) {
                    out.write(Base64.decode(request.base64, Base64.DEFAULT))
                } else {
                    val connection = URL(backendOrigin + request.path).openConnection() as HttpURLConnection
                    try {
                        if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                            throw IOException("The download answered HTTP ${connection.responseCode}")
                        }
                        connection.inputStream.use { it.copyTo(out) }
                    } finally {
                        connection.disconnect()
                    }
                }
            }
            reply(request, "saved")
        } catch (error: Exception) {
            DiagnosticLog.append(activity, "webview.log", "save ${request.fileName} failed: $error")
            // Do not leave an empty or partial file behind.
            runCatching { android.provider.DocumentsContract.deleteDocument(activity.contentResolver, uri) }
            reply(request, "failed", error.message ?: error.toString())
        }
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
