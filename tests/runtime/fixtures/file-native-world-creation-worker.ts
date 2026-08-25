import { readFile } from "node:fs/promises";

import type { FileNativeWorldCreationInput } from "../../../src/runtime/world/FileNativeWorldStore.ts";
import { FileNativeWorldStore } from "../../../src/runtime/world/FileNativeWorldStore.ts";

const [, , dataRoot, inputPath, crashEdge = "none"] = process.argv;
if (dataRoot === undefined || inputPath === undefined) {
  throw new Error("缺少文件原生世界创建进程测试参数");
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
