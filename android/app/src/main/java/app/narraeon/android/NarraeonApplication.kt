package app.narraeon.android

import android.app.Application

class NarraeonApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        DiagnosticLog.installJavaCrashHandler(this)
    }
}
