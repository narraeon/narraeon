package app.narraeon.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import java.io.File

// Runs the Narraeon backend inside this app process. The Node runtime can only start
// once per process, so a second start is ignored.
class NodeService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat()
        if (!nodeStarted.compareAndSet(false, true)) return START_STICKY

        Thread({
            try {
                val root = prepareBundle()
                val arguments = arrayOf("node", File(root, "node/server/mobile.js").path)
                val environment = arrayOf(
                    "NARRAEON_PORT=$PORT",
                    "NARRAEON_STATIC_ROOT=${File(root, "web").path}",
                    "NARRAEON_DATA_ROOT=${File(filesDir, "data").path}",
                    "NARRAEON_CONFIG_ROOT=${File(filesDir, "config").path}",
                    "NARRAEON_LOG_ROOT=${File(filesDir, "log").path}",
                    "HOME=${filesDir.path}",
                    "TMPDIR=${cacheDir.path}",
                )
                val code = NativeNode.startNode(arguments, environment)
                Log.e(TAG, "node exited with code $code")
            } catch (error: Throwable) {
                Log.e(TAG, "node failed to start", error)
            } finally {
                nodeStarted.set(false)
            }
        }, "narraeon-node").start()

        return START_STICKY
    }

    // Copies assets/narraeon into filesDir/narraeon when bundle-version.txt changes. Data
    // directories live outside that folder and survive upgrades.
    private fun prepareBundle(): File {
        val target = File(filesDir, "narraeon")
        val assetVersion = assets.open("$ASSET_ROOT/bundle-version.txt").bufferedReader().readText()
        val installedVersion = File(target, "bundle-version.txt").takeIf { it.exists() }?.readText()
        if (installedVersion != assetVersion) {
            target.deleteRecursively()
            copyAssetDir(ASSET_ROOT, target)
        }
        return target
    }

    private fun copyAssetDir(assetPath: String, destination: File) {
        destination.mkdirs()
        for (name in assets.list(assetPath).orEmpty()) {
            val child = "$assetPath/$name"
            val children = assets.list(child).orEmpty()
            if (children.isEmpty()) {
                assets.open(child).use { input ->
                    File(destination, name).outputStream().use { input.copyTo(it) }
                }
            } else {
                copyAssetDir(child, File(destination, name))
            }
        }
    }

    private fun startForegroundCompat() {
        val channelId = "narraeon-backend"
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(channelId, "Narraeon backend", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val notification: Notification = (
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, channelId)
            else Notification.Builder(this)
            )
            .setContentTitle("Narraeon")
            .setContentText("Backend is running")
            .setSmallIcon(android.R.drawable.ic_popup_sync)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        const val PORT = 4317
        private const val TAG = "NARRAEON-SERVICE"
        private const val ASSET_ROOT = "narraeon"
        private const val NOTIFICATION_ID = 4317
        private val nodeStarted = java.util.concurrent.atomic.AtomicBoolean(false)
    }
}
