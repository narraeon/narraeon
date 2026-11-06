import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { FileNativeWorldRevisionStore } from "../../src/runtime/world-revision/FileNativeWorldRevisionStore.ts";

const fixture = fileURLToPath(
  new URL(
    "./fixtures/world-revision-session-ae20e1f/session.json",
    import.meta.url,
  ),
);

test.each([false, true])(
  "schema 2 upgrade preserves exact historical source; conflicting backup: %s",
  async (conflicting) => {
    const root = await mkdtemp(join(tmpdir(), "revision-migration-"));
    try {
      const source = await readFile(fixture);
      const sessionId = (
        JSON.parse(source.toString("utf8")) as { sessionId: string }
      ).sessionId;
      const sessions = join(root, "world-revisions", "sessions");
      const path = join(sessions, `${sessionId}.json`);
      const backup = join(sessions, ".legacy", `${sessionId}.json`);
      await mkdir(join(sessions, ".legacy"), { recursive: true });
      await writeFile(path, source);
      if (conflicting) await writeFile(backup, "partial");
      const store = new FileNativeWorldRevisionStore(root);
      const session = await store.readSession(sessionId);
      expect(session.schemaVersion).toBe(2);
      // Recovery may need to save a released schema before the next user send.
      session.lastFailure = "Recovered after interruption.";
      if (conflicting) {
        await expect(store.saveSession(session)).rejects.toThrow(
          /backup does not match/iu,
        );
        expect(await readFile(path)).toEqual(source);
        return;
      }
      await store.saveSession(session);
      expect(await readFile(backup)).toEqual(source);
      expect((await store.readSession(sessionId)).schemaVersion).toBe(3);
      await store.saveSession(await store.readSession(sessionId));
      expect(await readFile(backup)).toEqual(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["request", "exchange", "status", "google"] as const)(
  "schema 3 rejects a %s retry checkpoint mismatch",
  async (corruption) => {
    const root = await mkdtemp(join(tmpdir(), "revision-retry-codec-"));
    try {
      const raw = JSON.parse(await readFile(fixture, "utf8")) as Record<
        string,
        unknown
      >;
      const sessionId = raw.sessionId as string;
      raw.schemaVersion = 3;
      raw.runStatus = corruption === "status" ? "ready" : "interrupted";
      const requests = raw.requests as { requestId: string }[];
      raw.retryDispatch = {
        requestId:
          corruption === "request"
            ? "wrong-request"
            : requests.at(-1)!.requestId,
        exchange: Number(raw.exchange) + (corruption === "exchange" ? 5 : 1),
        modelItemCount: (raw.modelItems as unknown[]).length,
        state: "retryable",
      };
      if (corruption === "google")
        (raw.modelBinding as Record<string, unknown>).provider =
          "google_interactions";
      const directory = join(root, "world-revisions", "sessions");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `${sessionId}.json`),
        JSON.stringify(raw),
      );
      await expect(
        new FileNativeWorldRevisionStore(root).readSession(sessionId),
      ).rejects.toThrow(/durable schema/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
