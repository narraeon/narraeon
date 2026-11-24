package app.narraeon.android

import java.net.URL

internal data class BackendEndpoint(val port: Int) {
    val authority = "127.0.0.1:$port"
    val origin = "http://$authority"
    val home = "$origin/"

    fun archiveUrl(path: String): URL? = if (archivePath.matches(path)) URL(origin + path) else null

    private companion object {
        val archivePath = Regex("/api/runtime/v1/world-archives/[A-Za-z0-9][A-Za-z0-9._-]{0,255}")
    }
}
