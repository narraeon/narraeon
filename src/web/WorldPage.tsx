import { uiText } from "./i18n.ts";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import type {
  ContentTreeFile,
  V1PlayCallChainContextView,
  V1PlayCallChainEvent,
  V1PlayCallChainStreamFrame,
  V1PlayCallChainView,
  V1Request,
} from "../protocol/v1.ts";
import type {
  PlayerViewDiagnostic,
  RenderedPlayerView,
} from "../protocol/playerViews.ts";
import { createClientId } from "./ClientId.ts";
import {
  FileNativeCorrectionPanel,
  type CorrectionPreviewView,
} from "./FileNativeCorrectionPanel.tsx";
import {
  ArtifactExtensionHost,
  ArtifactExtensionMount,
  type FrontendArtifactProjection,
  type FrontendPlayerViewPanelProjection,
} from "./ArtifactExtensionHost.tsx";
import {
  ArtifactDebugger,
  type FrontendArtifactExtensionSummary,
  type FrontendArtifactDebugRecord,
} from "./ArtifactDebugger.tsx";
import { projectUncoveredPlayerViews } from "./PlayerViewFallback.ts";

type WorldSection = "play" | "documents" | "history" | "manage";
type PendingAction =
  | "play-fresh"
  | "play-append"
  | "control-preview"
  | "control-apply"
  | "correction-preview"
  | "correction-apply"
  | "correction-cancel"
  | "rename"
  | "revise"
  | "derive";

interface WorldMessage {
  role: "player" | "narrator";
  exactText: string;
  messageId?: string;
  head?: string;
}

interface WorldReadView {
  worldId: string;
  head: string;
  state: ContentTreeFile[];
  control: ContentTreeFile[];
  history: ContentTreeFile[];
  runtime: unknown;
  playerViews: {
    views: RenderedPlayerView[];
    diagnostics: PlayerViewDiagnostic[];
  };
  artifacts?: FrontendArtifactProjection[];
  playerViewPanels?: FrontendPlayerViewPanelProjection[];
  artifactDebug?: FrontendArtifactDebugRecord[];
  extensions?: FrontendArtifactExtensionSummary[];
  committedMessages: WorldMessage[];
  playCallChain: V1PlayCallChainView | null;
}

interface Feedback {
  kind: "status" | "error";
  text: string;
}

interface DocumentOption {
  path: string;
  title: string;
  ref: string;
  handle: string;
}

interface WorldPageClient {
  request(request: V1Request): Promise<unknown>;
  streamPlayCallChain?: (
    request: Extract<
      V1Request,
      { type: "play.chain.start" | "play.chain.append" }
    >,
    onFrame: (frame: V1PlayCallChainStreamFrame) => void,
  ) => Promise<V1PlayCallChainView>;
}

export function WorldPage({
  client,
  worldId,
  worldTitle,
  modelConfigured,
  onBack,
  onConfigureModel,
  onRenameWorld,
  onOpenWorld,
}: {
  client: WorldPageClient;
  worldId: string;
  worldTitle: string;
  modelConfigured: boolean;
  onBack: () => void;
  onConfigureModel: () => void;
  onRenameWorld: (name: string) => Promise<void>;
  onOpenWorld: (worldId: string) => Promise<void>;
}): React.JSX.Element {
  const [world, setWorld] = useState<WorldReadView | null>(null);
  const [section, setSection] = useState<WorldSection>("play");
  const [playerText, setPlayerText] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [worldNameDraft, setWorldNameDraft] = useState(worldTitle);
  const [lastWorldTitle, setLastWorldTitle] = useState(worldTitle);
  if (lastWorldTitle !== worldTitle) {
    setLastWorldTitle(worldTitle);
    setWorldNameDraft(worldTitle);
  }
  const [playCallChain, setPlayCallChain] =
    useState<V1PlayCallChainView | null>(null);
  const [selectedDocument, setSelectedDocument] = useState("");
  const [controlFiles, setControlFiles] = useState("[]");
  const [controlDirty, setControlDirty] = useState(false);
  const [controlPreview, setControlPreview] = useState<unknown>(null);
  const [correction, setCorrection] = useState<{
    candidateId: string;
    version: number;
  } | null>(null);
  const [correctionPreview, setCorrectionPreview] =
    useState<CorrectionPreviewView | null>(null);
  const [correctionDocument, setCorrectionDocument] = useState("");
  const [correctionPath, setCorrectionPath] = useState(uiText("衣着"));
  const [correctionValue, setCorrectionValue] = useState("");
  const [bridgeEvents, setBridgeEvents] = useState<Record<string, string[]>>(
    {},
  );
  const historyEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    const open = async (): Promise<void> => {
      try {
        const [next, artifactDebug] = await Promise.all([
          requestRuntime<WorldReadView>(client, {
            type: "world.read",
            worldId,
          }),
          requestArtifactDebug(client, worldId),
        ]);
        if (!active) return;
        applyWorld({ ...next, artifactDebug }, false);
      } catch (reason: unknown) {
        if (!active) return;
        setFeedback({ kind: "error", text: errorMessage(reason) });
      } finally {
        if (active) setPending(null);
      }
    };
    void open();
    return () => {
      active = false;
    };
  }, [client, worldId]);

  useEffect(() => {
    const chainPending = pending === "play-fresh" || pending === "play-append";
    if (chainPending && client.streamPlayCallChain !== undefined) return;
    if (!chainPending && playCallChain?.status !== "running") return;
    let active = true;
    const poll = async (): Promise<void> => {
      try {
        const next = await requestRuntime<V1PlayCallChainView | null>(client, {
          type: "play.chain.inspect",
          worldId,
        });
        if (!active || next === null) return;
        setPlayCallChain(next);
      } catch {
        // Inspection is observational. The initiating request remains the
        // source of truth and the last visible call-chain snapshot stays put.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, pending, playCallChain?.status, worldId]);

  useEffect(() => {
    if (section !== "play") return;
    historyEndRef.current?.scrollIntoView?.({ block: "nearest" });
    // Only explicit navigation into the play surface may reposition the page.
    // Streaming frames must stay silent so the player can read older content.
  }, [section]);

  const documents = world?.state ?? [];
  const documentOptions = documents.map(documentOption);
  const correctableDocuments = documentOptions.filter(({ path }) =>
    /\.ya?ml$/iu.test(path),
  );
  const currentDocument =
    documents.find(({ path }) => path === selectedDocument) ?? documents[0];
  const playerViewFallback = projectUncoveredPlayerViews(
    world?.playerViews ?? { views: [], diagnostics: [] },
    world?.playerViewPanels ?? [],
  );
  const committedMessages = world?.committedMessages ?? [];
  const displayedPlayContexts =
    playCallChain === null
      ? []
      : [...(playCallChain.previousContexts ?? []), playCallChain];
  const committedStoryBeforeDisplayedContexts =
    displayedPlayContexts.length === 0
      ? committedMessages
      : messagesBeforeContext(committedMessages, displayedPlayContexts[0]!);
  const hasPlayerText = playerText.trim().length > 0;
  const playIdle = pending === null && playCallChain?.status !== "running";
  const canStartFresh = hasPlayerText && playIdle;
  const canAppend =
    playIdle &&
    (playCallChain === null
      ? hasPlayerText
      : playCallChain.status === "ready" ||
        (!hasPlayerText && playCallChain.canRetry));

  function applyWorld(
    next: WorldReadView,
    preserveControlDraft: boolean,
  ): void {
    setWorld(next);
    if (!preserveControlDraft) {
      setControlFiles(JSON.stringify(next.control, null, 2));
      setControlDirty(false);
      setControlPreview(null);
    }
    setPlayCallChain(next.playCallChain);
    setSelectedDocument((current) =>
      next.state.some(({ path }) => path === current)
        ? current
        : (next.state[0]?.path ?? ""),
    );
    setCorrectionDocument((current) => {
      const options = next.state
        .map(documentOption)
        .filter(({ path }) => /\.ya?ml$/iu.test(path));
      if (options.some(({ handle }) => handle === current)) return current;
      return (
        options.find(({ ref }) => ref === "qinlong")?.handle ??
        options[0]?.handle ??
        ""
      );
    });
  }

  async function refreshWorld(preserveControlDraft = true): Promise<void> {
    const [next, artifactDebug] = await Promise.all([
      requestRuntime<WorldReadView>(client, {
        type: "world.read",
        worldId,
      }),
      requestArtifactDebug(client, worldId),
    ]);
    applyWorld({ ...next, artifactDebug }, preserveControlDraft);
  }

  async function submitPlayChain(context: "fresh" | "append"): Promise<void> {
    if (!modelConfigured) return;
    const fresh = context === "fresh" || playCallChain === null;
    if ((fresh && !canStartFresh) || (!fresh && !canAppend)) return;
    const chainId = fresh
      ? createClientId("play-chain")
      : playCallChain.chainId;
    const exchangeId = createClientId("play-exchange");
    setPending(context === "fresh" ? "play-fresh" : "play-append");
    setFeedback({
      kind: "status",
      text: fresh
        ? uiText("正在从当前世界重新拼接上下文…")
        : hasPlayerText
          ? uiText("正在把玩家输入追加到现有上下文…")
          : playCallChain.status === "interrupted"
            ? uiText("正在原样发送上次未完成的模型请求…")
            : uiText("正在沿现有上下文继续生成…"),
    });
    try {
      const request = fresh
        ? ({
            type: "play.chain.start",
            worldId,
            chainId,
            exchangeId,
            playerText,
          } satisfies Extract<V1Request, { type: "play.chain.start" }>)
        : ({
            type: "play.chain.append",
            worldId,
            chainId,
            exchangeId,
            playerText,
          } satisfies Extract<V1Request, { type: "play.chain.append" }>);
      const next = await requestPlayCallChain(client, request, (frame) =>
        applyPlayCallChainFrame(frame, setPlayCallChain),
      );
      setPlayCallChain(next);
      if (hasPlayerText) setPlayerText("");
      await refreshWorld();
      setFeedback({
        kind: next.status === "interrupted" ? "error" : "status",
        text:
          next.status === "interrupted"
            ? next.canRetry
              ? uiText(
                  "模型请求中断；清空输入后点击追加上下文即可原样发送上次请求。",
                )
              : uiText("调用链处理失败；旧请求不能重发，请使用全新上下文。")
            : !fresh && !hasPlayerText
              ? uiText("AI 已沿现有上下文继续生成，没有追加玩家指令。")
              : uiText("调用链已返回；模型完成的叙事和世界变化已经分别提交。"),
      });
    } catch (reason: unknown) {
      const inspected = await requestRuntime<V1PlayCallChainView | null>(
        client,
        { type: "play.chain.inspect", worldId },
      ).catch(() => null);
      if (inspected !== null) setPlayCallChain(inspected);
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  async function previewControl(): Promise<void> {
    setPending("control-preview");
    try {
      const files = JSON.parse(controlFiles) as ContentTreeFile[];
      await client.request({
        type: "world.control-draft.save",
        worldId,
        files,
      });
      const preview = await client.request({
        type: "world.control-draft.preview",
        worldId,
      });
      setControlPreview(preview);
      setFeedback({
        kind: "status",
        text: uiText("控制草稿已通过真实提示词预览；确认后才会整批应用。"),
      });
    } catch (reason: unknown) {
      setControlPreview(null);
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  async function applyControl(): Promise<void> {
    if (controlPreview === null || playCallChain?.status === "running") return;
    setPending("control-apply");
    try {
      await client.request({ type: "world.control-draft.apply", worldId });
      await refreshWorld(false);
      setFeedback({ kind: "status", text: uiText("世界控制已整批应用。") });
    } catch (reason: unknown) {
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  async function previewCorrection(): Promise<void> {
    if (correctionDocument.length === 0 || correctionPath.trim().length === 0)
      return;
    setPending("correction-preview");
    try {
      const started =
        correction ??
        (await requestRuntime<{ candidateId: string; version: number }>(
          client,
          {
            type: "correction.begin",
            worldId,
            operationId: createClientId("correction"),
          },
        ));
      setCorrection(started);
      const document = await requestRuntime<{ hash: string }>(client, {
        type: "correction.read",
        candidateId: started.candidateId,
        document: correctionDocument,
      });
      const patched = await requestRuntime<{ version: number }>(client, {
        type: "correction.patch",
        candidateId: started.candidateId,
        expectedVersion: started.version,
        target: correctionDocument,
        expectedHash: document.hash,
        edits: [
          {
            op: "replace",
            locator: { yaml: correctionPath.split(".").filter(Boolean) },
            value: correctionValue,
          },
        ],
      });
      const preview = await requestRuntime<CorrectionPreviewView>(client, {
        type: "correction.preview",
        candidateId: started.candidateId,
        expectedVersion: patched.version,
      });
      setCorrection({
        candidateId: started.candidateId,
        version: patched.version,
      });
      setCorrectionPreview(preview);
      setFeedback({
        kind: "status",
        text: uiText("修正草稿已预览；应用前世界状态没有变化。"),
      });
    } catch (reason: unknown) {
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  async function applyCorrection(): Promise<void> {
    if (correction === null || correctionPreview === null) return;
    setPending("correction-apply");
    try {
      await client.request({
        type: "correction.apply",
        candidateId: correction.candidateId,
        expectedVersion: correction.version,
      });
      setCorrection(null);
      setCorrectionPreview(null);
      await refreshWorld();
      setFeedback({
        kind: "status",
        text: uiText("连续性修正已作为一笔新提交应用，旧历史保持不变。"),
      });
    } catch (reason: unknown) {
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  async function cancelCorrection(): Promise<void> {
    if (correction === null) {
      setCorrectionPreview(null);
      return;
    }
    setPending("correction-cancel");
    try {
      await client.request({
        type: "correction.cancel",
        candidateId: correction.candidateId,
        expectedVersion: correction.version,
      });
      setCorrection(null);
      setCorrectionPreview(null);
      setFeedback({
        kind: "status",
        text: uiText("修正草稿已放弃，世界端点没有推进。"),
      });
    } catch (reason: unknown) {
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  async function deriveWorld(sourceHead = world?.head): Promise<void> {
    if (world === null) return;
    if (sourceHead === undefined) return;
    setPending("derive");
    try {
      const derived = await requestRuntime<{ world: { worldId: string } }>(
        client,
        {
          type: "world.derive",
          operationId: createClientId("derive"),
          sourceWorldId: world.worldId,
          sourceHead,
        },
      );
      await onOpenWorld(derived.world.worldId);
    } catch (reason: unknown) {
      setFeedback({ kind: "error", text: errorMessage(reason) });
      setPending(null);
    }
  }

  async function reviseEditedPlayer(
    chainId: string,
    eventId: number,
    editedText: string,
  ): Promise<void> {
    if (world === null) return;
    if (editedText.trim().length === 0) {
      setFeedback({
        kind: "error",
        text: uiText("修改后的玩家提交不能为空。"),
      });
      return;
    }
    const replacementExchangeId = createClientId("play-exchange");
    setPending("revise");
    setFeedback({
      kind: "status",
      text: uiText("正在当前世界中保存修改，并舍弃这条消息之后的当前时间线…"),
    });
    try {
      const revised = await requestRuntime<{
        outcome: "revised";
        worldId: string;
        playCallChain: V1PlayCallChainView;
      }>(client, {
        type: "play.chain.revise-player",
        operationId: createClientId("revise-player"),
        worldId: world.worldId,
        chainId,
        eventId,
        replacementExchangeId,
        replacementText: editedText,
      });
      setPlayCallChain(revised.playCallChain);
      await refreshWorld();
      if (!modelConfigured) {
        setFeedback({
          kind: "status",
          text: uiText(
            "修改已保存在当前世界；配置模型后点击“追加上下文”即可继续生成。",
          ),
        });
        return;
      }

      setPending("play-append");
      setFeedback({
        kind: "status",
        text: uiText("修改已保存，正在从修改稿继续生成…"),
      });
      const continued = await requestPlayCallChain(
        client,
        {
          type: "play.chain.append",
          worldId: world.worldId,
          chainId: revised.playCallChain.chainId,
          exchangeId: createClientId("play-exchange"),
          playerText: "",
        },
        (frame) => applyPlayCallChainFrame(frame, setPlayCallChain),
      );
      setPlayCallChain(continued);
      await refreshWorld();
      setFeedback({
        kind: continued.status === "interrupted" ? "error" : "status",
        text:
          continued.status === "interrupted"
            ? continued.canRetry
              ? uiText(
                  "修改已保存，但模型请求中断；点击“追加上下文”即可原样重发。",
                )
              : uiText("修改已保存，但模型请求失败；请使用全新上下文继续。")
            : uiText("修改已保存在当前世界，并已从修改稿继续。"),
      });
    } catch (reason: unknown) {
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  function submitCurrentMode(): void {
    void submitPlayChain("append");
  }

  async function renameCurrentWorld(): Promise<void> {
    const name = worldNameDraft.trim();
    if (name === "" || name === worldTitle) return;
    setPending("rename");
    setFeedback(null);
    try {
      await onRenameWorld(name);
      setFeedback({ kind: "status", text: uiText("世界名称已保存。") });
    } catch (reason: unknown) {
      setFeedback({ kind: "error", text: errorMessage(reason) });
    } finally {
      setPending(null);
    }
  }

  if (world === null)
    return (
      <main className="world-page world-page-loading">
        <button className="world-back-button secondary-button" onClick={onBack}>
          {uiText("← 返回工作区")}
        </button>
        {feedback?.kind === "error" ? (
          <p role="alert">{feedback.text}</p>
        ) : (
          <p role="status">{uiText("正在打开世界…")}</p>
        )}
      </main>
    );

  return (
    <main className="world-page">
      <header className="world-page-header">
        <button className="world-back-button secondary-button" onClick={onBack}>
          <span aria-hidden="true">←</span> {uiText("工作区")}
        </button>
        <div className="world-title-block">
          <p className="eyebrow">{uiText("正在游玩的世界")}</p>
          <h1>{worldTitle}</h1>
        </div>
        <div className="world-header-summary" aria-label={uiText("世界概况")}>
          <span>
            {committedMessages.length} {uiText("条已提交消息")}
          </span>
          <span
            className={
              playCallChain?.status === "running" ? "is-live" : "is-saved"
            }
          >
            {playCallChain?.status === "running"
              ? uiText("模型调用中")
              : playCallChain?.status === "interrupted"
                ? uiText("调用链已中断")
                : uiText("世界已保存")}
          </span>
        </div>
      </header>

      <nav className="world-section-tabs" aria-label={uiText("世界页面")}>
        {(
          [
            ["play", uiText("游玩")],
            ["documents", uiText("当前文档")],
            ["history", uiText("已提交叙事")],
            ["manage", uiText("世界管理")],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={section === value ? "is-current" : "secondary-button"}
            aria-current={section === value ? "page" : undefined}
            onClick={() => setSection(value)}
          >
            {label}
          </button>
        ))}
      </nav>

      {feedback === null ? null : (
        <p
          className={`world-feedback ${feedback.kind}`}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.text}
        </p>
      )}

      {section === "play" && (
        <ArtifactExtensionHost
          worldId={world.worldId}
          artifacts={world.artifacts ?? []}
          playerViewPanels={world.playerViewPanels ?? []}
          playerViews={world.playerViews}
          interactionDisabled={pending !== null}
          onSetComposerDraft={setPlayerText}
          onRefresh={() => refreshWorld()}
          onBridgeEvent={(recordId, event) =>
            setBridgeEvents((current) => ({
              ...current,
              [recordId]: [...(current[recordId] ?? []), event],
            }))
          }
        >
          <section
            className="world-play-layout"
            aria-label={uiText("世界游玩")}
          >
            <article
              className="story-workspace"
              aria-busy={
                pending !== null || playCallChain?.status === "running"
              }
            >
              <header className="story-heading">
                <h2>{uiText("故事")}</h2>
                {playCallChain?.status === "running" ? (
                  <span className="session-badge">{uiText("模型响应中")}</span>
                ) : playCallChain?.status === "interrupted" ? (
                  <span className="session-badge call-chain-badge">
                    {uiText("调用链已中断")}
                  </span>
                ) : null}
              </header>

              <div
                className="story-transcript"
                aria-label={uiText("调用链记录")}
              >
                <ArtifactExtensionMount mount="story" />
                {playCallChain !== null ? (
                  <>
                    {committedStoryBeforeDisplayedContexts.length ===
                    0 ? null : (
                      <Transcript
                        messages={committedStoryBeforeDisplayedContexts.map(
                          (message) => ({ ...message, pending: false }),
                        )}
                        restartDisabled={pending !== null}
                        onRestartFrom={(head) => void deriveWorld(head)}
                      />
                    )}
                    {displayedPlayContexts.map((context, index) => (
                      <Fragment key={`${context.chainId}:${index}`}>
                        <div
                          className="story-context-boundary"
                          role="separator"
                          aria-label={uiText("全新上下文从这里开始")}
                        >
                          <span>{uiText("全新上下文从这里开始")}</span>
                        </div>
                        <CallChain
                          chain={context}
                          current={index === displayedPlayContexts.length - 1}
                          restartDisabled={pending !== null}
                          onRestartFrom={(head) => void deriveWorld(head)}
                          onEditPlayer={(eventId, editedText) =>
                            void reviseEditedPlayer(
                              context.chainId,
                              eventId,
                              editedText,
                            )
                          }
                        />
                      </Fragment>
                    ))}
                  </>
                ) : committedMessages.length === 0 ? (
                  <div className="story-empty-state">
                    <span aria-hidden="true">✦</span>
                    <h3>{uiText("故事还没有开始")}</h3>
                    <p>{uiText("描述你的行动，从当前世界开始一条调用链。")}</p>
                  </div>
                ) : (
                  <Transcript
                    messages={committedMessages.map((message) => ({
                      ...message,
                      pending: false,
                    }))}
                    restartDisabled={pending !== null}
                    onRestartFrom={(head) => void deriveWorld(head)}
                  />
                )}
                <div ref={historyEndRef} />
              </div>

              <footer className="play-composer">
                {!modelConfigured && (
                  <div className="model-required-callout">
                    <p>{uiText("需要先配置模型连接才能游玩。")}</p>
                    <button type="button" onClick={onConfigureModel}>
                      {uiText("配置模型")}
                    </button>
                  </div>
                )}

                <ArtifactExtensionMount mount="composer_above" />
                {!playCallChain?.canRetry ? null : (
                  <div className="play-retry-note" role="alert">
                    <span aria-hidden="true">!</span>
                    <p>
                      {uiText(
                        "上次模型请求没有完整返回。保持输入框为空并点击“追加上下文”，就会原样发送已保存的请求；不会追加玩家指令，中断片段也不会进入模型上下文。",
                      )}
                    </p>
                  </div>
                )}
                <label className="composer-field">
                  <span className="visually-hidden">{uiText("你的行动")}</span>
                  <textarea
                    aria-label={uiText("你的行动")}
                    rows={2}
                    placeholder={uiText(
                      "描述你的行动；也可以留空并追加，让 AI 沿现有上下文续写…",
                    )}
                    value={playerText}
                    disabled={
                      pending !== null ||
                      !modelConfigured ||
                      playCallChain?.status === "running"
                    }
                    onChange={(event) => setPlayerText(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        (event.ctrlKey || event.metaKey) &&
                        event.key === "Enter"
                      ) {
                        event.preventDefault();
                        submitCurrentMode();
                      }
                    }}
                  />
                </label>
                <ArtifactExtensionMount mount="composer_below" />
                <div className="composer-actions">
                  <p>
                    {uiText("Ctrl / ⌘ + Enter 追加；没有上下文时自动全新开始")}
                  </p>
                  <div className="button-row">
                    <button
                      type="button"
                      disabled={!canStartFresh || !modelConfigured}
                      onClick={() => void submitPlayChain("fresh")}
                    >
                      {pending === "play-fresh"
                        ? uiText("正在开始…")
                        : uiText("全新上下文")}
                    </button>
                    <button
                      type="button"
                      disabled={!canAppend || !modelConfigured}
                      onClick={() => void submitPlayChain("append")}
                    >
                      {pending === "play-append"
                        ? uiText("正在追加…")
                        : uiText("追加上下文")}
                    </button>
                  </div>
                </div>
              </footer>
            </article>

            <aside className="player-view-rail" aria-label={uiText("玩家视图")}>
              <h2 className="visually-hidden">{uiText("当前情景")}</h2>
              <ArtifactExtensionMount mount="sidebar" />
              {playerViewFallback.views.length === 0 ? (
                playerViewFallback.coveredViewIds.size > 0 ? null : (
                  <div className="player-view-empty">
                    <p>{uiText("这个世界还没有配置常驻玩家视图。")}</p>
                    <small>
                      {uiText("你仍然可以正常游玩；未显示不代表秘密。")}
                    </small>
                  </div>
                )
              ) : (
                playerViewFallback.views.map((view) => (
                  <PlayerViewCard key={view.id} view={view} />
                ))
              )}
              {playerViewFallback.diagnostics.length === 0 ? null : (
                <details className="player-view-diagnostics">
                  <summary>
                    {playerViewFallback.diagnostics.length}{" "}
                    {uiText("项视图诊断")}
                  </summary>
                  <ul>
                    {playerViewFallback.diagnostics.map((diagnostic, index) => (
                      <li key={`${diagnostic.code}-${index}`}>
                        {diagnostic.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </aside>
            <ArtifactExtensionMount mount="overlay" />
            <ArtifactExtensionMount mount="debug" />
            <ArtifactDebugger
              records={world.artifactDebug ?? []}
              extensions={world.extensions ?? []}
              playerViewPanels={world.playerViewPanels ?? []}
              bridgeEvents={bridgeEvents}
            />
          </section>
        </ArtifactExtensionHost>
      )}

      {section === "documents" && (
        <section className="world-browser" aria-labelledby="documents-heading">
          <aside className="world-browser-index">
            <div>
              <p className="eyebrow">CURRENT STATE</p>
              <h2 id="documents-heading">{uiText("当前文档")}</h2>
              <p>
                {documents.length} {uiText("份世界状态文件")}
              </p>
            </div>
            <ul>
              {documentOptions.map((document) => (
                <li key={document.path}>
                  <button
                    type="button"
                    className={
                      currentDocument?.path === document.path
                        ? "is-selected"
                        : "secondary-button"
                    }
                    onClick={() => setSelectedDocument(document.path)}
                  >
                    <strong>{document.title}</strong>
                    <span>{document.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
          <article className="world-document-reader">
            {currentDocument === undefined ? (
              <p>{uiText("当前世界没有状态文档。")}</p>
            ) : (
              <>
                <header>
                  <div>
                    <p className="eyebrow">WORLD DOCUMENT</p>
                    <h2>{documentOption(currentDocument).title}</h2>
                  </div>
                  <code>{currentDocument.path}</code>
                </header>
                <pre>{currentDocument.contents}</pre>
              </>
            )}
          </article>
        </section>
      )}

      {section === "history" && (
        <section
          className="world-history-page"
          aria-labelledby="history-heading"
        >
          <header>
            <div>
              <p className="eyebrow">COMMITTED NARRATIVE</p>
              <h2 id="history-heading">{uiText("已提交叙事")}</h2>
            </div>
            <p>{uiText("这里只显示已经进入世界权威的玩家与主持原文。")}</p>
          </header>
          {committedMessages.length === 0 ? (
            <div className="history-empty-state">
              {uiText("尚无已提交叙事。")}
            </div>
          ) : (
            <Transcript
              messages={committedMessages.map((message) => ({
                ...message,
                pending: false,
              }))}
              restartDisabled={pending !== null}
              onRestartFrom={(head) => void deriveWorld(head)}
            />
          )}
        </section>
      )}

      {section === "manage" && (
        <section className="world-manage-page" aria-labelledby="manage-heading">
          <header className="world-manage-heading">
            <div>
              <p className="eyebrow">WORLD MANAGEMENT</p>
              <h2 id="manage-heading">{uiText("世界管理")}</h2>
            </div>
            <p>
              {uiText("这些操作位于故事之外；它们不会被普通游玩 AI 擅自执行。")}
            </p>
          </header>

          <div className="world-manage-grid">
            <article className="manage-card world-name-card">
              <span className="manage-card-number">01</span>
              <div className="manage-card-copy">
                <h3>{uiText("世界名称")}</h3>
                <p>
                  {uiText(
                    "这是工作区和世界页显示的名字；修改它不会改动故事、状态或历史。",
                  )}
                </p>
              </div>
              <form
                className="world-name-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  void renameCurrentWorld();
                }}
              >
                <label>
                  {uiText("世界显示名称")}
                  <input
                    aria-label={uiText("世界显示名称")}
                    maxLength={160}
                    value={worldNameDraft}
                    onChange={(event) =>
                      setWorldNameDraft(event.currentTarget.value)
                    }
                  />
                </label>
                <button
                  type="submit"
                  disabled={
                    pending !== null ||
                    worldNameDraft.trim() === "" ||
                    worldNameDraft.trim() === worldTitle
                  }
                >
                  {pending === "rename"
                    ? uiText("正在保存…")
                    : uiText("保存名称")}
                </button>
              </form>
            </article>

            <article className="manage-card derive-card">
              <span className="manage-card-number">02</span>
              <div>
                <h3>{uiText("从此刻创建分叉")}</h3>
                <p>
                  {uiText(
                    "复制当前状态和截至此刻的已提交叙事，得到一个完全独立的新世界。",
                  )}
                </p>
              </div>
              <button
                type="button"
                disabled={
                  pending !== null || playCallChain?.status === "running"
                }
                onClick={() => void deriveWorld(world.head)}
              >
                {pending === "derive"
                  ? uiText("正在创建…")
                  : uiText("创建分叉")}
              </button>
            </article>

            <article className="manage-card control-card">
              <span className="manage-card-number">03</span>
              <div className="manage-card-copy">
                <h3>{uiText("世界控制")}</h3>
                <p>
                  {uiText(
                    "编辑主持框架和玩家视图。草稿必须先通过真实提示词预览，再整批应用。",
                  )}
                </p>
              </div>
              <span className="control-draft-state">
                {controlDirty
                  ? uiText("有尚未预览的修改")
                  : uiText("当前已应用控制")}
              </span>
              {playCallChain?.status !== "running" ? null : (
                <p className="manage-warning">
                  {uiText("模型调用尚未返回；完成或中断后才能应用新控制。")}
                </p>
              )}
              <label>
                {uiText("世界控制文件（JSON）")}
                <textarea
                  aria-label={uiText("世界控制文件")}
                  rows={18}
                  value={controlFiles}
                  onChange={(event) => {
                    setControlFiles(event.target.value);
                    setControlDirty(true);
                    setControlPreview(null);
                  }}
                />
              </label>
              <div className="button-row">
                <button
                  type="button"
                  disabled={pending !== null || !modelConfigured}
                  onClick={() => void previewControl()}
                >
                  {pending === "control-preview"
                    ? uiText("正在预览…")
                    : uiText("预览世界控制")}
                </button>
                <button
                  type="button"
                  disabled={
                    pending !== null ||
                    controlPreview === null ||
                    playCallChain?.status === "running"
                  }
                  onClick={() => void applyControl()}
                >
                  {pending === "control-apply"
                    ? uiText("正在应用…")
                    : uiText("整批应用世界控制")}
                </button>
              </div>
              {controlPreview === null ? null : (
                <details className="technical-details">
                  <summary>{uiText("查看真实提示词预览结果")}</summary>
                  <pre>{JSON.stringify(controlPreview, null, 2)}</pre>
                </details>
              )}
            </article>

            <article className="manage-card correction-card">
              <span className="manage-card-number">04</span>
              <div className="manage-card-copy">
                <h3>{uiText("连续性修正")}</h3>
                <p>
                  {uiText(
                    "在故事之外修正当前文档。修正会追加一笔新提交，不会改写旧叙事。",
                  )}
                </p>
              </div>
              {correctionPreview === null ? (
                <>
                  <div className="correction-fields">
                    <label>
                      {uiText("要修正的文档")}
                      <select
                        aria-label={uiText("要修正的文档")}
                        value={correctionDocument}
                        onChange={(event) =>
                          setCorrectionDocument(event.target.value)
                        }
                      >
                        {correctableDocuments.map((document) => (
                          <option key={document.handle} value={document.handle}>
                            {document.title}（@{document.ref}）
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {uiText("YAML 路径")}
                      <input
                        aria-label={uiText("YAML 路径")}
                        placeholder={uiText("例如：衣着 或 关系.秦龙.好感")}
                        value={correctionPath}
                        onChange={(event) =>
                          setCorrectionPath(event.target.value)
                        }
                      />
                    </label>
                    <label>
                      {uiText("新值")}
                      <textarea
                        aria-label={uiText("修正后的新值")}
                        rows={3}
                        value={correctionValue}
                        onChange={(event) =>
                          setCorrectionValue(event.target.value)
                        }
                      />
                    </label>
                  </div>
                  <div className="button-row">
                    <button
                      type="button"
                      disabled={
                        pending !== null ||
                        !modelConfigured ||
                        playCallChain?.status === "running" ||
                        correctableDocuments.length === 0 ||
                        correctionDocument.length === 0 ||
                        correctionPath.trim().length === 0
                      }
                      onClick={() => void previewCorrection()}
                    >
                      {pending === "correction-preview"
                        ? uiText("正在预览…")
                        : uiText("预览整笔修正")}
                    </button>
                    {correction === null ? null : (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={pending !== null}
                        onClick={() => void cancelCorrection()}
                      >
                        {uiText("取消修正草稿")}
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <FileNativeCorrectionPanel
                  preview={correctionPreview}
                  pending={pending !== null}
                  onApply={() => void applyCorrection()}
                  onCancel={() => void cancelCorrection()}
                />
              )}
            </article>

            <article className="manage-card runtime-card">
              <span className="manage-card-number">05</span>
              <div className="manage-card-copy">
                <h3>{uiText("运行详情")}</h3>
                <p>{uiText("用于排查本地恢复问题，不参与普通游玩。")}</p>
              </div>
              <dl className="runtime-summary">
                <div>
                  <dt>{uiText("当前端点")}</dt>
                  <dd>{world.head}</dd>
                </div>
                <div>
                  <dt>{uiText("世界 ID")}</dt>
                  <dd>{world.worldId}</dd>
                </div>
              </dl>
              <details className="technical-details">
                <summary>{uiText("查看 Runtime 原始诊断")}</summary>
                <pre>{JSON.stringify(world.runtime, null, 2)}</pre>
              </details>
            </article>
          </div>
        </section>
      )}
    </main>
  );
}

function Transcript({
  messages,
  restartDisabled = false,
  onRestartFrom,
}: {
  messages: readonly (WorldMessage & { pending: boolean })[];
  restartDisabled?: boolean;
  onRestartFrom?: (head: string) => void;
}): React.JSX.Element {
  return (
    <ol className="narrative-list">
      {messages.map((message, index) => (
        <li
          key={`${index}-${message.role}`}
          className={`${message.role}-message ${message.pending ? "pending-message" : ""}`}
        >
          <article>
            <header>
              <strong>
                {message.role === "player" ? uiText("你") : uiText("主持")}
              </strong>
              {message.pending ? <span>{uiText("未结算")}</span> : null}
              {message.head === undefined ||
              onRestartFrom === undefined ? null : (
                <button
                  type="button"
                  className="history-restart-button"
                  disabled={restartDisabled}
                  onClick={() => onRestartFrom(message.head!)}
                >
                  {uiText("创建分叉")}
                </button>
              )}
            </header>
            <p>{message.exactText}</p>
          </article>
        </li>
      ))}
    </ol>
  );
}

function messagesBeforeContext(
  messages: readonly WorldMessage[],
  chain: V1PlayCallChainContextView,
): readonly WorldMessage[] {
  if (chain.baselineHistoryLength !== undefined)
    return messages.slice(0, chain.baselineHistoryLength);
  const firstPlayer = chain.events.find(
    (event): event is Extract<V1PlayCallChainEvent, { kind: "player" }> =>
      event.kind === "player",
  );
  if (firstPlayer?.committedHead === undefined) return messages;
  const firstCurrentMessage = messages.findIndex(
    ({ head }) => head === firstPlayer.committedHead,
  );
  return firstCurrentMessage < 0
    ? messages
    : messages.slice(0, firstCurrentMessage);
}

function CallChain({
  chain,
  current,
  restartDisabled,
  onRestartFrom,
  onEditPlayer,
}: {
  chain: V1PlayCallChainContextView;
  current: boolean;
  restartDisabled: boolean;
  onRestartFrom: (head: string) => void;
  onEditPlayer: (eventId: number, editedText: string) => void;
}): React.JSX.Element {
  return (
    <section className="play-call-chain" aria-label={uiText("模型调用链")}>
      <header className="play-call-chain-heading">
        <span>
          {chain.playPreset.name} ·{" "}
          {callChainStatusLabel(chain.status, current)}
        </span>
      </header>

      <ol className="call-chain-events">
        {chain.events.map((event) => (
          <CallChainEvent
            key={
              event.kind === "player"
                ? `${event.id}:${event.exchangeId}`
                : event.id
            }
            event={event}
            restartDisabled={restartDisabled}
            onRestartFrom={onRestartFrom}
            onEditPlayer={onEditPlayer}
          />
        ))}
      </ol>

      <footer className="call-chain-summary">
        <strong>{uiText("本上下文已提交的世界变化")}</strong>
        {chain.changedDocuments.length === 0 ? (
          <span>{uiText("没有文档变化")}</span>
        ) : (
          <ul>
            {chain.changedDocuments.map((change) => (
              <li key={`${change.kind}:${change.path}`}>
                {change.kind === "create" ? uiText("新建") : uiText("更新")}{" "}
                {change.ref} · {change.path}
              </li>
            ))}
          </ul>
        )}
      </footer>
    </section>
  );
}

function CallChainEvent({
  event,
  restartDisabled,
  onRestartFrom,
  onEditPlayer,
}: {
  event: V1PlayCallChainEvent;
  restartDisabled: boolean;
  onRestartFrom: (head: string) => void;
  onEditPlayer: (eventId: number, editedText: string) => void;
}): React.JSX.Element | null {
  const [editedText, setEditedText] = useState<string | null>(null);
  if (event.kind === "player")
    return (
      <li className="call-chain-player">
        <article>
          <header>
            <strong>{uiText("玩家")}</strong>
            <span>
              {event.context === "fresh"
                ? uiText("全新上下文")
                : uiText("追加上下文")}
            </span>
            {event.committedHead === undefined ? null : (
              <span className="history-message-actions">
                {event.committedHead === "genesis" ? null : (
                  <button
                    type="button"
                    className="history-restart-button"
                    disabled={restartDisabled}
                    onClick={() => setEditedText(event.text)}
                  >
                    {uiText("修改")}
                  </button>
                )}
                <button
                  type="button"
                  className="history-restart-button"
                  disabled={restartDisabled}
                  onClick={() => onRestartFrom(event.committedHead!)}
                >
                  {uiText("创建分叉")}
                </button>
              </span>
            )}
          </header>
          {editedText === null ? (
            <p>{event.text}</p>
          ) : (
            <div className="history-player-edit">
              <label>
                <span>{uiText("修改后的行动")}</span>
                <textarea
                  aria-label={uiText("修改后的行动")}
                  rows={3}
                  value={editedText}
                  disabled={restartDisabled}
                  onChange={(change) => setEditedText(change.target.value)}
                />
              </label>
              <p>
                {uiText(
                  "修改会直接保存在当前世界；这条原提交及其后的内容会离开当前时间线，但旧 Authority 记录仍可恢复。",
                )}
              </p>
              <div className="button-row">
                <button
                  type="button"
                  disabled={restartDisabled || editedText.trim().length === 0}
                  onClick={() => onEditPlayer(event.id, editedText)}
                >
                  {uiText("保存修改并继续")}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={restartDisabled}
                  onClick={() => setEditedText(null)}
                >
                  {uiText("取消")}
                </button>
              </div>
            </div>
          )}
        </article>
      </li>
    );
  if (event.kind === "assistant")
    return (
      <li className={`call-chain-assistant is-${event.status}`}>
        <article>
          <header>
            <strong>{uiText("AI 响应")}</strong>
            <span>
              {uiText("{status} · 第 {attempt} 次派发", {
                status: callChainAssistantStatusLabel(event.status),
                attempt: event.attempt,
              })}
            </span>
            {event.committedHead === undefined ? null : (
              <button
                type="button"
                className="history-restart-button"
                disabled={restartDisabled}
                onClick={() => onRestartFrom(event.committedHead!)}
              >
                {uiText("创建分叉")}
              </button>
            )}
          </header>
          {event.reasoning === undefined ||
          event.reasoning.length === 0 ? null : (
            <details className="call-chain-reasoning">
              <summary>
                <strong>{uiText("模型思维链")}</strong>
                <span>{uiText("默认折叠")}</span>
              </summary>
              <pre>{event.reasoning}</pre>
            </details>
          )}
          <p>
            {event.text.length > 0
              ? event.text
              : event.status === "streaming"
                ? uiText("正在接收模型输出…")
                : uiText("（本次响应没有文本）")}
          </p>
          {event.toolFragment === undefined ? null : (
            <details>
              <summary>{uiText("正在接收的工具调用片段")}</summary>
              <pre>{event.toolFragment}</pre>
            </details>
          )}
          {event.usage === undefined ? null : (
            <small>
              {uiText("Provider usage：输入")}
              {event.usage.inputTokens ?? "unavailable"} {uiText("· 输出")}
              {event.usage.outputTokens ?? "unavailable"}
            </small>
          )}
        </article>
      </li>
    );
  if (event.kind === "tool_call")
    return (
      <li className="call-chain-tool">
        <details>
          <summary>
            <strong>{uiText("调用 {tool}", { tool: event.name })}</strong>
            <span>
              {event.replayed ? uiText("复用同 ID 结果") : event.callId}
            </span>
          </summary>
          <pre>{safeJson(event.arguments)}</pre>
        </details>
      </li>
    );
  if (event.kind === "tool_result")
    return (
      <li
        className={`call-chain-tool-result ${event.ok ? "is-ok" : "is-error"}`}
      >
        <details>
          <summary>
            <strong>
              {event.name} {uiText("返回")}
            </strong>
            <span>{event.ok ? uiText("成功") : uiText("拒绝／失败")}</span>
          </summary>
          <pre>{event.markdown}</pre>
        </details>
      </li>
    );
  if (event.kind === "followup")
    return (
      <li
        className={`call-chain-followup ${
          event.failure === undefined ? "is-ok" : "is-error"
        }`}
      >
        <details>
          <summary>
            <strong>
              {uiText("后置请求 ·")}
              {event.displayName}
            </strong>
            <span>
              {event.failure === undefined
                ? uiText("{count} 项产物", {
                    count: event.toolCalls.filter(({ ok }) => ok).length,
                  })
                : uiText("未完成")}
            </span>
          </summary>
          {/* Follow-ups stay outside the main chain and only explain panel provenance. */}
          {event.failure !== undefined && <p role="alert">{event.failure}</p>}
          {event.text.trim() !== "" && <pre>{event.text}</pre>}
          {event.toolCalls.map((call) => (
            <div key={call.callId}>
              <strong>
                {call.name} · {call.ok ? uiText("成功") : uiText("拒绝／失败")}
              </strong>
              <pre>{safeJson(call.arguments)}</pre>
              <pre>{call.markdown}</pre>
            </div>
          ))}
          {event.usage !== undefined && (
            <small>
              {uiText("Provider usage：输入")}
              {event.usage.inputTokens ?? "unavailable"} {uiText("· 输出")}
              {event.usage.outputTokens ?? "unavailable"}
            </small>
          )}
        </details>
      </li>
    );
  return (
    <li className="call-chain-failure" role="alert">
      <strong>{uiText("调用链中断")}</strong>
      <p>{event.message}</p>
    </li>
  );
}

function callChainStatusLabel(
  status: V1PlayCallChainContextView["status"],
  current: boolean,
): string {
  if (status === "running") return uiText("模型响应中");
  if (status === "interrupted") return uiText("调用链已中断");
  return current ? uiText("等待玩家追加") : uiText("上下文已结束");
}

function callChainAssistantStatusLabel(
  status: Extract<V1PlayCallChainEvent, { kind: "assistant" }>["status"],
): string {
  if (status === "streaming") return uiText("接收中");
  if (status === "interrupted") return uiText("中断片段");
  return uiText("已完成");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return uiText("[参数无法序列化]");
  }
}

function PlayerViewCard({
  view,
}: {
  view: RenderedPlayerView;
}): React.JSX.Element {
  return (
    <article className="player-view-card">
      <h3>{view.title}</h3>
      {view.items.length === 0 ? (
        <p className="player-view-empty-value">
          {uiText("当前没有可显示项目。")}
        </p>
      ) : (
        <dl>
          {view.items.map((item) => (
            <div key={item.id}>
              <dt>{item.label}</dt>
              <dd>
                <PlayerValue value={item.value} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

function PlayerValue({ value }: { value: unknown }): React.JSX.Element {
  if (value === null || value === undefined)
    return <span className="empty-value">—</span>;
  if (typeof value === "string")
    return <span className="text-value">{value}</span>;
  if (typeof value === "number" || typeof value === "boolean")
    return <span>{String(value)}</span>;
  if (Array.isArray(value)) {
    const entries = value as unknown[];
    return (
      <ul className="player-value-list">
        {entries.map((entry, index) => (
          <li key={index}>
            <PlayerValue value={entry} />
          </li>
        ))}
      </ul>
    );
  }
  if (isRecord(value)) {
    if (typeof value.$ref === "string")
      return (
        <span className="document-reference">
          {typeof value.title === "string" ? value.title : value.$ref}
          {typeof value.ref === "string" ? ` · @${value.ref}` : ""}
        </span>
      );
    return (
      <dl className="player-value-map">
        {Object.entries(value).map(([key, child]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>
              <PlayerValue value={child} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  if (typeof value === "bigint") return <span>{value.toString()}</span>;
  if (typeof value === "symbol")
    return <span>{value.description ?? "Symbol"}</span>;
  return <span className="empty-value">{uiText("[无法显示]")}</span>;
}

function documentOption(file: ContentTreeFile): DocumentOption {
  const titleMatch = /^\s{0,4}title:\s*["']?(.+?)["']?\s*$/mu.exec(
    file.contents,
  );
  const title =
    titleMatch?.[1] ??
    file.path
      .split("/")
      .at(-1)
      ?.replace(/\.(?:ya?ml|md)$/iu, "") ??
    file.path;
  const refMatch = /^\s{0,4}ref:\s*["']?(.+?)["']?\s*$/mu.exec(file.contents);
  const ref = refMatch?.[1] ?? file.path;
  return { path: file.path, title, ref, handle: `@${ref}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : uiText("操作失败");
}

function requestRuntime<T>(
  client: WorldPageClient,
  request: V1Request,
): Promise<T> {
  return client.request(request) as Promise<T>;
}

function requestPlayCallChain(
  client: WorldPageClient,
  request: Extract<
    V1Request,
    { type: "play.chain.start" | "play.chain.append" }
  >,
  onFrame: (frame: V1PlayCallChainStreamFrame) => void,
): Promise<V1PlayCallChainView> {
  return client.streamPlayCallChain === undefined
    ? requestRuntime<V1PlayCallChainView>(client, request)
    : client.streamPlayCallChain(request, onFrame);
}

function applyPlayCallChainFrame(
  frame: V1PlayCallChainStreamFrame,
  setChain: Dispatch<SetStateAction<V1PlayCallChainView | null>>,
): void {
  if (frame.kind === "snapshot") {
    setChain(frame.value);
    return;
  }
  if (frame.kind !== "assistant_delta") return;
  setChain((current) => {
    if (current === null) return current;
    return {
      ...current,
      updatedAt: frame.updatedAt,
      events: current.events.map((event) => {
        if (event.kind !== "assistant" || event.id !== frame.eventId)
          return event;
        if (frame.deltaKind === "text")
          return { ...event, text: event.text + frame.text };
        if (frame.deltaKind === "reasoning")
          return {
            ...event,
            reasoning: `${event.reasoning ?? ""}${frame.text}`,
          };
        return {
          ...event,
          toolFragment: `${event.toolFragment ?? ""}${frame.text}`,
        };
      }),
    };
  });
}

async function requestArtifactDebug(
  client: WorldPageClient,
  worldId: string,
): Promise<FrontendArtifactDebugRecord[]> {
  try {
    const result = await client.request({
      type: "artifacts.debug",
      worldId,
    });
    return Array.isArray(result)
      ? (result as FrontendArtifactDebugRecord[])
      : [];
  } catch {
    return [];
  }
}
