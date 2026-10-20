package app.narraeon.android

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import androidx.annotation.RequiresApi
import java.io.File

// Reads why earlier app processes ended (Android 11+). Node runs inside the app
// process, so a Node exit() shows up here as EXIT_SELF, a native crash in libnode as
// CRASH_NATIVE, and a low-memory kill while the app was on screen as LOW_MEMORY.
object ExitHistory {
    private const val PREFS = "narraeon-diagnostics"
    private const val LAST_SEEN = "last-exit-timestamp"

    // SIGABRT, SIGBUS, SIGSEGV.
    private val FATAL_SIGNALS = setOf(6, 7, 11)

    /**
     * Writes exits that are new since the last launch to exit-reasons.log (plus ANR
     * traces and native tombstones when Android kept them) and returns the newest
     * abnormal one, or null.
     */
    fun recordNewExits(context: Context): ApplicationExitInfo? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        return recordNewExitsApi30(context)
    }

    fun describeRecent(context: Context): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return "exit history needs Android 11+\n"
        val manager = context.getSystemService(ActivityManager::class.java)
        return manager.getHistoricalProcessExitReasons(context.packageName, 0, 10)
            .joinToString("\n") { describe(it) } + "\n"
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun recordNewExitsApi30(context: Context): ApplicationExitInfo? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val lastSeen = prefs.getLong(LAST_SEEN, 0L)
        val manager = context.getSystemService(ActivityManager::class.java)
        val fresh = manager.getHistoricalProcessExitReasons(context.packageName, 0, 10)
            .filter { it.timestamp > lastSeen }
        if (fresh.isEmpty()) return null
        prefs.edit().putLong(LAST_SEEN, fresh.maxOf { it.timestamp }).apply()

        for (exit in fresh.sortedBy { it.timestamp }) {
            DiagnosticLog.append(context, "exit-reasons.log", describe(exit))
            saveTrace(context, exit)
        }
        // A first install has no meaningful history to report.
        if (lastSeen == 0L) return null
        return fresh.filter(::isAbnormal).maxByOrNull { it.timestamp }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun isAbnormal(exit: ApplicationExitInfo): Boolean = when (exit.reason) {
        ApplicationExitInfo.REASON_CRASH,
        ApplicationExitInfo.REASON_CRASH_NATIVE,
        ApplicationExitInfo.REASON_ANR,
        ApplicationExitInfo.REASON_EXIT_SELF -> true
        // A fatal signal that skipped the crash reporter; SIGKILL (closing the app) is not.
        ApplicationExitInfo.REASON_SIGNALED -> exit.status in FATAL_SIGNALS
        ApplicationExitInfo.REASON_LOW_MEMORY ->
            exit.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
        else -> false
    }

    @RequiresApi(Build.VERSION_CODES.R)
    fun reasonLabel(context: Context, exit: ApplicationExitInfo): String = context.getString(
        when (exit.reason) {
            ApplicationExitInfo.REASON_CRASH -> R.string.exit_reason_crash
            ApplicationExitInfo.REASON_CRASH_NATIVE, ApplicationExitInfo.REASON_SIGNALED -> R.string.exit_reason_crash_native
            ApplicationExitInfo.REASON_ANR -> R.string.exit_reason_anr
            ApplicationExitInfo.REASON_EXIT_SELF -> R.string.exit_reason_exit_self
            ApplicationExitInfo.REASON_LOW_MEMORY -> R.string.exit_reason_low_memory
            else -> R.string.exit_reason_other
        },
    )

    @RequiresApi(Build.VERSION_CODES.R)
    private fun describe(exit: ApplicationExitInfo): String =
        "exit at=${DiagnosticLog.timestamp(exit.timestamp)} reason=${exit.reason} status=${exit.status} " +
            "importance=${exit.importance} pss=${exit.pss}KB rss=${exit.rss}KB pid=${exit.pid} " +
            "description=${exit.description}"

    @RequiresApi(Build.VERSION_CODES.R)
    private fun saveTrace(context: Context, exit: ApplicationExitInfo) {
        val extension = when (exit.reason) {
            ApplicationExitInfo.REASON_ANR -> "anr.txt"
            ApplicationExitInfo.REASON_CRASH_NATIVE -> "tombstone.pb"
            else -> return
        }
        try {
            val input = exit.traceInputStream ?: return
            val target = File(DiagnosticLog.crashDir(context), "trace-${exit.timestamp}.$extension")
            input.use { source -> target.outputStream().use { source.copyTo(it) } }
        } catch (_: Exception) {
            // Traces are optional; the exit-reasons.log line is already written.
        }
    }
}
