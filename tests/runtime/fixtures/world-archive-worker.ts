import { createReadStream } from "node:fs";
import { archiveStores } from "../../support/worldArchiveFixture.ts";
const [root, uploadId, edge] = process.argv.slice(2);
if (!root || !uploadId || !edge) throw new Error("Missing worker arguments");
if (edge.startsWith("derivation_"))
  process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_FILE_NATIVE_AUTHORITY_EDGE = edge;
else process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_WORLD_ARCHIVE_EDGE = edge;
if (edge === "upload")
  await archiveStores(root).archives.upload(createReadStream(uploadId));
else
  await archiveStores(root).archives.importWorld({
    operationId: "crash-import",
    uploadId,
  });
