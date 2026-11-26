import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { V1OrchestrationChangeSet } from "../../protocol/orchestrationSession.ts";
import { validAuthoringRequests } from "../authoring/AuthoringRequestSnapshot.ts";
import type { ModelToolConversationState } from "../authoring/ModelToolConversation.ts";
import type {
  ModelHostAppendItem,
  ModelHostToolCall,
} from "../model/ModelHost.ts";
import { validPromptCompilation } from "../prompt/PromptCompilationCodec.ts";
import { RuntimeDomainError } from "../RuntimeDomainError.ts";
import type { EditorAuthorization } from "./EditorTools.ts";
import { record } from "./EditorOperations.ts";

type ToolResult = Extract<ModelHostAppendItem, { kind: "tool" }>;

export interface EditorChangeRecord {
  receipt: Omit<V1OrchestrationChangeSet, "undoAvailable">;
  epoch: string;
  currentRevision: string;
  beforeHead: string;
  toolCallIds: string[];
  /** Prompt-only preimage; other preset files are untouched by model editing. */
  beforeManifest?: string;
}

export interface PendingEditorSettlement {
  assistantItemIndex: number;
  calls: ModelHostToolCall[];
  results: ToolResult[];
  authorization: EditorAuthorization;
  publication?: {
    change: EditorChangeRecord;
    beforeAuthorization: EditorAuthorization;
    afterManifest: string;
  };
}

export interface EditorSessionState extends ModelToolConversationState {
  schemaVersion: 1;
  presetId: string;
  creationRequestId: string;
  createdAt: number;
  authorization: EditorAuthorization;
  pendingSettlement: PendingEditorSettlement | null;
  pendingUndo?: { id: string; receiptId: string };
  changes: EditorChangeRecord[];
}

const sessionIdFormat = /^orchestration-[0-9a-f-]{36}$/u;

export function editorSessionId(): string {
  return `orchestration-${randomUUID()}`;
}

export class EditorSessionStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  get scope(): string {
    return this.#root;
  }

  async list(presetId: string): Promise<EditorSessionState[]> {
    let entries: string[];
    try {
      entries = await readdir(this.#directory(presetId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => this.read(presetId, entry.slice(0, -5))),
    );
    return sessions.sort(
      (a, b) =>
        b.updatedAt - a.updatedAt ||
        b.createdAt - a.createdAt ||
        b.sessionId.localeCompare(a.sessionId),
    );
  }

  async read(presetId: string, id: string): Promise<EditorSessionState> {
    const path = this.#path(presetId, id);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new RuntimeDomainError("Orchestration session not found", {
        receipt: { code: "invalid_request" },
      });
    }
    const data: unknown = JSON.parse(raw);
    const session = record(data);
    if (
      session.schemaVersion !== 1 ||
      session.sessionId !== id ||
      session.presetId !== presetId ||
      typeof session.creationRequestId !== "string" ||
      typeof session.createdAt !== "number" ||
      typeof session.updatedAt !== "number" ||
      !["ready", "running", "paused", "interrupted"].includes(
        String(session.runStatus),
      ) ||
      !validPromptCompilation(session.bootstrap) ||
      !Array.isArray(session.messages) ||
      !Array.isArray(session.modelItems) ||
      !Array.isArray(session.completedRequestIds) ||
      !Array.isArray(session.changes) ||
      typeof session.authorization !== "object" ||
      session.authorization === null ||
      !validAuthoringRequests(session.requests, validPromptCompilation, {
        modelItems: session.modelItems,
        activeRequestId: session.activeRequestId,
        completedRequestIds: session.completedRequestIds,
        extended: true,
        independent: true,
      })
    )
      throw new Error("Invalid persisted orchestration conversation");
    return session as unknown as EditorSessionState;
  }

  async save(session: EditorSessionState): Promise<void> {
    const path = this.#path(session.presetId, session.sessionId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(this.#directory(session.presetId), {
      mode: 0o700,
      recursive: true,
    });
    try {
      await writeFile(temporary, JSON.stringify(session), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async delete(presetId: string, id: string): Promise<void> {
    await rm(this.#path(presetId, id));
  }

  async deleteOrphans(presetIds: Iterable<string>): Promise<void> {
    const retained = new Set([...presetIds].map(directoryName));
    let directories: string[];
    try {
      directories = await readdir(this.#root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const directory of directories)
      if (/^[a-f0-9]{64}$/u.test(directory) && !retained.has(directory))
        await rm(join(this.#root, directory), { recursive: true, force: true });
  }

  #path(presetId: string, id: string): string {
    if (!sessionIdFormat.test(id))
      throw new RuntimeDomainError("Invalid orchestration session identity", {
        receipt: { code: "invalid_request" },
      });
    return join(this.#directory(presetId), `${id}.json`);
  }

  #directory(presetId: string): string {
    return join(this.#root, directoryName(presetId));
  }
}

function directoryName(presetId: string): string {
  return createHash("sha256").update(presetId).digest("hex");
}
