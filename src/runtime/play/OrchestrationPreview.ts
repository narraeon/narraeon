import { isDeepStrictEqual } from "node:util";
import type { AppLocale } from "../../protocol/appPreferences.ts";
import type { Gameplay } from "../../protocol/gameplay.ts";
import type { ModelProviderKind } from "../../protocol/modelConnections.ts";
import type {
  CompiledOrchestrationPreview,
  OrchestrationPlaceholder,
  OrchestrationPreviewComparison,
  OrchestrationPreviewEntry,
  OrchestrationPreviewInput,
  OrchestrationPreviewResult,
  OrchestrationSurface,
  OrchestrationAuthorTarget,
} from "../../protocol/orchestrationPreview.ts";
import {
  turnGuideLineSoftLimit,
  turnGuideLinesSoftLimit,
  orderedPromptScope,
  type PromptMessageRole,
} from "../../shared/ordered-play-prompts.ts";
import { promptArrangementKey } from "../../shared/prompt-arrangement.ts";
import { turnGuideWarnings } from "../../shared/turn-guide.ts";
import type { ModelConnectionPrompt } from "../model/ModelHost.ts";
import type { ModelConnectionStore } from "../model/ModelConnectionStore.ts";
import {
  leadingSystemOrder,
  effectiveAuthorPromptEntries,
  effectivePlayPromptEntries,
  orderedAuthorPromptMessages,
  orderedPlayDistinctMessage,
  orderedPromptMessagesMerge,
} from "../prompt/FileNativePromptCompiler.ts";
import type {
  FileNativePlayPresetStore,
  PlayPresetBinding,
} from "./FileNativePlayPresetStore.ts";

interface CompileInput {
  binding: PlayPresetBinding;
  locale: AppLocale;
  surface: OrchestrationSurface;
  gameplay: Gameplay;
  authorTarget?: OrchestrationAuthorTarget;
  connection?: {
    provider: ModelProviderKind;
    modelPrompt?: ModelConnectionPrompt | undefined;
  };
}

const authorPreloadId = "runtime.preload";

export async function previewOrchestration(
  services: {
    playPresets: FileNativePlayPresetStore;
    models: ModelConnectionStore;
    locale: AppLocale;
  },
  input: OrchestrationPreviewInput,
): Promise<OrchestrationPreviewResult> {
  const [bindings, connection] = await Promise.all([
    services.playPresets.bindOrchestrationPreview(input),
    input.connection === "none" ? null : services.models.bindActiveIfPresent(),
  ]);
  const context = {
    locale: services.locale,
    surface: input.surface,
    gameplay: input.gameplay,
    ...(input.authorTarget === undefined
      ? {}
      : { authorTarget: input.authorTarget }),
    ...(connection === null
      ? {}
      : {
          connection: {
            provider: connection.provider,
            modelPrompt: connection.modelPrompt,
          },
        }),
  };
  const selected = compileOrchestrationPreview({
    ...context,
    binding: bindings.selected,
  });
  const current =
    bindings.selected.revision === bindings.current.revision
      ? selected
      : compileOrchestrationPreview({ ...context, binding: bindings.current });
  return {
    presetId: bindings.selected.id,
    presetName: bindings.selected.name,
    isCurrentPreset: bindings.isCurrentPreset,
    selected,
    selectedKind: bindings.selectedKind,
    ...(input.candidate === undefined
      ? {}
      : { candidateBaseRevision: input.revision }),
    comparison: compareOrchestrationPreviews(current, selected),
  };
}

interface MessagePart {
  role: PromptMessageRole;
  promptId: string;
  optional: boolean;
}

/** Compile the scheme without constructing a document/authority snapshot or emitting a request. */
export function compileOrchestrationPreview(
  input: CompileInput,
): CompiledOrchestrationPreview {
  const { binding, locale, gameplay, connection, surface } = input;
  const play = surface === "play";
  const target = input.authorTarget ?? "setting";
  const runtimeSource =
    target === "setting"
      ? "runtime:builtin/setting-improvement"
      : "runtime:builtin/world-revision";
  const ordered = play
    ? effectivePlayPromptEntries(binding, locale, gameplay)
    : effectiveAuthorPromptEntries(binding, locale, gameplay, target);
  const authorMessages = play
    ? undefined
    : new Map(
        orderedAuthorPromptMessages({
          playPreset: binding,
          locale,
          target,
          gameplay,
          provider: connection?.provider,
          modelPrompt: connection?.modelPrompt,
          runtimeSource,
        }).map((message) => [message.promptId, message]),
      );
  const parts: MessagePart[] = [];
  const bootstrapParts: MessagePart[] = [];
  const placeholders: OrchestrationPlaceholder[] = [];
  const lines: NonNullable<CompiledOrchestrationPreview["turnGuide"]>["lines"] =
    [];
  let worldLineInsertIndex = 0;
  const entries = ordered.map((resolved, index): OrchestrationPreviewEntry => {
    const { entry, applies, builtin } = resolved;
    const enabled = entry.kind === "world" || entry.enabled;
    const messageRole =
      entry.kind === "tail" ? undefined : (entry.messageRole ?? "system");
    const message = !applies
      ? undefined
      : play
        ? orderedPlayDistinctMessage(entry, builtin, connection?.modelPrompt)
        : authorMessages?.get(entry.id);
    const rowPlaceholders: OrchestrationPlaceholder[] = [];
    const rolePart = (optional: boolean): MessagePart => ({
      role: messageRole ?? "system",
      promptId: entry.id,
      optional,
    });
    if (entry.kind === "world") {
      worldLineInsertIndex = lines.length;
      rowPlaceholders.push(
        {
          kind: "world-instructions",
          entryId: entry.id,
          source: "control/frame.yaml#instructions",
          timing: "prefix",
        },
        {
          kind: "world-material",
          entryId: entry.id,
          source: "control/frame.yaml#context",
          timing: "fresh-context",
        },
        {
          kind: "world-turn-guide",
          entryId: entry.id,
          source: "control/frame.yaml#instructions[*].turnGuide",
          timing: "turn-guide",
        },
      );
      // Coverage exists in compileOrderedPlayBootstrap even with no author world
      // instructions. The dispatched prefix moves that material to the preload.
      parts.push(rolePart(true));
      bootstrapParts.push(rolePart(false));
    } else if (builtin?.id === "author.target") {
      rowPlaceholders.push({
        kind: "author-target",
        entryId: entry.id,
        source:
          target === "setting"
            ? "content-package:title"
            : "world-revision:title",
        timing: "prefix",
      });
      parts.push(rolePart(false));
    } else if (message !== undefined) {
      parts.push(rolePart(false));
      bootstrapParts.push(rolePart(false));
    }
    placeholders.push(...rowPlaceholders);
    const line = resolved.turnGuide;
    if (line !== undefined) lines.push({ entryId: entry.id, ...line });
    const source =
      message?.blocks[0]?.source ??
      rowPlaceholders[0]?.source ??
      (entry.kind === "builtin"
        ? `builtin:${entry.builtin}`
        : `preset:prompt/${entry.id}`);
    const configuredMarkdown =
      message === undefined &&
      (entry.kind === "user" ||
        (builtin !== undefined &&
          builtin.dynamic === undefined &&
          rowPlaceholders.length === 0))
        ? entry.kind === "user"
          ? entry.body
          : builtin!.body
        : undefined;
    const scope = orderedPromptScope(
      entry,
      builtin === undefined ? [] : [builtin],
    );
    return {
      identity: promptArrangementKey(entry),
      id: entry.id,
      name:
        entry.kind === "user" || entry.kind === "tail"
          ? entry.name
          : (builtin?.name ?? entry.id),
      kind: entry.kind,
      ...(entry.kind === "builtin" ? { builtin: entry.builtin } : {}),
      source,
      position: index + 1,
      enabled,
      applies,
      ...(messageRole === undefined ? {} : { messageRole }),
      ...(builtin?.group === undefined ? {} : { group: builtin.group }),
      ...(scope === undefined ? {} : { gameplay: scope }),
      ...(configuredMarkdown === undefined ? {} : { configuredMarkdown }),
      ...(resolved.configuredTurnGuide === undefined
        ? {}
        : { configuredTurnGuide: resolved.configuredTurnGuide }),
      ...(message === undefined ? {} : { markdown: message.markdown }),
      ...(line === undefined ? {} : { turnGuide: line.text }),
      placeholders: rowPlaceholders.map(({ kind }) => kind),
    };
  });
  if (play) {
    placeholders.push({
      kind: "player-turn-note",
      source: "player:turn",
      timing: "turn-guide",
    });
  } else {
    placeholders.push({
      kind: "author-preload",
      entryId: authorPreloadId,
      source: "Runtime authoring preload",
      timing: "after-author-prompts",
    });
    parts.push({ role: "system", promptId: authorPreloadId, optional: true });
  }
  const mergeConsecutiveMessages =
    binding.definition.mergeConsecutiveMessages ?? true;
  const messages: CompiledOrchestrationPreview["messages"] = [];
  let previous: MessagePart | undefined;
  for (const part of parts) {
    const group = messages.at(-1);
    if (
      group !== undefined &&
      orderedPromptMessagesMerge(previous, part, mergeConsecutiveMessages)
    ) {
      group.entryIds.push(part.promptId);
      group.conditional ||= part.optional;
    } else {
      messages.push({
        role: part.role,
        entryIds: [part.promptId],
        conditional: part.optional,
      });
    }
    previous = part;
  }
  return {
    revision: binding.revision,
    surface,
    gameplay,
    ...(play ? {} : { authorTarget: target }),
    entries,
    messages,
    mergeConsecutiveMessages,
    messageOrder: parts.some(({ optional }) => optional)
      ? "conditional"
      : "determined",
    placeholders,
    ...(play
      ? {
          turnGuide: {
            worldLineInsertIndex,
            lines,
            warnings: turnGuideWarnings(lines),
            lineCount:
              lines.length > turnGuideLinesSoftLimit
                ? ("over-limit" as const)
                : ("conditional" as const),
            limits: {
              lines: turnGuideLinesSoftLimit,
              lineLength: turnGuideLineSoftLimit,
            },
          },
        }
      : {}),
    protocol: protocolCheck(
      connection?.provider,
      play && connection?.provider === "anthropic_messages"
        ? bootstrapParts
        : parts,
    ),
  };
}

function protocolCheck(
  provider: ModelProviderKind | undefined,
  parts: MessagePart[],
): CompiledOrchestrationPreview["protocol"] {
  if (provider === undefined) return { status: "not-checked" };
  if (provider !== "anthropic_messages" && provider !== "google_interactions")
    return { status: "compatible", provider, conflictingIds: [] };
  const definite = leadingSystemOrder(
    parts.filter(({ optional }) => !optional),
  ).conflicts;
  const possible = leadingSystemOrder(parts).conflicts;
  return {
    provider,
    status:
      definite.length > 0
        ? "incompatible"
        : possible.length > 0
          ? "conditional"
          : "compatible",
    conflictingIds: possible.map(({ promptId }) => promptId),
  };
}

export function compareOrchestrationPreviews(
  current: CompiledOrchestrationPreview,
  selected: CompiledOrchestrationPreview,
): OrchestrationPreviewComparison {
  const before = new Map(current.entries.map((row) => [row.identity, row]));
  const after = new Map(selected.entries.map((row) => [row.identity, row]));
  const changes = [...new Set([...before.keys(), ...after.keys()])].flatMap(
    (identity) => {
      const previous = before.get(identity);
      const next = after.get(identity);
      if (isDeepStrictEqual(previous, next)) return [];
      return [
        {
          identity,
          ...(previous === undefined ? {} : { before: previous }),
          ...(next === undefined ? {} : { after: next }),
        },
      ];
    },
  );
  return {
    baseRevision: current.revision,
    selectedRevision: selected.revision,
    changes,
    mergeConsecutiveMessagesChanged:
      current.mergeConsecutiveMessages !== selected.mergeConsecutiveMessages,
  };
}
