import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AppLocale } from "../../protocol/appPreferences.ts";
import type { ModelUsage } from "../../protocol/modelUsage.ts";
import type {
  ModelHostAppendItem,
  ModelHostBinding,
} from "../model/ModelHost.ts";
import {
  isPlayPresetBinding,
  type PlayPresetBinding,
} from "../play/FileNativePlayPresetStore.ts";
import type { PromptCompilation } from "../prompt/FileNativePromptCompiler.ts";
import type {
  PersistedSettingDraftState,
  SettingDraftReview,
} from "./SettingImprovementDraft.ts";

export interface SettingConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}

export interface StoredSettingImprovementSession {
  schemaVersion: 1;
  sessionId: string;
  packageId: string;
  locale: AppLocale;
  lifecycle: "open" | "applied" | "discarded";
  runStatus: "ready" | "running" | "interrupted";
  createdAt: number;
  updatedAt: number;
  baseFingerprint: string;
  baseFiles: PersistedSettingDraftState["files"];
  draftVersion: number;
  draft: PersistedSettingDraftState;
  review: SettingDraftReview;
  bootstrap: PromptCompilation;
  modelBinding: ModelHostBinding;
  /** Absent only on conversations created before preset freezing shipped. */
  playPreset?: PlayPresetBinding;
  modelItems: ModelHostAppendItem[];
  messages: SettingConversationMessage[];
  usage: ModelUsage;
  exchange: number;
  toolCalls: number;
  activeRequestId: string | null;
  completedRequestIds: string[];
  lastFailure: string | null;
  applyRequest: null | {
    expectedDraftVersion: number;
    draftFingerprint: string;
  };
  appliedAt: number | null;
}

const sessionFilePattern = /^setting-[0-9a-f-]{36}\.json$/u;

export class FileNativeSettingImprovementStore {
  readonly #sessionsRoot: string;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(dataRoot: string) {
    this.#sessionsRoot = join(dataRoot, "setting-improvements", "sessions");
  }

  createId(): string {
    return `setting-${randomUUID()}`;
  }

  async read(sessionId: string): Promise<StoredSettingImprovementSession> {
    await this.#mutationTail;
    return this.#read(sessionId);
  }

  async findOpenByPackage(
    packageId: string,
  ): Promise<StoredSettingImprovementSession | null> {
    await this.#mutationTail;
    let entries;
    try {
      entries = await readdir(this.#sessionsRoot, { withFileTypes: true });
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    const matches: StoredSettingImprovementSession[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !sessionFilePattern.test(entry.name)) continue;
      const session = await this.#read(entry.name.slice(0, -5));
      if (session.packageId === packageId && session.lifecycle === "open")
        matches.push(session);
    }
    matches.sort((left, right) => right.updatedAt - left.updatedAt);
    if (matches.length > 1)
      throw new Error(
        "More than one open setting-improvement session exists for the content package",
      );
    return matches[0] ?? null;
  }

  save(session: StoredSettingImprovementSession): Promise<void> {
    return this.#mutate(async () => {
      validateStoredSession(session);
      await publishJson(this.#path(session.sessionId), session);
    });
  }

  async #read(sessionId: string): Promise<StoredSettingImprovementSession> {
    assertSessionId(sessionId);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.#path(sessionId), "utf8"));
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT")
        throw new Error("Setting-improvement session does not exist", {
          cause: error,
        });
      throw error;
    }
    return validateStoredSession(value);
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release: () => void = () => undefined;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #path(sessionId: string): string {
    assertSessionId(sessionId);
    return join(this.#sessionsRoot, `${sessionId}.json`);
  }
}

function assertSessionId(sessionId: string): void {
  if (
    !/^setting-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      sessionId,
    )
  )
    throw new Error("Invalid setting-improvement session ID");
}

function validateStoredSession(
  value: unknown,
): StoredSettingImprovementSession {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.sessionId !== "string" ||
    typeof value.packageId !== "string" ||
    (value.locale !== "en" && value.locale !== "zh-CN") ||
    (value.lifecycle !== "open" &&
      value.lifecycle !== "applied" &&
      value.lifecycle !== "discarded") ||
    (value.runStatus !== "ready" &&
      value.runStatus !== "running" &&
      value.runStatus !== "interrupted") ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    typeof value.baseFingerprint !== "string" ||
    !Array.isArray(value.baseFiles) ||
    !Number.isSafeInteger(value.draftVersion) ||
    Number(value.draftVersion) < 0 ||
    !isRecord(value.draft) ||
    !isRecord(value.review) ||
    !isRecord(value.bootstrap) ||
    !isRecord(value.modelBinding) ||
    (value.playPreset !== undefined &&
      !isPlayPresetBinding(value.playPreset)) ||
    !Array.isArray(value.modelItems) ||
    !Array.isArray(value.messages) ||
    !isRecord(value.usage) ||
    !Number.isSafeInteger(value.exchange) ||
    Number(value.exchange) < 0 ||
    !Number.isSafeInteger(value.toolCalls) ||
    Number(value.toolCalls) < 0 ||
    (value.activeRequestId !== null &&
      typeof value.activeRequestId !== "string") ||
    !Array.isArray(value.completedRequestIds) ||
    (value.lastFailure !== null && typeof value.lastFailure !== "string") ||
    (value.applyRequest !== null &&
      (!isRecord(value.applyRequest) ||
        !Number.isSafeInteger(value.applyRequest.expectedDraftVersion) ||
        Number(value.applyRequest.expectedDraftVersion) < 0 ||
        typeof value.applyRequest.draftFingerprint !== "string")) ||
    (value.appliedAt !== null && typeof value.appliedAt !== "number")
  )
    throw new Error(
      "Setting-improvement session does not match its durable schema",
    );
  assertSessionId(value.sessionId);
  if (
    !value.completedRequestIds.every((id) => typeof id === "string") ||
    !value.messages.every(
      (message) =>
        isRecord(message) &&
        typeof message.id === "string" &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.text === "string" &&
        typeof message.createdAt === "number",
    )
  )
    throw new Error("Setting-improvement transcript is damaged");
  return structuredClone(value) as unknown as StoredSettingImprovementSession;
}

async function publishJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
