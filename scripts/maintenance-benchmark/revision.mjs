import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { modelBinding, post, rpc, rpcBody, runtimeServer } from "./common.mjs";
import { editedDocument, fileVolume, revisionFiles } from "./fixtures.mjs";

async function measureWorld(root, url, size) {
  const files = revisionFiles(size);
  const { localId: packageId } = await rpc(url, { type: "content.create" });
  const { treeRevision } = await rpc(url, { type: "content.read", packageId });
  const content = await rpc(url, {
    type: "content.replace",
    packageId,
    baseTreeRevision: treeRevision,
    files,
  });
  assert.equal(content.status, "usable");
  const { outcome, world } = await rpc(url, {
    type: "world.create",
    operationId: `revision-${packageId}`,
    packageId,
    model: modelBinding("revision-fixture"),
  });
  assert.equal(outcome, "created");

  const { worldId } = world;
  const initial = await rpc(url, { type: "world.revision.open", worldId });
  assert.equal(initial.epoch.locked, true);
  const { epochId } = initial.epoch;
  const path = join(root, "world-revisions", "epochs", `${epochId}.json`);
  const workload = {
    files: initial.epoch.files.length,
    draftUtf8Bytes: fileVolume(initial.epoch.files),
    editedFileBytes: Buffer.byteLength(
      initial.epoch.files.find(({ path }) => path === editedDocument).contents,
    ),
    initialEpochDiskBytes: (await stat(path)).size,
  };
  let epoch = initial.epoch;
  const saves = [];
  for (let edit = 1; edit <= 3; edit++) {
    const editedFiles = epoch.files.map((file) =>
      file.path === editedDocument
        ? {
            ...file,
            contents: file.contents.replace(
              `Revision marker ${edit - 1}.`,
              `Revision marker ${edit}.`,
            ),
          }
        : file,
    );
    const body = rpcBody({
      type: "world.revision.files.replace",
      worldId,
      epochId,
      expectedRevision: epoch.revision,
      files: editedFiles,
    });
    const { bytes, elapsedMs } = await post(url, body);
    const next = JSON.parse(bytes).result.epoch;
    assert.equal(next.epochId, epochId);
    assert.notEqual(next.revision, epoch.revision);
    assert.equal(next.changes.length, edit);
    assert.deepEqual(
      next.changes.at(-1).changes.map(({ path }) => path),
      [editedDocument],
    );
    saves.push({
      edit,
      elapsedMs,
      requestBytes: body.byteLength,
      responseBytes: bytes.byteLength,
      epochDiskBytes: (await stat(path)).size,
    });
    epoch = next;
  }
  const readback = await rpc(url, { type: "world.revision.overview", worldId });
  assert.equal(readback.epoch.revision, epoch.revision);
  const current = await rpc(url, { type: "world.read", worldId });
  assert.equal(current.head, initial.epoch.baseHead);
  assert.deepEqual(readback.epoch.files, epoch.files);
  assert(
    readback.epoch.files
      .find(({ path }) => path === editedDocument)
      .contents.includes("Revision marker 3."),
  );
  return { size, workload, saves };
}

export async function measureRevisions(root, repeats) {
  const { server, url, dataRoot } = await runtimeServer(root);
  try {
    await measureWorld(dataRoot, url, "small");
    const samples = [];
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const sizes = repeat % 2 ? ["small", "large"] : ["large", "small"];
      for (const size of sizes) {
        console.error(`revision ${size} ${repeat}/${repeats}`);
        samples.push({ repeat, ...(await measureWorld(dataRoot, url, size)) });
      }
    }
    return samples;
  } finally {
    await server.close();
  }
}
