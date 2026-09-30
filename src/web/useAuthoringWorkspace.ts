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
  return { workspace, state };
}
