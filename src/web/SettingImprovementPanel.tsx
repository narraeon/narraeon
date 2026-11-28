import {
  idleWorkspaceNavigation,
  type WorkspaceNavigationProtection,
} from "./WorkspaceLocation.ts";
import { ModelCallAttempts } from "./ModelCallAttempts.tsx";
import { groupCallAttempts } from "./GroupModelCallAttempts.ts";
import {
  ModelRetryLimitNotice,
  ModelRetryStatus,
} from "./ModelRetryStatus.tsx";
import type { PlayRequestContext } from "../protocol/playRequestContext.ts";
import { RequestContextDetails } from "./PlayRequestContextDetails.tsx";
import {
  ModelCallDetails,
  ModelCallDetailsGroup,
  ModelCallReasoning,
  ModelCallTools,
} from "./ModelCallDetails.tsx";
import {
  confirmsAuthoringRequest,
  type AuthoringConversationView,
} from "./AuthoringTarget.ts";
import { AuthoringPromptPreview } from "./AuthoringPromptPreview.tsx";
import { createClientId } from "./ClientId.ts";
import { ModelRecoveryActions } from "./ModelRecoveryActions.tsx";
import type { PromptRoleOrderTarget } from "../protocol/promptRoleOrder.ts";
import {
  promptRoleOrderRule,
  type ModelSendRecovery,
} from "./ModelSendRecovery.ts";
import { useConversationComposer } from "./useConversationComposer.ts";
import { useAutosizeTextarea } from "./useAutosizeTextarea.ts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { Gameplay, ResolutionScheme } from "../protocol/gameplay.ts";
import type {
  ContentTreeFile,
  V1SettingConversationExchange,
  V1AuthoringRequestPreview,
  V1SettingConversationTurn,
  V1SettingAuthoringDiff,
  V1SettingImprovementHistoryItem,
  V1SettingImprovementRollbackResult,
  V1SettingImprovementView,
  V1SettingPromptPreview,
  V1WorldRevisionChangeSet,
  V1WorldRevisionEpochView,
  V1WorldRevisionSealedEpochView,
} from "../protocol/v1.ts";
import {
  ContentFileDraftActions,
  type ContentTreeEditorProps,
} from "./ContentTreeEditor.tsx";
import { ModelUsageBreakdown } from "./ModelUsageBreakdown.tsx";
import { PackageGameplaySection } from "./PackageGameplaySection.tsx";
import { useAndroidBack } from "./androidBridge.ts";
import {
  ConfirmationDialog,
  type ConfirmationRequest,
} from "./ConfirmationDialog.tsx";
import { getWebLocale, uiText } from "./i18n.ts";
import { UnifiedTextDiff } from "./UnifiedTextDiff.tsx";
import { SyncNotice } from "./SyncNotice.tsx";
import { AuthoringFileRail } from "./AuthoringFileRail.tsx";

export type SettingImprovementView = AuthoringConversationView;

type RevisionDiscardTarget = Pick<
  V1WorldRevisionEpochView,
  "epochId" | "revision"
>;
type AuthoringConfirmation =
  | { kind: "delete-session"; item: V1SettingImprovementHistoryItem }
  | { kind: "leave-revision" }
  | { kind: "delete-package"; title: string }
  | {
      kind: "discard-revision";
      epoch: RevisionDiscardTarget;
      worldName: string;
    };

interface SettingImprovementPanelProps {
  target?: "content-package" | "world-revision";
  packageName: string;
  modelConfigured: boolean;
  hasUnsavedFileDraft: boolean;
  loading: boolean;
  conversation: {
    view: SettingImprovementView | null;
    history: V1SettingImprovementHistoryItem[];
    latestSessionId: string | null;
    requestFailure: string | null;
    requestRecovery?: ModelSendRecovery | null;
    syncFailed?: boolean;
    syncError?: unknown;
    now: number;
  };
  notice: string;
  contentEditor: Omit<ContentTreeEditorProps, "onDelete"> & {
    onDelete: () => void;
  };
  savedFiles?: readonly ContentTreeFile[];
  conversationActions: {
    onRead?: () => void;
    onPreview?: () => Promise<V1SettingPromptPreview["compilation"] | null>;
    onCallContext?: (
      sessionId: string,
      callId: string,
    ) => Promise<PlayRequestContext>;
    onRequestPreview?: (
      sessionId: string,
      requestId: string,
    ) => Promise<V1AuthoringRequestPreview | null>;
    onSend: (message: string, requestId: string) => Promise<void>;
    onEditMessage?: (
      messageId: string,
      message: string,
      filePolicy: "keep" | "revert",
      requestId: string,
    ) => Promise<void>;
    onCancel: () => Promise<void>;
    onResume: (recovery?: "continue_partial") => Promise<void>;
    onFreshContext: () => void;
    onSelectSession: (sessionId: string) => Promise<void>;
    onDeleteSession: (sessionId: string) => Promise<void>;
    onRollbackFile: (
      sessionId: string,
      changeSetId: string,
      path: string,
    ) => Promise<V1SettingImprovementRollbackResult>;
  };
  onConfigureModel: () => void;
  onViewPromptOrder?: ((target?: PromptRoleOrderTarget) => void) | undefined;
  onBack: () => void;
  showWorkspaceBack?: boolean;
  backLabel?: string;
  onCreateWorld?: () => void;
  titleSuggestion?: {
    packageId: string;
    onSave: (title: string, expectedTitle: string) => Promise<boolean>;
  };
  onNavigationProtectionChange?: (
    protection: WorkspaceNavigationProtection,
  ) => void;
  packageGameplay?: {
    gameplay: Gameplay;
    onChangeScheme: (scheme: ResolutionScheme) => Promise<void>;
  };
  /** A saved-tree change is in flight, so no file draft may start. */
  draftsLocked?: boolean;
  revisionActions?: {
    discardTarget: RevisionDiscardTarget | null;
    applyLabel?: string;
    changedFileCount: number;
    canApply: boolean;
    applying: boolean;
    changes: V1WorldRevisionChangeSet[];
    sealedEpochs: V1WorldRevisionSealedEpochView[];
    onApply: () => Promise<void>;
    onDiscard: (epoch: RevisionDiscardTarget) => Promise<void>;
  };
}

type FileRailMode = "preview" | "edit";

interface TitleOffer {
  key: string;
  baseTitle: string;
  handled: boolean;
}

function readTitleOffer(key: string): TitleOffer | null {
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return null;
    const value: unknown = JSON.parse(stored);
    if (
      typeof value === "object" &&
      value !== null &&
      "baseTitle" in value &&
      typeof value.baseTitle === "string" &&
      "handled" in value &&
      typeof value.handled === "boolean"
    )
      return { key, baseTitle: value.baseTitle, handled: value.handled };
  } catch {
    // A missing or unavailable browser preference leaves the offer visible.
  }
  return null;
}

function rememberTitleOffer({ key, baseTitle, handled }: TitleOffer): void {
  try {
    window.localStorage.setItem(key, JSON.stringify({ baseTitle, handled }));
  } catch {
    // The mounted panel still remembers the decision without browser storage.
  }
}

export function SettingImprovementPanel({
  target = "content-package",
  packageName,
  modelConfigured,
  hasUnsavedFileDraft,
  loading: loadingTarget,
  conversation: {
    view,
    history,
    latestSessionId,
    requestFailure,
    requestRecovery,
    syncFailed = false,
    syncError,
    now,
  },
  notice,
  contentEditor,
  savedFiles = contentEditor.files,
  conversationActions: {
    onRead,
    onSend,
    onEditMessage,
    onPreview,
    onCallContext,
    onRequestPreview,
    onCancel,
    onResume,
    onFreshContext,
    onSelectSession,
    onDeleteSession,
    onRollbackFile,
  },
  onConfigureModel,
  onViewPromptOrder,
  onBack,
  showWorkspaceBack = true,
  backLabel,
  onCreateWorld,
  titleSuggestion,
  onNavigationProtectionChange,
  packageGameplay,
  draftsLocked = false,
  revisionActions,
}: SettingImprovementPanelProps): React.JSX.Element {
  const [message, setMessage] = useState("");
  const { ref: attachMessageTextarea, textareaRef: messageTextareaRef } =
    useAutosizeTextarea(message);
  const [editing, setEditing] = useState<{
    sessionId: string;
    messageId: string;
    original: string;
    draft: string;
    requestId: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [titleEdit, setTitleEdit] = useState<{
    suggestion: string;
    draft: string;
    failed: boolean;
  } | null>(null);
  const [titleOffer, setTitleOffer] = useState<TitleOffer | null>(null);
  useLayoutEffect(() => {
    if (titleOffer !== null) rememberTitleOffer(titleOffer);
  }, [titleOffer]);
  const [savingTitle, setSavingTitle] = useState(false);
  const savingTitleRef = useRef(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const [leftRailOpen, setLeftRailOpen] = useState(false);
  const [rightRailOpen, setRightRailOpen] = useState(false);
  const [fileRailMode, setFileRailMode] = useState<FileRailMode>("preview");
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null,
  );
  const [confirmation, setConfirmation] =
    useState<ConfirmationRequest<AuthoringConfirmation> | null>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const filesButton = useRef<HTMLButtonElement>(null);
  const railOpener = useRef<HTMLButtonElement>(null);
  const historyCloseButton = useRef<HTMLButtonElement>(null);
  const filesCloseButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (leftRailOpen)
      historyCloseButton.current?.focus({ preventScroll: true });
    if (rightRailOpen) filesCloseButton.current?.focus({ preventScroll: true });
  }, [leftRailOpen, rightRailOpen]);
  const [rollingBackFile, setRollingBackFile] = useState<{
    changeSetId: string;
    path: string;
  } | null>(null);
  const rollingBackRef = useRef(false);
  const conversationRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (composer === null) return;
    const publish = (): void =>
      setComposerHeight(composer.getBoundingClientRect().height);
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(publish);
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);
  const loading = loadingTarget || contentEditor.saving === true;
  const fileSaveConflict = !rightRailOpen && contentEditor.conflict === true;
  const running = view?.runStatus === "running" || submitting;
  const rollbackRunning = rollingBackFile !== null;
  const finishingRevision = revisionActions?.applying === true;
  const editBusy =
    running || rollbackRunning || finishingRevision || savingTitle;
  const revisingWorld = target === "world-revision";
  const completedSetting =
    !revisingWorld &&
    view?.sessionId === latestSessionId &&
    view.runStatus === "ready" &&
    view.lastFailure === null
      ? view
      : null;
  const suggestedTitle = completedSetting?.suggestedTitle;
  const titleKey =
    suggestedTitle === undefined ||
    completedSetting === null ||
    titleSuggestion === undefined
      ? null
      : `narraeon.setting-title.v1:${JSON.stringify([
          titleSuggestion.packageId,
          completedSetting.sessionId,
          suggestedTitle,
        ])}`;
  const activeTitleOffer = titleOffer?.key === titleKey ? titleOffer : null;
  if (titleKey !== null && activeTitleOffer === null && !loading)
    setTitleOffer(
      readTitleOffer(titleKey) ?? {
        key: titleKey,
        baseTitle: packageName,
        handled: false,
      },
    );
  const activeTitleEdit = titleKey === titleEdit?.suggestion ? titleEdit : null;
  const titleDraft = activeTitleEdit?.draft ?? suggestedTitle ?? "";
  const titleChanged =
    activeTitleEdit !== null && titleDraft !== suggestedTitle;
  const savedTitleChanged =
    activeTitleOffer !== null && packageName !== activeTitleOffer.baseTitle;
  if (
    savedTitleChanged &&
    !titleChanged &&
    !savingTitle &&
    !activeTitleOffer.handled
  )
    setTitleOffer({ ...activeTitleOffer, handled: true });
  const showTitleSuggestion =
    activeTitleOffer?.handled === false &&
    (savingTitle ||
      titleChanged ||
      (!savedTitleChanged && packageName !== suggestedTitle));
  const titleDirty = showTitleSuggestion && titleChanged;
  const editSubmitDisabled =
    editBusy ||
    loading ||
    hasUnsavedFileDraft ||
    draftsLocked ||
    titleDirty ||
    !modelConfigured;
  const interactionLocked = editBusy || editing !== null;
  if (
    editing !== null &&
    (view?.sessionId !== editing.sessionId ||
      !view.turns.some((turn) => turn.user.id === editing.messageId))
  )
    setEditing(null);
  const navigationDirty =
    hasUnsavedFileDraft || titleDirty || editing?.draft !== editing?.original;
  const navigationBusy = editBusy || loading || draftsLocked;
  useLayoutEffect(() => {
    onNavigationProtectionChange?.({
      dirty: navigationDirty,
      busy: navigationBusy,
    });
    return () => onNavigationProtectionChange?.(idleWorkspaceNavigation);
  }, [onNavigationProtectionChange, navigationDirty, navigationBusy]);
  const startingFresh = view === null;
  const continuingHistory =
    view !== null &&
    view.freshContextReason === undefined &&
    latestSessionId !== null &&
    view.sessionId !== latestSessionId;
  const disabled =
    loading ||
    interactionLocked ||
    !modelConfigured ||
    hasUnsavedFileDraft ||
    titleDirty;
  const rollbackDisabled =
    loading || interactionLocked || hasUnsavedFileDraft || draftsLocked;
  const packageActionLocked =
    loading || interactionLocked || hasUnsavedFileDraft || draftsLocked;
  const createWorldDisabled =
    packageActionLocked || titleDirty || contentEditor.status !== "usable";
  const showCreationNextStep =
    onCreateWorld !== undefined &&
    completedSetting !== null &&
    contentEditor.status === "usable" &&
    (suggestedTitle !== undefined ||
      completedSetting.turns.some((turn) =>
        turn.exchanges.some((exchange) =>
          exchange.toolCalls.some(
            (tool) =>
              tool.result?.isError === false &&
              (tool.result.changes?.length ?? 0) > 0,
          ),
        ),
      ));
  const titleSaveDisabled =
    packageActionLocked ||
    savedTitleChanged ||
    titleDraft.trim() === "" ||
    titleDraft.trim() === packageName;
  const packageDeleteLocked =
    revisingWorld ||
    loading ||
    interactionLocked ||
    draftsLocked ||
    contentEditor.dirty;
  const historyLocked =
    loading ||
    rollbackRunning ||
    finishingRevision ||
    editing !== null ||
    savingTitle ||
    titleDirty ||
    (!revisingWorld && (running || hasUnsavedFileDraft));
  const discardTarget = revisionActions?.discardTarget ?? null;
  const revisionLocked = discardTarget !== null;
  const discardLocked =
    loading ||
    interactionLocked ||
    hasUnsavedFileDraft ||
    discardTarget === null;
  const activeRevisionChanges = revisionActions?.changes;
  const sealedEpochs = revisionActions?.sealedEpochs;
  const rollbackableChangeSetIds = useMemo(
    () =>
      activeRevisionChanges === undefined
        ? undefined
        : new Set(activeRevisionChanges.map(({ changeSetId }) => changeSetId)),
    [activeRevisionChanges],
  );
  const sealedChangeSetIds = useMemo(
    () =>
      new Set(
        sealedEpochs?.flatMap(({ changes }) =>
          changes.map(({ changeSetId }) => changeSetId),
        ),
      ),
    [sealedEpochs],
  );
  const filesByPath = useMemo(
    () => new Map(savedFiles.map((file) => [file.path, file])),
    [savedFiles],
  );

  function createWorldFromSetting(): void {
    if (createWorldDisabled || savingTitleRef.current) return;
    if (showTitleSuggestion) {
      focusTitleSuggestion();
      return;
    }
    onCreateWorld?.();
  }

  function focusTitleSuggestion(): void {
    setLeftRailOpen(false);
    setRightRailOpen(false);
    titleInput.current?.scrollIntoView({ block: "center" });
    titleInput.current?.focus({ preventScroll: true });
  }

  function finishTitleSuggestion(): void {
    if (activeTitleOffer === null) return;
    setTitleOffer({ ...activeTitleOffer, handled: true });
    setTitleEdit(null);
  }

  async function saveTitle(): Promise<void> {
    if (
      titleSuggestion === undefined ||
      activeTitleOffer === null ||
      titleSaveDisabled ||
      savingTitleRef.current
    )
      return;
    savingTitleRef.current = true;
    setSavingTitle(true);
    try {
      const saved = await titleSuggestion.onSave(
        titleDraft.trim(),
        activeTitleOffer.baseTitle,
      );
      if (saved) finishTitleSuggestion();
      else
        setTitleEdit({
          suggestion: activeTitleOffer.key,
          draft: titleDraft,
          failed: true,
        });
    } finally {
      savingTitleRef.current = false;
      setSavingTitle(false);
    }
  }

  const [unconfirmedDraft, setUnconfirmedDraft] = useState<{
    text: string;
    requestId: string;
    sessionId: string | null;
  } | null>(null);
  if (
    unconfirmedDraft !== null &&
    (unconfirmedDraft.sessionId === null ||
      view?.sessionId === unconfirmedDraft.sessionId) &&
    confirmsAuthoringRequest(view, unconfirmedDraft.requestId)
  ) {
    setUnconfirmedDraft(null);
    if (message === unconfirmedDraft.text) setMessage("");
  }
  function openFreshComposer(options?: { keepMessage: true }): void {
    if (titleDirty || savingTitleRef.current) return;
    if (!options?.keepMessage && unconfirmedDraft?.text === message)
      setMessage("");
    setUnconfirmedDraft(null);
    setLeftRailOpen(false);
    onFreshContext();
    messageTextareaRef.current?.focus();
  }
  const sendText = useCallback(
    async (text: string): Promise<void> => {
      if (disabled || submittingRef.current || text.trim().length === 0) return;
      submittingRef.current = true;
      setSubmitting(true);
      setMessage("");
      setRightRailOpen(false);
      const requestId =
        unconfirmedDraft?.text === text
          ? unconfirmedDraft.requestId
          : createClientId("authoring-message");
      const sessionId = view?.sessionId ?? null;
      try {
        await onSend(text, requestId);
        setUnconfirmedDraft(null);
      } catch {
        setUnconfirmedDraft({ text, requestId, sessionId });
        setMessage((current) => (current.length === 0 ? text : current));
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [disabled, onSend, unconfirmedDraft, view?.sessionId],
  );

  const resume = async (recovery?: "continue_partial"): Promise<void> => {
    if (disabled || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onResume(recovery);
    } catch {
      // The parent projects the Runtime failure into the conversation surface.
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const saveEditedMessage = async (
    filePolicy: "keep" | "revert",
  ): Promise<void> => {
    if (
      editing === null ||
      onEditMessage === undefined ||
      editBusy ||
      loading ||
      hasUnsavedFileDraft ||
      draftsLocked ||
      !modelConfigured ||
      submittingRef.current ||
      editing.draft.trim().length === 0
    )
      return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onEditMessage(
        editing.messageId,
        editing.draft,
        filePolicy,
        editing.requestId,
      );
      setEditing(null);
    } catch {
      // Keep the draft and request ID for retry after an error.
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const canSendMessage =
    !disabled &&
    view?.freshContextReason === undefined &&
    message.trim().length > 0;
  const composer = useConversationComposer(canSendMessage, () =>
    sendText(message),
  );

  const openFileRail = (
    mode: FileRailMode,
    opener: HTMLButtonElement,
  ): void => {
    if (mode === "edit" && (interactionLocked || draftsLocked)) return;
    railOpener.current = opener;
    setFileRailMode(mode);
    setRightRailOpen(true);
    setLeftRailOpen(false);
  };

  const collapseAllTraces = (): void => {
    for (const detail of conversationRef.current?.querySelectorAll(
      "details[open]",
    ) ?? [])
      detail.removeAttribute("open");
  };

  const requestSessionDeletion = (
    item: V1SettingImprovementHistoryItem,
    opener: HTMLButtonElement,
  ): void => {
    if (
      historyLocked ||
      item.runStatus === "running" ||
      deletingSessionId !== null
    )
      return;
    setConfirmation({
      action: { kind: "delete-session", item },
      opener,
      fallback: historyButton.current,
      message: uiText(
        revisingWorld
          ? "删除对话“{title}”？只会删除对话记录；修订工作树中的改动不会回滚。此操作无法撤销。"
          : "删除对话“{title}”？只会删除这份对话记录；已经写入内容包当前树的改动不会回滚。此操作无法撤销。",
        { title: item.excerpt || uiText("未命名对话") },
      ),
      confirmLabel: uiText("删除"),
    });
  };

  const deleteSession = async (sessionId: string): Promise<void> => {
    setDeletingSessionId(sessionId);
    try {
      await onDeleteSession(sessionId);
    } catch {
      // The parent projects the Runtime failure into the conversation surface.
    } finally {
      setDeletingSessionId(null);
    }
  };

  function requestRevisionDiscard(opener: HTMLButtonElement): void {
    if (discardLocked || discardTarget === null) return;
    setConfirmation({
      action: {
        kind: "discard-revision",
        epoch: discardTarget,
        worldName: packageName,
      },
      opener,
      fallback: historyButton.current,
      message: uiText(
        "放弃“{name}”的这次世界修订？所有尚未应用的手动和 AI 修改都会丢失。",
        { name: packageName },
      ),
      confirmLabel: uiText("放弃"),
    });
  }

  function requestPackageDeletion(opener: HTMLButtonElement): void {
    if (packageDeleteLocked) return;
    const { title } = contentEditor;
    setConfirmation({
      action: { kind: "delete-package", title },
      opener,
      fallback: opener.closest("details")?.querySelector("summary") ?? null,
      message: uiText(
        "删除内容包“{title}”？它会从本机移除，且无法撤销。已创建的世界不受影响。",
        { title },
      ),
      confirmLabel: uiText("删除"),
    });
  }

  function decideConfirmation(confirmed: boolean): void {
    setConfirmation(null);
    if (!confirmed || confirmation === null) return;
    const action = confirmation.action;
    if (action.kind === "leave-revision") {
      if (!navigationBusy) onBack();
    } else if (action.kind === "delete-session") {
      const item = history.find(
        ({ sessionId }) => sessionId === action.item.sessionId,
      );
      if (
        !historyLocked &&
        deletingSessionId === null &&
        item !== undefined &&
        item.runStatus !== "running" &&
        item.updatedAt === action.item.updatedAt &&
        item.excerpt === action.item.excerpt
      )
        void deleteSession(item.sessionId);
    } else if (action.kind === "delete-package") {
      if (!packageDeleteLocked && contentEditor.title === action.title)
        contentEditor.onDelete();
    } else if (
      !discardLocked &&
      packageName === action.worldName &&
      discardTarget?.epochId === action.epoch.epochId &&
      discardTarget.revision === action.epoch.revision
    ) {
      void revisionActions?.onDiscard(action.epoch);
    }
  }

  const rollbackFile = async (
    changeSetId: string,
    path: string,
  ): Promise<void> => {
    if (
      (view === null && !revisingWorld) ||
      rollbackDisabled ||
      rollingBackRef.current
    )
      return;
    rollingBackRef.current = true;
    setLeftRailOpen(false);
    setRightRailOpen(false);
    setRollingBackFile({ changeSetId, path });
    try {
      await onRollbackFile(view?.sessionId ?? "", changeSetId, path);
    } catch {
      // The parent projects the Runtime failure into the conversation surface.
    } finally {
      rollingBackRef.current = false;
      setRollingBackFile(null);
    }
  };

  function requestBack(): void {
    if (navigationBusy) return;
    if (revisingWorld && navigationDirty) {
      setConfirmation({
        action: { kind: "leave-revision" },
        opener: backButton.current,
        message: uiText("此页有未保存的修改。要放弃修改并离开吗？"),
        confirmLabel: uiText("放弃并离开"),
      });
    } else onBack();
  }

  const closeRail = useCallback((): void => {
    setLeftRailOpen(false);
    setRightRailOpen(false);
    const opener = railOpener.current;
    (opener?.disabled ? filesButton.current : opener)?.focus({
      preventScroll: true,
    });
    railOpener.current = null;
  }, []);

  const railOpen = leftRailOpen || rightRailOpen;
  // A rail action can replace the focused element and leave focus on the body.
  useEffect(() => {
    if (!railOpen || confirmation !== null) return;
    function dismissRail(event: KeyboardEvent): void {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        (event.target instanceof Element &&
          event.target.closest('dialog, [role="dialog"]'))
      )
        return;
      event.preventDefault();
      closeRail();
    }
    document.addEventListener("keydown", dismissRail);
    return () => document.removeEventListener("keydown", dismissRail);
  }, [closeRail, confirmation, railOpen]);

  // World revision is a panel within play. Content authoring has its own address.
  useAndroidBack(revisingWorld, requestBack);
  useAndroidBack(railOpen, closeRail);

  return (
    <main
      className="setting-reader-page"
      aria-labelledby="setting-improvement-title"
      style={
        {
          "--setting-composer-height": `${composerHeight}px`,
        } as React.CSSProperties
      }
    >
      <div className="setting-reader-shell">
        <header className="setting-workbench-header">
          <nav
            className="setting-workbench-nav"
            aria-label={
              revisingWorld ? uiText("世界修订导航") : uiText("设定完善导航")
            }
          >
            {(revisingWorld || showWorkspaceBack) && (
              <button
                ref={backButton}
                type="button"
                disabled={navigationBusy}
                onClick={requestBack}
                aria-label={
                  backLabel ?? uiText(revisingWorld ? "返回游玩" : "返回工作区")
                }
              >
                ←
              </button>
            )}
            <button
              ref={historyButton}
              type="button"
              className={leftRailOpen ? "is-current" : ""}
              aria-pressed={leftRailOpen}
              onClick={(event) => {
                if (leftRailOpen) closeRail();
                else {
                  railOpener.current = event.currentTarget;
                  setLeftRailOpen(true);
                  setRightRailOpen(false);
                }
              }}
            >
              {uiText("历史")}
            </button>
          </nav>

          <h1 id="setting-improvement-title" title={packageName}>
            <span>{packageName}</span>
            {" · "}
            <span>{uiText(revisingWorld ? "世界修订" : "AI 设定完善")}</span>
          </h1>

          <nav
            className="setting-workbench-tools"
            aria-label={
              revisingWorld ? uiText("世界修订工具") : uiText("设定完善工具")
            }
          >
            {!revisingWorld && onCreateWorld !== undefined && (
              <div className="setting-create-action">
                <button
                  type="button"
                  className={`setting-create-world${showCreationNextStep ? " is-ready" : ""}`}
                  disabled={createWorldDisabled}
                  aria-describedby={
                    showTitleSuggestion
                      ? "setting-create-title-note"
                      : undefined
                  }
                  onClick={createWorldFromSetting}
                >
                  {uiText("创建世界")}
                </button>
                {showTitleSuggestion && (
                  <div className="setting-title-reminder">
                    <span id="setting-create-title-note">
                      {uiText(
                        titleDirty
                          ? "创建世界前请保存书名草稿或保留当前书名。"
                          : "创建世界前请选择书名。",
                      )}
                    </span>
                    <button
                      type="button"
                      className="text-button"
                      disabled={packageActionLocked}
                      onClick={focusTitleSuggestion}
                    >
                      {uiText("处理建议书名")}
                    </button>
                  </div>
                )}
              </div>
            )}
            <button
              ref={filesButton}
              type="button"
              className={
                rightRailOpen && fileRailMode === "preview" ? "is-current" : ""
              }
              aria-expanded={rightRailOpen && fileRailMode === "preview"}
              onClick={(event) => openFileRail("preview", event.currentTarget)}
            >
              {uiText("文件")}
            </button>
            <button
              type="button"
              className={
                rightRailOpen && fileRailMode === "edit" ? "is-current" : ""
              }
              aria-expanded={rightRailOpen && fileRailMode === "edit"}
              disabled={interactionLocked || draftsLocked}
              onClick={(event) => openFileRail("edit", event.currentTarget)}
            >
              {uiText("编辑")}
            </button>
            <button type="button" onClick={collapseAllTraces}>
              {uiText("全部收起")}
            </button>
            <button
              type="button"
              disabled={interactionLocked || loading || titleDirty}
              onClick={() => {
                setUnconfirmedDraft(null);
                onFreshContext();
              }}
            >
              {uiText("全新上下文")}
            </button>
            {!revisionLocked ? null : (
              <button
                type="button"
                className="danger-button"
                disabled={discardLocked}
                onClick={(event) => requestRevisionDiscard(event.currentTarget)}
              >
                {uiText("放弃")}
              </button>
            )}
            {revisionActions === undefined || !revisionLocked ? null : (
              <button
                type="button"
                disabled={
                  interactionLocked ||
                  hasUnsavedFileDraft ||
                  !revisionActions.canApply ||
                  revisionActions.applying
                }
                className={
                  revisionActions.applyLabel === undefined
                    ? undefined
                    : "primary-button"
                }
                onClick={() => void revisionActions.onApply()}
              >
                {revisionActions.applying
                  ? uiText("正在应用…")
                  : (revisionActions.applyLabel ?? uiText("应用并解锁"))}
              </button>
            )}
          </nav>
        </header>

        <section
          ref={conversationRef}
          className="setting-reader-scroll"
          aria-label={
            revisingWorld ? uiText("世界修订对话") : uiText("设定完善对话")
          }
        >
          <article
            className="setting-story-column"
            aria-live="polite"
            aria-busy={interactionLocked}
          >
            {(view === null || view.turns.length === 0) && (
              <header className="setting-conversation-intro">
                <h2>
                  {uiText(
                    revisingWorld
                      ? "手动编辑和 AI 共用一份修订"
                      : "可以从一句故事点子开始",
                  )}
                </h2>
                {!revisingWorld && (
                  <p>
                    {uiText(
                      "成功的工具改动直接写入内容包当前树；需要核对或手动修改时，从右侧打开文件。",
                    )}
                  </p>
                )}
              </header>
            )}

            {packageGameplay === undefined ? null : (
              <PackageGameplaySection
                gameplay={packageGameplay.gameplay}
                disabled={interactionLocked || hasUnsavedFileDraft || loading}
                onChangeScheme={packageGameplay.onChangeScheme}
              />
            )}

            {notice.length === 0 ? null : (
              <p className="setting-workspace-feedback" role="status">
                {notice}
              </p>
            )}

            {!modelConfigured ? (
              <section className="setting-improvement-blocker" role="status">
                <p>
                  {uiText(
                    revisingWorld
                      ? revisionLocked &&
                        revisionActions?.applyLabel === undefined
                        ? "先配置并启用模型，才能让 AI 参与或应用世界修订；手动编辑和放弃仍然可用。"
                        : "先配置并启用模型，才能让 AI 参与修订。也可以先手动编辑。"
                      : "先配置并启用模型，才能开始设定完善对话。",
                  )}
                </p>
                <button
                  type="button"
                  disabled={hasUnsavedFileDraft}
                  onClick={onConfigureModel}
                >
                  {uiText("配置模型")}
                </button>
              </section>
            ) : null}

            {!revisingWorld && (
              <p className="setting-current-tree-notice" role="note">
                {uiText(
                  "成功的 AI 改动直接写入内容包。每轮记录保留当时的差异。",
                )}
              </p>
            )}

            {revisionActions === undefined ||
            (!revisionLocked && loading) ? null : (
              <div className="setting-history-review-banner" role="status">
                <div>
                  <strong>
                    {uiText(
                      revisionLocked ? "世界游玩已锁定" : "世界游玩未锁定",
                    )}
                  </strong>
                  <p>
                    {uiText(
                      revisionLocked
                        ? "世界已锁定到这份修订；关闭页面也会保留工作树。"
                        : "浏览不会锁定世界；首次编辑或发送消息后才会锁定。",
                    )}
                  </p>
                  {revisionLocked && (
                    <p>
                      {uiText(
                        "当前累计改动 {count} 个文件。应用会提交改动，应用或放弃都会解锁游玩。",
                        { count: revisionActions.changedFileCount },
                      )}
                    </p>
                  )}
                </div>
              </div>
            )}

            {revisionActions === undefined ||
            revisionActions.changes.length === 0 ? null : (
              <details className="setting-turn-trace" open>
                <summary>
                  <span>{uiText("修订记录")}</span>
                  <small>
                    {uiText("{count} 次修改", {
                      count: revisionActions.changes.length,
                    })}
                  </small>
                </summary>
                <div className="setting-turn-trace-exchanges">
                  {[...revisionActions.changes].reverse().map((changeSet) => (
                    <section
                      className="setting-conversation-trace"
                      key={changeSet.changeSetId}
                    >
                      <header className="section-heading-row">
                        <strong>
                          {changeSet.source === "manual"
                            ? uiText("手动编辑")
                            : changeSet.source === "ai"
                              ? uiText("AI 修改")
                              : uiText("回滚")}
                        </strong>
                        <small>{formatHistoryTime(changeSet.createdAt)}</small>
                      </header>
                      <AcceptedChanges
                        changes={changeSet.changes}
                        heading={uiText("这次修改的完整差异")}
                        rollback={{
                          changeSetId: changeSet.changeSetId,
                          filesByPath,
                          disabled: rollbackDisabled,
                          rollingBackFile,
                          onRollbackFile: rollbackFile,
                        }}
                      />
                    </section>
                  ))}
                </div>
              </details>
            )}

            {revisionActions === undefined ? null : (
              <SealedWorldRevisionHistory
                epochs={revisionActions.sealedEpochs}
              />
            )}

            {startingFresh && history.length > 0 ? (
              <div className="setting-history-review-banner" role="status">
                <div>
                  <strong>{uiText("下一条消息将开启全新上下文")}</strong>
                  <p>
                    {uiText(
                      !revisingWorld
                        ? "新对话会从内容包当前树重新编译；原有对话仍保留在历史中。"
                        : revisionLocked
                          ? "新对话会从当前修订工作树开始；原有对话仍保留在历史中。"
                          : "发送时会根据世界当前文件创建修订；原有对话仍保留在历史中。",
                    )}
                  </p>
                </div>
              </div>
            ) : continuingHistory ? (
              <div className="setting-history-review-banner" role="status">
                <div>
                  <strong>{uiText("正在继续历史对话")}</strong>
                  <p>
                    {uiText(
                      revisingWorld
                        ? "下一条消息会追加到原 Provider 上下文；若修订 epoch 已变化，Runtime 会要求 AI 重新读取。"
                        : "下一条消息会追加到这段历史的原 Provider 上下文；写入仍以此刻的内容包当前树为准。",
                    )}
                  </p>
                </div>
              </div>
            ) : null}

            <SyncNotice
              failed={syncFailed}
              onRead={() => onRead?.()}
              reason={syncError}
            />

            <AuthoringPromptPreview
              key={`${packageName}:${view?.sessionId ?? "fresh"}:${view?.messages.length ?? 0}`}
              requests={view?.requestPreviews ?? []}
              onRequestPreview={
                view === null || onRequestPreview === undefined
                  ? undefined
                  : (requestId) => onRequestPreview(view.sessionId, requestId)
              }
              {...(onPreview === undefined ? {} : { onPreview })}
            />

            <div className="setting-conversation-messages">
              {loading ? (
                <p className="setting-conversation-empty">
                  {uiText(
                    revisingWorld
                      ? "正在恢复世界修订…"
                      : "正在恢复设定完善对话…",
                  )}
                </p>
              ) : view === null || view.turns.length === 0 ? (
                <div className="setting-conversation-empty">
                  <p>{uiText("直接说你现在想做什么。")}</p>
                  <p>
                    {uiText(
                      revisingWorld
                        ? "例如：先检查人物关系是否自洽；或者把当前地点改成雨夜码头，并同步控制规则。"
                        : "例如：先帮我梳理人物关系；或者直接把开场改成雨夜码头，并同步当前情境。",
                    )}
                  </p>
                </div>
              ) : (
                view.turns.map((turn) => (
                  <SettingConversationTurnView
                    key={turn.id}
                    turn={applyStreamingCall(turn, view)}
                    revisingWorld={revisingWorld}
                    loadContext={(callId) =>
                      onCallContext?.(view.sessionId, callId) ??
                      Promise.resolve({ status: "unavailable", messages: [] })
                    }
                    filesByPath={filesByPath}
                    rollbackDisabled={rollbackDisabled}
                    rollbackableChangeSetIds={rollbackableChangeSetIds}
                    sealedChangeSetIds={sealedChangeSetIds}
                    rollingBackFile={rollingBackFile}
                    onRollbackFile={rollbackFile}
                    editing={
                      editing?.messageId === turn.user.id ? editing : null
                    }
                    editEnabled={onEditMessage !== undefined}
                    editDisabled={disabled || draftsLocked}
                    editSaving={editBusy}
                    onEdit={() =>
                      setEditing({
                        sessionId: view.sessionId,
                        messageId: turn.user.id,
                        original: turn.user.text,
                        draft: turn.user.text,
                        requestId: createClientId("setting-edit"),
                      })
                    }
                    onEditDraft={(draft) =>
                      setEditing((current) =>
                        current === null ? null : { ...current, draft },
                      )
                    }
                    onCancelEdit={() => setEditing(null)}
                    onSaveEdit={saveEditedMessage}
                    editSubmitDisabled={editSubmitDisabled}
                  />
                ))
              )}

              {running ? (
                <SettingConversationProgress view={view} now={now} />
              ) : null}
              {view?.legacyDraft !== null && view?.legacyDraft !== undefined ? (
                <LegacyDraftHistory legacy={view.legacyDraft} />
              ) : null}
              {view &&
              (view.lastFailure ||
                view.freshContextReason ||
                view.canContinuePartial) ? (
                <div
                  className={
                    view.freshContextReason || !view.canRetry
                      ? "setting-conversation-failure"
                      : "setting-conversation-paused"
                  }
                  role={
                    view.freshContextReason || !view.canRetry
                      ? "alert"
                      : "status"
                  }
                >
                  {view.lastFailure && (
                    <>
                      <strong>{uiText("上一次操作未完成")}</strong>
                      <ModelRetryLimitNotice message={view.lastFailure} />
                      <details>
                        <summary>{uiText("查看详情")}</summary>
                        <p>{view.lastFailure}</p>
                      </details>
                      <p>
                        {uiText(
                          !revisingWorld
                            ? "完整对话和已经结算的当前树改动都已保留。"
                            : revisionLocked
                              ? "对话和已保存的修订改动可以继续查看。"
                              : "可以继续查看历史对话和已封存修订。",
                        )}
                      </p>
                    </>
                  )}
                  {!running && (
                    <ModelRecoveryActions
                      disabled={disabled}
                      freshContextReason={view.freshContextReason}
                      onFreshContext={openFreshComposer}
                      onContinue={
                        view.canContinuePartial
                          ? () => void resume("continue_partial")
                          : undefined
                      }
                      onResend={view.canRetry ? () => void resume() : undefined}
                    />
                  )}
                </div>
              ) : null}
              {view?.runStatus === "paused" &&
              !view.freshContextReason &&
              !running ? (
                <div className="setting-conversation-paused" role="status">
                  <strong>
                    {uiText("已暂停：模型调用次数达到单条消息上限")}
                  </strong>
                  <p>
                    {uiText(
                      "已完成的改动都已保存。可以让 AI 从这里接着做，也可以先查看改动或直接发新消息。",
                    )}
                  </p>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void resume()}
                  >
                    {uiText("继续")}
                  </button>
                </div>
              ) : null}
              {requestFailure !== null ? (
                <div className="setting-conversation-failure" role="alert">
                  {requestRecovery?.kind === "protocol_mismatch" ? (
                    <>
                      <p>
                        {uiText(
                          "当前模型协议与此对话不同。切回兼容连接即可继续，或开启新对话并保留已保存的创作工作。",
                        )}
                      </p>
                      <button
                        type="button"
                        disabled={loading || interactionLocked || titleDirty}
                        onClick={() => openFreshComposer({ keepMessage: true })}
                      >
                        {uiText("选择新对话（保留已保存的创作工作）")}
                      </button>
                    </>
                  ) : requestRecovery?.kind === "prompt_role_order" ? (
                    <>
                      <p>{promptRoleOrderRule()}</p>
                      {onViewPromptOrder && (
                        <button
                          type="button"
                          disabled={loading || interactionLocked}
                          onClick={() =>
                            onViewPromptOrder(requestRecovery.target)
                          }
                        >
                          {uiText("查看编排")}
                        </button>
                      )}
                    </>
                  ) : (
                    requestFailure
                  )}
                </div>
              ) : null}
              {(showTitleSuggestion ||
                (showCreationNextStep && !createWorldDisabled)) && (
                <section className="setting-world-next-step">
                  {showTitleSuggestion && (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveTitle();
                      }}
                    >
                      <h2>{uiText("AI 建议的书名")}</h2>
                      <p>{uiText("当前书名：{name}", { name: packageName })}</p>
                      <label>
                        {uiText("书名")}
                        <input
                          ref={titleInput}
                          value={titleDraft}
                          disabled={packageActionLocked}
                          maxLength={160}
                          onChange={(event) => {
                            if (titleKey !== null)
                              setTitleEdit({
                                suggestion: titleKey,
                                draft: event.target.value,
                                failed: false,
                              });
                          }}
                        />
                      </label>
                      <div className="button-row">
                        <button type="submit" disabled={titleSaveDisabled}>
                          {uiText(
                            savingTitle
                              ? "正在保存书名…"
                              : titleChanged
                                ? "保存书名"
                                : "采用建议书名",
                          )}
                        </button>
                        <button
                          type="button"
                          disabled={savingTitle}
                          onClick={() => {
                            if (!savingTitleRef.current)
                              finishTitleSuggestion();
                          }}
                        >
                          {uiText("保留当前书名")}
                        </button>
                      </div>
                      {savedTitleChanged && !savingTitle ? (
                        <p role="status">
                          {uiText("当前书名已更改。可保留当前书名。")}
                        </p>
                      ) : activeTitleEdit?.failed ? (
                        <p role="alert">{uiText("未能保存书名。请重试。")}</p>
                      ) : null}
                    </form>
                  )}
                  {showCreationNextStep && !createWorldDisabled && (
                    <p role="status">
                      {uiText(
                        showTitleSuggestion
                          ? "内容包已准备好。先选择书名，再创建世界。"
                          : "内容包已准备好。点击「创建世界」开始游玩。",
                      )}
                    </p>
                  )}
                </section>
              )}
              {view === null ? null : (
                <details className="technical-details">
                  <summary>{uiText("本对话累计用量")}</summary>
                  <ModelUsageBreakdown usage={view.usage} />
                </details>
              )}
            </div>
          </article>
        </section>

        <footer ref={composerRef} className="setting-conversation-composer">
          {titleDirty && (
            <div className="setting-title-reminder">
              <span id="setting-composer-title-note" role="status">
                {uiText("保存修改后的书名或保留当前书名后，即可继续聊天。")}
              </span>
              <button
                type="button"
                className="text-button"
                disabled={packageActionLocked}
                onClick={focusTitleSuggestion}
              >
                {uiText("处理建议书名")}
              </button>
            </div>
          )}
          {hasUnsavedFileDraft && (
            <div
              className={`setting-improvement-warning${fileSaveConflict ? " is-error" : ""}`}
            >
              <p role={fileSaveConflict ? "alert" : "status"}>
                {uiText(
                  fileSaveConflict
                    ? "内容包已被其他操作修改，草稿已保留，尚未保存。"
                    : "请先保存或放弃文件编辑中的未保存修改。",
                )}
              </p>
              {!rightRailOpen && (
                <ContentFileDraftActions
                  mode={target}
                  disabled={loading || interactionLocked || draftsLocked}
                  onSave={contentEditor.onSave}
                  onReset={contentEditor.onReset}
                />
              )}
            </div>
          )}
          <label htmlFor="setting-conversation-input">
            {startingFresh
              ? uiText("用全新上下文给 AI 发消息")
              : uiText("继续这段对话")}
          </label>
          <div className="setting-conversation-composer-row">
            <textarea
              ref={attachMessageTextarea}
              id="setting-conversation-input"
              rows={2}
              value={message}
              disabled={disabled}
              aria-describedby={
                titleDirty ? "setting-composer-title-note" : undefined
              }
              placeholder={uiText(
                revisingWorld
                  ? "可以讨论、要求它检查状态，也可以直接让它修改当前世界修订。"
                  : "可以讨论、要求它检查某份设定，也可以直接让它修改内容包。",
              )}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={composer.onKeyDown}
              enterKeyHint="enter"
            />
            {running && view !== null ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void onCancel()}
              >
                {uiText("停止回复")}
              </button>
            ) : (
              <button
                type="button"
                className="setting-conversation-send primary-button"
                disabled={!canSendMessage}
                onClick={() => void composer.submit()}
              >
                {uiText("发送")}
              </button>
            )}
          </div>
          <span className="field-note">
            {uiText(
              composer.enterInsertsNewline
                ? "回车换行，点击发送按钮发送"
                : "Enter 发送，Shift + Enter 换行",
            )}
          </span>
        </footer>

        <button
          type="button"
          className={
            leftRailOpen || rightRailOpen
              ? "setting-panel-scrim is-visible"
              : "setting-panel-scrim"
          }
          aria-label={uiText("收起侧栏")}
          aria-hidden={!leftRailOpen && !rightRailOpen}
          tabIndex={leftRailOpen || rightRailOpen ? 0 : -1}
          onClick={closeRail}
        />

        <aside
          className={
            leftRailOpen
              ? "setting-overlay-rail setting-overlay-rail-left is-open"
              : "setting-overlay-rail setting-overlay-rail-left"
          }
          aria-hidden={!leftRailOpen}
          aria-label={uiText(
            revisingWorld ? "世界修订对话历史" : "设定完善对话历史",
          )}
        >
          <header>
            <div>
              <strong>{uiText("历史")}</strong>
              <span className="panel-count">
                {uiText("{count} 次对话", { count: history.length })}
              </span>
            </div>
            <button
              ref={historyCloseButton}
              type="button"
              aria-label={uiText("收起对话历史")}
              onClick={closeRail}
            >
              ×
            </button>
          </header>
          <div className="setting-overlay-rail-body">
            <SettingConversationHistory
              target={target}
              history={history}
              latestSessionId={latestSessionId}
              selectedSessionId={view?.sessionId ?? null}
              loading={historyLocked}
              deletingSessionId={deletingSessionId}
              onSelectSession={async (sessionId) => {
                setUnconfirmedDraft(null);
                await onSelectSession(sessionId);
                setLeftRailOpen(false);
              }}
              onDeleteSession={requestSessionDeletion}
              onFreshContext={openFreshComposer}
            />
          </div>
        </aside>

        <AuthoringFileRail
          target={target}
          mode={fileRailMode}
          open={rightRailOpen}
          onModeChange={setFileRailMode}
          onClose={closeRail}
          closeButtonRef={filesCloseButton}
          contentEditor={{
            ...contentEditor,
            deleteDisabled: packageDeleteLocked,
            onDelete: requestPackageDeletion,
          }}
          editDisabled={interactionLocked || draftsLocked}
        />
      </div>
      {confirmation !== null && (
        <ConfirmationDialog
          request={confirmation}
          onDecision={decideConfirmation}
        />
      )}
    </main>
  );
}

function SettingConversationHistory({
  target,
  history,
  latestSessionId,
  selectedSessionId,
  loading,
  onFreshContext,
  deletingSessionId,
  onSelectSession,
  onDeleteSession,
}: {
  target: "content-package" | "world-revision";
  history: readonly V1SettingImprovementHistoryItem[];
  latestSessionId: string | null;
  selectedSessionId: string | null;
  loading: boolean;
  onFreshContext: () => void;
  deletingSessionId: string | null;
  onSelectSession: (sessionId: string) => Promise<void>;
  onDeleteSession: (
    item: V1SettingImprovementHistoryItem,
    opener: HTMLButtonElement,
  ) => void;
}): React.JSX.Element {
  const revisingWorld = target === "world-revision";
  return (
    <section
      className="setting-conversation-history"
      aria-labelledby="setting-conversation-history-title"
    >
      <h2 id="setting-conversation-history-title" className="visually-hidden">
        {uiText("对话历史")}
      </h2>
      {history.length === 0 ? (
        <p className="field-note">
          {uiText(
            revisingWorld
              ? "开始后，对话、Provider 返回内容和修订差异会保留在这里。"
              : "开始后，对话、Provider 返回内容和已生效差异会保留在这里。",
          )}
        </p>
      ) : (
        <ol
          aria-label={uiText(
            revisingWorld ? "世界修订对话历史" : "设定完善对话历史",
          )}
        >
          {history.map((item) => {
            const selected = item.sessionId === selectedSessionId;
            const deleting = item.sessionId === deletingSessionId;
            return (
              <li key={item.sessionId}>
                <button
                  type="button"
                  className={
                    selected
                      ? "setting-history-select is-selected"
                      : "setting-history-select"
                  }
                  aria-pressed={selected}
                  disabled={
                    loading || deleting || item.unavailableReason !== undefined
                  }
                  onClick={() => void onSelectSession(item.sessionId)}
                >
                  <span className="setting-history-item-main">
                    <strong>{item.excerpt || uiText("未命名对话")}</strong>
                    <small>{formatHistoryTime(item.createdAt)}</small>
                  </span>
                  <span
                    className={`setting-history-status is-${item.runStatus}`}
                  >
                    {item.unavailableReason !== undefined
                      ? uiText("不可继续")
                      : item.runStatus === "running"
                        ? uiText("回复中")
                        : item.runStatus === "paused"
                          ? uiText("已暂停")
                          : item.sessionId === selectedSessionId
                            ? uiText("当前所选")
                            : item.sessionId === latestSessionId
                              ? uiText("最近")
                              : uiText("可继续")}
                  </span>
                  <small className="setting-history-counts">
                    {item.unavailableReason && (
                      <span>
                        {getWebLocale() === "zh-CN"
                          ? "此对话的模型续传已损坏，请开启全新上下文。"
                          : item.unavailableReason}
                        <br />
                      </span>
                    )}
                    {uiText(
                      "{turns} 轮对话 · {tools} 次工具 · {files} 个文件",
                      {
                        turns: item.turnCount,
                        tools: item.toolCallCount,
                        files: item.changedFileCount,
                      },
                    )}
                  </small>
                </button>
                <button
                  type="button"
                  className="setting-history-delete"
                  aria-label={uiText("删除对话：{title}", {
                    title: item.excerpt || uiText("未命名对话"),
                  })}
                  disabled={
                    loading ||
                    deletingSessionId !== null ||
                    item.runStatus === "running"
                  }
                  onClick={(event) =>
                    onDeleteSession(item, event.currentTarget)
                  }
                >
                  {deleting ? "…" : uiText("删除")}
                </button>
                {item.unavailableReason && (
                  <button
                    type="button"
                    className="setting-history-fresh"
                    disabled={loading || deleting}
                    onClick={onFreshContext}
                  >
                    {uiText("用新上下文")}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function applyStreamingCall(
  turn: V1SettingConversationTurn,
  view: SettingImprovementView,
): V1SettingConversationTurn {
  const stream = view.progress.streaming;
  if (stream?.callId === undefined || view.turns.at(-1)?.id !== turn.id)
    return turn;
  const exchanges = [...turn.exchanges];
  const index = exchanges.findIndex(({ id }) => id === stream.callId);
  const existing = exchanges[index];
  if (existing?.status !== undefined && existing.status !== "streaming")
    return turn;
  const live: V1SettingConversationExchange = {
    id: stream.callId,
    exchange: view.progress.exchange,
    toolCalls: [],
    ...existing,
    status: "streaming",
    reasoning: stream.reasoningText ?? "",
    text: stream.visibleText ?? "",
    toolFragment: stream.toolFragment ?? "",
  };
  if (index < 0) exchanges.push(live);
  else exchanges[index] = live;
  return { ...turn, exchanges };
}

function SettingConversationTurnView({
  turn,
  loadContext,
  revisingWorld,
  filesByPath,
  rollbackDisabled,
  rollbackableChangeSetIds,
  sealedChangeSetIds,
  rollingBackFile,
  onRollbackFile,
  editing,
  editEnabled,
  editDisabled,
  editSaving,
  editSubmitDisabled,
  onEdit,
  onEditDraft,
  onCancelEdit,
  onSaveEdit,
}: {
  turn: V1SettingConversationTurn;
  loadContext: (callId: string) => Promise<PlayRequestContext>;
  revisingWorld: boolean;
  filesByPath: ReadonlyMap<string, ContentTreeFile>;
  rollbackDisabled: boolean;
  rollbackableChangeSetIds: ReadonlySet<string> | undefined;
  sealedChangeSetIds: ReadonlySet<string>;
  rollingBackFile: { changeSetId: string; path: string } | null;
  onRollbackFile: (changeSetId: string, path: string) => Promise<void>;
  editing: { draft: string } | null;
  editEnabled: boolean;
  editDisabled: boolean;
  editSaving: boolean;
  editSubmitDisabled: boolean;
  onEdit: () => void;
  onEditDraft: (draft: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (policy: "keep" | "revert") => Promise<void>;
}): React.JSX.Element {
  const callAttempts = groupCallAttempts(
    turn.exchanges,
    (call) => call.id,
    (call) => call.retryOf,
  );
  const fileChanges = turn.exchanges.flatMap((exchange) =>
    exchange.toolCalls.flatMap(({ callId, result }) =>
      result === null || result.isError
        ? []
        : result.changes.map((diff) => ({
            key: `${exchange.id}:${callId}:${diff.path}`,
            changeSetId: result.changeSetId,
            diff,
          })),
    ),
  );
  const rollbackFor = (id: string | null): ChangeRollback | undefined =>
    id === null || (revisingWorld && !rollbackableChangeSetIds?.has(id))
      ? undefined
      : {
          changeSetId: id,
          filesByPath,
          disabled: rollbackDisabled,
          rollingBackFile,
          onRollbackFile,
        };
  return (
    <section className="setting-conversation-turn">
      <article className="setting-conversation-message setting-conversation-user">
        <span className="setting-conversation-role">{uiText("你")}</span>
        {editing === null ? (
          <>
            <p>{turn.user.text}</p>
            {editEnabled ? (
              <button type="button" disabled={editDisabled} onClick={onEdit}>
                {uiText("修改消息")}
              </button>
            ) : null}
          </>
        ) : (
          <div className="setting-message-edit">
            <label>
              {uiText("修改消息")}
              <textarea
                value={editing.draft}
                disabled={editSaving}
                onChange={(event) => onEditDraft(event.target.value)}
              />
            </label>
            <p>
              {uiText(
                "保存后会替换这条消息及之后的对话。请选择如何处理文件改动。",
              )}
            </p>
            <button
              type="button"
              disabled={editSubmitDisabled || editing.draft.trim().length === 0}
              onClick={() => void onSaveEdit("keep")}
            >
              {uiText("保留文件改动并继续")}
            </button>
            <button
              type="button"
              disabled={editSubmitDisabled || editing.draft.trim().length === 0}
              onClick={() => void onSaveEdit("revert")}
            >
              {uiText("撤回文件改动并继续")}
            </button>
            <button type="button" disabled={editSaving} onClick={onCancelEdit}>
              {uiText("取消")}
            </button>
          </div>
        )}
      </article>
      {turn.exchanges.map((exchange) =>
        (exchange.status === "streaming" ||
          exchange.status === "completed" ||
          exchange.status === undefined) &&
        exchange.toolCalls.length === 0 &&
        exchange.text.length > 0 ? (
          <article
            className="setting-conversation-message setting-conversation-assistant"
            key={`text:${exchange.id}`}
          >
            <span className="setting-conversation-role">{uiText("AI")}</span>
            <p>{exchange.text}</p>
            {exchange.status === "streaming" ? (
              <small>{uiText("正在接收的正文")}</small>
            ) : null}
          </article>
        ) : null,
      )}
      {fileChanges.length > 0 && (
        <section
          className="setting-accepted-changes setting-turn-file-changes"
          aria-label={uiText("本轮已改文件")}
        >
          <h5>{uiText("本轮已改文件")}</h5>
          {fileChanges.map(({ key, changeSetId, diff }) => {
            const rollback = rollbackFor(changeSetId);
            const file = filesByPath.get(diff.path);
            let status = uiText("历史改动");
            if (changeSetId !== null && sealedChangeSetIds.has(changeSetId))
              status = uiText("已封存修订");
            else if (
              rollback !== undefined &&
              fileMatchesContents(file, diff.before)
            )
              status = uiText("当前文件已是修改前版本");
            else if (
              rollback !== undefined &&
              fileMatchesContents(file, diff.after)
            )
              status = uiText(revisingWorld ? "修订工作树" : "内容包当前树");
            return (
              <FileChangeDiff
                key={key}
                diff={diff}
                rollback={rollback}
                status={status}
              />
            );
          })}
        </section>
      )}
      <ModelCallDetailsGroup count={callAttempts.length}>
        {callAttempts.map((attempts) => (
          <ModelCallAttempts
            key={attempts[0]!.id}
            attempts={attempts}
            render={(exchange) => (
              <ModelCallDetails
                key={exchange.id}
                retries={exchange.retries}
                status={exchange.status}
                failure={exchange.failure}
                context={
                  <RequestContextDetails
                    load={() => loadContext(exchange.id)}
                  />
                }
                reasoning={<ModelCallReasoning text={exchange.reasoning} />}
                tools={
                  <ModelCallTools
                    count={exchange.toolCalls.length}
                    stepText={
                      exchange.toolCalls.length > 0 ? exchange.text : undefined
                    }
                    fragment={exchange.toolFragment}
                  >
                    <SettingConversationTools
                      exchange={exchange}
                      revisingWorld={revisingWorld}
                      rollbackFor={rollbackFor}
                    />
                  </ModelCallTools>
                }
                usage={exchange.usage}
              />
            )}
          />
        ))}
      </ModelCallDetailsGroup>
    </section>
  );
}

function SettingConversationTools({
  exchange,
  revisingWorld,
  rollbackFor,
}: {
  exchange: V1SettingConversationExchange;
  revisingWorld: boolean;
  rollbackFor: (changeSetId: string | null) => ChangeRollback | undefined;
}): React.JSX.Element {
  return (
    <div className="model-call-tool-list">
      {exchange.toolCalls.map((call) => (
        <details
          className={`setting-exchange-tool ${call.result?.isError === true ? "is-error" : "is-ok"}`}
          key={call.callId}
        >
          <summary>
            <strong>{uiText("调用 {tool}", { tool: call.name })}</strong>
            <span>
              {call.result === null
                ? uiText("等待 Runtime 结果")
                : call.result.isError
                  ? uiText("拒绝／失败")
                  : call.result.changes.length > 0
                    ? uiText(
                        revisingWorld
                          ? "已修改修订工作树 · {count} 个文件"
                          : "已修改内容包 · {count} 个文件",
                        {
                          count: call.result.changes.length,
                        },
                      )
                    : uiText("成功")}
            </span>
          </summary>
          <h5>{uiText("工具参数")}</h5>
          <pre>{safeJson(call.arguments)}</pre>
          {call.result === null ? null : (
            <>
              <h5>{uiText("Runtime 工具结果")}</h5>
              <pre>{call.result.markdown}</pre>
              <AcceptedChanges
                changes={call.result.changes}
                rollback={rollbackFor(call.result.changeSetId)}
              />
            </>
          )}
        </details>
      ))}
    </div>
  );
}

interface ChangeRollback {
  changeSetId: string;
  filesByPath: ReadonlyMap<string, ContentTreeFile>;
  disabled: boolean;
  rollingBackFile: { changeSetId: string; path: string } | null;
  onRollbackFile: (changeSetId: string, path: string) => Promise<void>;
}

function AcceptedChanges({
  changes,
  heading = uiText("当时已生效差异"),
  rollback,
}: {
  changes: readonly V1SettingAuthoringDiff[];
  heading?: string;
  rollback?: ChangeRollback | undefined;
}): React.JSX.Element | null {
  if (changes.length === 0) return null;
  return (
    <section className="setting-accepted-changes" aria-label={heading}>
      <h5>{heading}</h5>
      {changes.map((diff) => (
        <FileChangeDiff
          key={`${diff.kind}-${diff.path}`}
          diff={diff}
          rollback={rollback}
        />
      ))}
    </section>
  );
}

function FileChangeDiff({
  diff,
  rollback,
  status,
}: {
  diff: V1SettingAuthoringDiff;
  rollback: ChangeRollback | undefined;
  status?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="setting-change-diff"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className={`setting-diff-kind setting-diff-${diff.kind}`}>
          {uiText(
            diff.kind === "create"
              ? "新增"
              : diff.kind === "delete"
                ? "删除"
                : "修改",
          )}
        </span>
        <code>{diff.path}</code>
        {status === undefined ? null : (
          <small className="setting-change-status">{status}</small>
        )}
      </summary>
      {(open || status === undefined) && (
        <>
          <UnifiedTextDiff
            before={diff.before}
            after={diff.after}
            label={uiText("{path} 的完整差异", { path: diff.path })}
          />
          {rollback === undefined ? null : (
            <FileRollbackControl
              changeSetId={rollback.changeSetId}
              change={diff}
              currentFile={rollback.filesByPath.get(diff.path)}
              disabled={rollback.disabled}
              rolling={
                rollback.rollingBackFile?.changeSetId ===
                  rollback.changeSetId &&
                rollback.rollingBackFile.path === diff.path
              }
              onRollback={rollback.onRollbackFile}
            />
          )}
        </>
      )}
    </details>
  );
}

function SealedWorldRevisionHistory({
  epochs,
}: {
  epochs: readonly V1WorldRevisionSealedEpochView[];
}): React.JSX.Element | null {
  if (epochs.length === 0) return null;
  return (
    <details className="setting-turn-trace">
      <summary>
        <span>{uiText("已封存修订")}</span>
        <small>{uiText("{count} 次记录", { count: epochs.length })}</small>
      </summary>
      <div className="setting-turn-trace-exchanges">
        {epochs.map((epoch) => (
          <details className="setting-conversation-trace" key={epoch.epochId}>
            <summary className="section-heading-row">
              <strong>
                {epoch.lifecycle === "applied"
                  ? uiText("已应用修订")
                  : uiText("已放弃修订")}
              </strong>
              <small>{formatHistoryTime(epoch.finishedAt)}</small>
            </summary>
            <AcceptedChanges
              changes={epoch.diff}
              heading={uiText("封存时的完整差异")}
            />
            {epoch.changes.map((changeSet) => (
              <AcceptedChanges
                key={changeSet.changeSetId}
                changes={changeSet.changes}
                heading={`${
                  changeSet.source === "manual"
                    ? uiText("手动编辑")
                    : changeSet.source === "ai"
                      ? uiText("AI 修改")
                      : uiText("回滚")
                } · ${formatHistoryTime(changeSet.createdAt)}`}
              />
            ))}
          </details>
        ))}
      </div>
    </details>
  );
}

function FileRollbackControl({
  changeSetId,
  change,
  currentFile,
  disabled,
  rolling,
  onRollback,
}: {
  changeSetId: string;
  change: V1SettingAuthoringDiff;
  currentFile: ContentTreeFile | undefined;
  disabled: boolean;
  rolling: boolean;
  onRollback: (changeSetId: string, path: string) => Promise<void>;
}): React.JSX.Element {
  const alreadyRolledBack = fileMatchesContents(currentFile, change.before);
  return (
    <div
      className={`setting-change-rollback ${alreadyRolledBack ? "is-already_rolled_back" : ""}`}
    >
      {alreadyRolledBack ? (
        <span>{uiText("当前文件已是修改前版本")}</span>
      ) : (
        <button
          type="button"
          className="secondary-button"
          disabled={disabled}
          onClick={() => void onRollback(changeSetId, change.path)}
        >
          {rolling ? uiText("正在回滚…") : uiText("回滚这个文件")}
        </button>
      )}
    </div>
  );
}

function fileMatchesContents(
  file: ContentTreeFile | undefined,
  contents: string | null,
): boolean {
  return contents === null
    ? file === undefined
    : file?.encoding === undefined && file?.contents === contents;
}

function LegacyDraftHistory({
  legacy,
}: {
  legacy: NonNullable<V1SettingImprovementView["legacyDraft"]>;
}): React.JSX.Element {
  return (
    <details className="setting-legacy-draft-history">
      <summary>{uiText("迁移前的隔离草稿记录（仅回顾）")}</summary>
      <p>
        {legacy.outcome === "applied"
          ? uiText("这份旧草稿在迁移前已经应用。")
          : legacy.outcome === "discarded"
            ? uiText("这份旧草稿在迁移前已经放弃。")
            : legacy.outcome === "apply_outcome_unknown"
              ? uiText("旧应用收据的结果无法确认；迁移没有改写当前树。")
              : uiText("这份旧草稿没有自动应用；当前树保持迁移时的真实状态。")}
      </p>
      <AcceptedChanges
        changes={legacy.changes}
        heading={
          legacy.outcome === "applied"
            ? uiText("迁移前已应用的差异")
            : legacy.outcome === "apply_outcome_unknown"
              ? uiText("迁移前草稿差异（结果未知）")
              : uiText("迁移前草稿差异（未生效）")
        }
      />
    </details>
  );
}

function SettingConversationProgress({
  view,
  now,
}: {
  view: SettingImprovementView | null;
  now: number;
}): React.JSX.Element {
  const retries = view?.turns
    .flatMap((turn) => turn.exchanges)
    .findLast((exchange) => exchange.status === "streaming")?.retries;
  const retryWaiting = retries?.at(-1)?.status === "waiting";
  const progress = view?.progress;
  const stream = progress?.streaming;
  const silence =
    stream === null || stream === undefined
      ? null
      : Math.max(0, Math.round((now - stream.receivedAt) / 1000));
  const chars =
    stream === null || stream === undefined
      ? 0
      : stream.reasoningChars + stream.textChars + stream.toolChars;
  const hasLiveTrace =
    stream?.callId === undefined &&
    ((stream?.reasoningText?.length ?? 0) > 0 ||
      (stream?.toolFragment?.length ?? 0) > 0);
  return (
    <div className="setting-conversation-running" role="status">
      <span className="setting-conversation-spinner" aria-hidden="true" />
      <div>
        <strong>
          {uiText(retryWaiting ? "正在等待自动重试…" : "AI 正在处理…")}
        </strong>
        <ModelRetryStatus retries={retries} active />
        <p>
          {uiText(
            "第 {exchange} 次模型交换 · {tools} 次工具调用 · 已接收 {chars} 字",
            {
              exchange: progress?.exchange ?? 0,
              tools: progress?.toolCalls ?? 0,
              chars,
            },
          )}
        </p>
        {silence !== null && silence >= 90 ? (
          <p className="setting-run-age-stalled">
            {uiText("已 {seconds} 秒没有收到新片段，可以停止后继续对话。", {
              seconds: silence,
            })}
          </p>
        ) : null}
        {!stream?.visibleText?.length && stream?.tail.trim() ? (
          <p>{stream.tail}</p>
        ) : null}
        {stream?.callId === undefined && stream?.visibleText?.length ? (
          <div className="setting-live-response">
            <strong>{uiText("正在接收的正文")}</strong>
            <pre>{stream.visibleText}</pre>
          </div>
        ) : null}
        {hasLiveTrace ? (
          <details className="setting-live-trace-group">
            <summary>{uiText("正在接收调用详情")}</summary>
            {stream?.reasoningText?.length ? (
              <details className="setting-live-trace">
                <summary>
                  {uiText("Provider 返回推理（不等同隐藏思维链）")}
                </summary>
                <pre>{stream.reasoningText}</pre>
              </details>
            ) : null}
            {stream?.toolFragment?.length ? (
              <details className="setting-live-trace">
                <summary>{uiText("正在接收的工具调用片段")}</summary>
                <pre>{stream.toolFragment}</pre>
              </details>
            ) : null}
          </details>
        ) : null}
      </div>
    </div>
  );
}

function formatHistoryTime(value: number): string {
  return new Intl.DateTimeFormat(getWebLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return uiText("[参数无法序列化]");
  }
}
