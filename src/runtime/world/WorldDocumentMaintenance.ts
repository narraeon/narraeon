import type {
  WorldDocumentMaintenance,
  WorldWritePosition,
} from "../../protocol/worldMaintenance.ts";
import { listWorldDocuments } from "../prompt/WorldMaintenanceReport.ts";
import { WorldDocumentStore } from "./WorldDocumentStore.ts";
import {
  isCorrectionCommit,
  type WorldLedgerAuthority,
} from "./WorldLedgerAuthority.ts";

export interface DocumentMaintenanceState {
  files: Map<string, string>;
  facts: Record<string, WorldDocumentMaintenance>;
  bodyContexts: Map<string, Set<string>>;
  metadataContexts: Map<string, Set<string>>;
  contexts: Map<string, { ordinal: number; round: number }>;
  inputPosition: number;
  unassignedPlayer: boolean;
}

/** Reachable committed bytes only. Cached prefixes are disposable accelerators. */
export async function readDocumentMaintenanceFacts(
  authority: WorldLedgerAuthority,
  head: string | undefined,
  cache: Map<string, DocumentMaintenanceState>,
): Promise<Record<string, WorldDocumentMaintenance>> {
  const cachedPrefixes = new Map(cache);
  const history = await authority.readStateHistory(head, (candidate) =>
    cachedPrefixes.has(candidate),
  );
  const prefix = cachedPrefixes.get(history.prefixHead);
  if (history.prefixHead === history.head && prefix !== undefined)
    return structuredClone(prefix.facts);
  const files =
    prefix === undefined
      ? new Map(
          history.genesisState.map(({ path, contents }) => [path, contents]),
        )
      : new Map(prefix.files);
  const snapshotFiles = () =>
    [...files].map(([path, contents]) => ({
      path: `state/${path}`,
      contents,
    }));
  let previous = WorldDocumentStore.open({
    layout: "world_state",
    files: snapshotFiles(),
  });
  const facts: Record<string, WorldDocumentMaintenance> = structuredClone(
    prefix?.facts ?? {},
  );
  const bodyContexts = structuredClone(
    prefix?.bodyContexts ?? new Map<string, Set<string>>(),
  );
  const metadataContexts = structuredClone(
    prefix?.metadataContexts ?? new Map<string, Set<string>>(),
  );
  const origin: WorldWritePosition = {
    kind: "world_origin",
    context: null,
    round: 0,
    worldTime: null,
  };
  for (const document of prefix === undefined
    ? listWorldDocuments(previous)
    : []) {
    const read = previous.query({
      kind: "read_document",
      document: { shortRef: document.shortRef },
    });
    if (read.kind !== "read_document") continue;
    facts[document.shortRef] = {
      baselineKind: "world_origin",
      baselineBytes: Buffer.byteLength(read.body, "utf8"),
      lastBodyWrite: origin,
      lastMetadataWrite: origin,
      bodyChangedContexts: 0,
      metadataChangedContexts: 0,
    };
  }
  const contexts = structuredClone(
    prefix?.contexts ?? new Map<string, { ordinal: number; round: number }>(),
  );
  let inputPosition = prefix?.inputPosition ?? 0;
  let unassignedPlayer = prefix?.unassignedPlayer ?? false;
  for (const commit of history.commits) {
    const { changes } = commit;
    let context =
      commit.playContext === undefined
        ? undefined
        : contexts.get(commit.playContext);
    if (commit.playContext !== undefined && context === undefined) {
      context = { ordinal: contexts.size + 1, round: 0 };
      contexts.set(commit.playContext, context);
    }
    if (context !== undefined && unassignedPlayer) {
      context.round += 1;
      unassignedPlayer = false;
    }
    for (const message of commit.historyAppend) {
      if (message.role === "player" && message.exactText.trim().length > 0) {
        inputPosition += 1;
        if (context !== undefined) context.round += 1;
        else unassignedPlayer = true;
      } else if (message.role === "narrator") unassignedPlayer = false;
    }
    if (changes.length === 0) continue;
    for (const { relativePath, contents } of changes)
      if (contents === null) files.delete(relativePath);
      else files.set(relativePath, contents);
    const next = previous.withFiles(snapshotFiles());
    const position: WorldWritePosition = {
      kind: isCorrectionCommit(commit.mode)
        ? "correction"
        : context === undefined
          ? "history"
          : "play",
      context: context?.ordinal ?? null,
      round: context?.round ?? inputPosition,
      worldTime: commit.worldClock ?? null,
    };
    for (const { kind, stableShortRef: ref } of changes) {
      if (kind === "delete") continue;
      const before = previous.query({
        kind: "read_document",
        document: { shortRef: ref },
      });
      const after = next.query({
        kind: "read_document",
        document: { shortRef: ref },
      });
      if (after.kind !== "read_document")
        throw new Error(`Accepted document @${ref} is unreadable`);
      const fact = facts[ref] ?? {
        baselineKind: "document_creation" as const,
        baselineBytes: Buffer.byteLength(after.body, "utf8"),
        lastBodyWrite: null,
        lastMetadataWrite: null,
        bodyChangedContexts: 0,
        metadataChangedContexts: 0,
      };
      const bodyChanged =
        before.kind !== "read_document" || before.body !== after.body;
      const metadataChanged =
        before.kind !== "read_document" ||
        JSON.stringify([
          before.document.title,
          before.document.summary,
          before.document.aliases,
          before.document.retired,
        ]) !==
          JSON.stringify([
            after.document.title,
            after.document.summary,
            after.document.aliases,
            after.document.retired,
          ]);
      if (bodyChanged) {
        fact.lastBodyWrite = structuredClone(position);
        if (commit.playContext !== undefined) {
          const changedContexts = bodyContexts.get(ref) ?? new Set<string>();
          changedContexts.add(commit.playContext);
          bodyContexts.set(ref, changedContexts);
          fact.bodyChangedContexts = changedContexts.size;
        }
      }
      if (metadataChanged) {
        fact.lastMetadataWrite = structuredClone(position);
        if (commit.playContext !== undefined) {
          const changedContexts =
            metadataContexts.get(ref) ?? new Set<string>();
          changedContexts.add(commit.playContext);
          metadataContexts.set(ref, changedContexts);
          fact.metadataChangedContexts = changedContexts.size;
        }
      }
      facts[ref] = fact;
    }
    previous = next;
  }
  for (const fact of Object.values(facts))
    fact.observedContexts = contexts.size;
  if (cache.size >= 8) cache.delete(cache.keys().next().value!);
  cache.set(history.head, {
    files,
    facts,
    bodyContexts,
    metadataContexts,
    contexts,
    inputPosition,
    unassignedPlayer,
  });
  return structuredClone(facts);
}
