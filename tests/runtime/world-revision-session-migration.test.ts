import type * as FileSystem from "node:fs/promises";
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { FileNativeWorldRevisionStore } from "../../src/runtime/world-revision/FileNativeWorldRevisionStore.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof FileSystem>();
  return { ...fs, link: vi.fn(fs.link), rename: vi.fn(fs.rename) };
});

const fixture = fileURLToPath(
  new URL(
    "./fixtures/world-revision-session-ae20e1f/session.json",
    import.meta.url,
  ),
);

test.each([
  { existing: "absent", failPublication: false },
  { existing: "identical", failPublication: false },
  { existing: "conflicting", failPublication: false },
  { existing: "absent", failPublication: true },
])(
  "schema 2 upgrade without hard links preserves its source (backup: $existing, publication failure: $failPublication)",
  async ({ existing, failPublication }) => {
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
      const conflictingBackup = Buffer.from(
        "prior backup with different bytes",
      );
      if (existing === "identical") await writeFile(backup, source);
      if (existing === "conflicting")
        await writeFile(backup, conflictingBackup);
      vi.mocked(link).mockRejectedValue(
        Object.assign(new Error("Hard links are unavailable"), {
          code: "EACCES",
        }),
      );
      const upgrade = async () => {
        const store = new FileNativeWorldRevisionStore(root);
        const session = await store.readSession(sessionId);
        expect(session.schemaVersion).toBe(2);
        // Recovery may need to save a released schema before the next user send.
        session.lastFailure = "Recovered after interruption.";
        await store.saveSession(session);
      };
      if (existing === "conflicting") {
        await expect(upgrade()).rejects.toThrow(/backup does not match/iu);
        expect(await readFile(path)).toEqual(source);
        expect(await readFile(backup)).toEqual(conflictingBackup);
        return;
      }
      if (failPublication) {
        const publish = vi.mocked(rename).getMockImplementation()!;
        vi.mocked(rename).mockImplementation(async (source, target) => {
          if (target === backup)
            throw Object.assign(new Error("Backup publication interrupted"), {
              code: "EIO",
            });
          return publish(source, target);
        });
        await expect(upgrade()).rejects.toThrow(
          "Backup publication interrupted",
        );
        expect(await readFile(path)).toEqual(source);
        await expect(readFile(backup)).rejects.toMatchObject({
          code: "ENOENT",
        });
        vi.mocked(rename).mockReset();
      }
      await upgrade();
      expect(await readFile(backup)).toEqual(source);
      const reopened = new FileNativeWorldRevisionStore(root);
      const upgraded = await reopened.readSession(sessionId);
      expect(upgraded).toMatchObject({
        schemaVersion: 3,
        lastFailure: "Recovered after interruption.",
      });
      await reopened.saveSession(upgraded);
      expect(await readFile(backup)).toEqual(source);
    } finally {
      vi.mocked(link).mockReset();
      vi.mocked(rename).mockReset();
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

test("schema 3 source is preserved when dispatch evidence upgrades to schema 4", async () => {
  const root = await mkdtemp(join(tmpdir(), "revision-schema4-"));
  try {
    const raw = JSON.parse(await readFile(fixture, "utf8")) as {
      sessionId: string;
      schemaVersion: number;
    };
    raw.schemaVersion = 3;
    const source = JSON.stringify(raw);
    const sessions = join(root, "world-revisions", "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, `${raw.sessionId}.json`), source);
    const store = new FileNativeWorldRevisionStore(root);
    const session = await store.readSession(raw.sessionId);
    session.schemaVersion = 4;
    await store.saveSession(session);
    expect(
      await readFile(
        join(sessions, ".legacy", `${raw.sessionId}.schema-v3.json`),
        "utf8",
      ),
    ).toBe(source);
    expect((await store.readSession(raw.sessionId)).schemaVersion).toBe(4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
