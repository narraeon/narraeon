import { execFileSync } from "node:child_process";
import {
  cp,
  copyFile,
  readdir,
  readFile,
  rm,
  mkdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
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
// Test fixtures from dependencies (for example @fastify/static) contain duplicate
// names such as x.html and x.html.gz, which AAPT rejects as duplicate resources.
execFileSync(
  "find",
  [
    "node_modules",
    "-type",
    "d",
    "(",
    "-name",
    "test",
    "-o",
    "-name",
    "tests",
    "-o",
    "-name",
    "__tests__",
    ")",
    "-prune",
    "-exec",
    "rm",
    "-rf",
    "{}",
    "+",
  ],
  { cwd: assetPath, stdio: "inherit" },
);

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

// Lists every staged file (relative to the bundle root) so the native side can copy
// them without walking AssetManager directories.
const files = [];
for (const name of await readdir(assetPath, { recursive: true })) {
  const relative = name.split(path.sep).join("/");
  if (relative === "bundle-version.txt" || relative === "bundle-files.txt")
    continue;
  if ((await stat(`${assetPath}${relative}`)).isFile()) files.push(relative);
}
await writeFile(`${assetPath}bundle-files.txt`, `${files.sort().join("\n")}\n`);

console.log(`Android bundle staged at ${assetPath}`);
