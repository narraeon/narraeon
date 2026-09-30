import type {
  ContentTreeFile,
  V1SettingImprovementRollbackResult,
  V1SettingImprovementView,
} from "../protocol/v1.ts";
import { uiText } from "./i18n.ts";
import type { ObserveConversation } from "./ConversationObserver.ts";
import {
  type AuthoringTarget,
  type AuthoringTargetSnapshot,
  sameAuthoringFiles,
} from "./AuthoringTarget.ts";

export interface AuthoringWorkspaceState {
  target: AuthoringTargetSnapshot | null;
  view: V1SettingImprovementView | null;
  files: ContentTreeFile[];
  baseline: ContentTreeFile[];
  serverFiles: ContentTreeFile[];
  dirty: boolean;
  loading: boolean;
  applying: boolean;
  requestFailure: string | null;
  observationFailure: string | null;
  notice: string;
  now: number;
}
const cloneFiles = (files: readonly ContentTreeFile[]) =>
  files.map((file) => ({ ...file }));

/** Browser lifetime of one authoring target. Runtime publication belongs to the adapter. */
export class AuthoringWorkspace {
  private state: AuthoringWorkspaceState = {
    target: null,
    view: null,
    files: [],
    baseline: [],
    serverFiles: [],
    dirty: false,
    loading: true,
    applying: false,
    requestFailure: null,
    observationFailure: null,
    notice: "",
    now: 0,
  };
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | undefined;
  private scope = 0;
  private active = false;
  private target: AuthoringTarget;
  private observe: ObserveConversation | undefined;
  private selection:
    string | { previousSessionId: string | null; started: boolean } | null =
    null;
  private selectionVersion = 0;
  private observationVersion = 0;
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
    const files = cloneFiles(snapshot.files);
    this.update({
      target: snapshot,
      serverFiles: files,
      ...(!this.state.dirty && this.saving === null
        ? { files: cloneFiles(files), baseline: cloneFiles(files) }
        : {}),
    });
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
      serverFiles: [],
      dirty: false,
      loading: true,
      applying: false,
      requestFailure: null,
      observationFailure: null,
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
      async (observation, changed) => {
        if (!alive() || observation.kind !== this.target.kind) return;
        if (changed) {
          try {
            const next = await this.target.read();
            if (!alive()) return;
            const selection = this.selection;
            const view =
              typeof selection === "string" &&
              selection !== next.latest?.sessionId
                ? await this.target.readSession(selection)
                : next.latest;
            if (!alive()) return;
            this.accept(next);
            if (selection === null) {
              this.selection = next.latest?.sessionId ?? null;
              this.update({ view });
            } else if (typeof selection === "string") this.update({ view });
            else if (
              selection.started &&
              next.latest !== null &&
              next.latest.sessionId !== selection.previousSessionId
            ) {
              this.selection = next.latest.sessionId;
              this.update({ view: next.latest });
            }
            if (
              selected !==
              (typeof this.selection === "string" ? this.selection : undefined)
            )
              this.observeSelection();
          } catch (error: unknown) {
            if (alive()) throw error;
          }
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
      (connection) => {
        if (alive())
          this.update({
            observationFailure:
              connection === "connected"
                ? null
                : uiText(
                    connection === "reconnecting"
                      ? "对话连接已断开，正在重新连接…"
                      : "对话同步失败，请重新打开此页面。",
                  ),
          });
      },
    );
  }
  close(): void {
    this.active = false;
    this.scope += 1;
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
    this.selectionVersion += 1;
    this.selection = {
      previousSessionId: this.state.target?.latest?.sessionId ?? null,
      started: false,
    };
    this.update({ view: null, loading: false, requestFailure: null });
    this.observeSelection();
  }
  async selectSession(sessionId: string): Promise<void> {
    if (!this.active || this.state.applying) return;
    this.selectionVersion += 1;
    this.selection = sessionId;
    const valid = this.current();
    this.update({ view: null, loading: true, requestFailure: null });
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
  async send(message: string): Promise<void> {
    if (!this.active || this.state.applying) return;
    const valid = this.current();
    if (this.state.dirty)
      throw new Error(uiText("请先保存文件编辑，再继续 AI 设定完善。"));
    if (typeof this.selection !== "string") {
      if (this.selection === null)
        this.selection = {
          previousSessionId: this.state.target?.latest?.sessionId ?? null,
          started: true,
        };
      else this.selection.started = true;
    }
    const sessionId =
      typeof this.selection === "string" ? this.selection : null;
    this.update({ requestFailure: null, notice: "" });
    try {
      const view = await this.target.send(message, sessionId);
      if (!valid()) return;
      this.selection = view.sessionId;
      this.update({ view });
      this.observeSelection();
      const next = await this.target.read();
      if (valid()) this.accept(next);
    } catch (error: unknown) {
      if (!valid()) return;
      this.update({ requestFailure: errorMessage(error) });
      throw error;
    }
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
      if (!valid()) return;
      this.accept(next);
      if (this.selection === sessionId || this.selection === null) {
        this.selection = next.latest?.sessionId ?? null;
        this.update({ view: next.latest });
        this.observeSelection();
      } else if (typeof this.selection === "object" && !this.selection.started)
        this.selection.previousSessionId = next.latest?.sessionId ?? null;
      this.observeSelection();
      this.update({
        notice: uiText(this.target.messages.deleted),
      });
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
    try {
      const next = await this.target.read();
      if (valid()) {
        this.accept(next);
        this.observeSelection();
      }
    } catch (error: unknown) {
      if (valid())
        this.update({
          requestFailure: uiText(this.target.messages.rollbackReadFailure, {
            message: errorMessage(error),
          }),
        });
    }
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
    if (!this.active || this.state.applying) return;
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
        this.state.baseline,
        this.state.target,
      );
      if (!valid()) return;
      const draft = cloneFiles(this.state.files);
      const unchanged = sameAuthoringFiles(submitted, draft);
      this.accept(next);
      const baseline = cloneFiles(next.files);
      this.update({
        baseline,
        ...(unchanged
          ? { files: cloneFiles(baseline), dirty: false }
          : { files: draft, dirty: !sameAuthoringFiles(baseline, draft) }),
        notice: uiText(this.target.messages.saved),
      });
      this.observeSelection();
    } catch (error: unknown) {
      if (valid()) this.update({ requestFailure: errorMessage(error) });
    } finally {
      if (valid()) this.update({ loading: false });
    }
  }
  resetFiles(): void {
    if (!this.active || this.state.applying) return;
    this.update({
      files: cloneFiles(this.state.serverFiles),
      baseline: cloneFiles(this.state.serverFiles),
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
