import type { V1SettingAuthoringDiff } from "../../protocol/v1.ts";
import type { ContentTreeFile } from "../content/ContentTreeFile.ts";
import { validAuthoringNativeContinuation } from "../model/FileNativeModelAdapters.ts";
import type { ModelHostAppendItem } from "../model/ModelHost.ts";
import type { ModelToolConversationState } from "./ModelToolConversation.ts";

interface Edit {
  requestId: string;
  messageId: string;
  message: string;
  filePolicy: "keep" | "revert";
}
type EditableSession = ModelToolConversationState & { editReceipts?: Edit[] };

/** Checks idempotency before a target claims its own publication lease. */
export function completedAuthoringEdit(
  session: EditableSession,
  edit: Edit,
): boolean {
  const prior = session.editReceipts?.find(
    ({ requestId }) => requestId === edit.requestId,
  );
  if (
    prior !== undefined &&
    (prior.messageId !== edit.messageId ||
      prior.message !== edit.message ||
      prior.filePolicy !== edit.filePolicy)
  )
    throw new Error(
      "This edit request ID was already used for different content",
    );
  if (!session.completedRequestIds.includes(edit.requestId)) return false;
  if (prior === undefined)
    throw new Error(
      "This request ID was already used for another authoring operation",
    );
  return true;
}

/** Locates and validates the native prefix and prepares the replacement transcript. */
export function planAuthoringEdit<Session extends EditableSession>(
  session: Session,
  edit: Edit,
) {
  const messageIndex = session.messages.findIndex(
    (entry) => entry.role === "user" && entry.id === edit.messageId,
  );
  if (messageIndex < 0)
    throw new Error("The selected authoring message no longer exists");
  const userIndex = session.messages
    .slice(0, messageIndex)
    .filter((entry) => entry.role === "user").length;
  const itemIndex = session.modelItems
    .map((item, index) => (item.kind === "user" ? index : -1))
    .filter((index) => index >= 0)[userIndex];
  if (
    itemIndex === undefined ||
    session.modelItems[itemIndex]?.kind !== "user" ||
    session.modelItems[itemIndex].text !== session.messages[messageIndex]!.text
  )
    throw new Error(
      "The selected authoring message cannot be matched to the native transcript",
    );
  const prefix = session.modelItems.slice(0, itemIndex);
  if (!validAuthoringNativeContinuation(prefix, session.modelBinding.provider))
    throw new Error(
      "The native continuation before this message is damaged; start a fresh context",
    );
  const next = structuredClone(session);
  next.editReceipts = [...(next.editReceipts ?? []), edit];
  delete next.retryDispatch;
  next.modelItems = prefix;
  next.messages = next.messages.slice(0, messageIndex);
  next.requests = (next.requests ?? []).filter(
    (entry) => entry.modelItemStart < itemIndex,
  );
  return {
    itemIndex,
    tail: session.modelItems.slice(itemIndex) as Session["modelItems"],
    next: { ...next, requests: next.requests },
  };
}

/** Returns a candidate tree and conflicts; the target validates and publishes it. */
export function revertAuthoringChanges(
  files: readonly ContentTreeFile[],
  items: readonly (
    | Exclude<ModelHostAppendItem, { kind: "tool" }>
    | (Extract<ModelHostAppendItem, { kind: "tool" }> & {
        changes: V1SettingAuthoringDiff[];
      })
  )[],
): { files: ContentTreeFile[]; conflicts: string[] } {
  const result = new Map(
    files.map((file) => [file.path, structuredClone(file)]),
  );
  const conflicts = new Set<string>();
  const changes = items.flatMap((item) =>
    item.kind === "tool" && !item.isError ? item.changes : [],
  );
  for (const change of changes.reverse()) {
    if (conflicts.has(change.path)) continue;
    const malformed =
      (change.kind === "create" &&
        (change.before !== null || change.after === null)) ||
      (change.kind === "delete" &&
        (change.before === null || change.after !== null)) ||
      (change.kind === "modify" &&
        (change.before === null ||
          change.after === null ||
          change.before === change.after));
    const current = result.get(change.path);
    if (
      malformed ||
      (change.after === null
        ? current !== undefined
        : current?.contents !== change.after || current.encoding !== undefined)
    ) {
      conflicts.add(change.path);
      continue;
    }
    if (change.before === null) result.delete(change.path);
    else
      result.set(change.path, { path: change.path, contents: change.before });
  }
  return {
    files: [...result.values()].sort((a, b) => a.path.localeCompare(b.path)),
    conflicts: [...conflicts].sort(),
  };
}
