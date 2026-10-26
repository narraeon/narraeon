import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { StoredWorldRevisionEpoch } from "./FileNativeWorldRevisionStore.ts";

/**
 * The one-time upgrade seam for epochs written by v0.7.4, the last release
 * before #106. The legacy apply phase names live only in this module, so the
 * normal read and write path validates the current schema alone.
 */
export interface LegacyEpochUpgradeInput {
  epochsRoot: string;
  epochIds: readonly string[];
  /** The current strict validator; a v0.7.4 epoch is accepted only once its phase is mapped. */
  validate: (value: unknown) => StoredWorldRevisionEpoch;
  /** Atomic publication of one epoch file. */
  publish: (path: string, value: unknown) => Promise<void>;
}

/**
 * Rewrites v0.7.4 epochs whose control was published into the current
 * `committed` phase. Returns the world of each v0.7.4 epoch left in
 * `state_committed`, which cannot be finished here. Files that do not match a
 * v0.7.4 schema, or cannot be parsed, are left as they are.
 */
export async function upgradeLegacyEpochs(
  input: LegacyEpochUpgradeInput,
): Promise<Map<string, string>> {
  const blocked = new Map<string, string>();
  for (const epochId of input.epochIds) {
    const path = join(input.epochsRoot, `${epochId}.json`);
    const value = await readFile(path, "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => null);
    if (!isRecord(value) || !isRecord(value.apply)) continue;
    if (value.apply.phase === "control_published") {
      const upgraded = epochWithApplyPhase(input, value, "committed");
      if (upgraded !== null) await input.publish(path, upgraded);
    } else if (
      value.apply.phase === "state_committed" &&
      value.lifecycle === "applying"
    ) {
      const legacy = epochWithApplyPhase(input, value, "committed");
      if (legacy !== null) blocked.set(epochId, legacy.worldId);
    }
  }
  return blocked;
}

/** The epoch with its apply phase replaced, if that makes it a valid current epoch. */
function epochWithApplyPhase(
  input: LegacyEpochUpgradeInput,
  value: Record<string, unknown>,
  phase: "committed",
): StoredWorldRevisionEpoch | null {
  try {
    return input.validate({
      ...value,
      apply: { ...(value.apply as Record<string, unknown>), phase },
    });
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
