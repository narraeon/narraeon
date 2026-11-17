import type { AuthoringConversationView } from "./AuthoringTarget.ts";
import type {
  ContentTreeFile,
  V1SettingImprovementRollbackResult,
} from "../protocol/v1.ts";
import { RuntimeRequestError } from "./runtimeClient.ts";
import { createClientId } from "./ClientId.ts";
import { readAfterCommit } from "./RequestOutcome.ts";
import { uiText } from "./i18n.ts";
import {
  conversationConnectionText,
  type ObserveConversation,
} from "./ConversationObserver.ts";
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
  applying: boolean;
  requestFailure: string | null;
  observationFailure: string | null;
  projectionFailure: string | null;
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
    applying: false,
    requestFailure: null,
    observationFailure: null,
    projectionFailure: null,
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
  private projectionVersion = 0;
  private unconfirmedRequest: { id: string; warning: string } | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(target: AuthoringTarget, observe?: ObserveConversation) {
    this.target = target;
    this.observe = observe;
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
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private accept(snapshot: AuthoringTargetSnapshot): void {
    this.projectionVersion++;
    const files = cloneFiles(snapshot.files);
    this.update({
      target: snapshot,
      projectionFailure: null,
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
      if (alive()) await this.refreshAfterCommit(alive);
    } finally {
      this.draftHolds -= 1;
      this.update({ draftsLocked: this.draftHolds > 0 });
    }
  }

  /** Re-reads the saved package after a change made outside the file editor. */
  async refresh(): Promise<void> {
    if (!this.active || this.state.applying || this.state.dirty) return;
    await this.refreshProjection(this.current());
  }
  private async refreshProjection(valid: () => boolean): Promise<void> {
    const version = ++this.projectionVersion;
    const current = () => valid() && version === this.projectionVersion;
    try {
      const next = await this.target.read();
      if (!current()) return;
      const selection = this.selection;
      const selected = typeof selection === "string" ? selection : undefined;
      const view =
        selected !== undefined && selected !== next.latest?.sessionId
          ? await this.target.readSession(selected)
          : next.latest;
      if (!current()) return;
      this.accept(next);
      if (
        this.unconfirmedRequest !== null &&
        confirmsAuthoringRequest(view, this.unconfirmedRequest.id)
      ) {
        if (this.state.requestFailure === this.unconfirmedRequest.warning)
          this.update({ requestFailure: null });
        this.unconfirmedRequest = null;
      }
      if (selection === null || typeof selection === "string") {
        this.selection = view?.sessionId ?? null;
        this.update({ view });
      } else if (
        selection.requestId !== undefined &&
        view !== null &&
        confirmsAuthoringRequest(view, selection.requestId)
      ) {
        this.selection = view.sessionId;
        this.update({ view });
      }
      if (
        selected !==
        (typeof this.selection === "string" ? this.selection : undefined)
      )
        this.observeSelection();
    } catch (error) {
      if (current()) throw error;
    }
  }
  private async refreshAfterCommit(valid: () => boolean): Promise<void> {
    try {
      await readAfterCommit(() => this.refreshProjection(valid));
    } catch (error) {
      if (valid()) this.update({ projectionFailure: errorMessage(error) });
    }
  }
  async open(): Promise<void> {
    this.close();
    this.active = true;
    this.selection = null;
    this.update({
      target: null,
      view: null,
      files: [],
      baseline: [],
      baselineRevision: null,
      serverFiles: [],
      dirty: false,
      conflict: false,
      loading: true,
      applying: false,
      requestFailure: null,
      observationFailure: null,
      projectionFailure: null,
      notice: "",
    });
    const valid = this.current();
    try {
      const snapshot = await this.target.read();
      if (!valid()) return;
      this.accept(snapshot);
      this.selection = snapshot.latest?.sessionId ?? null;
      this.update({
        view: snapshot.latest,
        loading: false,
        now: Date.now(),
        notice: uiText(
          snapshot.revision?.epoch?.locked
            ? this.target.messages.locked
            : this.target.messages.opened,
        ),
      });
      this.observeSelection();
      this.timer = setInterval(() => {
        if (this.active) this.update({ now: Date.now() });
      }, 1000);
    } catch (error: unknown) {
      if (valid())
        this.update({ requestFailure: errorMessage(error), loading: false });
    }
  }
  private observeSelection(): void {
    this.unsubscribe?.();
    const version = ++this.observationVersion;
    const valid = this.current();
    const alive = () => valid() && version === this.observationVersion;
    const selected =
      typeof this.selection === "string" ? this.selection : undefined;
    this.unsubscribe = this.observe?.(
      {
        kind: this.target.kind,
        id: this.target.id,
        ...(selected === undefined ? {} : { sessionId: selected }),
      },
      async (observation, changed, isCurrent) => {
        const deliveryCurrent = () => alive() && isCurrent?.() !== false;
        if (!alive() || observation.kind !== this.target.kind) return;
        if (changed) {
          await this.refreshProjection(deliveryCurrent);
        } else {
          const status = observation.value.selected;
          const view = this.state.view;
          if (status !== null && view?.sessionId === status.sessionId)
            this.update({
              view: {
                ...view,
                runStatus: status.runStatus,
                progress: status.progress,
              },
            });
        }
        if (alive()) this.update({ now: Date.now() });
      },
      (connection, message) => {
        if (alive())
          this.update({
            observationFailure: conversationConnectionText(connection, message),
          });
      },
    );
  }
  close(): void {
    this.active = false;
    this.scope += 1;
    this.unconfirmedRequest = null;
    this.selectionVersion += 1;
    this.observationVersion += 1;
    this.editOpening = null;
    this.saving = null;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearInterval(this.timer);
    this.timer = undefined;
  }
  startFresh(): void {
    if (!this.active || this.state.applying) return;
    this.unconfirmedRequest = null;
    this.selectionVersion += 1;
    this.selection = {};
    this.update({
      view: null,
      loading: false,
      requestFailure: null,
      observationFailure: null,
      projectionFailure: null,
    });
    this.observeSelection();
  }
  async selectSession(sessionId: string): Promise<void> {
    if (!this.active || this.state.applying) return;
    this.unconfirmedRequest = null;
    this.selectionVersion += 1;
    this.selection = sessionId;
    const valid = this.current();
    this.update({
      view: null,
      loading: true,
      requestFailure: null,
      observationFailure: null,
      projectionFailure: null,
    });
    this.observeSelection();
    try {
      const view =
        this.state.target?.latest?.sessionId === sessionId
          ? this.state.target.latest
          : await this.target.readSession(sessionId);
      if (valid()) this.update({ view });
    } catch (error: unknown) {
      if (valid()) this.update({ requestFailure: errorMessage(error) });
    } finally {
      if (valid()) this.update({ loading: false });
    }
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
      if (
        !(error instanceof RuntimeRequestError) ||
        error.protocolCode !== undefined
      ) {
        this.update({ requestFailure: errorMessage(error) });
        throw error;
      }
      // A Runtime or SSE view is a receipt only for the exact submitted request.
      const observed = this.state.view;
      const matching = (candidate: AuthoringConversationView | null) =>
        candidate !== null &&
        (sessionId === null || candidate.sessionId === sessionId) &&
        confirmsAuthoringRequest(candidate, requestId);
      let candidate = matching(observed)
        ? observed
        : await (
            sessionId === null
              ? this.target.read().then((snapshot) => snapshot.latest)
              : this.target.readSession(sessionId)
          ).catch(() => null);
      if (!valid()) return;
      if (!matching(candidate) && matching(this.state.view))
        candidate = this.state.view;
      if (candidate === null || !matching(candidate)) {
        const warning = error.message;
        this.unconfirmedRequest = { id: requestId, warning };
        this.update({ requestFailure: warning });
        throw error;
      }
      view = candidate;
    }
    if (!valid()) return;
    this.selection = view.sessionId;
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
        this.update({ view });
        this.observeSelection();
      }
    } catch (error: unknown) {
      if (valid()) this.update({ requestFailure: errorMessage(error) });
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
      if (valid()) this.update({ requestFailure: errorMessage(error) });
      throw error;
    }
    if (!valid()) return result;
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
  ): Promise<{ changed: boolean } | null> {
    const snapshot = this.state.target;
    const epoch = snapshot?.revision?.epoch;
    if (
      !this.active ||
      this.state.applying ||
      this.state.loading ||
      snapshot === null ||
      !epoch?.locked ||
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
      if (valid()) this.update({ requestFailure: errorMessage(error) });
      return null;
    } finally {
      if (valid()) this.update({ applying: false });
    }
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
      .catch((error: unknown) => {
        if (valid()) this.update({ requestFailure: errorMessage(error) });
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
      if (this.saving === saving) this.saving = null;
    });
    this.saving = saving;
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
    } finally {
      if (valid()) this.update({ loading: false });
    }
  }
  /** Discards the draft after a rejected save and adopts the saved tree Runtime reported. */
  loadLatest(): void {
    if (!this.active || this.state.applying || !this.state.conflict) return;
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
    if (!this.active || this.state.applying) return;
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
