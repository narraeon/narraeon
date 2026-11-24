package app.narraeon.android

// Thin JNI binding to node::Start in libnode.so. node::Start never returns during normal
// operation and can only run once per process, so callers must guard against a second call.
object NativeNode {
    init {
        System.loadLibrary("narraeon-native")
    }

    /**
     * @param arguments Node argv, including the bootstrap script and its configuration and readiness pipe fds.
     * @param stderrPath private file to preserve a copy of Node stderr for diagnostic export.
     */
    @JvmStatic
    external fun startNode(arguments: Array<String>, stderrPath: String): Int
}
