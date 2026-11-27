import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  ChatGptAuthError,
  isIssuedClientId,
  isToken,
  safeIdentityText,
  type ChatGptTokens,
} from "./ChatGptOAuth.ts";
import { isRecord } from "./ProviderValues.ts";

const fileName = "chatgpt-auth-v1.json";
const maxFileBytes = 4 * 1024 * 1024;
const uuid =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const accountIdPattern = new RegExp(`^${uuid}$`, "u");
const hostIdPattern = new RegExp(`^urn:uuid:${uuid}$`, "u");
export const maxChatGptAccounts = 32;

export interface StoredChatGptAccount {
  id: string;
  clientId: string;
  subject: string;
  email?: string;
  label: string;
  tokens?: ChatGptTokens;
  needsReauthorization?: true;
  revocationUnconfirmed?: true;
}

export interface ChatGptCredentialDocument {
  version: 1;
  hostId: string;
  accounts: StoredChatGptAccount[];
}

export class ChatGptCredentialStore {
  readonly #directory: string;
  readonly #path: string;

  constructor(workspaceDirectory: string) {
    this.#directory = workspaceDirectory;
    this.#path = join(workspaceDirectory, fileName);
  }

  async read(): Promise<ChatGptCredentialDocument | undefined> {
    let file;
    try {
      file = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new ChatGptAuthError("service_unavailable");
    }
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > maxFileBytes ||
        (process.platform !== "win32" &&
          ((info.mode & 0o077) !== 0 ||
            (process.getuid !== undefined && info.uid !== process.getuid())))
      )
        throw new ChatGptAuthError("service_unavailable");
      const value: unknown = JSON.parse(await file.readFile("utf8"));
      if (!isDocument(value)) throw new ChatGptAuthError("invalid_response");
      return value;
    } catch (error) {
      if (error instanceof ChatGptAuthError) throw error;
      throw new ChatGptAuthError("invalid_response");
    } finally {
      await file.close();
    }
  }

  async write(document: ChatGptCredentialDocument): Promise<void> {
    const temporary = join(this.#directory, `.${fileName}.${randomUUID()}.tmp`);
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const file = await open(temporary, "wx", 0o600);
      try {
        if (process.platform !== "win32") await file.chmod(0o600);
        await file.writeFile(`${JSON.stringify(document)}\n`, "utf8");
      } finally {
        await file.close();
      }
      await rename(temporary, this.#path);
    } catch {
      await unlink(temporary).catch(() => undefined);
      throw new ChatGptAuthError("service_unavailable");
    }
  }
}

function isDocument(value: unknown): value is ChatGptCredentialDocument {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.hostId === "string" &&
    hostIdPattern.test(value.hostId) &&
    Array.isArray(value.accounts) &&
    value.accounts.length <= maxChatGptAccounts &&
    value.accounts.every(isAccount) &&
    new Set(value.accounts.map(({ id }) => id)).size ===
      value.accounts.length &&
    new Set(value.accounts.map(({ clientId }) => clientId)).size ===
      value.accounts.length
  );
}

function isAccount(value: unknown): value is StoredChatGptAccount {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    accountIdPattern.test(value.id) &&
    isIssuedClientId(value.clientId) &&
    safeIdentityText(value.subject, 512) &&
    safeIdentityText(value.label, 350) &&
    (value.email === undefined || safeIdentityText(value.email, 320)) &&
    (value.tokens === undefined || isTokenRecord(value.tokens)) &&
    (value.needsReauthorization === undefined ||
      (value.needsReauthorization === true && value.tokens === undefined)) &&
    (value.revocationUnconfirmed === undefined ||
      (value.revocationUnconfirmed === true &&
        value.tokens === undefined &&
        value.needsReauthorization === undefined))
  );
}

function isTokenRecord(value: unknown): value is ChatGptTokens {
  return (
    isRecord(value) &&
    isToken(value.accessToken) &&
    (value.refreshToken === undefined || isToken(value.refreshToken)) &&
    (value.idToken === undefined || isToken(value.idToken)) &&
    Number.isSafeInteger(value.expiresAt) &&
    (value.earliestRefreshAt === undefined ||
      Number.isSafeInteger(value.earliestRefreshAt)) &&
    Array.isArray(value.scopes) &&
    value.scopes.every((scope: unknown) => safeIdentityText(scope, 4096))
  );
}
