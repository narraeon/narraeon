package app.narraeon.android

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.os.Process
import android.util.Log
import java.io.DataInputStream
import java.io.EOFException
import java.io.File
import java.io.IOException
import kotlin.concurrent.thread
import org.json.JSONObject

// Runs the Narraeon backend inside this app process. The Node runtime can only start
// once per process, so a second start is ignored.
class NodeService : Service() {
    private var generationWakeLock: GenerationWakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_EXIT) {
            exitApp()
            return START_NOT_STICKY
        }
        startForegroundCompat()
        if (!nodeStarted.compareAndSet(false, true)) return START_STICKY
        val wakeLock = try {
            GenerationWakeLock(this)
        } catch (error: IOException) {
            Log.e(TAG, "Could not open generation activity socket", error)
            null
        }
        generationWakeLock = wakeLock

        Thread({
            try {
                nodeState = NodeState.Preparing
                val root = prepareBundle()
                val crashDir = DiagnosticLog.crashDir(this)
                // The data-root lock (server.pid) survives an app kill. After a restart, its PID can
                // belong to another process; kill(pid, 0) then reports EPERM, which the server reads as
                // alive, and startup is refused. Android runs one app process at a time, so no live
                // Narraeon owner can exist here. Remove the stale file before starting Node.
                File(filesDir, "data/server.pid").delete()
                val code = startNode(root, File(crashDir, "node-stderr.log"), wakeLock?.socketName)
                nodeState = NodeState.Exited("node exited with code $code")
                Log.e(TAG, "node exited with code $code")
                DiagnosticLog.append(this, "node-service.log", "node exited with code $code")
            } catch (error: Throwable) {
                nodeState = NodeState.Exited("node failed to start: $error")
                Log.e(TAG, "node failed to start", error)
                DiagnosticLog.append(this, "node-service.log", "node failed to start\n${Log.getStackTraceString(error)}")
            } finally {
                wakeLock?.close()
                // node::Start cannot be re-entered in this process, so the guard stays set.
                Log.w(TAG, "node thread finished; restart requires a new app process")
            }
        }, "narraeon-node").start()

        return START_STICKY
    }

    private fun startNode(root: File, stderrLog: File, generationSocket: String?): Int {
        val config = JSONObject()
            .put("NARRAEON_PORT", "0")
            .put("NARRAEON_GENERATION_SOCKET", generationSocket)
            .put("NARRAEON_MOBILE_STARTUP_KEY", backendIdentity.startupKey)
            .put("NARRAEON_STATIC_ROOT", File(root, "web").path)
            .put("NARRAEON_DATA_ROOT", File(filesDir, "data").path)
            .put("NARRAEON_CONFIG_ROOT", File(filesDir, "config").path)
            .put("NARRAEON_LOG_ROOT", File(filesDir, "log").path)
            .put("HOME", filesDir.path)
            .put("TMPDIR", cacheDir.path)
            .toString().toByteArray(Charsets.UTF_8)

        // The payload must fit in an Android pipe before Node starts reading it.
        // Keep ownership of the read end here even if native initialization fails.
        check(config.size <= 4096) { "Node startup configuration exceeds pipe capacity" }
        val (reader, writer) = ParcelFileDescriptor.createPipe()
        return reader.use {
            ParcelFileDescriptor.AutoCloseOutputStream(writer).use { it.write(config) }
            val (readyReader, readyWriter) = ParcelFileDescriptor.createPipe()
            var relay: Thread? = null
            try {
                readyWriter.use {
                    relay = thread(name = "narraeon-node-readiness") { receiveReadiness(readyReader) }
                    NativeNode.startNode(
                        arrayOf(
                            "node", File(root, "node/server/mobile-bootstrap.js").path,
                            reader.fd.toString(), readyWriter.fd.toString(),
                        ),
                        stderrLog.path,
                    )
                }
            } finally {
                // On startup failure, closing the writer releases the waiting reader.
                // Join before publishing Exited so a late handoff cannot replace it.
                relay?.join() ?: readyReader.close()
            }
        }
    }

    private fun receiveReadiness(reader: ParcelFileDescriptor) {
        try {
            DataInputStream(ParcelFileDescriptor.AutoCloseInputStream(reader)).use { input ->
                val port = input.readUnsignedShort()
                if (port == 0) throw IOException("Node reported an invalid listening port")
                nodeState = NodeState.Ready(BackendEndpoint(port))
            }
        } catch (_: EOFException) {
            // Node returned before publishing readiness. The startup thread reports its exit.
        } catch (error: IOException) {
            Log.e(TAG, "could not read Node listening port", error)
            DiagnosticLog.append(this, "node-service.log", "could not read Node listening port: $error")
        }
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

    override fun onTimeout(startId: Int, fgsType: Int) {
        generationWakeLock?.close()
        stopSelf()
        Log.i(TAG, "dataSync foreground service timed out (startId=$startId, type=$fgsType)")
    }

    override fun onDestroy() {
        generationWakeLock?.close()
        super.onDestroy()
        if (nodeStarted.get()) {
            // Let Android acknowledge the service stop before ending the process.
            // Reopening the app can then start Node once in a fresh process.
            Handler(mainLooper).post { Process.killProcess(Process.myPid()) }
        }
    }

    // Node cannot be started twice in one process, so exiting ends the process.
    private fun exitApp() {
        generationWakeLock?.close()
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
        internal val backendIdentity = BackendIdentity()
        private const val TAG = "NARRAEON-SERVICE"
        private const val ASSET_ROOT = "narraeon"
        private const val VERSION_FILE = "bundle-version.txt"
        private const val FILE_LIST = "bundle-files.txt"
        private const val NOTIFICATION_ID = 4317
        private const val ACTION_EXIT = "app.narraeon.android.action.EXIT"
        private val nodeStarted = java.util.concurrent.atomic.AtomicBoolean(false)

        @Volatile
        internal var nodeState: NodeState = NodeState.NotStarted
            private set
    }

    internal sealed interface NodeState {
        data object NotStarted : NodeState
        data object Preparing : NodeState
        data class Ready(val endpoint: BackendEndpoint) : NodeState

        // node::Start returned or threw. It cannot run again in this process.
        data class Exited(val detail: String) : NodeState
    }
}
