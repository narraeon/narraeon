import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const testDataRoot = resolve(".test-data");

// Each e2e run starts from empty data, config and log roots so that
// accumulated state (for example the model connection cap) cannot leak
// between runs. Refuse anything outside .test-data to keep this safe.
for (const directory of process.argv.slice(2)) {
  const target = resolve(directory);
  const inside = relative(testDataRoot, target);
  if (inside === "" || isAbsolute(inside) || inside.split(sep)[0] === "..")
    throw new Error(
      `Refusing to reset a directory outside .test-data: ${directory}`,
    );
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
}
