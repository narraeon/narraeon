import { FileNativeWorldStore } from "../../../src/runtime/world/FileNativeWorldStore.ts";

const [, , root, worldId, edge = "none"] = process.argv;
if (root === undefined || worldId === undefined)
  throw new Error("Missing released-storage migration fixture identity");
if (edge !== "none")
  process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_STORAGE_MIGRATION_EDGE = edge;
await new FileNativeWorldStore(root).currentHead(worldId);
