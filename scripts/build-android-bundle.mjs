import { execFileSync } from "node:child_process";
import { cp, copyFile, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Stages the backend, web assets and production dependencies into the Android
// app's assets folder. The native shell copies this folder into filesDir on first
// launch and whenever bundle-version.txt changes.
const root = fileURLToPath(new URL("..", import.meta.url));
const assetRoot = new URL(
  "../android/app/src/main/assets/narraeon/",
  import.meta.url,
);
const assetPath = fileURLToPath(assetRoot);

execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });

await rm(assetPath, { recursive: true, force: true });
await mkdir(assetPath, { recursive: true });

await cp(new URL("../dist/node/", import.meta.url), `${assetPath}node`, {
  recursive: true,
});
await cp(new URL("../dist/web/", import.meta.url), `${assetPath}web`, {
  recursive: true,
});
await copyFile(
  new URL("../package.json", import.meta.url),
  `${assetPath}package.json`,
);
await copyFile(
  new URL("../package-lock.json", import.meta.url),
  `${assetPath}package-lock.json`,
);

execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
  cwd: assetPath,
  stdio: "inherit",
});
await rm(`${assetPath}package-lock.json`, { force: true });

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
await writeFile(
  `${assetPath}bundle-version.txt`,
  `${packageJson.version}+${sha}\n`,
);

console.log(`Android bundle staged at ${assetPath}`);
