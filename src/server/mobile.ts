import { resolveAppPaths } from "../runtime/config/appPaths.ts";
import { parseWebPort, startWebServer } from "./startWebServer.ts";

// Mobile entry: started inside the Android app's Node runtime. The native shell
// owns the process lifecycle, so this module never registers signal handlers and
// never calls process.exit(); a startup failure rejects and the native side reads
// stderr.
const staticRoot = process.env.NARRAEON_STATIC_ROOT?.trim();
if (!staticRoot)
  throw new Error("NARRAEON_STATIC_ROOT is required for the mobile entry");

const port = parseWebPort(process.env.NARRAEON_PORT);
const paths = resolveAppPaths(process.env);
const server = await startWebServer({
  paths,
  staticRoot,
  host: "127.0.0.1",
  port,
});

const address = server.server.address();
const listeningPort =
  typeof address === "object" && address !== null ? address.port : port;
process.stdout.write(`NARRAEON_READY ${listeningPort}\n`);
