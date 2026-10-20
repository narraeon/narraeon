import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Build the release image from an npm tarball. With --package <dir> the
// tarball already in that directory is used (CI passes the validated release
// artifact); otherwise the repository is packed into a temporary directory
// first. Either way the Dockerfile only ever sees the tarball, never the
// source tree.
const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const dockerCommand = process.platform === "win32" ? "docker.exe" : "docker";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const tag = requiredArgument("--tag");
const suppliedPackageRoot = optionalArgument("--package");
let temporaryRoot;

try {
  let packageRoot = suppliedPackageRoot;
  if (packageRoot === undefined) {
    temporaryRoot = await mkdtemp(join(tmpdir(), "narraeon-container-"));
    packageRoot = temporaryRoot;
    await execute(
      npmCommand,
      ["pack", "--silent", "--pack-destination", packageRoot],
      { cwd: repositoryRoot, env: { ...process.env, TMPDIR: "/tmp" } },
    );
  }
  const tarballs = (await readdir(packageRoot)).filter((name) =>
    /^narraeon-.*\.tgz$/u.test(name),
  );
  if (tarballs.length !== 1)
    throw new Error(
      `Expected exactly one narraeon-*.tgz in ${packageRoot}, found ${String(tarballs.length)}`,
    );
  await execute(
    dockerCommand,
    [
      "build",
      "--tag",
      tag,
      "--build-context",
      `package=${packageRoot}`,
      repositoryRoot,
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  process.stdout.write(`Built ${tag} from ${join(packageRoot, tarballs[0])}\n`);
} finally {
  if (temporaryRoot !== undefined)
    await rm(temporaryRoot, { recursive: true, force: true });
}

function requiredArgument(name) {
  const value = optionalArgument(name);
  if (value === undefined) throw new Error(`Missing required argument ${name}`);
  return value;
}

function optionalArgument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`Missing value for argument ${name}`);
  return value;
}
