package app.narraeon.android

// Thin JNI binding to node::Start in libnode.so. node::Start never returns during normal
// operation and can only run once per process, so callers must guard against a second call.
object NativeNode {
    init {
        System.loadLibrary("narraeon-native")
    }

    /**
     * @param arguments argv for node, e.g. ["node", "<path>/server/mobile.js"].
     * @param environment entries in "KEY=VALUE" form, applied with setenv before node starts.
     */
    @JvmStatic
    external fun startNode(arguments: Array<String>, environment: Array<String>): Int
}
