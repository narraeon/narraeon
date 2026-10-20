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
                // The data-root lock (server.pid) survives an app kill. After a restart, its PID can
                // belong to another process; kill(pid, 0) then reports EPERM, which the server reads as
                // alive, and startup is refused. Android runs one app process at a time, so no live
                // Narraeon owner can exist here. Remove the stale file before starting Node.
                File(filesDir, "data/server.pid").delete()
                val code = NativeNode.startNode(arguments, environment)
                Log.e(TAG, "node exited with code $code")
            } catch (error: Throwable) {
                Log.e(TAG, "node failed to start", error)
            } finally {
                // node::Start cannot be re-entered in this process, so the guard stays set.
                Log.w(TAG, "node thread finished; restart requires a new app process")
            }
        }, "narraeon-node").start()

        return START_STICKY
    }

    // Copies assets/narraeon into filesDir/narraeon when bundle-version.txt changes. The file
    // list comes from bundle-files.txt, written by build-android-bundle.mjs, because walking
    // AssetManager directories is slow for node_modules. Data directories live outside this
    // folder and survive upgrades. The version marker is written last, so an interrupted copy
    // is redone on the next launch.
    private fun prepareBundle(): File {
        val target = File(filesDir, "narraeon")
        val assetVersion = readAsset("$ASSET_ROOT/$VERSION_FILE")
        val installedVersion = File(target, VERSION_FILE).takeIf { it.exists() }?.readText()
        if (installedVersion != assetVersion) {
            target.deleteRecursively()
            target.mkdirs()
            for (relative in readAsset("$ASSET_ROOT/$FILE_LIST").lineSequence()) {
                if (relative.isEmpty()) continue
                val destination = File(target, relative)
                destination.parentFile?.mkdirs()
                assets.open("$ASSET_ROOT/$relative").use { input ->
                    destination.outputStream().use { input.copyTo(it) }
                }
            }
            File(target, VERSION_FILE).writeText(assetVersion)
        }
        return target
    }

    private fun readAsset(path: String): String =
        assets.open(path).bufferedReader().use { it.readText() }

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
        private const val VERSION_FILE = "bundle-version.txt"
        private const val FILE_LIST = "bundle-files.txt"
        private const val NOTIFICATION_ID = 4317
        private val nodeStarted = java.util.concurrent.atomic.AtomicBoolean(false)
    }
}
