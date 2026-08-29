import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const expectedPackage = {
  access: "public",
  bin: "dist/node/cli/main.js",
  engine: ">=24.12.0",
  name: "narraeon",
  registry: "https://registry.npmjs.org/",
  repository: "git+https://github.com/narraeon/narraeon.git",
};

export function verifyRelease({ manifest, releaseTag, releaseIsPrerelease }) {
  assertObject(manifest, "package.json must contain an object");
  assert(
    manifest.name === expectedPackage.name,
    `package name must remain ${expectedPackage.name}`,
  );
  assert(
    typeof manifest.version === "string" && isValidSemver(manifest.version),
    `package version is not valid SemVer: ${String(manifest.version)}`,
  );
  assert(manifest.private !== true, "package.json must not be private");
  assert(
    manifest.bin?.[expectedPackage.name] === expectedPackage.bin &&
      Object.keys(manifest.bin).length === 1,
    `package.json must expose only ${expectedPackage.name} at ${expectedPackage.bin}`,
  );
  assertObject(
    manifest.exports,
    "package.json exports must be an empty object for the CLI-only package",
  );
  assert(
    Object.keys(manifest.exports).length === 0,
    "package.json exports must be an empty object for the CLI-only package",
  );
  assert(
    Array.isArray(manifest.files) && manifest.files.includes("dist"),
    "package.json files must include dist",
  );
  assert(
    manifest.repository?.url === expectedPackage.repository,
    `repository.url must be ${expectedPackage.repository}`,
  );
  assert(
    manifest.publishConfig?.registry === expectedPackage.registry,
    `publishConfig.registry must be ${expectedPackage.registry}`,
  );
  assert(
    manifest.publishConfig?.access === expectedPackage.access,
    `publishConfig.access must be ${expectedPackage.access}`,
  );
  assert(
    manifest.engines?.node === expectedPackage.engine,
    `engines.node must be ${expectedPackage.engine}`,
  );

  const expectedTag = `v${manifest.version}`;
  assert(
    releaseTag === expectedTag,
    `GitHub Release tag ${releaseTag} does not match ${expectedTag}`,
  );

  const versionIsPrerelease = hasPrerelease(manifest.version);
  assert(
    releaseIsPrerelease === versionIsPrerelease,
    versionIsPrerelease
      ? `${expectedTag} contains a prerelease version and must be marked as a GitHub prerelease`
      : `${expectedTag} is stable and must not be marked as a GitHub prerelease`,
  );

  return {
    distTag: versionIsPrerelease ? "next" : "latest",
    name: manifest.name,
    version: manifest.version,
  };
}

function isValidSemver(version) {
  const match = version.match(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  );
  if (match === null) return false;
  return (match[1]?.split(".") ?? []).every(
    (identifier) =>
      !/^\d+$/u.test(identifier) ||
      identifier === "0" ||
      !identifier.startsWith("0"),
  );
}

function hasPrerelease(version) {
  return version.split("+", 1)[0].includes("-");
}

function assertObject(value, message) {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    message,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const releaseTag = requiredArgument("--tag");
  const releaseIsPrerelease = parseBoolean(requiredArgument("--prerelease"));
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const release = verifyRelease({ manifest, releaseTag, releaseIsPrerelease });

  if (process.env.GITHUB_OUTPUT !== undefined) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      [
        `dist_tag=${release.distTag}`,
        `package_name=${release.name}`,
        `package_version=${release.version}`,
        "",
      ].join("\n"),
    );
  }

  process.stdout.write(
    `Release metadata verified: ${release.name}@${release.version} -> npm ${release.distTag}\n`,
  );
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index === -1 || value === undefined || value.startsWith("--")) {
    throw new Error(`Missing required argument ${name}`);
  }
  return value;
}

function parseBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected true or false, received ${value}`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
