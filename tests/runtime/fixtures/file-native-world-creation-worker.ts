import { readFile } from "node:fs/promises";

import type { FileNativeWorldCreationInput } from "../../../src/runtime/world/FileNativeWorldStore.ts";
import { FileNativeWorldStore } from "../../../src/runtime/world/FileNativeWorldStore.ts";

const [, , dataRoot, inputPath, crashEdge = "none"] = process.argv;
if (dataRoot === undefined || inputPath === undefined) {
  throw new Error("Missing file-native world-creation process test arguments");
}
if (crashEdge !== "none") {
  process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_FILE_NATIVE_WORLD_CREATION_EDGE =
    crashEdge;
}
const input = JSON.parse(
  await readFile(inputPath, "utf8"),
) as FileNativeWorldCreationInput;
const result = await new FileNativeWorldStore(
  dataRoot,
).createFromContentPackage(input);
process.stdout.write(`${JSON.stringify(result.world)}\n`);
