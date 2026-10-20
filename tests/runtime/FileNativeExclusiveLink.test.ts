import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { linkExclusive } from "../../src/runtime/FileNativeExclusiveLink.ts";

const forcedCodeVariable = "NARRAEON_INTERNAL_TEST_LINK_ERROR_CODE";

describe("linkExclusive", () => {
  let directory: string;
  let source: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "narraeon-exclusive-link-"));
    source = join(directory, "source.txt");
    await writeFile(source, "payload", "utf8");
  });

  afterEach(async () => {
    delete process.env[forcedCodeVariable];
    await rm(directory, { recursive: true, force: true });
  });

  it("creates target as a hard link when the filesystem allows it", async () => {
    const target = join(directory, "linked.txt");

    await linkExclusive(source, target);

    expect(await readFile(target, "utf8")).toBe("payload");
    expect((await stat(target)).nlink).toBe(2);
  });

  it.each(["EACCES", "EPERM", "ENOTSUP", "EXDEV"])(
    "falls back to an exclusive copy when link fails with %s",
    async (code) => {
      process.env[forcedCodeVariable] = code;
      const target = join(directory, `fallback-${code}.txt`);

      await linkExclusive(source, target);

      expect(await readFile(target, "utf8")).toBe("payload");
      expect((await stat(target)).nlink).toBe(1);
    },
  );

  it("fails with EEXIST on the hard-link path when target already exists", async () => {
    const target = join(directory, "existing.txt");
    await writeFile(target, "other", "utf8");

    await expect(linkExclusive(source, target)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(target, "utf8")).toBe("other");
  });

  it("fails with EEXIST on the fallback path when target already exists", async () => {
    const target = join(directory, "existing-fallback.txt");
    await writeFile(target, "other", "utf8");
    process.env[forcedCodeVariable] = "EACCES";

    await expect(linkExclusive(source, target)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(target, "utf8")).toBe("other");
  });

  it("rethrows errors that are not fallback codes", async () => {
    process.env[forcedCodeVariable] = "EIO";
    const target = join(directory, "io-error.txt");

    await expect(linkExclusive(source, target)).rejects.toMatchObject({
      code: "EIO",
    });
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
