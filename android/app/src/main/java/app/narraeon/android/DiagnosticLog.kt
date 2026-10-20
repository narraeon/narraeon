package app.narraeon.android

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// On-device crash records kept in filesDir/log/crash. The Node entry writes
// node-errors.log and the native layer writes node-stderr.log to the same folder;
// this object adds the records the Android shell itself observes. LogExport zips the
// whole folder. Each file is renamed to "<name>.1" once it passes FILE_LIMIT bytes.
object DiagnosticLog {
    private const val TAG = "NARRAEON-DIAG"
    private const val FILE_LIMIT = 512L * 1024

    fun crashDir(context: Context): File = File(context.filesDir, "log/crash").apply { mkdirs() }

    @Synchronized
    fun append(context: Context, fileName: String, message: String) {
        try {
            val file = File(crashDir(context), fileName)
            if (file.length() > FILE_LIMIT) file.renameTo(File(file.path + ".1"))
            file.appendText("${timestamp()} $message\n")
        } catch (error: Exception) {
            Log.w(TAG, "could not write $fileName", error)
        }
    }

    // Records uncaught JVM exceptions, then hands them to the previous handler so
    // Android still reports the crash and ends the process as usual.
    fun installJavaCrashHandler(context: Context) {
        val appContext = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            append(appContext, "java-crash.log", "thread=${thread.name}\n${Log.getStackTraceString(error)}")
            previous?.uncaughtException(thread, error)
        }
    }

    fun timestamp(time: Long = System.currentTimeMillis()): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US)
            .apply { timeZone = TimeZone.getDefault() }
            .format(Date(time))
}
