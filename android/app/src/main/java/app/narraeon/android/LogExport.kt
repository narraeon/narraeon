package app.narraeon.android

import android.app.Activity
import android.app.ActivityManager
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

// Packs diagnostics into one zip and opens the share sheet. The zip holds a device
// report, this app's logcat, filesDir/log/crash and the newest runtime-errors files.
// It leaves out log/ai-failures, which can hold world text sent to the model.
object LogExport {
    private const val RUNTIME_ERROR_DAYS = 7
    private const val LOGCAT_LIMIT = 8 * 1024 * 1024

    fun share(activity: Activity) {
        Toast.makeText(activity, R.string.export_preparing, Toast.LENGTH_SHORT).show()
        Thread({
            val result = runCatching { buildZip(activity) }
            Handler(Looper.getMainLooper()).post {
                if (activity.isFinishing || activity.isDestroyed) return@post
                result.onSuccess { startShare(activity, it) }.onFailure {
                    DiagnosticLog.append(activity, "export.log", "export failed: $it")
                    Toast.makeText(activity, R.string.export_failed, Toast.LENGTH_LONG).show()
                }
            }
        }, "narraeon-log-export").start()
    }

    private fun startShare(activity: Activity, zip: File) {
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.diagnostics", zip)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "application/zip"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, zip.name)
            clipData = ClipData.newRawUri(zip.name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        activity.startActivity(Intent.createChooser(send, activity.getString(R.string.export_chooser_title)))
    }

    private fun buildZip(context: Context): File {
        val folder = File(context.cacheDir, "diagnostics").apply {
            deleteRecursively()
            mkdirs()
        }
        val stamp = DiagnosticLog.timestamp().replace(":", "").replace(".", "")
        val zip = File(folder, "narraeon-diagnostics-$stamp.zip")
        ZipOutputStream(zip.outputStream().buffered()).use { out ->
            out.putText("report.txt", report(context))
            out.putText("logcat.txt", logcat())
            DiagnosticLog.crashDir(context).listFiles()?.sortedBy { it.name }?.forEach {
                out.putFile("crash/${it.name}", it)
            }
            File(context.filesDir, "log/runtime-errors").listFiles()
                ?.sortedByDescending { it.name }
                ?.take(RUNTIME_ERROR_DAYS)
                ?.forEach { out.putFile("runtime-errors/${it.name}", it) }
        }
        return zip
    }

    private fun report(context: Context): String {
        val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
        val memory = ActivityManager.MemoryInfo().also {
            context.getSystemService(ActivityManager::class.java).getMemoryInfo(it)
        }
        val webView = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WebView.getCurrentWebViewPackage()?.let { "${it.packageName} ${it.versionName}" }
        } else {
            null
        }
        val bundle = File(context.filesDir, "narraeon/bundle-version.txt").takeIf { it.exists() }?.readText()?.trim()
        return buildString {
            appendLine("generated=${DiagnosticLog.timestamp()}")
            appendLine("app=${packageInfo.versionName} (${packageInfo.longVersionCodeCompat()})")
            appendLine("bundle=$bundle")
            appendLine("device=${Build.MANUFACTURER} ${Build.MODEL} (${Build.DEVICE})")
            appendLine("android=${Build.VERSION.RELEASE} sdk=${Build.VERSION.SDK_INT}")
            appendLine("abis=${Build.SUPPORTED_ABIS.joinToString()}")
            appendLine("webview=$webView")
            appendLine("memory total=${memory.totalMem / 1_048_576}MB available=${memory.availMem / 1_048_576}MB low=${memory.lowMemory}")
            appendLine("node=${NodeService.nodeState}")
            appendLine()
            appendLine("# Recent process exits")
            append(ExitHistory.describeRecent(context))
        }
    }

    // Apps may read their own UID's log lines without any permission, including
    // lines from the previous app process if the buffer has not rotated yet.
    private fun logcat(): String = try {
        val process = ProcessBuilder("logcat", "-d", "-v", "threadtime", "-b", "main,system,crash")
            .redirectErrorStream(true)
            .start()
        val text = process.inputStream.bufferedReader().use { it.readText() }
        process.waitFor()
        if (text.length > LOGCAT_LIMIT) text.takeLast(LOGCAT_LIMIT) else text
    } catch (error: Exception) {
        "logcat unavailable: $error\n"
    }

    private fun ZipOutputStream.putText(name: String, text: String) {
        putNextEntry(ZipEntry(name))
        write(text.toByteArray())
        closeEntry()
    }

    private fun ZipOutputStream.putFile(name: String, file: File) {
        if (!file.isFile) return
        putNextEntry(ZipEntry(name))
        file.inputStream().use { it.copyTo(this) }
        closeEntry()
    }

    @Suppress("DEPRECATION")
    private fun android.content.pm.PackageInfo.longVersionCodeCompat(): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) longVersionCode else versionCode.toLong()
}
