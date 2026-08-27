import { parseDocument, stringify } from "yaml";

import type { ModelProviderKind } from "../../protocol/modelConnections.ts";
import {
  WorldDocumentStore,
  type WorldDocumentDescriptor,
  type WorldDocumentLocator,
  type WorldDocumentQueryFailure,
  type WorldDocumentSelectNodeResult,
  type WorldDocumentSelector,
  type WorldDocumentValue,
} from "../world/WorldDocumentStore.ts";
import {
  defaultRuntimeToolDefinitionStrategy,
  registeredRuntimeToolNames,
  runtimeToolsForNames,
  type RegisteredRuntimeToolName,
  type RuntimeToolDefinitionStrategy,
} from "./FileNativeToolRegistry.ts";
import type {
  PlayPresetBinding,
  PlayPresetFollowupDefinition,
  PlayPresetMount,
} from "../play/FileNativePlayPresetStore.ts";
import type { MaterialSelection } from "./MaterialSelection.ts";

export type { MaterialSelection } from "./MaterialSelection.ts";

export type LogicalRole =
  | "runtime_system"
  | "author_instruction"
  | "world_context"
  | "player_input"
  | "assistant"
  | "tool";

export type ProviderKind = ModelProviderKind;

export type FileNativeWorldDocumentSnapshot = Pick<
  WorldDocumentStore,
  "id" | "layout" | "logicalRoot" | "files" | "status" | "query"
>;

export interface FileNativePromptInput {
  endpoint: { id: string; commit: string; operationId?: string };
  hostBinding: {
    hostPresetId: string;
    files: Record<string, string>;
  };
  world: {
    controlFingerprint: string;
    documentSnapshot: FileNativeWorldDocumentSnapshot;
    history?: Record<string, string>;
    additionalMaterials: MaterialSelection[];
    hostPath?: string;
  };
  playerInputPlacement: "bootstrap" | "append";
  playerInput: string;
  modelBinding: {
    provider: ProviderKind;
    modelId: string;
    contextWindowTokens: number;
    maxOutputTokens: number;
    endpointFingerprint?: string;
  };
}

export interface PromptCompilation {
  logicalMessages: {
    role: LogicalRole;
    markdown: string;
    blocks: { source: string; markdown: string }[];
  }[];
  provider: {
    protocol: ProviderKind;
    system?: {
      type: "text";
      text: string;
      cache_control?: { type: "ephemeral" };
    }[];
    messages: { role: "system" | "user"; content: unknown }[];
  };
  tools: { name: string; description: string; inputSchema: object }[];
  /** Frozen definitions sent to a provider for the whole logical session. */
  toolUniverse: { name: string; description: string; inputSchema: object }[];
  toolStrategy: RuntimeToolDefinitionStrategy;
  coverage: {
    slot: string;
    source: string;
    status: "resolved" | "optional_missing" | "paged_catalog";
    complete: boolean;
    continuation: string | null;
    readAuthorization?: {
      shortRef: string;
      locator:
        | { yaml: readonly (string | number)[] }
        | { markdown: readonly string[] }
        | null;
    };
  }[];
  budget: {
    estimator: "conservative_utf8_bytes" | "disabled";
    messageTokens: number;
    toolTokens: number;
    outputReserveTokens: number;
    forcedTailReserveTokens: number;
    safetyMarginTokens: number;
    requiredTokens: number;
    contextWindowTokens: number;
    status: "fits" | "over_budget" | "not_checked";
  };
  cache: {
    stablePrefixFingerprint: string;
    breakpoints: LogicalRole[];
    estimatedCacheableTokens: number;
    firstDynamicByte: number;
  };
}

export interface PromptPreview {
  diagnosticBinding: {
    endpoint: string;
    commit: string;
    hostPresetId: string;
    controlFingerprint: string;
    modelId: string;
    playPresetId?: string;
    playPresetRevision?: string;
  };
  compilation: PromptCompilation;
  initialAppend?: {
    logical: { kind: "player"; text: string };
    provider: { role: "user"; content: string };
  };
  playPreset?: PlayPresetPreview;
  leakage: { status: "clean"; checkedFields: string[] };
}

export interface PlayPresetPreview {
  id: string;
  name: string;
  revision: string;
  callChainPath: string;
  mounts: PlayPresetMount[];
  extensionRefs: string[];
  toolUniverse: PromptCompilation["tools"];
  toolStrategy: RuntimeToolDefinitionStrategy;
  bootstrap: PromptCompilation;
  followups: PlayFollowupCompilation[];
  cache: {
    stablePrefixFingerprint: string;
    toolDefinitionBoundary: "stable";
  };
}

export interface PlayPresetCompilation {
  bootstrap: PromptCompilation;
  toolUniverse: PromptCompilation["tools"];
  toolStrategy: RuntimeToolDefinitionStrategy;
  /**
   * Derived requests dispatched after the main call chain settles. Each uses
   * the same frozen main-chain prefix, cannot see another follow-up's prompt or
   * output, and cannot add anything to the chain transcript.
   */
  followups: PlayFollowupCompilation[];
}

/** One post-commit derived request compiled against the main-chain prefix. */
export interface PlayFollowupCompilation {
  id: string;
  displayName: string;
  /** Author prompt plus the Runtime artifact contract for this request. */
  logicalMessages: PromptCompilation["logicalMessages"];
  tools: PromptCompilation["tools"];
  allowedTools: RegisteredRuntimeToolName[];
  artifacts: PlayPresetFollowupDefinition["artifacts"];
  maxArtifactBytes: number;
}

export interface FileNativeModelAdapter<Result = unknown> {
  sendBootstrap(request: {
    provider: PromptCompilation["provider"];
    tools: PromptCompilation["tools"];
    modelId: string;
    maxOutputTokens: number;
  }): Promise<Result>;
}

export class PromptCompilationError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details: unknown = null) {
    super(message);
    this.name = "PromptCompilationError";
    this.code = code;
    this.details = details;
  }
}

const runtimeContract = `# Runtime 权限边界

- 只有 Runtime 能把一次操作正式写入世界。模型的文字或工具调用都不能绕过 Runtime 直接提交结果。
- 当前玩法文件声明叙事规则、调用链工具和后置产物；未声明的能力一律不可用。
- 可编辑的主持、世界和玩法提示决定故事语义、玩家代理权、人称与文风；Runtime 只检查文件、引用、权限和原子提交，不替作者判断剧情。`;
const runtimeToolContract = `# Runtime 工具契约

- 只使用请求随附的工具；读取结果会明确范围、cursor 与完整性。目录只能使用 Runtime 返回的 @dir-*，文档和历史只能使用 Runtime 返回的 @句柄，不要把 world/路径或自然语言名称冒充句柄。
- 材料覆盖报告标为 \`已注入全文\` 的文档，其完整原文已经逐字在本次请求里，写入资格同样已经具备。不要为确认结构、核对字段或"保险起见"重读它：context_read 只会原样返回你已经看到的字节，白费一次往返。只有需要报告未覆盖的内容时才读。
- 字面搜索 0 命中不证明事实不存在。工具、目录、文档、档案、检索、命中、句柄、Runtime 及失败过程只供私下裁决；玩家可见叙事不得出现“没搜到／没找到资料”等内部措辞。信息不足时保持世界内的不确定性，不编造内部过程。
- 世界写入工具只修改尚未提交的工作副本；Runtime 接受并完成提交前，这些修改都不是正式世界事实。`;
const runtimeOperationContract = `# Runtime 调用链规则

- 模型可以直接输出玩家可见文本，或调用本次请求随附的读取和世界写入工具，再根据工具结果继续。
- 只服从当前请求的真实工具定义；没有定义的工具不可调用。
- 状态提交与后置产物保存由 Runtime 执行。工具交换与内部处理过程不得混入玩家可见内容。`;
const playRuntimeShell = `# Runtime 游玩边界

模型可以根据当前需要直接输出玩家可见文本、调用请求随附的读取或世界写入工具，或在取得工具结果后继续。Runtime 只执行真实工具定义、文件校验和权威提交；本段不规定故事、人称、文风、玩家代理权或状态语义。`;

const playCallChainToolNames = new Set<RegisteredRuntimeToolName>([
  "context_list",
  "context_search",
  "context_read",
  "world_patch",
  "world_create",
]);

export type FileNativeToolName = RegisteredRuntimeToolName;

export class FileNativePromptCompiler {
  readonly #toolStrategyOverride: RuntimeToolDefinitionStrategy | undefined;

  constructor(options: { toolStrategy?: RuntimeToolDefinitionStrategy } = {}) {
    this.#toolStrategyOverride = options.toolStrategy;
  }

  renderWorldDocument(
    snapshot: FileNativeWorldDocumentSnapshot,
    selector: WorldDocumentSelector,
  ): string {
    const rendered = renderSnapshotDocument(snapshot, selector);
    if (rendered.kind === "error") throwQueryFailure(rendered, "read_document");
    return rendered.markdown;
  }

  async sendBootstrap<Result>(
    input: FileNativePromptInput,
    adapter: FileNativeModelAdapter<Result>,
  ): Promise<Result> {
    const compiled = this.compileBootstrap(input);
    return await adapter.sendBootstrap({
      provider: compiled.provider,
      tools: compiled.tools,
      modelId: input.modelBinding.modelId,
      maxOutputTokens: input.modelBinding.maxOutputTokens,
    });
  }

  compileBootstrap(input: FileNativePromptInput): PromptCompilation {
    const effectiveInput = withoutAppendedContextGenesis(input);
    validateModel(effectiveInput.modelBinding);
    const documentSnapshot = effectiveInput.world.documentSnapshot;
    const worldFiles = snapshotFiles(documentSnapshot);
    const hostFrame = readYamlRecord(
      effectiveInput.hostBinding.files["frame.yaml"],
      "host frame",
    );
    const worldFrame = readYamlRecord(
      worldFiles["control/frame.yaml"],
      "world frame",
    );
    requireFormat(hostFrame, "narraeon.host-frame/v1", "host frame");
    requireFormat(worldFrame, "narraeon.world-frame/v1", "world frame");

    const coverage: PromptCompilation["coverage"] = [];
    const instructions = readWorldInstructions(worldFiles, worldFrame);
    const context = resolveContext(
      effectiveInput,
      worldFrame,
      documentSnapshot,
      coverage,
    );
    const hostRoles = compileHostRoles(
      effectiveInput.hostBinding.files,
      hostFrame,
      instructions,
      context,
      coverage,
    );
    const blocks = {
      ...hostRoles,
      player_input:
        effectiveInput.playerInputPlacement === "append"
          ? []
          : [
              {
                source: "player:input",
                markdown: `# 玩家原文\n\n${effectiveInput.playerInput.trim()}`,
              },
            ],
    } satisfies Record<
      Exclude<LogicalRole, "assistant" | "tool">,
      { source: string; markdown: string }[]
    >;
    const logicalMessages = (Object.keys(blocks) as LogicalRole[])
      .filter((role) => blocks[role].length > 0)
      .map((role) => ({
        role,
        blocks: blocks[role],
        markdown: joinBlocks(blocks[role]),
      }));
    scanRuntimeLeakage(logicalMessages);
    const tools = runtimeToolsForNames(registeredRuntimeToolNames);
    const toolStrategy =
      this.#toolStrategyOverride ??
      defaultRuntimeToolDefinitionStrategy(
        effectiveInput.modelBinding.provider,
      );
    const provider = mapProvider(
      effectiveInput.modelBinding.provider,
      logicalMessages,
    );
    const budget = disabledPromptBudget(effectiveInput);
    const stableMessages = logicalMessages.filter(
      ({ role }) => role !== "player_input",
    );
    const stableText = stableMessages
      .map(({ role, markdown }) => `${role}\n${markdown}`)
      .join("\n");
    const cache = stableCacheBoundary(stableText, tools, toolStrategy);
    return {
      logicalMessages,
      provider,
      tools,
      toolUniverse: structuredClone(tools),
      toolStrategy,
      coverage,
      budget,
      cache: {
        ...cache,
        breakpoints: ["runtime_system", "author_instruction", "world_context"],
      },
    };
  }

  preview(
    input: FileNativePromptInput,
    playPreset?: PlayPresetBinding,
  ): PromptPreview {
    const playCompilation =
      playPreset === undefined
        ? undefined
        : this.compilePlayCallChain(input, playPreset);
    return promptPreview(
      input,
      playPreset,
      playCompilation?.bootstrap ?? this.compileBootstrap(input),
      playCompilation,
    );
  }

  previewPlayPreset(
    input: FileNativePromptInput,
    playPreset: PlayPresetBinding,
  ): PromptPreview {
    const playCompilation = this.compilePlayPreset(input, playPreset);
    return promptPreview(
      input,
      playPreset,
      playCompilation.bootstrap,
      playCompilation,
    );
  }

  /**
   * Compile the production play surface. The selected preset contributes its
   * frozen tool universe and narrative guidance. The genesis opening remains
   * Authority history for the player-facing record; it is not repeated as
   * model history in a fresh play context.
   */
  compilePlayCallChain(
    input: FileNativePromptInput,
    binding: PlayPresetBinding,
  ): PlayPresetCompilation {
    const presetCompilation = this.compilePlayPreset(input, binding);
    const toolUniverse = presetCompilation.toolUniverse.filter(({ name }) =>
      playCallChainToolNames.has(name as RegisteredRuntimeToolName),
    );
    const logicalMessages = playCallChainNarrativeGuidance(
      presetCompilation.bootstrap.logicalMessages,
      binding,
    );
    const provider = mapProvider(input.modelBinding.provider, logicalMessages);
    const stableText = logicalMessages
      .filter(({ role }) => role !== "player_input")
      .map(({ role, markdown }) => `${role}\n${markdown}`)
      .join("\n");
    const bootstrap: PromptCompilation = {
      ...structuredClone(presetCompilation.bootstrap),
      logicalMessages,
      provider,
      tools: structuredClone(toolUniverse),
      toolUniverse: structuredClone(toolUniverse),
      cache: {
        ...presetCompilation.bootstrap.cache,
        ...stableCacheBoundary(
          stableText,
          toolUniverse,
          presetCompilation.toolStrategy,
        ),
      },
    };
    return {
      bootstrap,
      toolUniverse: structuredClone(toolUniverse),
      toolStrategy: presetCompilation.toolStrategy,
      followups: compileFollowups(binding),
    };
  }

  /**
   * Compile a frozen play preset into one stable bootstrap plus its followups.
   * Runtime orchestration can reuse this seam when it starts a real provider
   * session; Preview is only one consumer of the compilation.
   */
  compilePlayPreset(
    input: FileNativePromptInput,
    binding: PlayPresetBinding,
  ): PlayPresetCompilation {
    const bootstrap = this.compilePlayBootstrap(input);
    return compilePlayPresetCompilation(input, bootstrap, binding);
  }

  /**
   * A play preset owns the editable story policy. Its bootstrap keeps only the
   * mechanical Runtime shell; narrative semantics remain author instructions.
   */
  private compilePlayBootstrap(
    input: FileNativePromptInput,
  ): PromptCompilation {
    const base = this.compileBootstrap(input);
    const logicalMessages = base.logicalMessages.map((message) => {
      if (message.role !== "runtime_system") return message;
      const blocks = message.blocks.filter(
        ({ source }) => !source.startsWith("runtime:builtin/"),
      );
      blocks.push({ source: "runtime:play-shell", markdown: playRuntimeShell });
      return { role: message.role, blocks, markdown: joinBlocks(blocks) };
    });
    const provider = mapProvider(input.modelBinding.provider, logicalMessages);
    const budget = disabledPromptBudget(input);
    const stableMessages = logicalMessages.filter(
      ({ role }) => role !== "player_input",
    );
    const stableText = stableMessages
      .map(({ role, markdown }) => `${role}\n${markdown}`)
      .join("\n");
    const cache = stableCacheBoundary(
      stableText,
      base.tools,
      base.toolStrategy,
    );
    return {
      ...base,
      logicalMessages,
      provider,
      budget,
      cache: {
        ...base.cache,
        ...cache,
      },
    };
  }
}

/**
 * Compile each post-commit followup as an independent derived request. Each
 * request keeps only its author prompt and artifact contract; the main call
 * chain supplies the shared prefix.
 */
function compileFollowups(
  binding: PlayPresetBinding,
): PlayFollowupCompilation[] {
  return binding.definition.followups.map((followup) => {
    const markdown = binding.definition.files[followup.prompt.path];
    if (markdown === undefined || markdown.trim() === "")
      throw new PromptCompilationError(
        "play_preset_prompt_missing",
        `后置请求提示块不存在：${followup.prompt.path}`,
      );
    const blocks = [
      {
        source: `play:${followup.prompt.path}`,
        markdown: markdown.trim(),
      },
      {
        source: `runtime:followup/${followup.id}`,
        markdown: followupRuntimeContract(followup),
      },
    ];
    return {
      id: followup.id,
      displayName: followup.displayName,
      logicalMessages: [
        {
          role: "author_instruction" as const,
          blocks,
          markdown: joinBlocks(blocks),
        },
      ],
      tools: runtimeToolsForNames(followupToolNames),
      allowedTools: [...followupToolNames],
      artifacts: structuredClone(followup.artifacts),
      maxArtifactBytes: followup.maxArtifactBytes,
    };
  });
}

const followupToolNames = [
  "artifact_emit",
  "artifact_clear",
] as const satisfies readonly RegisteredRuntimeToolName[];

/**
 * The mechanical half of a followup prompt. It states the one thing the model
 * cannot infer from the author text: this request is dispatched once after the
 * main call chain has committed its core results, and it may only emit the
 * declared artifacts.
 */
function followupRuntimeContract(
  followup: PlayPresetFollowupDefinition,
): string {
  return `# Runtime 后置请求规则

核心叙事与世界状态已经提交，本次请求不写世界、不产生叙事、不影响已提交的结果。它只发出一次，没有后续往返。

只能提交下面声明的产物；模型选择 output name 并提供 payload，其余字段由 Runtime 固定。

${followup.artifacts
  .map(
    (artifact) =>
      `- output=${artifact.name}; channel=${artifact.channel}; key=${artifact.key ?? "（无）"}; contentType=${artifact.contentType}; renderer=${artifact.renderer ?? "builtin"}@${artifact.rendererRevision ?? "v1"}; save=${artifact.save}; projection=${artifact.strategy}; invalidation=${artifact.invalidation}; required=${artifact.required ? "yes" : "no"}; maxEmits=${artifact.maxEmits}${
        artifact.payloadContract === undefined
          ? ""
          : `; payloadContract=${payloadContractSummary(artifact.payloadContract)}`
      }`,
  )
  .join("\n")}`;
}

/**
 * Narrative prompt blocks are author instructions appended to
 * `author_instruction`; they apply whenever the model writes player-visible
 * prose.
 */
function playCallChainNarrativeGuidance(
  messages: PromptCompilation["logicalMessages"],
  binding: PlayPresetBinding,
): PromptCompilation["logicalMessages"] {
  const narrativeBlocks = binding.definition.narrativePrompts.map((prompt) => {
    const markdown = binding.definition.files[prompt.path];
    if (markdown === undefined)
      throw new PromptCompilationError(
        "play_preset_prompt_missing",
        `玩法预设叙事提示块不存在：${prompt.path}`,
      );
    return { source: `play:${prompt.path}`, markdown: markdown.trim() };
  });
  if (narrativeBlocks.length === 0) return cloneLogicalMessages(messages);
  let found = false;
  const result = cloneLogicalMessages(messages).map((message) => {
    if (message.role !== "author_instruction") return message;
    found = true;
    const blocks = [...message.blocks, ...narrativeBlocks];
    return { ...message, blocks, markdown: joinBlocks(blocks) };
  });
  if (!found)
    throw new PromptCompilationError(
      "host_frame_invalid",
      "游玩调用链缺少 author_instruction，无法注入玩法叙事规则",
    );
  scanRuntimeLeakage(result);
  return result;
}

function withoutAppendedContextGenesis(
  input: FileNativePromptInput,
): FileNativePromptInput {
  if (input.playerInputPlacement !== "append") return input;
  const additionalMaterials = input.world.additionalMaterials.filter(
    (material) =>
      material.kind !== "history_message" ||
      !material.message.endsWith(".message.genesis.narrator"),
  );
  if (additionalMaterials.length === input.world.additionalMaterials.length)
    return input;
  return {
    ...input,
    world: { ...input.world, additionalMaterials },
  };
}

function promptPreview(
  input: FileNativePromptInput,
  playPreset: PlayPresetBinding | undefined,
  compilation: PromptCompilation,
  playCompilation: PlayPresetCompilation | undefined,
): PromptPreview {
  const result: PromptPreview = {
    diagnosticBinding: {
      endpoint: input.endpoint.id,
      commit: input.endpoint.commit,
      hostPresetId: input.hostBinding.hostPresetId,
      controlFingerprint: input.world.controlFingerprint,
      modelId: input.modelBinding.modelId,
      ...(playPreset === undefined
        ? {}
        : {
            playPresetId: playPreset.id,
            playPresetRevision: playPreset.revision,
          }),
    },
    compilation,
    ...(input.playerInputPlacement === "append"
      ? {
          initialAppend: {
            logical: { kind: "player", text: input.playerInput },
            provider: { role: "user", content: input.playerInput },
          },
        }
      : {}),
    leakage: { status: "clean", checkedFields: leakageFields },
  };
  if (playPreset !== undefined && playCompilation !== undefined)
    result.playPreset = createPlayPresetPreview(playPreset, playCompilation);
  return result;
}

function createPlayPresetPreview(
  binding: PlayPresetBinding,
  compilation: PlayPresetCompilation,
): PlayPresetPreview {
  const { bootstrap } = compilation;
  return {
    id: binding.id,
    name: binding.name,
    revision: binding.revision,
    callChainPath: binding.definition.callChainPath,
    mounts: structuredClone(binding.definition.mounts),
    extensionRefs: [...binding.definition.extensionRefs],
    toolUniverse: compilation.toolUniverse,
    toolStrategy: compilation.toolStrategy,
    bootstrap,
    followups: structuredClone(compilation.followups),
    cache: {
      stablePrefixFingerprint: bootstrap.cache.stablePrefixFingerprint,
      toolDefinitionBoundary: "stable",
    },
  };
}

/**
 * A frozen preset compiles to one stable bootstrap plus its follow-ups. The
 * main chain is a single logical context, so everything the preset contributes
 * is either part of the bootstrap or a derived request dispatched after the
 * chain settles.
 */
function compilePlayPresetCompilation(
  input: Pick<FileNativePromptInput, "modelBinding">,
  bootstrap: PromptCompilation,
  binding: PlayPresetBinding,
): PlayPresetCompilation {
  const toolUniverse = fileNativeToolsForNames(registeredRuntimeToolNames);
  const toolStrategy = bootstrap.toolStrategy;
  const stableMessages = bootstrap.logicalMessages.filter(
    ({ role }) => role !== "player_input",
  );
  const stableText = stableMessages
    .map(({ role, markdown }) => `${role}\n${markdown}`)
    .join("\n");
  const sessionBootstrap: PromptCompilation = {
    ...bootstrap,
    tools: structuredClone(toolUniverse),
    toolUniverse: structuredClone(toolUniverse),
    toolStrategy,
    budget: disabledPromptBudget(input),
    cache: {
      ...bootstrap.cache,
      ...stableCacheBoundary(stableText, toolUniverse, toolStrategy),
    },
  };
  return {
    bootstrap: sessionBootstrap,
    toolUniverse,
    toolStrategy,
    followups: compileFollowups(binding),
  };
}

function cloneLogicalMessages(
  messages: PromptCompilation["logicalMessages"],
): PromptCompilation["logicalMessages"] {
  return messages.map((message) => ({
    role: message.role,
    markdown: message.markdown,
    blocks: message.blocks.map(({ source, markdown }) => ({
      source,
      markdown,
    })),
  }));
}

/**
 * Render one appended prompt block for providers without a native system-role
 * append. Only author instructions travel this way now that Runtime no longer
 * authors phase deltas.
 */
export function renderPromptDeltaMessage(
  role: string,
  markdown: string,
): string {
  if (role !== "author_instruction")
    throw new PromptCompilationError(
      "prompt_delta_role_invalid",
      `Runtime 构造了非法追加 role：${role}`,
    );
  return `# 作者提示\n\n${markdown}`;
}

function payloadContractSummary(
  contract: NonNullable<
    PlayPresetFollowupDefinition["artifacts"][number]["payloadContract"]
  >,
): string {
  const shape =
    contract.type === "array"
      ? `array${contract.minItems === undefined ? "" : `[${contract.minItems},`}${contract.maxItems === undefined ? "" : `${contract.maxItems}]`}${contract.uniqueBy === undefined ? "" : ` uniqueBy=${contract.uniqueBy}`}`
      : contract.type === "object"
        ? `object{${Object.keys(contract.properties ?? {}).join(",")}}`
        : contract.type;
  const required =
    contract.required === undefined
      ? ""
      : ` required=${contract.required.join(",")}`;
  return `${shape}${required}${contract.maxBytes === undefined ? "" : ` maxBytes=${contract.maxBytes}`}`;
}

export function createMinimalFileNativePreviewInput(input: {
  provider: ProviderKind;
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  playerInput: string;
  playerInputPlacement: FileNativePromptInput["playerInputPlacement"];
}): FileNativePromptInput {
  const worldFiles = {
    "control/frame.yaml": `format: narraeon.world-frame/v1
bindings:
  currentSituation: situation.current
instructions:
  - markdown: blocks/world-style.md
context:
  - slot: { kind: current_situation }
  - slot: { kind: catalog, directory: characters, maxEntries: 24 }
  - slot: { kind: additional_materials }
`,
    "control/blocks/world-style.md":
      "# 世界状态规则\n\n只保存已经发生且下一次行动不能忽略的结果；人物变化写入对应人物，眼前未结束的局面写入当前情境。\n",
    "state/current-situation.yaml": `$document:
  id: situation.current
  ref: current-situation
  title: 当前情境
  summary: 宿舍里的当前局面。
  aliases: []
地点: 男生宿舍 302
人物:
  - $ref: character.qinlong
情况: 秦龙正在整理球衣。
`,
    "state/characters/qinlong.yaml": `$document:
  id: character.qinlong
  ref: qinlong
  title: 秦龙
  summary: 篮球队前锋，直率护短。
  aliases: []
衣着: 白色运动背心，运动短裤，拖鞋
`,
  };
  return {
    endpoint: { id: "preview-endpoint", commit: "preview-commit" },
    hostBinding: {
      hostPresetId: "preview-host",
      files: {
        "frame.yaml": `format: narraeon.host-frame/v1
roles:
  runtime_system:
    - builtin: runtime.play-contract
    - builtin: runtime.tool-contract
    - builtin: runtime.operation-contract
  author_instruction:
    - markdown: blocks/style.md
    - include: world.instructions
  world_context:
    - builtin: runtime.coverage
    - include: world.context
`,
        "blocks/style.md": "# 主持风格\n\n克制、具体，不替玩家行动。\n",
      },
    },
    world: {
      controlFingerprint: "preview-control",
      documentSnapshot: WorldDocumentStore.open({
        layout: "world_state",
        files: Object.entries(worldFiles).map(([path, contents]) => ({
          path,
          contents,
        })),
      }),
      additionalMaterials: [],
    },
    playerInputPlacement: input.playerInputPlacement,
    playerInput: input.playerInput,
    modelBinding: input,
  };
}

function validateModel(model: FileNativePromptInput["modelBinding"]): void {
  if (
    !Number.isSafeInteger(model.contextWindowTokens) ||
    model.contextWindowTokens <= 0
  ) {
    throw new PromptCompilationError(
      "model_context_window_invalid",
      "模型必须提供有效的 contextWindowTokens",
    );
  }
  if (
    !Number.isSafeInteger(model.maxOutputTokens) ||
    model.maxOutputTokens <= 0
  ) {
    throw new PromptCompilationError(
      "model_max_output_invalid",
      "模型必须提供有效的 maxOutputTokens",
    );
  }
}

interface RenderedSnapshotDocument {
  kind: "rendered_document";
  descriptor: WorldDocumentDescriptor;
  markdown: string;
}

interface CompleteDocumentRead {
  kind: "complete_document";
  descriptor: WorldDocumentDescriptor;
  codec: "yaml" | "markdown";
  body: string;
}

function snapshotFiles(
  snapshot: FileNativeWorldDocumentSnapshot,
): Record<string, string> {
  return Object.fromEntries(
    snapshot.files.map(({ path, contents }) => [path, contents]),
  );
}

interface DocumentQueryTarget {
  selector: WorldDocumentSelector;
  source: string;
}

function parseDocumentQueryTarget(handle: string): DocumentQueryTarget {
  return {
    selector: handle.startsWith("@")
      ? { shortRef: handle.slice(1) }
      : { documentId: handle },
    source: handle,
  };
}

function descriptorQueryTarget(
  descriptor: Pick<WorldDocumentDescriptor, "documentId" | "shortRef">,
): DocumentQueryTarget {
  return {
    selector: { documentId: descriptor.documentId },
    source: `@${descriptor.shortRef}`,
  };
}

function modelVisibleDocumentSource(
  target: DocumentQueryTarget,
  failure?: WorldDocumentQueryFailure,
): string {
  if (failure?.document !== undefined) return `@${failure.document.shortRef}`;
  return target.source.startsWith("@") ? target.source : "（文档不可用）";
}

function locatorCoverageKey(locator: WorldDocumentLocator): string {
  return "yaml" in locator
    ? `yaml:${locator.yaml.join("/")}`
    : `markdown:${locator.markdown.join("/")}`;
}

function readCompleteDocument(
  snapshot: FileNativeWorldDocumentSnapshot,
  selector: WorldDocumentSelector,
): CompleteDocumentRead | WorldDocumentQueryFailure {
  let cursor: string | null = null;
  let descriptor: WorldDocumentDescriptor | null = null;
  let codec: CompleteDocumentRead["codec"] | null = null;
  let body = "";
  do {
    const result = snapshot.query({
      kind: "read_document",
      document: selector,
      maxBytes: 65_536,
      cursor,
    });
    if (result.kind === "error") return result;
    if (result.kind !== "read_document")
      throw new PromptCompilationError(
        "world_document_query_failed",
        "世界文档快照返回了错误的整文档查询类型",
      );
    descriptor ??= result.document;
    codec ??= result.codec;
    if (
      descriptor.documentId !== result.document.documentId ||
      codec !== result.codec
    )
      throw new PromptCompilationError(
        "world_document_query_failed",
        "整文档分页在同一快照内改变了目标",
      );
    body += result.body;
    cursor = result.page.nextCursor;
  } while (cursor !== null);
  if (descriptor === null || codec === null)
    throw new PromptCompilationError(
      "world_document_query_failed",
      "整文档查询没有返回目标",
    );
  return { kind: "complete_document", descriptor, codec, body };
}

function selectSnapshotNode(
  snapshot: FileNativeWorldDocumentSnapshot,
  selector: WorldDocumentSelector,
  locator: WorldDocumentLocator,
): WorldDocumentSelectNodeResult | WorldDocumentQueryFailure {
  const result = snapshot.query({
    kind: "select_node",
    document: selector,
    locator,
  });
  if (result.kind === "error" || result.kind === "select_node") return result;
  throw new PromptCompilationError(
    "world_document_query_failed",
    "世界文档快照返回了错误的节点查询类型",
  );
}

function renderSnapshotDocument(
  snapshot: FileNativeWorldDocumentSnapshot,
  selector: WorldDocumentSelector,
): RenderedSnapshotDocument | WorldDocumentQueryFailure {
  const read = readCompleteDocument(snapshot, selector);
  if (read.kind === "error") return read;
  if (read.codec === "markdown")
    return {
      kind: "rendered_document",
      descriptor: read.descriptor,
      markdown: `## ${read.descriptor.title} [ref: @${read.descriptor.shortRef} · Markdown]\n\n> ${read.descriptor.summary}\n\n${read.body.trim()}`,
    };
  const selected = snapshot.query({
    kind: "select_node",
    document: selector,
    locator: { yaml: [] },
  });
  if (selected.kind === "error") return selected;
  if (selected.kind !== "select_node" || selected.node.codec !== "yaml")
    throw new PromptCompilationError(
      "world_document_query_failed",
      "YAML 整文档没有返回 YAML 根节点投影",
    );
  return {
    kind: "rendered_document",
    descriptor: read.descriptor,
    markdown: renderYamlDocument(read.descriptor, selected.node.value),
  };
}

/**
 * Serialize a YAML node exactly the way context_read does, so what bootstrap
 * injects is what a later read would hand back. Internal document ids become
 * the @shortRef handles the model can actually pass to a tool.
 */
export function renderWorldYamlSource(value: WorldDocumentValue): string {
  return stringify(promptYamlValue(value), {
    indent: 2,
    lineWidth: 0,
  }).trimEnd();
}

function renderYamlDocument(
  descriptor: WorldDocumentDescriptor,
  value: WorldDocumentValue,
): string {
  if (!isRecord(value))
    throw new PromptCompilationError(
      "world_document_query_failed",
      "YAML 世界文档根节点必须是 map",
    );
  return `## ${descriptor.title} [ref: @${descriptor.shortRef} · YAML]\n\n> ${descriptor.summary}\n\n${renderWorldYamlSource(value)}`;
}

function projectedReference(
  value: WorldDocumentValue,
): { shortRef: string } | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.$ref !== "string" ||
    !isRecord(value.target)
  )
    return null;
  return typeof value.target.shortRef === "string"
    ? { shortRef: value.target.shortRef }
    : null;
}

function promptYamlValue(value: WorldDocumentValue): unknown {
  const reference = projectedReference(value);
  if (reference !== null) return { $ref: `@${reference.shortRef}` };
  if (Array.isArray(value)) return value.map(promptYamlValue);
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        promptYamlValue(child),
      ]),
    );
  return value;
}

function throwQueryFailure(
  failure: WorldDocumentQueryFailure,
  operation: string,
): never {
  throw new PromptCompilationError(
    "world_document_query_failed",
    `世界文档快照无法完成 ${operation} 查询`,
    {
      requestKind: failure.requestKind,
      snapshotStatus: failure.snapshotStatus,
      diagnostics: failure.diagnostics,
    },
  );
}

interface SelectedMaterial {
  key: string;
  source: string;
  markdown: string;
}

function resolveContext(
  input: FileNativePromptInput,
  worldFrame: Record<string, unknown>,
  snapshot: FileNativeWorldDocumentSnapshot,
  coverage: PromptCompilation["coverage"],
): { source: string; markdown: string }[] {
  const context = worldFrame.context;
  if (!Array.isArray(context))
    throw new PromptCompilationError(
      "world_frame_invalid",
      "world frame.context 必须是数组",
    );
  const selected: { key: string; source: string; markdown: string }[] = [];
  const currentSituation = isRecord(worldFrame.bindings)
    ? worldFrame.bindings.currentSituation
    : undefined;
  // The model's own list must yield to every author slot, however the frame
  // happens to order them, so resolve it last and splice it back into place.
  let additionalMaterialsAt: { selected: number; coverage: number } | null =
    null;
  for (const entry of context) {
    const slot = isRecord(entry) && isRecord(entry.slot) ? entry.slot : null;
    if (slot === null || typeof slot.kind !== "string")
      throw new PromptCompilationError(
        "world_frame_invalid",
        "context 条目必须是 slot",
      );
    if (slot.kind === "current_situation")
      addDocumentSelection(
        parseDocumentQueryTarget(stringOrEmpty(currentSituation)),
        "current_situation",
        true,
        snapshot,
        selected,
        coverage,
      );
    else if (slot.kind === "reference_targets")
      resolveReferenceTargets(slot, snapshot, selected, coverage);
    else if (slot.kind === "catalog")
      resolveCatalog(slot, snapshot, selected, coverage);
    else if (slot.kind === "history")
      resolveRecentHistory(slot, input.world.history ?? {}, selected, coverage);
    else if (slot.kind === "additional_materials")
      additionalMaterialsAt ??= {
        selected: selected.length,
        coverage: coverage.length,
      };
    else if (slot.kind === "document")
      addDocumentSelection(
        parseDocumentQueryTarget(stringOrEmpty(slot.document)),
        "document",
        slot.required !== false,
        snapshot,
        selected,
        coverage,
      );
    else if (slot.kind === "node")
      addNodeSelection(
        parseDocumentQueryTarget(stringOrEmpty(slot.document)),
        slot.locator,
        "node",
        slot.required !== false,
        snapshot,
        selected,
        coverage,
      );
    else
      throw new PromptCompilationError(
        "world_frame_invalid",
        `不支持的 slot：${slot.kind}`,
      );
  }
  assertNoOverlap(selected);
  if (additionalMaterialsAt !== null) {
    const withMaterials = [...selected];
    const materialCoverage: PromptCompilation["coverage"] = [];
    resolveAdditionalMaterials(
      input.world.additionalMaterials,
      snapshot,
      input.world.history ?? {},
      withMaterials,
      materialCoverage,
    );
    selected.splice(
      additionalMaterialsAt.selected,
      0,
      ...withMaterials.slice(selected.length),
    );
    coverage.splice(additionalMaterialsAt.coverage, 0, ...materialCoverage);
  }
  return selected.map(({ source, markdown }) => ({ source, markdown }));
}

function addDocumentSelection(
  target: DocumentQueryTarget,
  slot: string,
  required: boolean,
  snapshot: FileNativeWorldDocumentSnapshot,
  selected: SelectedMaterial[],
  coverage: PromptCompilation["coverage"],
  dedupe = false,
): void {
  const document = renderSnapshotDocument(snapshot, target.selector);
  if (document.kind === "error") {
    if (required)
      throw new PromptCompilationError(
        "required_slot_missing",
        `必需 slot ${slot} 的文档无法从固定快照读取：${target.source}`,
        document.diagnostics,
      );
    coverage.push({
      slot,
      source: modelVisibleDocumentSource(target, document),
      status: "optional_missing",
      complete: false,
      continuation: "context_list",
    });
    return;
  }
  const key = `document:${document.descriptor.documentId}`;
  const overlapping = overlappingSelection(selected, key);
  // Selecting the same complete document is idempotent. In particular, an
  // author may keep a character document fixed in the frame while
  // reference_targets independently selects that character whenever the
  // current situation says they are present. Presence remains world state;
  // it must not make a valid fixed material fail prompt compilation.
  if (overlapping?.key === key || (dedupe && overlapping !== null)) return;
  selected.push({
    key,
    source: `slot:${slot}:@${document.descriptor.shortRef}`,
    markdown: document.markdown,
  });
  coverage.push({
    slot,
    source: `@${document.descriptor.shortRef}`,
    status: "resolved",
    complete: true,
    continuation: "context_read",
    readAuthorization: {
      shortRef: document.descriptor.shortRef,
      locator: null,
    },
  });
}

function resolveReferenceTargets(
  slot: Record<string, unknown>,
  snapshot: FileNativeWorldDocumentSnapshot,
  selected: SelectedMaterial[],
  coverage: PromptCompilation["coverage"],
): void {
  const from = isRecord(slot.from) ? slot.from : {};
  const sourceTarget = parseDocumentQueryTarget(stringOrEmpty(from.document));
  const required = slot.required !== false;
  const locator =
    isRecord(from.locator) &&
    Object.keys(from.locator).length === 1 &&
    Array.isArray(from.locator.yaml) &&
    from.locator.yaml.every((segment) => typeof segment === "string")
      ? { yaml: from.locator.yaml }
      : null;
  const locatorCoverage =
    locator === null ? "[]" : JSON.stringify(locator.yaml);
  const result =
    locator === null
      ? null
      : selectSnapshotNode(snapshot, sourceTarget.selector, locator);
  if (
    result === null ||
    result.kind === "error" ||
    result.node.codec !== "yaml"
  ) {
    if (required)
      throw new PromptCompilationError(
        "required_slot_missing",
        "reference_targets 来源无法从固定快照精确选择",
        result?.kind === "error" ? result.diagnostics : null,
      );
    coverage.push({
      slot: "reference_targets",
      source: `${modelVisibleDocumentSource(
        sourceTarget,
        result?.kind === "error" ? result : undefined,
      )}#yaml:${locatorCoverage}`,
      status: "optional_missing",
      complete: false,
      continuation: "context_read",
    });
    return;
  }
  const max = Number(slot.maxEntries ?? 0);
  if (
    !Number.isInteger(max) ||
    max < 1 ||
    max > 64 ||
    result.references.length > max
  )
    throw new PromptCompilationError(
      "slot_limit_exceeded",
      "reference_targets 超过明确上限",
    );
  coverage.push({
    slot: "reference_targets",
    source: `@${result.document.shortRef}#yaml:${locatorCoverage}`,
    status: "resolved",
    complete: true,
    continuation: "context_read",
  });
  for (const { target } of result.references)
    addDocumentSelection(
      descriptorQueryTarget(target),
      "reference_targets",
      required,
      snapshot,
      selected,
      coverage,
    );
}

function resolveCatalog(
  slot: Record<string, unknown>,
  snapshot: FileNativeWorldDocumentSnapshot,
  selected: SelectedMaterial[],
  coverage: PromptCompilation["coverage"],
): void {
  const directory = stringOrEmpty(slot.directory);
  const max = Number(slot.maxEntries ?? 0);
  if (!validCatalogDirectory(directory))
    throw new PromptCompilationError(
      "world_frame_invalid",
      "catalog.directory 必须是相对于世界文档根的安全目录路径",
    );
  if (!Number.isInteger(max) || max < 1 || max > 100)
    throw new PromptCompilationError(
      "world_frame_invalid",
      "catalog.maxEntries 无效",
    );
  const matches: WorldDocumentDescriptor[] = [];
  const damaged: string[] = [];
  let cursor: string | null = null;
  do {
    const result = snapshot.query({
      kind: "catalog",
      directory,
      limit: 100,
      cursor,
    });
    if (result.kind === "error") throwQueryFailure(result, "catalog");
    if (result.kind !== "catalog")
      throw new PromptCompilationError(
        "world_document_query_failed",
        "世界文档快照返回了错误的目录查询类型",
      );
    for (const entry of result.entries) {
      if (entry.kind !== "document") continue;
      if (entry.status === "queryable" && entry.document !== undefined)
        matches.push(entry.document);
      else damaged.push(entry.logicalPath);
    }
    cursor = result.page.nextCursor;
  } while (cursor !== null);
  if ((matches.length === 0 || damaged.length > 0) && slot.required !== false)
    throw new PromptCompilationError(
      "required_slot_missing",
      `必需 catalog ${directory} 没有完整关联可查询的直接子文档`,
      {
        slot: "catalog",
        directory,
        logicalRoot: snapshot.logicalRoot,
        matchedEntries: matches.length,
        damaged,
      },
    );
  const page = matches.slice(0, max);
  const markdown = `# ${directory} 目录\n\n${page.map((document) => `- ${document.title} [ref: @${document.shortRef}] — ${document.summary}`).join("\n") || "（空）"}\n\n显示 ${page.length}/${matches.length}。`;
  selected.push({
    key: `catalog:${directory}`,
    source: `slot:catalog:${directory}`,
    markdown,
  });
  coverage.push({
    slot: "catalog",
    source: directory,
    status:
      matches.length === 0 || damaged.length > 0
        ? "optional_missing"
        : matches.length > max
          ? "paged_catalog"
          : "resolved",
    complete:
      matches.length > 0 && matches.length <= max && damaged.length === 0,
    continuation: "context_list",
  });
}

function validCatalogDirectory(directory: string): boolean {
  return (
    directory.length > 0 &&
    directory
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/**
 * Inject the last few committed messages verbatim when a fresh context is
 * compiled. Model-directed play may commit visible detail without duplicating
 * every detail into a world document, so recent history remains an explicit
 * source alongside the current state.
 */
function resolveRecentHistory(
  slot: Record<string, unknown>,
  history: Record<string, string>,
  selected: SelectedMaterial[],
  coverage: PromptCompilation["coverage"],
): void {
  const recent = Number(slot.recent ?? 2);
  if (!Number.isInteger(recent) || recent < 1 || recent > 32)
    throw new PromptCompilationError(
      "world_frame_invalid",
      "history slot 的 recent 必须是 1 到 32 的整数",
    );
  // FileNativeWorldStore builds this record from the recovered Authority array
  // in commit order. Its keys are semantic message IDs, not sortable file
  // names: lexical sorting would put `message.genesis` after every numbered
  // message and `message.9` after `message.15`.
  const ordered = Object.entries(history).filter(
    ([ref]) => !ref.endsWith(".message.genesis.narrator"),
  );
  const chosen = ordered.slice(-recent);
  if (chosen.length === 0) {
    selected.push({
      key: "history:empty",
      source: "slot:history:empty",
      markdown:
        "# 最近已提交对话\n\n（空：当前世界没有更早的玩家原文或主持叙事；无需为寻找上一条记录调用历史检索工具。）",
    });
    coverage.push({
      slot: "history",
      source: `最近 ${recent} 条`,
      status: "resolved",
      complete: true,
      continuation: null,
    });
    return;
  }
  for (const [index, [ref, text]] of chosen.entries()) {
    const key = `history_message:${ref}`;
    if (overlappingSelection(selected, key) !== null) continue;
    selected.push({
      key,
      source: `slot:history:${ref}`,
      markdown: renderHistoryMessage(ref, text),
    });
    coverage.push({
      slot: "history",
      source: `${historyMessageLabel(ref)}（最近记录 ${index + 1}/${chosen.length}）`,
      status: "resolved",
      complete: true,
      continuation: "context_list",
    });
  }
}

function resolveAdditionalMaterials(
  materials: MaterialSelection[],
  snapshot: FileNativeWorldDocumentSnapshot,
  history: Record<string, string>,
  selected: SelectedMaterial[],
  coverage: PromptCompilation["coverage"],
): void {
  if (materials.length > 32)
    throw new PromptCompilationError(
      "material_limit_exceeded",
      "附加材料超过 32 项",
    );
  for (const material of materials) {
    // The model picks this list, and it cannot see which documents a context
    // slot already injected verbatim. A duplicate pick adds nothing the prompt
    // is missing, so drop it instead of failing the whole compilation.
    if (material.kind === "document")
      addDocumentSelection(
        parseDocumentQueryTarget(material.document),
        "additional_materials",
        true,
        snapshot,
        selected,
        coverage,
        true,
      );
    else if (material.kind === "node")
      addNodeSelection(
        parseDocumentQueryTarget(material.document),
        material.locator,
        "additional_materials",
        true,
        snapshot,
        selected,
        coverage,
        true,
      );
    else {
      const ref =
        material.kind === "history_message"
          ? material.message
          : material.commit;
      const matches = Object.entries(history).filter(([key]) =>
        material.kind === "history_message"
          ? key === ref.replace(/^@/u, "")
          : key.startsWith(
              ref
                .replace(/^@?history-commit-/u, "history-message-")
                .concat("-"),
            ),
      );
      if (matches.length === 0)
        throw new PromptCompilationError(
          "required_slot_missing",
          `附加历史材料不存在：${ref}`,
        );
      const key = `${material.kind}:${ref}`;
      if (overlappingSelection(selected, key) !== null) continue;
      selected.push({
        key,
        source: `slot:additional_materials:${ref}`,
        markdown: matches
          .map(([key, text]) => renderHistoryMessage(key, text))
          .join("\n\n"),
      });
      coverage.push({
        slot: "additional_materials",
        source:
          matches.length === 1
            ? historyMessageLabel(matches[0]![0])
            : `已选历史提交（${matches.length} 条）`,
        status: "resolved",
        complete: true,
        continuation: "context_list",
      });
    }
  }
}

function renderHistoryMessage(ref: string, text: string): string {
  return `## ${historyMessageLabel(ref)}\n\n${text.trim()}`;
}

function historyMessageLabel(ref: string): string {
  if (ref.endsWith(".message.genesis.narrator")) return "开场白";
  if (/(?:\.message\.[^.]+(?:\.[0-9]+)?\.|-)(player)(?:-|$)/u.test(ref))
    return "玩家原文";
  if (/(?:\.message\.[^.]+(?:\.[0-9]+)?\.|-)(narrator)(?:-|$)/u.test(ref))
    return "主持叙事";
  return "已提交消息";
}

function addNodeSelection(
  target: DocumentQueryTarget,
  locator: unknown,
  slot: string,
  required: boolean,
  snapshot: FileNativeWorldDocumentSnapshot,
  selected: SelectedMaterial[],
  coverage: PromptCompilation["coverage"],
  dedupe = false,
): void {
  let exactLocator: WorldDocumentLocator | null = null;
  if (isRecord(locator) && Array.isArray(locator.yaml)) {
    if (locator.yaml.some((segment) => typeof segment !== "string"))
      throw new PromptCompilationError(
        "persistent_locator_invalid",
        "世界框架和附加材料的持久 YAML locator 不允许列表下标",
      );
    exactLocator = { yaml: locator.yaml };
  } else if (
    isRecord(locator) &&
    Array.isArray(locator.markdown) &&
    locator.markdown.every((segment) => typeof segment === "string")
  )
    exactLocator = { markdown: locator.markdown };
  const result =
    exactLocator === null
      ? null
      : selectSnapshotNode(snapshot, target.selector, exactLocator);
  if (result === null || result.kind === "error") {
    if (required)
      throw new PromptCompilationError(
        "required_slot_missing",
        `逻辑 locator 无法从固定快照选择：${target.source}`,
        result?.kind === "error" ? result.diagnostics : null,
      );
    coverage.push({
      slot,
      source:
        exactLocator === null
          ? modelVisibleDocumentSource(
              target,
              result?.kind === "error" ? result : undefined,
            )
          : `${modelVisibleDocumentSource(
              target,
              result?.kind === "error" ? result : undefined,
            )} · ${locatorCoverageKey(exactLocator)}`,
      status: "optional_missing",
      complete: false,
      continuation: "context_read",
    });
    return;
  }
  let pathKey: string;
  let markdown: string;
  if (result.node.codec === "yaml" && "yaml" in result.node.locator) {
    pathKey = locatorCoverageKey(result.node.locator);
    markdown = `## ${result.document.title} [ref: @${result.document.shortRef} · YAML] · 节点 ${result.node.locator.yaml.join(" / ")}\n\n${renderWorldYamlSource(result.node.value)}`;
  } else if (
    result.node.codec === "markdown" &&
    "markdown" in result.node.locator
  ) {
    pathKey = locatorCoverageKey(result.node.locator);
    markdown = `## ${result.document.title} [ref: @${result.document.shortRef} · Markdown] · 节点 ${result.node.locator.markdown.join(" / ")}\n\n${result.node.markdown.trim()}`;
  } else {
    throw new PromptCompilationError(
      "world_document_query_failed",
      "精确节点结果的 codec 与 locator 不一致",
    );
  }
  const key = `node:${result.document.documentId}:${pathKey}`;
  if (dedupe && overlappingSelection(selected, key) !== null) return;
  selected.push({
    key,
    source: `slot:${slot}:@${result.document.shortRef}:${pathKey}`,
    markdown,
  });
  coverage.push({
    slot,
    source: `@${result.document.shortRef} · ${pathKey}`,
    status: "resolved",
    complete: true,
    continuation: "context_read",
    readAuthorization: {
      shortRef: result.document.shortRef,
      locator: result.node.locator,
    },
  });
}

/** Expand an author allowlist through the Runtime-owned registry. */
export function fileNativeToolsForNames(
  names: readonly FileNativeToolName[],
): PromptCompilation["tools"] {
  return runtimeToolsForNames(names);
}

function keysOverlap(a: string, b: string): boolean {
  const aNode = parseNodeKey(a);
  const bNode = parseNodeKey(b);
  return (
    a === b ||
    (a.startsWith("document:") && b.startsWith(`node:${a.slice(9)}:`)) ||
    (b.startsWith("document:") && a.startsWith(`node:${b.slice(9)}:`)) ||
    (aNode !== null &&
      bNode !== null &&
      aNode.document === bNode.document &&
      aNode.codec === bNode.codec &&
      (isPathPrefix(aNode.path, bNode.path) ||
        isPathPrefix(bNode.path, aNode.path)))
  );
}

/** Which already-selected material covers `key`, or null when nothing does. */
function overlappingSelection(
  selected: readonly SelectedMaterial[],
  key: string,
): SelectedMaterial | null {
  return selected.find((material) => keysOverlap(material.key, key)) ?? null;
}

function assertNoOverlap(selected: SelectedMaterial[]): void {
  for (let index = 0; index < selected.length; index += 1) {
    for (let other = index + 1; other < selected.length; other += 1) {
      const a = selected[index]!;
      const b = selected[other]!;
      if (keysOverlap(a.key, b.key))
        throw new PromptCompilationError(
          "material_overlap",
          `材料重叠：${a.source} 与 ${b.source}`,
        );
    }
  }
}

function parseNodeKey(
  key: string,
): { document: string; codec: string; path: string[] } | null {
  const match = /^node:(.+?):(yaml|markdown):(.*)$/u.exec(key);
  return match === null
    ? null
    : {
        document: match[1]!,
        codec: match[2]!,
        path: match[3]!.split("/"),
      };
}

function isPathPrefix(prefix: string[], path: string[]): boolean {
  return (
    prefix.length <= path.length &&
    prefix.every((segment, index) => segment === path[index])
  );
}

function readWorldInstructions(
  files: Record<string, string>,
  frame: Record<string, unknown>,
): { source: string; markdown: string }[] {
  if (!Array.isArray(frame.instructions))
    throw new PromptCompilationError(
      "world_frame_invalid",
      "world frame.instructions 必须是数组",
    );
  return frame.instructions.map((entry) => {
    if (!isRecord(entry) || typeof entry.markdown !== "string")
      throw new PromptCompilationError(
        "world_frame_invalid",
        "instruction 必须引用 Markdown 块",
      );
    const path = `control/${entry.markdown}`;
    return {
      source: `world:${path}`,
      markdown: readMarkdown(files, path, "世界提示块"),
    };
  });
}

function compileHostRoles(
  files: Record<string, string>,
  frame: Record<string, unknown>,
  worldInstructions: { source: string; markdown: string }[],
  worldContext: { source: string; markdown: string }[],
  coverage: PromptCompilation["coverage"],
): Record<
  Exclude<LogicalRole, "player_input">,
  { source: string; markdown: string }[]
> {
  if (!isRecord(frame.roles))
    throw new PromptCompilationError(
      "host_frame_invalid",
      "host frame.roles 必须明确编排三个逻辑 role",
    );
  const roles = frame.roles;
  const expectedRoles = [
    "runtime_system",
    "author_instruction",
    "world_context",
  ] as const;
  if (
    Object.keys(frame.roles).length !== expectedRoles.length ||
    expectedRoles.some((role) => !Array.isArray(roles[role]))
  ) {
    throw new PromptCompilationError(
      "host_frame_invalid",
      "host frame.roles 必须且只能包含 runtime_system、author_instruction、world_context",
    );
  }
  const result = Object.fromEntries(
    expectedRoles.map((role) => [
      role,
      (roles[role] as unknown[]).flatMap((entry) => {
        if (!isRecord(entry))
          throw new PromptCompilationError(
            "host_frame_invalid",
            `${role} 条目无效`,
          );
        if (role === "runtime_system" && Object.keys(entry).length === 1) {
          const builtin = {
            "runtime.play-contract": runtimeContract,
            "runtime.tool-contract": runtimeToolContract,
            "runtime.operation-contract": runtimeOperationContract,
          }[String(entry.builtin)];
          if (builtin !== undefined)
            return [
              {
                source: `runtime:builtin/${String(entry.builtin)}`,
                markdown: builtin,
              },
            ];
        }
        if (
          role === "world_context" &&
          entry.builtin === "runtime.coverage" &&
          Object.keys(entry).length === 1
        )
          return [
            {
              source: "runtime:builtin/runtime.coverage",
              markdown: renderCoverage(coverage),
            },
          ];
        if (
          role === "author_instruction" &&
          typeof entry.markdown === "string" &&
          Object.keys(entry).length === 1
        ) {
          return [
            {
              source: `host:${entry.markdown}`,
              markdown: readMarkdown(files, entry.markdown, "主持预设块"),
            },
          ];
        }
        if (
          role === "author_instruction" &&
          entry.include === "world.instructions" &&
          Object.keys(entry).length === 1
        )
          return worldInstructions;
        if (
          role === "world_context" &&
          entry.include === "world.context" &&
          Object.keys(entry).length === 1
        )
          return worldContext;
        throw new PromptCompilationError(
          "host_frame_invalid",
          `${role} 中存在越权、未知或错位的编排条目`,
        );
      }),
    ]),
  ) as Record<
    Exclude<LogicalRole, "player_input">,
    { source: string; markdown: string }[]
  >;
  const roleEntries = expectedRoles.flatMap(
    (role) => roles[role] as Record<string, unknown>[],
  );
  const sources = Object.values(result).flatMap((blocks) =>
    blocks.map(({ source }) => source),
  );
  const requiredSources = [
    "runtime:builtin/runtime.play-contract",
    "runtime:builtin/runtime.tool-contract",
    "runtime:builtin/runtime.operation-contract",
    "runtime:builtin/runtime.coverage",
  ];
  if (
    requiredSources.some(
      (source) =>
        sources.filter((candidate) => candidate === source).length !== 1,
    ) ||
    roleEntries.filter((entry) => entry.include === "world.instructions")
      .length !== 1 ||
    roleEntries.filter((entry) => entry.include === "world.context").length !==
      1
  )
    throw new PromptCompilationError(
      "host_frame_invalid",
      "三个 Runtime contract、runtime.coverage 与两个 world include 必须各恰好出现一次",
    );
  return result;
}

function renderCoverage(coverage: PromptCompilation["coverage"]): string {
  return `# 材料覆盖报告

下列条目说明本次请求注入了哪些材料，以及可以用哪个工具取得更多。\`未完整\` 表示这一项的覆盖没有得到证明，不表示一定还有内容：\`optional_missing\` 的位置可能什么都没注入（目录为空、或内容存在但未被选中），也可能已经注入了一部分（目录里还有无法解析的条目）；\`paged_catalog\` 表示确实还有条目没有列出。任何一种都不能用来推断世界上是否存在某件事；需要确认时用条目末尾列出的工具查。

\`已注入全文\` 表示该文档的完整正文已经出现在下方世界材料里，并且已经具备写入资格：直接对它调用写入工具即可，\`context_read\` 会返回同样的正文。\`已注入节点\` 表示只注入并授权了标出的那个节点，改动该节点之外的位置才需要先读。

每份材料的标题都标出了它的 codec：\`· YAML\` 的用 \`{yaml: [键, ...]}\` 定位，正文就是它的 YAML 原文，键名和层级照写即可；\`· Markdown\` 的用 \`{markdown: [标题, ...]}\` 定位，路径是正文里的标题层级。文档 id 一律投影成 \`@短引用\`，写回时照原样保留。

${coverage
  .map(
    (entry) =>
      `- ${entry.slot}: ${entry.source} · ${entry.status} · ${entry.complete ? "完整" : "未完整"}${coverageWriteHint(entry)}`,
  )
  .join("\n")}`;
}

/**
 * A resolved slot already carries the bytes and the write authorization, so
 * pointing at context_read there reads as an invitation to re-read what the
 * prompt just supplied. Name the write right instead.
 */
function coverageWriteHint(
  entry: PromptCompilation["coverage"][number],
): string {
  const authorization = entry.readAuthorization;
  if (
    entry.status === "resolved" &&
    entry.complete &&
    authorization !== undefined
  )
    return authorization.locator === null ? " · 已注入全文" : " · 已注入节点";
  return entry.continuation === null ? "" : ` · 可继续 ${entry.continuation}`;
}

function mapProvider(
  provider: ProviderKind,
  messages: PromptCompilation["logicalMessages"],
): PromptCompilation["provider"] {
  const byRole = Object.fromEntries(
    messages.map((message) => [message.role, message.markdown]),
  ) as Record<LogicalRole, string>;
  const userBlocks = [
    { type: "text" as const, text: byRole.world_context },
    ...(typeof byRole.player_input === "string" &&
    byRole.player_input.length > 0
      ? [{ type: "text" as const, text: byRole.player_input }]
      : []),
  ];
  if (provider === "anthropic_messages") {
    return {
      protocol: provider,
      system: [
        {
          type: "text",
          text: byRole.runtime_system,
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: byRole.author_instruction,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userBlocks }],
    };
  }
  return {
    protocol: provider,
    messages: [
      {
        role: "system",
        content: `# Runtime System\n\n${byRole.runtime_system}\n\n# Author Instruction\n\n${byRole.author_instruction}`,
      },
      { role: "user", content: userBlocks },
    ],
  };
}

function disabledPromptBudget(
  input: Pick<FileNativePromptInput, "modelBinding">,
): PromptCompilation["budget"] {
  return {
    estimator: "disabled",
    messageTokens: 0,
    toolTokens: 0,
    outputReserveTokens: 0,
    forcedTailReserveTokens: 0,
    safetyMarginTokens: 0,
    requiredTokens: 0,
    contextWindowTokens: input.modelBinding.contextWindowTokens,
    status: "not_checked",
  };
}

const leakageFields = [
  "hostPresetId",
  "materialId",
  "sourceType",
  "recordId",
  "operationId",
  "version",
];

export function scanRuntimeLeakage(
  messages: PromptCompilation["logicalMessages"],
): void {
  for (const message of messages) {
    for (const block of message.blocks) {
      if (!block.source.startsWith("runtime:")) continue;
      const field = leakageFields.find((candidate) =>
        new RegExp(`\\b${candidate}\\b`, "u").test(block.markdown),
      );
      if (field !== undefined)
        throw new PromptCompilationError(
          "internal_field_leakage",
          `Runtime 生成块泄漏内部字段：${field}`,
        );
      if (
        /(?:[A-Za-z]:[\\/]|\/(?:home|Users|mnt|tmp|var|workspace|private|opt|root|etc)\/)/u.test(
          block.markdown,
        )
      )
        throw new PromptCompilationError(
          "internal_path_leakage",
          "Runtime 生成块泄漏绝对路径",
        );
    }
  }
}

function readYamlRecord(
  source: string | undefined,
  label: string,
): Record<string, unknown> {
  if (source === undefined || source.trim() === "")
    throw new PromptCompilationError("required_slot_missing", `${label} 缺失`);
  if (
    /(^|\s)[&*!][^\s,\]}]+/mu.test(source) ||
    /^\s*<<\s*:/mu.test(source) ||
    /^---\s*$/mu.test(source) ||
    /^\.\.\.\s*$/mu.test(source)
  )
    throw new PromptCompilationError(
      "unsafe_yaml",
      `${label} 使用了受限 YAML 禁止的 anchor、alias、tag、merge 或多文档语法`,
    );
  const document = parseDocument(source, {
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0)
    throw new PromptCompilationError(
      "unsafe_yaml",
      `${label} 不是安全的受限 YAML`,
      [...document.errors, ...document.warnings].map(({ message }) => message),
    );
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (!isRecord(value))
    throw new PromptCompilationError("unsafe_yaml", `${label} 顶层必须是 map`);
  return value;
}

function requireFormat(
  record: Record<string, unknown>,
  format: string,
  label: string,
): void {
  if (record.format !== format)
    throw new PromptCompilationError(
      "frame_format_invalid",
      `${label} format 必须是 ${format}`,
    );
}

function readMarkdown(
  files: Record<string, string>,
  path: string,
  label: string,
): string {
  const value = files[path];
  if (value === undefined || value.trim() === "")
    throw new PromptCompilationError(
      "required_slot_missing",
      `${label}不存在：${path}`,
    );
  return value.trim();
}

function joinBlocks(blocks: { source: string; markdown: string }[]): string {
  return blocks.map(({ markdown }) => markdown.trim()).join("\n\n");
}

function utf8Tokens(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function stableCacheBoundary(
  stableText: string,
  toolUniverse: PromptCompilation["tools"],
  toolStrategy: RuntimeToolDefinitionStrategy,
): Pick<
  PromptCompilation["cache"],
  "stablePrefixFingerprint" | "estimatedCacheableTokens" | "firstDynamicByte"
> {
  const stableTools = JSON.stringify({ toolUniverse, toolStrategy });
  const stablePrefix = JSON.stringify({
    stableText,
    toolUniverse,
    toolStrategy,
  });
  const stableBytes = utf8Tokens(stableText) + utf8Tokens(stableTools);
  return {
    stablePrefixFingerprint: `sha256:${sha256(stablePrefix)}`,
    estimatedCacheableTokens: stableBytes,
    firstDynamicByte: stableBytes,
  };
}

// Small synchronous SHA-256 keeps the compiler usable by the browser preview and
// the Node sender without introducing two cache-key implementations.
function sha256(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const words: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    words[index >> 2] =
      (words[index >> 2] ?? 0) | (bytes[index]! << (24 - (index % 4) * 8));
  }
  const bitLength = bytes.length * 8;
  words[bitLength >> 5] =
    (words[bitLength >> 5] ?? 0) | (0x80 << (24 - (bitLength % 32)));
  words[(((bitLength + 64) >> 9) << 4) + 15] = bitLength;
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const rotate = (word: number, amount: number): number =>
    (word >>> amount) | (word << (32 - amount));
  for (let offset = 0; offset < words.length; offset += 16) {
    const schedule = new Array<number>(64);
    for (let index = 0; index < 64; index += 1) {
      if (index < 16) schedule[index] = words[offset + index] ?? 0;
      else {
        const first = schedule[index - 15]!;
        const second = schedule[index - 2]!;
        const sigma0 = rotate(first, 7) ^ rotate(first, 18) ^ (first >>> 3);
        const sigma1 =
          rotate(second, 17) ^ rotate(second, 19) ^ (second >>> 10);
        schedule[index] =
          (schedule[index - 16]! + sigma0 + schedule[index - 7]! + sigma1) | 0;
      }
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temp1 =
        (h! + sum1 + choice + constants[index]! + schedule[index]!) | 0;
      const sum0 = rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (sum0 + majority) | 0;
      [a, b, c, d, e, f, g, h] = [
        (temp1 + temp2) | 0,
        a,
        b,
        c,
        (d! + temp1) | 0,
        e,
        f,
        g,
      ];
    }
    [a, b, c, d, e, f, g, h].forEach((value, index) => {
      hash[index] = (hash[index]! + value!) | 0;
    });
  }
  return hash
    .map((word) => (word >>> 0).toString(16).padStart(8, "0"))
    .join("");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}
