package app.narraeon.android

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.Process
import android.util.Log
import java.io.File

// Runs the Narraeon backend inside this app process. The Node runtime can only start
// once per process, so a second start is ignored.
class NodeService : Service() {
    @Volatile
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_EXIT) {
            exitApp()
            return START_NOT_STICKY
        }
        startForegroundCompat()
        if (!nodeStarted.compareAndSet(false, true)) return START_STICKY

        Thread({
            try {
                nodeState = NodeState.Preparing
                val root = prepareBundle()
                val crashDir = DiagnosticLog.crashDir(this)
                val arguments = arrayOf("node", File(root, "node/server/mobile.js").path)
                val environment = arrayOf(
                    "NARRAEON_PORT=$PORT",
                    "NARRAEON_STATIC_ROOT=${File(root, "web").path}",
                    "NARRAEON_DATA_ROOT=${File(filesDir, "data").path}",
                    "NARRAEON_CONFIG_ROOT=${File(filesDir, "config").path}",
                    "NARRAEON_LOG_ROOT=${File(filesDir, "log").path}",
                    "HOME=${filesDir.path}",
                    "TMPDIR=${cacheDir.path}",
                    "NARRAEON_STDERR_LOG=${File(crashDir, "node-stderr.log").path}",
                )
                // The data-root lock (server.pid) survives an app kill. After a restart, its PID can
                // belong to another process; kill(pid, 0) then reports EPERM, which the server reads as
                // alive, and startup is refused. Android runs one app process at a time, so no live
                // Narraeon owner can exist here. Remove the stale file before starting Node.
                File(filesDir, "data/server.pid").delete()
                acquireWakeLock()
                nodeState = NodeState.Running
                val code = NativeNode.startNode(arguments, environment)
                nodeState = NodeState.Exited("node exited with code $code")
                Log.e(TAG, "node exited with code $code")
                DiagnosticLog.append(this, "node-service.log", "node exited with code $code")
            } catch (error: Throwable) {
                nodeState = NodeState.Exited("node failed to start: $error")
                Log.e(TAG, "node failed to start", error)
                DiagnosticLog.append(this, "node-service.log", "node failed to start\n${Log.getStackTraceString(error)}")
            } finally {
                releaseWakeLock()
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

    // The foreground service keeps the process alive, but with the screen off the CPU
    // still sleeps and Node stops mid-request. A partial wake lock keeps it running for
    // as long as Node does; the notification's Exit action ends both.
    @SuppressLint("WakelockTimeout")
    private fun acquireWakeLock() {
        val lock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Narraeon:node")
        lock.setReferenceCounted(false)
        lock.acquire()
        wakeLock = lock
    }

    private fun releaseWakeLock() {
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
    }

    // Node cannot be started twice in one process, so exiting ends the process.
    private fun exitApp() {
        releaseWakeLock()
        getSystemService(ActivityManager::class.java).appTasks.forEach { it.finishAndRemoveTask() }
        stopSelf()
        Process.killProcess(Process.myPid())
    }

    private fun startForegroundCompat() {
        val channelId = "narraeon-backend"
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(channelId, getString(R.string.backend_channel_name), NotificationManager.IMPORTANCE_LOW),
            )
        }
        // Tapping the notification brings the existing task forward, as the launcher does.
        val openApp = PendingIntent.getActivity(
            this,
            0,
            packageManager.getLaunchIntentForPackage(packageName)!!
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val exit = PendingIntent.getService(
            this,
            0,
            Intent(this, NodeService::class.java).setAction(ACTION_EXIT),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification: Notification = (
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, channelId)
            else Notification.Builder(this)
            )
            .setContentTitle("Narraeon")
            .setContentText(getString(R.string.backend_running))
            .setSmallIcon(android.R.drawable.ic_popup_sync)
            .setContentIntent(openApp)
            .setOngoing(true)
            .addAction(
                Notification.Action.Builder(null, getString(R.string.backend_exit), exit).build(),
            )
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
        private const val ACTION_EXIT = "app.narraeon.android.action.EXIT"
        private val nodeStarted = java.util.concurrent.atomic.AtomicBoolean(false)

        @Volatile
        var nodeState: NodeState = NodeState.NotStarted
            private set
    }

    sealed interface NodeState {
        data object NotStarted : NodeState
        data object Preparing : NodeState
        data object Running : NodeState

        // node::Start returned or threw. It cannot run again in this process.
        data class Exited(val detail: String) : NodeState
    }
}
