package app.narraeon.android

import android.content.Context
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.os.PowerManager
import android.os.Process
import android.util.Log
import java.io.IOException
import java.util.UUID

/** Receives generation state from Node over a private, same-process socket. */
internal class GenerationWakeLock(context: Context) : AutoCloseable {
    val socketName = "narraeon-generation-${UUID.randomUUID()}"
    private val wakeLock = context.getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Narraeon:generation")
        .apply { setReferenceCounted(false) }
    private val listener = LocalServerSocket(socketName)
    private var connection: LocalSocket? = null
    private var closed = false
    private var active = false

    init {
        Thread(::receive, "narraeon-generation").start()
    }

    private fun receive() {
        try {
            while (true) {
                val socket = listener.accept()
                try {
                    val peer = socket.peerCredentials
                    if (peer.uid != Process.myUid() || peer.pid != Process.myPid()) continue
                    synchronized(this) {
                        if (closed) return
                        connection = socket
                    }
                    val input = socket.inputStream
                    while (true) {
                        when (input.read()) {
                            '1'.code -> setActive(true)
                            '0'.code -> setActive(false)
                            else -> return
                        }
                    }
                } finally {
                    socket.close()
                }
            }
        } catch (error: IOException) {
            synchronized(this) {
                if (!closed) Log.w(TAG, "Generation activity socket closed", error)
            }
        } finally {
            close()
        }
    }

    @Synchronized
    private fun setActive(next: Boolean) {
        if (active == next || (next && closed)) return
        active = next
        // The OS releases a stuck generation after one bounded hold. Only the
        // next idle-to-active transition can start a fresh hold.
        if (next) wakeLock.acquire(MAX_HOLD_MS)
        else if (wakeLock.isHeld) wakeLock.release()
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        setActive(false)
        runCatching { connection?.close() }
        runCatching { listener.close() }
    }

    private companion object {
        const val TAG = "NARRAEON-SERVICE"
        const val MAX_HOLD_MS = 15 * 60_000L
    }
}
