import type { AuthoringConversationView } from "./AuthoringTarget.ts";
import type {
  ContentTreeFile,
  V1SettingImprovementRollbackResult,
  V1WorldRevisionEpochView,
} from "../protocol/v1.ts";
import { RuntimeRequestError } from "./runtimeClient.ts";
import { createClientId } from "./ClientId.ts";
import { ReadTarget } from "./ReadTarget.ts";
import { uiText } from "./i18n.ts";
import {
  modelSendRecovery,
  type ModelSendRecovery,
} from "./ModelSendRecovery.ts";
import type { ObserveConversation } from "./ConversationObserver.ts";
import {
  AuthoringConflictError,
  confirmsAuthoringRequest,
  type AuthoringTarget,
  type AuthoringTargetSnapshot,
  sameAuthoringFiles,
} from "./AuthoringTarget.ts";

export interface AuthoringWorkspaceState {
  target: AuthoringTargetSnapshot | null;
  view: AuthoringConversationView | null;
  files: ContentTreeFile[];
  baseline: ContentTreeFile[];
  /** The tree revision `baseline` was saved at; a save must say it is based on this. */
  baselineRevision: string | null;
  serverFiles: ContentTreeFile[];
  dirty: boolean;
  /** True after a save was rejected because the saved tree changed; the draft is kept. */
  conflict: boolean;
  /** True while Runtime changes the saved tree outside the editor; no file draft can start. */
  draftsLocked: boolean;
  loading: boolean;
  savingFiles: boolean;
  applying: boolean;
  requestFailure: string | null;
  requestRecovery: ModelSendRecovery | null;
  syncFailed: boolean;
  syncError: unknown;
  notice: string;
  now: number;
}
const cloneFiles = (files: readonly ContentTreeFile[]) =>
  files.map((file) => ({ ...file }));

const revisionOf = (snapshot: AuthoringTargetSnapshot | null) =>
  snapshot?.packageDetail?.treeRevision ?? null;

/** Browser lifetime of one authoring target. Runtime publication belongs to the adapter. */
export class AuthoringWorkspace {
  private state: AuthoringWorkspaceState = {
    target: null,
    view: null,
    files: [],
    baseline: [],
    baselineRevision: null,
    serverFiles: [],
    dirty: false,
    conflict: false,
    draftsLocked: false,
    loading: true,
    savingFiles: false,
    applying: false,
    requestFailure: null,
    requestRecovery: null,
    syncFailed: false,
    syncError: undefined,
    notice: "",
    now: 0,
  };
  private draftHolds = 0;
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | undefined;
  private scope = 0;
  private active = false;
  private target: AuthoringTarget;
  private observe: ObserveConversation | undefined;
  private selection: string | { requestId?: string } | null = null;
  private selectionVersion = 0;
  private observationVersion = 0;
  private progressVersion = 0;
  private reader: ReadTarget<{
    snapshot: AuthoringTargetSnapshot;
    view: AuthoringConversationView | null;
    progressVersion: number;
  }>;
  private connectionFault = false;
  private observationClosed = false;
  private unconfirmedRequest: {
    id: string;
    sessionId: string | null;
    warning: string;
  } | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(target: AuthoringTarget, observe?: ObserveConversation) {
    this.target = target;
    this.observe = observe;
    this.reader = this.createReader();
  }
  private current() {
    const scope = this.scope;
    const selection = this.selectionVersion;
    return () =>
      this.active &&
      scope === this.scope &&
      selection === this.selectionVersion;
  }
  getSnapshot = (): AuthoringWorkspaceState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<AuthoringWorkspaceState>): void {
    const next = { ...this.state, ...patch };
    // Recovery belongs to the last command failure, not to the conversation.
    if ("requestFailure" in patch)
      next.requestRecovery = patch.requestRecovery ?? null;
    if (this.active && next.view?.runStatus === "running") {
      if (this.timer === undefined) {
        next.now = Date.now();
        this.timer = setInterval(() => this.update({ now: Date.now() }), 1000);
      }
    } else if (this.timer !== undefined) this.stopClock();
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  private stopClock(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
  private accept(snapshot: AuthoringTargetSnapshot, receipt = true): void {
    if (receipt) this.reader.accept({ complete: false });
    const files = cloneFiles(snapshot.files);
    this.update({
      target: snapshot,
      serverFiles: files,
      ...(!this.state.dirty && this.saving === null
        ? {
            files: cloneFiles(files),
            baseline: cloneFiles(files),
            baselineRevision: revisionOf(snapshot),
          }
        : {}),
    });
  }
  /**
   * Runs a change that Runtime applies to the saved tree outside the file editor.
   * File drafts cannot start until it finishes, then the saved package is re-read.
   * A draft started earlier would otherwise be saved over the change.
   */
  async holdDraftsWhile(change: () => Promise<void>): Promise<void> {
    const scope = this.scope;
    const alive = () => this.active && scope === this.scope;
    this.draftHolds += 1;
    this.update({ draftsLocked: true });
    try {
      await change();
      if (alive()) {
        this.reader.accept({ complete: false });
        await this.refreshAfterCommit(alive);
      }
    } catch (error) {
      await this.recoverCommand(alive);
      throw error;
    } finally {
      if (alive()) {
        this.draftHolds -= 1;
        this.update({ draftsLocked: this.draftHolds > 0 });
      }
    }
  }

  private createReader() {
    const valid = this.current();
    return new ReadTarget({
      load: async () => {
        const selection = this.selection;
        const progressVersion = this.progressVersion;
        const snapshot = await this.target.read();
        const view =
          typeof selection === "string" &&
          selection !== snapshot.latest?.sessionId &&
          snapshot.history.some((session) => session.sessionId === selection)
            ? await this.target.readSession(selection)
            : snapshot.latest;
        return { snapshot, view, progressVersion };
      },
      apply: ({ snapshot, view, progressVersion }) => {
        if (!valid()) return;
        const live = this.state.view;
        // Keep progress delivered during this read; a newer Runtime snapshot still wins.
        if (
          progressVersion !== this.progressVersion &&
          view !== null &&
          live?.sessionId === view.sessionId &&
          live.progress.updatedAt > view.progress.updatedAt
        )
          view = {
            ...view,
            runStatus: live.runStatus,
            progress: live.progress,
          };
        this.accept(snapshot, false);
        const unconfirmed = this.unconfirmedRequest;
        if (
          unconfirmed !== null &&
          (unconfirmed.sessionId === null ||
            view?.sessionId === unconfirmed.sessionId) &&
          confirmsAuthoringRequest(view, unconfirmed.id)
        ) {
          if (this.state.requestFailure === unconfirmed.warning)
            this.update({ requestFailure: null });
          this.unconfirmedRequest = null;
        }
        const selection = this.selection;
        if (selection === null || typeof selection === "string") {
          this.selection = view?.sessionId ?? null;
          this.update({ view });
        } else if (selection.requestId !== undefined) {
          // Render the record actually read, but claim a fresh conversation only
          // when its durable request receipt identifies this submission.
          if (
            this.unconfirmedRequest !== null ||
            confirmsAuthoringRequest(view, selection.requestId)
          )
            this.update({ view });
          if (confirmsAuthoringRequest(view, selection.requestId))
            this.selection = view!.sessionId;
        }
        this.update({ loading: false });
        if (selection !== this.selection && this.unsubscribe !== undefined)
          this.observeSelection();
      },
      onSyncFailure: (syncFailed, syncError) => {
        if (valid()) this.update({ syncFailed, syncError, loading: false });
      },
    });
  }
  private replaceReader(): void {
    this.reader.dispose();
    this.reader = this.createReader();
  }
  /** Reads authoritative files and the selected conversation without replacing drafts. */
  async refresh(): Promise<void> {
    if (!this.active || this.state.applying) return;
    await this.reader.read();
  }
  /** Explicit recovery is read-only; a closed observer is attached again after reading. */
  async reread(): Promise<void> {
    if (!this.active) return;
    const valid = this.current();
    await this.reader.recover();
    if (valid() && (this.observationClosed || this.unsubscribe === undefined)) {
      this.connectionFault = false;
      this.observeSelection();
    }
  }
  private async refreshAfterCommit(valid: () => boolean): Promise<void> {
    if (valid()) await this.reader.read();
  }
  private async recoverCommand(valid: () => boolean): Promise<void> {
    if (valid()) await this.reader.recover();
  }
  async open(): Promise<void> {
    this.close();
    this.active = true;
    this.selection = null;
    this.draftHolds = 0;
    this.replaceReader();
    this.update({
      target: null,
      view: null,
      files: [],
      baseline: [],
      baselineRevision: null,
      serverFiles: [],
      dirty: false,
      conflict: false,
      draftsLocked: false,
      loading: true,
      savingFiles: false,
      applying: false,
      requestFailure: null,
      syncFailed: false,
      syncError: undefined,
      notice: "",
    });
    const valid = this.current();
    await this.reader.read();
    if (!valid() || this.state.target === null) return;
    this.update({
      notice: uiText(
        this.state.target?.revision?.epoch?.locked
          ? this.target.messages.locked
          : this.target.messages.opened,
      ),
    });
    this.observeSelection();
  }
  private observeSelection(): void {
    this.unsubscribe?.();
    const version = ++this.observationVersion;
    this.observationClosed = false;
    const valid = this.current();
    const alive = () => valid() && version === this.observationVersion;
    const selected =
      typeof this.selection === "string" ? this.selection : undefined;
    let receivedRevision = false;
    let awaitingReconnect = this.connectionFault;
    this.unsubscribe = this.observe?.(
      {
        kind: this.target.kind,
        id: this.target.id,
        ...(selected === undefined ? {} : { sessionId: selected }),
      },
      (observation, changed, isCurrent) => {
        const deliveryCurrent = () => alive() && isCurrent?.() !== false;
        if (!deliveryCurrent() || observation.kind !== this.target.kind) return;
        const alreadyLoaded =
          !receivedRevision &&
          observation.kind === "setting" &&
          observation.value.revision === this.state.target?.observationRevision;
        if (changed) {
          if (!alreadyLoaded) {
            // A newer revision needs a read begun after its notification.
            void (receivedRevision
              ? this.reader.recover()
              : this.reader.read());
          }
          receivedRevision = true;
        }
        if (!changed || alreadyLoaded) {
          const status = observation.value.selected;
          const view = this.state.view;
          if (status !== null && view?.sessionId === status.sessionId) {
            this.progressVersion++;
            this.update({
              now: Date.now(),
              view: {
                ...view,
                runStatus: status.runStatus,
                progress: status.progress,
              },
            });
          }
        }
      },
      (connection) => {
        if (!alive()) return;
        if (connection === "connected" || connection === "synchronized") {
          this.connectionFault = false;
          awaitingReconnect = false;
          return;
        }
        if (connection === "failed") this.observationClosed = true;
        if (this.connectionFault) {
          if (awaitingReconnect) {
            this.observationClosed = true;
            this.update({ syncFailed: true });
          }
          return;
        }
        this.connectionFault = true;
        void this.reader.recover().then(() => {
          if (alive() && this.observationClosed && !this.state.syncFailed)
            this.observeSelection();
        });
      },
    );
  }
  close(): void {
    this.reader.dispose();
    this.connectionFault = false;
    this.active = false;
    this.scope += 1;
    this.unconfirmedRequest = null;
    this.selectionVersion += 1;
    this.observationVersion += 1;
    this.editOpening = null;
    this.saving = null;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.stopClock();
  }
  startFresh(): void {
    if (!this.active || this.state.applying) return;
    this.unconfirmedRequest = null;
    this.selectionVersion += 1;
    this.selection = {};
    this.connectionFault = false;
    this.replaceReader();
    this.update({
      view: null,
      loading: false,
      requestFailure: null,
      syncFailed: false,
    });
    this.observeSelection();
  }
  async selectSession(sessionId: string): Promise<void> {
    if (!this.active || this.state.applying) return;
    this.unconfirmedRequest = null;
    this.selectionVersion += 1;
    this.selection = sessionId;
    this.connectionFault = false;
    this.replaceReader();
    const valid = this.current();
    this.update({
      view: null,
      loading: true,
      requestFailure: null,
      syncFailed: false,
    });
    this.observeSelection();
    await this.reader.read();
    if (valid()) this.update({ loading: false });
  }

  async send(
    message: string,
    requestId = createClientId("authoring-message"),
  ): Promise<void> {
    if (!this.active || this.state.applying) return;
    const valid = this.current();
    if (this.state.dirty)
      throw new Error(uiText("请先保存文件编辑，再继续 AI 设定完善。"));
    const sessionId =
      typeof this.selection === "string" ? this.selection : null;
    if (sessionId === null) this.selection = { requestId };
    await this.settleRequest(valid, sessionId, requestId, () =>
      this.target.send(message, sessionId, requestId),
    );
  }

  async editMessage(
    messageId: string,
    message: string,
    filePolicy: "keep" | "revert",
    requestId: string,
  ): Promise<void> {
    if (
      !this.active ||
      this.state.applying ||
      typeof this.selection !== "string" ||
      this.target.editMessage === undefined
    )
      throw new Error("The selected conversation cannot be edited");
    if (this.state.dirty)
      throw new Error(uiText("请先保存文件编辑，再继续 AI 设定完善。"));
    const sessionId = this.selection;
    await this.settleRequest(this.current(), sessionId, requestId, () =>
      this.target.editMessage!(
        sessionId,
        messageId,
        message,
        filePolicy,
        requestId,
      ),
    );
  }
  /** Continues the selected conversation after it paused at its exchange budget. */
  async resume(recovery?: "continue_partial"): Promise<void> {
    if (
      !this.active ||
      this.state.applying ||
      typeof this.selection !== "string"
    )
      return;
    const valid = this.current();
    if (this.state.dirty)
      throw new Error(uiText("请先保存文件编辑，再继续 AI 设定完善。"));
    const sessionId = this.selection;
    const requestId = createClientId("authoring-resume");
    await this.settleRequest(valid, sessionId, requestId, () =>
      this.target.resume(sessionId, requestId, recovery),
    );
  }
  private async settleRequest(
    valid: () => boolean,
    sessionId: string | null,
    requestId: string,
    request: () => Promise<AuthoringConversationView>,
  ): Promise<void> {
    this.unconfirmedRequest = null;
    this.update({ requestFailure: null, notice: "" });
    let view: AuthoringConversationView;
    try {
      view = await request();
    } catch (error) {
      if (!valid()) return;
      const warning = errorMessage(error);
      const requestRecovery = modelSendRecovery(error);
      this.unconfirmedRequest =
        error instanceof RuntimeRequestError && error.protocolCode === undefined
          ? { id: requestId, sessionId, warning }
          : null;
      this.update({ requestFailure: warning, requestRecovery });
      await this.recoverCommand(valid);
      if (!valid()) return;
      const candidate = this.state.view;
      if (
        !(error instanceof RuntimeRequestError) ||
        error.protocolCode !== undefined ||
        candidate === null ||
        (sessionId !== null && candidate.sessionId !== sessionId) ||
        !confirmsAuthoringRequest(candidate, requestId)
      ) {
        // A refusal still has a reason even if a partial operation was published.
        this.update({ requestFailure: warning, requestRecovery });
        throw error;
      }
      this.unconfirmedRequest = null;
      this.update({ requestFailure: null });
      view = candidate;
    }
    if (!valid()) return;
    this.selection = view.sessionId;
    this.reader.accept({ complete: false });
    this.update({ view });
    this.observeSelection();
    await this.refreshAfterCommit(valid);
  }
  async cancel(): Promise<void> {
    if (
      !this.active ||
      this.state.applying ||
      typeof this.selection !== "string"
    )
      return;
    const valid = this.current();
    this.update({ requestFailure: null });
    try {
      const view = await this.target.cancel(this.selection);
      if (valid()) {
        this.reader.accept({ complete: false });
        this.update({ view });
        this.observeSelection();
        await this.refreshAfterCommit(valid);
      }
    } catch (error: unknown) {
      if (valid()) {
        this.update({ requestFailure: errorMessage(error) });
        await this.recoverCommand(valid);
      }
    }
  }
  async deleteSession(sessionId: string): Promise<void> {
    if (!this.active || this.state.applying) return;
    const valid = this.current();
    this.update({ loading: true, requestFailure: null });
    try {
      const next = await this.target.deleteSession(sessionId);
      if (!valid() || this.state.target === null) return;
      this.accept({
        ...this.state.target,
        ...next,
        files: next.revision?.epoch?.files ?? this.state.serverFiles,
      });
      if (this.selection === sessionId || this.selection === null) {
        this.selection = next.latest?.sessionId ?? null;
        this.update({ view: next.latest });
      }
      this.observeSelection();
      this.update({
        notice: uiText(this.target.messages.deleted),
      });
      await this.refreshAfterCommit(valid);
    } catch (error: unknown) {
      if (!valid()) return;
      this.update({ requestFailure: errorMessage(error) });
      await this.recoverCommand(valid);
      throw error;
    } finally {
      if (valid()) this.update({ loading: false });
    }
  }
  async rollbackFile(
    sessionId: string,
    changeSetId: string,
    path: string,
  ): Promise<V1SettingImprovementRollbackResult> {
    const valid = this.current();
    if (this.state.applying || this.state.dirty || this.state.target === null)
      throw new Error(uiText("请先保存或放弃文件编辑中的未保存修改。"));
    this.update({ requestFailure: null, notice: "" });
    let result: V1SettingImprovementRollbackResult;
    try {
      result = await this.target.rollback(
        sessionId,
        changeSetId,
        path,
        this.state.target,
      );
    } catch (error: unknown) {
      if (valid()) {
        this.update({ requestFailure: errorMessage(error) });
        await this.recoverCommand(valid);
      }
      throw error;
    }
    if (!valid()) return result;
    this.reader.accept({ complete: false });
    this.observeSelection();
    await this.refreshAfterCommit(valid);
    if (valid())
      this.update({
        notice: uiText(
          result.status === "rolled_back"
            ? this.target.messages.rolledBack
            : this.target.messages.alreadyRolledBack,
        ),
      });
    return result;
  }
  async finish(
    action: "apply" | "discard",
    expectedEpoch?: Pick<V1WorldRevisionEpochView, "epochId" | "revision">,
  ): Promise<{ changed: boolean } | null> {
    const snapshot = this.state.target;
    const epoch = snapshot?.revision?.epoch;
    if (
      !this.active ||
      this.state.applying ||
      this.state.loading ||
      snapshot === null ||
      !epoch?.locked ||
      (expectedEpoch !== undefined &&
        (epoch.epochId !== expectedEpoch.epochId ||
          epoch.revision !== expectedEpoch.revision)) ||
      this.state.dirty ||
      this.target.finish === undefined ||
      (action === "apply" && epoch.diagnostics.length > 0)
    )
      return null;
    const valid = this.current();
    this.update({ applying: true, requestFailure: null });
    try {
      await this.target.finish(action, snapshot);
      if (!valid()) return null;
      return { changed: epoch.diff.length > 0 };
    } catch (error: unknown) {
      if (valid()) {
        this.update({ requestFailure: errorMessage(error) });
        await this.recoverCommand(valid);
      }
      return null;
    } finally {
      if (valid()) this.update({ applying: false });
    }
  }
  callContext(sessionId: string, callId: string) {
    return (
      this.target.callContext?.(sessionId, callId) ??
      Promise.resolve({ status: "unavailable" as const, messages: [] })
    );
  }
  requestPreview(sessionId: string, requestId: string) {
    return (
      this.target.requestPreview?.(sessionId, requestId) ??
      Promise.resolve(null)
    );
  }
  async preview() {
    const valid = this.current();
    try {
      const result = await this.target.preview(
        typeof this.selection === "string" ? this.selection : null,
      );
      return valid() ? result : null;
    } catch (error: unknown) {
      if (!valid()) return null;
      throw error;
    }
  }
  private editOpening: Promise<void> | null = null;
  editFiles(files: ContentTreeFile[]): void {
    if (!this.active || this.state.applying || this.draftHolds > 0) return;
    this.update({
      files: cloneFiles(files),
      dirty: !sameAuthoringFiles(this.state.baseline, files),
    });
    this.ensureEditing();
  }
  private ensureEditing(): void {
    if (
      !this.state.dirty ||
      this.state.target === null ||
      this.editOpening !== null
    )
      return;
    const opening = this.target.beginEdit(this.state.target);
    if (opening === null) return;
    const valid = this.current();
    this.update({ loading: true, requestFailure: null });
    const pending = opening
      .then((next) => {
        if (valid()) {
          this.accept(next);
          this.update({
            notice: uiText(this.target.messages.locked),
          });
        }
      })
      .catch(async (error: unknown) => {
        if (valid()) {
          this.update({ requestFailure: errorMessage(error) });
          await this.recoverCommand(valid);
        }
      })
      .finally(() => {
        if (this.editOpening === pending) this.editOpening = null;
        if (valid()) this.update({ loading: false });
      });
    this.editOpening = pending;
  }
  private saving: Promise<void> | null = null;
  saveFiles(): Promise<void> {
    if (this.saving !== null) return this.saving;
    const submitted = cloneFiles(this.state.files);
    const saving = this.saveDraft(submitted).finally(() => {
      if (this.saving !== saving) return;
      this.saving = null;
      this.update({ savingFiles: false });
    });
    this.saving = saving;
    this.update({ savingFiles: true });
    return saving;
  }
  private async saveDraft(submitted: ContentTreeFile[]): Promise<void> {
    if (
      !this.active ||
      this.state.applying ||
      !this.state.dirty ||
      this.state.target === null
    )
      return;
    const valid = this.current();
    this.ensureEditing();
    if (this.editOpening !== null) await this.editOpening;
    if (!valid() || this.state.target === null) return;
    this.update({ loading: true, requestFailure: null });
    try {
      const next = await this.target.save(
        submitted,
        {
          files: this.state.baseline,
          treeRevision: this.state.baselineRevision,
        },
        this.state.target,
      );
      if (!valid()) return;
      const draft = cloneFiles(this.state.files);
      const unchanged = sameAuthoringFiles(submitted, draft);
      this.accept(next);
      const baseline = cloneFiles(next.files);
      this.update({
        baseline,
        baselineRevision: revisionOf(next),
        conflict: false,
        ...(unchanged
          ? { files: cloneFiles(baseline), dirty: false }
          : { files: draft, dirty: !sameAuthoringFiles(baseline, draft) }),
        notice: uiText(this.target.messages.saved),
      });
      this.observeSelection();
    } catch (error: unknown) {
      if (!valid()) return;
      if (error instanceof AuthoringConflictError) {
        this.accept(error.latest);
        this.update({ conflict: true, requestFailure: null });
      } else this.update({ requestFailure: errorMessage(error) });
      await this.recoverCommand(valid);
    } finally {
      if (valid()) this.update({ loading: false });
    }
  }
  /** Discards the draft after a rejected save and adopts the saved tree Runtime reported. */
  loadLatest(): void {
    if (
      !this.active ||
      this.state.applying ||
      this.saving !== null ||
      !this.state.conflict
    )
      return;
    this.update({
      files: cloneFiles(this.state.serverFiles),
      baseline: cloneFiles(this.state.serverFiles),
      baselineRevision: revisionOf(this.state.target),
      dirty: false,
      conflict: false,
      requestFailure: null,
      notice: uiText("已放弃草稿，载入内容包最新版本。"),
    });
  }
  resetFiles(): void {
    if (!this.active || this.state.applying || this.saving !== null) return;
    this.update({
      files: cloneFiles(this.state.serverFiles),
      baseline: cloneFiles(this.state.serverFiles),
      baselineRevision: revisionOf(this.state.target),
      conflict: false,
      dirty: false,
      requestFailure: null,
      notice:
        this.target.messages.reset === null
          ? this.state.notice
          : uiText(this.target.messages.reset),
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : uiText("操作失败");
}
