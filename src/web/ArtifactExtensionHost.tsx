/* eslint-disable react-refresh/only-export-components */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type FrontendRegexScope =
  "raw_text" | "markdown_html" | "structured_payload";
export type FrontendRegexErrorPolicy = "fallback" | "skip" | "fail";

export interface FrontendRegexRule {
  order: number;
  scope: FrontendRegexScope;
  pattern: string;
  flags: string;
  replace: string;
  maxMatches: number;
  errorPolicy: FrontendRegexErrorPolicy;
}

export interface FrontendExtensionBundle {
  status:
    "ready" | "missing_revision" | "invalid_revision" | "missing_declaration";
  preset: { id: string; revision: string };
  source?: "artifact" | "player_view";
  authority?: "non_authoritative_artifact" | "committed_player_view_projection";
  lifecycle?: "operation_frozen" | "current_preset";
  mount?:
    | "story"
    | "sidebar"
    | "composer_above"
    | "composer_below"
    | "overlay"
    | "debug";
  declaration?: {
    outputName: string;
    channel: string;
    key?: string;
    contentType:
      "text/plain" | "text/markdown" | "application/json" | "text/html";
    projection: "append" | "replace" | "upsert" | "transient" | "hidden";
    save: "none" | "operation" | "commit";
    invalidation:
      | "new_operation"
      | "head_change"
      | "operation_end"
      | "explicit_clear"
      | "never";
    required: boolean;
    maxEmits: number;
    rendererMode: "document" | "app";
  };
  regex: FrontendRegexRule[];
  renderer?: {
    mode: "document" | "app";
    revision?: string;
    document?: string;
    scripts: string[];
    assets: { id: string; source: string }[];
    trustedLocalCode: boolean;
  };
  trustedLocalCode: boolean;
  fallback: "none" | "raw";
  diagnostic?: string;
}

export type ArtifactPayload =
  | string
  | number
  | boolean
  | null
  | ArtifactPayload[]
  | { [key: string]: ArtifactPayload };

export interface FrontendArtifactProjection {
  recordId: string;
  worldId: string;
  operationId: string;
  playPresetId: string;
  playPresetRevision: string;
  requestId: string;
  requestAttempt: number;
  output: string;
  channel: string;
  key?: string;
  contentType:
    "text/plain" | "text/markdown" | "application/json" | "text/html";
  renderer?: string;
  rendererRevision?: string;
  payload: ArtifactPayload;
  projection: "append" | "replace" | "upsert" | "transient" | "hidden";
  save: "none" | "operation" | "commit";
  sequence: number;
  head: string;
  frontend: FrontendExtensionBundle;
}

export interface FrontendPlayerViewPanelProjection {
  panelId: string;
  worldId: string;
  preset: { id: string; revision: string };
  lifecycle: "current_preset";
  source: { kind: "player_view"; viewId: string; itemIds?: string[] };
  authority: "committed_player_view_projection";
  head: string;
  channel: string;
  key: string;
  contentType: "application/json";
  payload: ArtifactPayload;
  projection: "upsert";
  diagnostics: {
    code: string;
    viewId?: string;
    itemId?: string;
    message: string;
  }[];
  frontend: FrontendExtensionBundle;
}

export interface RegexPipelineStep {
  order: number;
  scope: FrontendRegexScope;
  input: string;
  output: string;
  matches: number;
  status: "applied" | "skipped" | "fallback" | "failed";
  error?: string;
}

export interface RegexPipelineResult {
  original: string;
  final: string;
  steps: RegexPipelineStep[];
  fallback: boolean;
  failure: "none" | "fallback" | "fail";
  error?: string;
}

export function artifactInstanceKey(
  artifact: Pick<
    FrontendArtifactProjection,
    | "worldId"
    | "channel"
    | "key"
    | "output"
    | "projection"
    | "recordId"
    | "frontend"
  >,
): string {
  const base = `${artifact.worldId}\0${artifact.channel}\0${artifact.key ?? ""}\0${artifact.output}`;
  const renderer = artifact.frontend.renderer;
  if (artifact.projection === "append") {
    const append = `${base}\0append\0${artifact.recordId}`;
    return renderer?.mode === "app"
      ? `${append}\0app\0${renderer.revision ?? "builtin"}`
      : `${append}\0document`;
  }
  if (renderer?.mode === "app")
    return `${base}\0app\0${renderer.revision ?? "builtin"}`;
  return `${base}\0document`;
}

export function payloadToText(
  payload: ArtifactPayload,
  contentType: FrontendArtifactProjection["contentType"],
): string {
  if (contentType === "application/json")
    return JSON.stringify(payload, null, 2);
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

export function markdownToHtml(markdown: string): string {
  const escaped = escapeHtml(markdown.replace(/\r\n?/gu, "\n"));
  const lines = escaped.split("\n");
  const output: string[] = [];
  let listOpen = false;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    const list = /^[-*]\s+(.*)$/u.exec(line);
    if (list !== null) {
      if (!listOpen) {
        output.push("<ul>");
        listOpen = true;
      }
      output.push(`<li>${inlineMarkdown(list[1] ?? "")}</li>`);
      continue;
    }
    if (listOpen) {
      output.push("</ul>");
      listOpen = false;
    }
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      output.push(`<h${level}>${inlineMarkdown(heading[2] ?? "")}</h${level}>`);
    } else if (line.trim() !== "") {
      output.push(`<p>${inlineMarkdown(line)}</p>`);
    }
  }
  if (listOpen) output.push("</ul>");
  return output.join("\n");
}

export function applyRegexPipeline(input: {
  payload: ArtifactPayload;
  contentType: FrontendArtifactProjection["contentType"];
  rules: FrontendRegexRule[];
  maxOutputBytes?: number;
  maxDomCharacters?: number;
  maxRules?: number;
  maxTransformations?: number;
}): RegexPipelineResult {
  const maxRules = input.maxRules ?? 256;
  const maxTransformations = input.maxTransformations ?? 1_024;
  const maxOutputBytes = input.maxOutputBytes ?? 4 * 1024 * 1024;
  const maxDomCharacters = input.maxDomCharacters ?? 1_000_000;
  const original = payloadToText(input.payload, input.contentType);
  const initialMarkdownHtml =
    input.contentType === "text/markdown" ? markdownToHtml(original) : "";
  if (
    new TextEncoder().encode(original).byteLength > maxOutputBytes ||
    initialMarkdownHtml.length > maxDomCharacters
  )
    return {
      original,
      final: original,
      steps: [],
      fallback: true,
      failure: "fallback",
      error: "artifact 内容超过宿主渲染上限",
    };
  if (input.rules.length > maxRules)
    return {
      original,
      final: original,
      steps: [],
      fallback: true,
      failure: "fallback",
      error: "正则规则数量超过宿主上限",
    };
  const rules = [...input.rules].sort(
    (left, right) => left.order - right.order,
  );
  let raw = original;
  let structured = input.contentType === "application/json" ? original : raw;
  let markdownHtml =
    input.contentType === "text/markdown" ? initialMarkdownHtml : raw;
  let markdownTouched = false;
  const steps: RegexPipelineStep[] = [];
  let transformations = 0;
  let failure: RegexPipelineResult["failure"] = "none";
  for (const rule of rules) {
    const current =
      rule.scope === "raw_text"
        ? raw
        : rule.scope === "structured_payload"
          ? structured
          : markdownHtml;
    let matches = 0;
    try {
      if (
        rule.scope === "markdown_html" &&
        input.contentType !== "text/markdown"
      ) {
        steps.push({
          order: rule.order,
          scope: rule.scope,
          input: current,
          output: current,
          matches: 0,
          status: "skipped",
          error: "markdown_html 规则只作用于 Markdown 转换后的 HTML",
        });
        continue;
      }
      const expression = new RegExp(
        rule.pattern,
        rule.flags.includes("g") ? rule.flags : `${rule.flags}g`,
      );
      const next = current.replace(expression, (...args: unknown[]) => {
        if (matches >= rule.maxMatches)
          return typeof args[0] === "string" ? args[0] : "";
        matches += 1;
        transformations += 1;
        return replacementText(rule.replace, args, current);
      });
      if (transformations > maxTransformations)
        throw new Error("正则转换次数超过宿主上限");
      if (new TextEncoder().encode(next).byteLength > maxOutputBytes)
        throw new Error("正则输出超过宿主字节上限");
      if (rule.scope === "markdown_html" && next.length > maxDomCharacters)
        throw new Error("Markdown HTML DOM 大小超过宿主上限");
      if (rule.scope === "raw_text") {
        raw = next;
        if (!markdownTouched && input.contentType === "text/markdown") {
          markdownHtml = markdownToHtml(raw);
          if (markdownHtml.length > maxDomCharacters)
            throw new Error("Markdown HTML DOM 大小超过宿主上限");
        }
      } else if (rule.scope === "structured_payload") structured = next;
      else {
        markdownHtml = next;
        markdownTouched = true;
      }
      steps.push({
        order: rule.order,
        scope: rule.scope,
        input: current,
        output: next,
        matches,
        status: "applied",
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "正则执行失败";
      if (rule.errorPolicy === "skip") {
        steps.push({
          order: rule.order,
          scope: rule.scope,
          input: current,
          output: current,
          matches,
          status: "skipped",
          error: message,
        });
      } else if (rule.errorPolicy === "fallback") {
        steps.push({
          order: rule.order,
          scope: rule.scope,
          input: current,
          output: original,
          matches,
          status: "fallback",
          error: message,
        });
        failure = "fallback";
        break;
      } else {
        steps.push({
          order: rule.order,
          scope: rule.scope,
          input: current,
          output: current,
          matches,
          status: "failed",
          error: message,
        });
        failure = "fail";
        break;
      }
    }
  }
  const final =
    failure !== "none"
      ? original
      : input.contentType === "text/markdown"
        ? markdownHtml
        : input.contentType === "application/json"
          ? structured
          : raw;
  return {
    original,
    final,
    steps,
    fallback: failure !== "none",
    failure,
    ...(failure === "fallback"
      ? { error: "正则规则失败，实例显示 raw artifact（可恢复）" }
      : failure === "fail"
        ? { error: "正则规则失败，实例进入错误状态并显示 raw artifact" }
        : {}),
  };
}

export function buildDocumentSrcDoc(
  content: string,
  contentType: FrontendArtifactProjection["contentType"],
  renderer?: NonNullable<FrontendExtensionBundle["renderer"]>,
  payload?: ArtifactPayload,
): string {
  if (renderer?.mode === "document" && renderer.document !== undefined)
    return buildDocumentTemplateSrcDoc({
      template: renderer.document,
      content,
      contentType,
      ...(payload === undefined ? {} : { payload }),
    });
  if (contentType === "text/html") return content;
  return `<!doctype html><meta charset="utf-8"><style>body{font:15px/1.6 system-ui,sans-serif;margin:1rem;color:#202020}pre{white-space:pre-wrap}code{font-family:ui-monospace,monospace}</style><main>${contentType === "text/markdown" ? content : `<pre>${escapeHtml(content)}</pre>`}</main>`;
}

/**
 * A document renderer is a trusted local HTML template with explicit markers.
 * `<!-- narraeon:content -->` is required exactly once.  The optional
 * `<!-- narraeon:payload -->` marker receives JSON in a non-executable script
 * element.  No implicit selector or arbitrary host DOM mutation is allowed.
 */
export function buildDocumentTemplateSrcDoc(input: {
  template: string;
  content: string;
  contentType: FrontendArtifactProjection["contentType"];
  payload?: ArtifactPayload;
}): string {
  const contentMarker = "<!-- narraeon:content -->";
  const payloadMarker = "<!-- narraeon:payload -->";
  if (countOccurrences(input.template, contentMarker) !== 1)
    throw new Error("document renderer 必须包含唯一 narraeon:content marker");
  const contentMarkup =
    input.contentType === "text/html"
      ? input.content
      : input.contentType === "text/markdown"
        ? input.content
        : `<pre>${escapeHtml(input.content)}</pre>`;
  let output = input.template.replace(contentMarker, contentMarkup);
  if (output.includes(payloadMarker)) {
    const serialized = JSON.stringify(input.payload ?? null).replace(
      /</gu,
      "\\u003c",
    );
    output = output.replace(
      payloadMarker,
      `<script type="application/json" data-narraeon-payload>${serialized}</script>`,
    );
  }
  return output;
}

export function buildAppSrcDoc(input: {
  renderer: NonNullable<FrontendExtensionBundle["renderer"]>;
  instanceId: string;
  nonce: string;
}): string {
  const source = input.renderer.document ?? "<main></main>";
  const scripts = input.renderer.scripts
    .map(
      (script) =>
        `<script>${script.replace(/<\/script/giu, "<\\/script")}</script>`,
    )
    .join("");
  const assetMetadata = JSON.stringify(
    Object.fromEntries(
      input.renderer.assets.map(({ id, source }) => [id, source]),
    ),
  ).replace(/</gu, "\\u003c");
  const instance = JSON.stringify(input.instanceId);
  const nonce = JSON.stringify(input.nonce);
  const bootstrap = `<script>(function(){var send=function(message){parent.postMessage(message,"*")};window.addEventListener("error",function(event){send({namespace:"${extensionBridgeNamespace}",type:"bridge.event",instanceId:${instance},nonce:${nonce},event:"diagnostic",payload:{message:String(event.message||"扩展脚本错误")}})});window.addEventListener("unhandledrejection",function(event){send({namespace:"${extensionBridgeNamespace}",type:"bridge.event",instanceId:${instance},nonce:${nonce},event:"diagnostic",payload:{message:String(event.reason||"扩展 Promise 错误")}})})})();</script>`;
  const metadata = `<meta name="narraeon-extension" content="local-trusted"><script>document.documentElement.dataset.narraeonInstance=${instance};document.documentElement.dataset.narraeonNonce=${nonce};window.__NARRAEON_ASSETS__=${assetMetadata};</script>`;
  const injected = `${bootstrap}${metadata}`;
  const ready = `<script>parent.postMessage({namespace:"${extensionBridgeNamespace}",type:"bridge.ready",instanceId:${instance},nonce:${nonce}},"*");</script>`;
  return appendBeforeBodyClose(
    injectIntoHead(source, injected, ""),
    `${scripts}${ready}`,
  );
}

function appendBeforeBodyClose(source: string, markup: string): string {
  const close = /<\/body\s*>/iu.exec(source);
  if (close === null) return `${source}${markup}`;
  const at = close.index ?? source.length;
  return `${source.slice(0, at)}${markup}${source.slice(at)}`;
}

function injectIntoHead(
  source: string,
  beforeAuthorScripts: string,
  scripts: string,
): string {
  const headOpen = /<head(?:\s[^>]*)?>/iu.exec(source);
  if (headOpen !== null) {
    const at = (headOpen.index ?? 0) + headOpen[0].length;
    return `${source.slice(0, at)}${beforeAuthorScripts}${scripts}${source.slice(at)}`;
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/iu.exec(source);
  if (htmlOpen !== null) {
    const at = (htmlOpen.index ?? 0) + htmlOpen[0].length;
    return `${source.slice(0, at)}<head>${beforeAuthorScripts}${scripts}</head>${source.slice(at)}`;
  }
  return `<!doctype html><html><head>${beforeAuthorScripts}${scripts}</head><body>${source}</body></html>`;
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

export const extensionBridgeNamespace = "narraeon.extension.v1" as const;

export type ArtifactMountName =
  | "story"
  | "sidebar"
  | "composer_above"
  | "composer_below"
  | "overlay"
  | "debug";

export type ExtensionBridgeCommand =
  | "read_channel"
  | "read_player_view"
  | "composer.set_draft"
  | "panel.close"
  | "panel.refresh"
  | "diagnostic";

export interface ExtensionBridgeMessage {
  namespace: typeof extensionBridgeNamespace;
  command: ExtensionBridgeCommand;
  instanceId: string;
  nonce: string;
  requestId?: string;
  payload?: unknown;
}

export interface ExtensionBridgeResponse {
  namespace: typeof extensionBridgeNamespace;
  type: "bridge.response";
  requestId: string;
  instanceId: string;
  nonce: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export interface ExtensionBridgeReadyMessage {
  namespace: typeof extensionBridgeNamespace;
  type: "bridge.ready";
  instanceId: string;
  nonce: string;
}

interface ExtensionBridgeEventMessage {
  namespace: typeof extensionBridgeNamespace;
  type: "bridge.event";
  event: "diagnostic";
  instanceId: string;
  nonce: string;
  payload?: unknown;
}

export function isExtensionBridgeMessage(
  value: unknown,
  expected: { instanceId: string; nonce: string },
): value is ExtensionBridgeMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<ExtensionBridgeMessage>;
  const requestCommands = [
    "read_channel",
    "read_player_view",
    "composer.set_draft",
    "panel.close",
    "panel.refresh",
  ];
  return (
    message.namespace === extensionBridgeNamespace &&
    typeof message.command === "string" &&
    [
      "read_channel",
      "read_player_view",
      "composer.set_draft",
      "panel.close",
      "panel.refresh",
      "diagnostic",
    ].includes(message.command) &&
    message.instanceId === expected.instanceId &&
    message.nonce === expected.nonce &&
    (requestCommands.includes(message.command)
      ? typeof message.requestId === "string" && message.requestId.length > 0
      : message.requestId === undefined ||
        typeof message.requestId === "string")
  );
}

export function isExtensionBridgeReadyMessage(
  value: unknown,
  expected: { instanceId: string; nonce: string },
): value is ExtensionBridgeReadyMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<ExtensionBridgeReadyMessage>;
  return (
    message.namespace === extensionBridgeNamespace &&
    message.type === "bridge.ready" &&
    message.instanceId === expected.instanceId &&
    message.nonce === expected.nonce
  );
}

function isExtensionBridgeEventMessage(
  value: unknown,
  expected: { instanceId: string; nonce: string },
): value is ExtensionBridgeEventMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<ExtensionBridgeEventMessage>;
  return (
    message.namespace === extensionBridgeNamespace &&
    message.type === "bridge.event" &&
    message.event === "diagnostic" &&
    message.instanceId === expected.instanceId &&
    message.nonce === expected.nonce
  );
}

export function isExtensionBridgeResponse(
  value: unknown,
): value is ExtensionBridgeResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Partial<ExtensionBridgeResponse>;
  return (
    response.namespace === extensionBridgeNamespace &&
    response.type === "bridge.response" &&
    typeof response.requestId === "string" &&
    response.requestId.length > 0 &&
    typeof response.instanceId === "string" &&
    typeof response.nonce === "string" &&
    typeof response.ok === "boolean"
  );
}

export interface ArtifactExtensionHostProps {
  worldId: string;
  artifacts: FrontendArtifactProjection[];
  playerViewPanels?: FrontendPlayerViewPanelProjection[];
  playerViews: { views: unknown[] };
  /** Generic interaction gate used while the owning composer is submitting. */
  interactionDisabled?: boolean;
  onSetComposerDraft: (text: string) => void;
  onRefresh: () => void | Promise<void>;
  onBridgeEvent?: (recordId: string, event: string) => void;
  children?: ReactNode;
}

export const mountOrder = [
  "story",
  "sidebar",
  "composer_above",
  "composer_below",
  "overlay",
  "debug",
] as const;

interface ArtifactExtensionContextValue extends ArtifactExtensionHostProps {
  interactionDisabled: boolean;
  byMount: Map<ArtifactMountName, FrontendArtifactProjection[]>;
  disabled: Set<string>;
  errors: Map<string, string>;
  bridgeEvents: Map<string, string[]>;
  disable: (key: string) => void;
  enable: (key: string) => void;
  error: (key: string, message: string) => void;
  bridgeEvent: (key: string, recordId: string, event: string) => void;
}

const ArtifactExtensionContext =
  createContext<ArtifactExtensionContextValue | null>(null);

export function ArtifactExtensionHost({
  worldId,
  artifacts,
  playerViewPanels = [],
  playerViews,
  interactionDisabled = false,
  onSetComposerDraft,
  onRefresh,
  onBridgeEvent,
  children,
}: ArtifactExtensionHostProps): React.JSX.Element {
  const [disabled, setDisabled] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());
  const [bridgeEvents, setBridgeEvents] = useState<Map<string, string[]>>(
    () => new Map(),
  );
  const byMount = useMemo(() => {
    const grouped = new Map<
      (typeof mountOrder)[number],
      FrontendArtifactProjection[]
    >();
    for (const mount of mountOrder) grouped.set(mount, []);
    const entries = [
      ...artifacts,
      ...playerViewPanels.map(playerViewPanelAsArtifact),
    ];
    for (const artifact of entries) {
      const mount =
        artifact.frontend.mount ??
        (artifact.frontend.fallback === "raw" ? "debug" : undefined);
      if (mount === undefined) continue;
      if (artifact.projection === "hidden" && mount !== "debug") continue;
      grouped.get(mount)?.push(artifact);
    }
    return grouped;
  }, [artifacts, playerViewPanels]);
  const value = useMemo<ArtifactExtensionContextValue>(
    () => ({
      worldId,
      artifacts,
      playerViewPanels,
      playerViews,
      interactionDisabled,
      onSetComposerDraft,
      onRefresh,
      ...(onBridgeEvent === undefined ? {} : { onBridgeEvent }),
      children,
      byMount,
      disabled,
      errors,
      bridgeEvents,
      disable: (key) => setDisabled((current) => new Set(current).add(key)),
      enable: (key) => {
        setDisabled((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
        setErrors((current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        });
      },
      error: (key, message) =>
        setErrors((current) => new Map(current).set(key, message)),
      bridgeEvent: (key, recordId, event) => {
        setBridgeEvents((current) => {
          const next = new Map(current);
          next.set(key, [...(next.get(key) ?? []), event]);
          return next;
        });
        onBridgeEvent?.(recordId, event);
      },
    }),
    [
      artifacts,
      bridgeEvents,
      byMount,
      children,
      disabled,
      errors,
      onBridgeEvent,
      onRefresh,
      onSetComposerDraft,
      playerViews,
      playerViewPanels,
      interactionDisabled,
      worldId,
    ],
  );
  return (
    <ArtifactExtensionContext.Provider value={value}>
      {children}
    </ArtifactExtensionContext.Provider>
  );
}

export function ArtifactExtensionMount({
  mount,
}: {
  mount: ArtifactMountName;
}): React.JSX.Element {
  const context = useContext(ArtifactExtensionContext);
  if (context === null)
    throw new Error("ArtifactExtensionMount 必须位于 ArtifactExtensionHost 内");
  const entries = context.byMount.get(mount) ?? [];
  return (
    <div
      className={`artifact-extension-mount artifact-extension-mount-${mount}`}
      data-extension-mount={mount}
    >
      {entries.map((artifact) => {
        const key = artifactInstanceKey(artifact);
        return (
          <ArtifactExtensionInstance
            key={key}
            artifact={artifact}
            worldId={context.worldId}
            channelArtifacts={context.artifacts.filter(
              ({ channel }) => channel === artifact.channel,
            )}
            playerViews={context.playerViews.views}
            interactionDisabled={context.interactionDisabled}
            disabled={context.disabled.has(key)}
            error={context.errors.get(key)}
            events={context.bridgeEvents.get(key) ?? []}
            onDisable={() => context.disable(key)}
            onEnable={() => context.enable(key)}
            onError={(message) => context.error(key, message)}
            onBridgeEvent={(event) =>
              context.bridgeEvent(key, artifact.recordId, event)
            }
            onSetComposerDraft={context.onSetComposerDraft}
            onRefresh={context.onRefresh}
          />
        );
      })}
    </div>
  );
}

function playerViewPanelAsArtifact(
  panel: FrontendPlayerViewPanelProjection,
): FrontendArtifactProjection {
  return {
    recordId: `player-view:${panel.panelId}`,
    worldId: panel.worldId,
    operationId: `player-view:${panel.panelId}`,
    playPresetId: panel.preset.id,
    playPresetRevision: panel.preset.revision,
    requestId: "player_view",
    requestAttempt: 0,
    output: panel.panelId,
    channel: panel.channel,
    key: panel.key,
    contentType: panel.contentType,
    payload: panel.payload,
    projection: panel.projection,
    save: "none",
    sequence: 0,
    head: panel.head,
    frontend: panel.frontend,
  };
}

function ArtifactExtensionInstance({
  artifact,
  worldId,
  channelArtifacts,
  playerViews,
  interactionDisabled,
  disabled,
  error,
  events,
  onDisable,
  onEnable,
  onError,
  onBridgeEvent,
  onSetComposerDraft,
  onRefresh,
}: {
  artifact: FrontendArtifactProjection;
  worldId: string;
  channelArtifacts: FrontendArtifactProjection[];
  playerViews: unknown[];
  interactionDisabled: boolean;
  disabled: boolean;
  error: string | undefined;
  events: string[];
  onDisable: () => void;
  onEnable: () => void;
  onError: (message: string) => void;
  onBridgeEvent: (message: string) => void;
  onSetComposerDraft: (text: string) => void;
  onRefresh: () => void | Promise<void>;
}): React.JSX.Element {
  const instanceKey = artifactInstanceKey(artifact);
  const instanceId = `extension-${hashForDom(instanceKey)}`;
  const [lifecycle, setLifecycle] = useState(() => ({
    epoch: 0,
    nonce: randomNonce(),
  }));
  const nonce = lifecycle.nonce;
  const [childReady, setChildReady] = useState(false);
  const pipeline = useMemo(
    () =>
      applyRegexPipeline({
        payload: artifact.payload,
        contentType: artifact.contentType,
        rules: artifact.frontend.regex,
      }),
    [artifact.contentType, artifact.frontend.regex, artifact.payload],
  );
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const renderer = artifact.frontend.renderer;
  const isApp = renderer?.mode === "app";
  const content = pipeline.final;
  const renderedDocument = useMemo(() => {
    try {
      return {
        srcDoc:
          isApp && renderer !== undefined
            ? buildAppSrcDoc({ renderer, instanceId, nonce })
            : buildDocumentSrcDoc(
                content,
                artifact.contentType,
                renderer,
                artifact.payload,
              ),
        error: undefined,
      };
    } catch (reason: unknown) {
      return {
        srcDoc: "",
        error: reason instanceof Error ? reason.message : "文档 renderer 无效",
      };
    }
  }, [
    artifact.contentType,
    artifact.payload,
    content,
    instanceId,
    isApp,
    nonce,
    renderer,
  ]);
  const srcDoc = renderedDocument.srcDoc;
  const renderError = renderedDocument.error;
  const instanceError =
    error ??
    renderError ??
    (pipeline.failure === "fail" ? pipeline.error : undefined);

  const refreshPanel = useCallback((): void => {
    setChildReady(false);
    setLifecycle((current) => ({
      epoch: current.epoch + 1,
      nonce: randomNonce(),
    }));
    void onRefresh();
  }, [onRefresh]);

  const sendAppUpdate = useCallback((): void => {
    const iframe = iframeRef.current;
    if (!isApp || iframe?.contentWindow == null) return;
    iframe.contentWindow.postMessage(
      {
        namespace: extensionBridgeNamespace,
        type: "render.update",
        instanceId,
        nonce,
        payload: {
          content,
          contentType: artifact.contentType,
          worldId,
          channel: artifact.channel,
          key: artifact.key,
          interactionDisabled,
        },
      },
      "*",
    );
  }, [
    artifact.channel,
    artifact.contentType,
    artifact.key,
    content,
    instanceId,
    isApp,
    nonce,
    worldId,
    interactionDisabled,
  ]);

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (
        isExtensionBridgeReadyMessage(event.data, {
          instanceId,
          nonce,
        })
      ) {
        setChildReady(true);
        onBridgeEvent("bridge.ready");
        return;
      }
      if (
        isExtensionBridgeEventMessage(event.data, {
          instanceId,
          nonce,
        })
      ) {
        const payload = isRecord(event.data.payload) ? event.data.payload : {};
        onBridgeEvent("diagnostic");
        onError(
          typeof payload.message === "string"
            ? payload.message
            : "扩展报告了未知诊断",
        );
        return;
      }
      if (
        !isExtensionBridgeMessage(event.data, {
          instanceId,
          nonce,
        })
      )
        return;
      onBridgeEvent(event.data.command);
      const payload = isRecord(event.data.payload) ? event.data.payload : {};
      if (event.data.command === "read_channel") {
        respond(event, event.data, {
          artifacts: channelArtifacts.map((item) => ({
            recordId: item.recordId,
            channel: item.channel,
            ...(item.key === undefined ? {} : { key: item.key }),
            contentType: item.contentType,
            payload: item.payload,
            projection: item.projection,
            save: item.save,
            sequence: item.sequence,
            head: item.head,
          })),
        });
      } else if (event.data.command === "read_player_view") {
        const viewId = typeof payload.viewId === "string" ? payload.viewId : "";
        respond(event, event.data, {
          view: playerViews.find(
            (view) => isRecord(view) && view.id === viewId,
          ),
        });
      } else if (event.data.command === "composer.set_draft") {
        if (interactionDisabled) {
          respondError(event, event.data, "当前调用链正在提交，暂不能修改草稿");
        } else if (typeof payload.text !== "string") {
          respondError(
            event,
            event.data,
            "composer.set_draft.text 必须是字符串",
          );
        } else {
          onSetComposerDraft(payload.text);
          respondSuccess(event, event.data, { accepted: true });
        }
      } else if (event.data.command === "panel.close") {
        onDisable();
        respond(event, event.data, { accepted: true });
      } else if (event.data.command === "panel.refresh") {
        refreshPanel();
        respond(event, event.data, { accepted: true });
      } else if (event.data.command === "diagnostic") {
        onError(
          typeof payload.message === "string"
            ? payload.message
            : "扩展报告了未知诊断",
        );
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [
    channelArtifacts,
    instanceId,
    nonce,
    onBridgeEvent,
    onDisable,
    onError,
    onRefresh,
    onSetComposerDraft,
    interactionDisabled,
    playerViews,
    refreshPanel,
  ]);

  useEffect(() => {
    if (!childReady) return;
    sendAppUpdate();
  }, [childReady, sendAppUpdate]);

  function handleFrameLoad(): void {
    // The ready event is authoritative; load is a safe fallback for a local
    // document that does not install the bridge bootstrap.
    setChildReady(true);
    if (isApp) window.setTimeout(sendAppUpdate, 0);
  }

  return (
    <article
      className={`artifact-extension-instance${instanceError ? " has-error" : ""}`}
      data-artifact-output={artifact.output}
      data-artifact-status={artifact.frontend.status}
      data-extension-authority={
        artifact.frontend.authority ?? "non_authoritative_artifact"
      }
    >
      {disabled ||
      instanceError ||
      artifact.frontend.fallback === "raw" ||
      pipeline.fallback ? (
        <div className="artifact-extension-fallback" role="status">
          <p>
            {instanceError ??
              pipeline.error ??
              artifact.frontend.diagnostic ??
              "扩展资源不可用，显示 raw artifact。"}
          </p>
          <pre>{pipeline.original}</pre>
          <button type="button" onClick={disabled ? onEnable : onDisable}>
            {disabled ? "恢复此扩展" : "停用此扩展"}
          </button>
        </div>
      ) : (
        <>
          {artifact.frontend.trustedLocalCode ? (
            <small className="artifact-extension-trusted-label">
              本地可信代码
            </small>
          ) : null}
          <iframe
            ref={iframeRef}
            title={artifact.output}
            className="artifact-extension-frame"
            key={lifecycle.epoch}
            sandbox={artifact.frontend.trustedLocalCode ? "allow-scripts" : ""}
            srcDoc={srcDoc}
            onLoad={handleFrameLoad}
            onError={() => onError("扩展 iframe 加载失败")}
          />
        </>
      )}
      {artifact.frontend.mount === "debug" ? (
        <details className="artifact-extension-debug">
          <summary>产物诊断</summary>
          <dl>
            <dt>来源</dt>
            <dd>
              {artifact.operationId} / {artifact.requestId} / attempt{" "}
              {artifact.requestAttempt}
            </dd>
            <dt>保存／投影</dt>
            <dd>
              {artifact.save} / {artifact.projection}
            </dd>
            <dt>renderer revision</dt>
            <dd>{artifact.frontend.renderer?.revision ?? "built-in"}</dd>
          </dl>
          <p>raw payload</p>
          <pre>{pipeline.original}</pre>
          <p>regex steps</p>
          <pre>{JSON.stringify(pipeline.steps, null, 2)}</pre>
          {events.length === 0 ? null : (
            <p>bridge events: {events.join(", ")}</p>
          )}
        </details>
      ) : null}
      {events.length === 0 ? null : (
        <details className="artifact-extension-events">
          <summary>bridge 事件（{events.length}）</summary>
          <ul>
            {events.map((event, index) => (
              <li key={`${event}-${index}`}>{event}</li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

function respond(
  event: MessageEvent,
  request: ExtensionBridgeMessage,
  payload: unknown,
): void {
  respondSuccess(event, request, payload);
}

function respondSuccess(
  event: MessageEvent,
  request: ExtensionBridgeMessage,
  payload: unknown,
): void {
  respondEnvelope(event, request, { ok: true, payload });
}

function respondError(
  event: MessageEvent,
  request: ExtensionBridgeMessage,
  error: string,
): void {
  respondEnvelope(event, request, { ok: false, error });
}

function respondEnvelope(
  event: MessageEvent,
  request: ExtensionBridgeMessage,
  result: { ok: true; payload: unknown } | { ok: false; error: string },
): void {
  if (request.requestId === undefined) return;
  const source = event.source;
  if (source !== null && "postMessage" in source)
    (source as WindowProxy).postMessage(
      {
        namespace: extensionBridgeNamespace,
        type: "bridge.response",
        ok: result.ok,
        requestId: request.requestId,
        instanceId: request.instanceId,
        nonce: request.nonce,
        ...(result.ok ? { payload: result.payload } : { error: result.error }),
      },
      "*",
    );
}

function replacementText(
  replacement: string,
  args: unknown[],
  source: string,
): string {
  const match = typeof args[0] === "string" ? args[0] : "";
  const offset = typeof args.at(-2) === "number" ? (args.at(-2) as number) : 0;
  const captureEnd = typeof args.at(-1) === "object" ? -3 : -2;
  const captures = args.slice(1, captureEnd);
  return replacement.replace(
    /\$(\$|&|`|'|\d{1,2})/gu,
    (_token, code: string) => {
      if (code === "&") return match;
      if (code === "`") return source.slice(0, offset);
      if (code === "'") return source.slice(offset + match.length);
      if (/^\d{1,2}$/u.test(code)) {
        const capture = captures[Number(code) - 1];
        return typeof capture === "string" ? capture : "";
      }
      return "$";
    },
  );
}

function inlineMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/gu, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function hashForDom(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function randomNonce(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return Math.random().toString(36).slice(2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
