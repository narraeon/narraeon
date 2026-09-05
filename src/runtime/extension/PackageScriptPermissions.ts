import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { readPackageFollowups } from "../content/PackageFollowups.ts";
import type { ContentTreeFile } from "../content/ContentTreeFile.ts";

const fileName = "package-script-permissions.json";

/** Local grants authorize exact resource bytes. They never travel in a portable content tree. */
export class PackageScriptPermissions {
  static async read(ownerRoot: string): Promise<string[]> {
    try {
      const value: unknown = JSON.parse(
        await readFile(join(ownerRoot, fileName), "utf8"),
      );
      if (
        typeof value !== "object" ||
        value === null ||
        !("schemaVersion" in value) ||
        value.schemaVersion !== 1 ||
        !("grants" in value) ||
        Object.keys(value).length !== 2 ||
        !Array.isArray(value.grants) ||
        !value.grants.every(
          (entry: unknown): entry is string =>
            typeof entry === "string" && /^[a-f0-9]{64}$/u.test(entry),
        )
      )
        throw new Error("Invalid local package script permissions");
      return value.grants;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }
  }
  static async write(
    ownerRoot: string,
    grants: readonly string[],
  ): Promise<void> {
    const path = join(ownerRoot, fileName);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ schemaVersion: 1, grants }));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      const directory = await open(ownerRoot, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
  static fingerprint(files: Record<string, string>): string {
    return createHash("sha256")
      .update(
        JSON.stringify(
          Object.entries(files).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        ),
      )
      .digest("hex");
  }
  static currentGrants(files: readonly ContentTreeFile[]): string[] {
    const source = readPackageFollowups(files);
    return [
      ...new Set(
        source.followups.map(({ definition }) => {
          const paths = new Set(
            definition.artifacts.flatMap((artifact) =>
              [
                artifact.renderer,
                artifact.regex,
                ...(artifact.scripts ?? []),
                ...(artifact.assets ?? []),
              ].filter((path): path is string => path !== undefined),
            ),
          );
          return this.fingerprint(
            Object.fromEntries(
              [...paths].map((path) => [path, source.files[path]!]),
            ),
          );
        }),
      ),
    ];
  }
  static status(
    files: readonly ContentTreeFile[],
    grants: readonly string[],
  ): { enabled: boolean } {
    const current = this.currentGrants(files);
    return {
      enabled:
        current.length > 0 && current.every((grant) => grants.includes(grant)),
    };
  }
}
