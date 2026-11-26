import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AuthoringWorkspace } from "./AuthoringWorkspace.ts";
import {
  contentPackageTarget,
  worldRevisionTarget,
  type AuthoringClient,
} from "./AuthoringTarget.ts";
import type { ObserveConversation } from "./ConversationObserver.ts";

export function useAuthoringWorkspace(
  client: AuthoringClient & { observeConversation?: ObserveConversation },
  kind: "setting" | "revision",
  id: string,
  active: boolean,
) {
  const workspace = useMemo(
    () =>
      new AuthoringWorkspace(
        kind === "setting"
          ? contentPackageTarget(client, id)
          : worldRevisionTarget(client, id),
        client.observeConversation,
      ),
    [client, kind, id],
  );
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  useEffect(() => {
    if (active && id !== "") void workspace.open();
    return () => workspace.close();
  }, [workspace, active, id]);
  const history = state.target?.history ?? [];
  return {
    workspace,
    state,
    conversation: {
      view: state.view,
      history,
      latestSessionId:
        state.target?.latest?.sessionId ??
        (kind === "setting" ? (history[0]?.sessionId ?? null) : null),
      requestFailure: state.requestFailure,
      requestRecovery: state.requestRecovery,
      syncFailed: state.syncFailed,
      syncError: state.syncError,
      now: state.now,
    },
  };
}

/** Both authoring surfaces use the same conversation commands. */
export function authoringConversationActions(
  workspace: AuthoringWorkspace,
  clearNotice?: () => void,
) {
  return {
    onRead: () => void workspace.reread(),
    onPreview: () => workspace.preview(),
    onCallContext: (sessionId: string, callId: string) =>
      workspace.callContext(sessionId, callId),
    onRequestPreview: (sessionId: string, requestId: string) =>
      workspace.requestPreview(sessionId, requestId),
    onSend: (message: string, requestId: string) => {
      clearNotice?.();
      return workspace.send(message, requestId);
    },
    onEditMessage: (...args: Parameters<AuthoringWorkspace["editMessage"]>) =>
      workspace.editMessage(...args),
    onCancel: () => workspace.cancel(),
    onResume: (recovery?: "continue_partial") => {
      clearNotice?.();
      return workspace.resume(recovery);
    },
    onFreshContext: () => workspace.startFresh(),
    onSelectSession: (id: string) => workspace.selectSession(id),
    onDeleteSession: (id: string) => {
      clearNotice?.();
      return workspace.deleteSession(id);
    },
    onRollbackFile: (id: string, change: string, path: string) => {
      clearNotice?.();
      return workspace.rollbackFile(id, change, path);
    },
  };
}
