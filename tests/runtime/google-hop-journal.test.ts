import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writeGoogleHop } from "../../src/runtime/model/GoogleHopJournal.ts";

test("过期或已删除的记录不会被排队的迟到写入重建", async () => {
  const root = await mkdtemp(join(tmpdir(), "google-hop-expired-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let retained = true;
  let checks = 0;
  const pending = writeGoogleHop(
    join(root, "expired"),
    "main",
    {
      exchange: 1,
      attempt: 1,
      hop: 2,
      tokenSupplied: true,
      status: "completed",
    },
    async () => {
      if (++checks === 2) {
        entered();
        await gate;
      }
      return retained;
    },
  );
  await writing;
  retained = false;
  await rm(join(root, "expired"), { recursive: true, force: true });
  release();
  await pending;
  expect(await readdir(root)).toEqual([]);
  await rm(root, { recursive: true, force: true });
});
