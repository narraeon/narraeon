import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  chatGptUsageUrl,
  type ChatGptAccount,
  type ChatGptDisconnectResult,
  type ChatGptModel,
  type ChatGptSignInResult,
} from "../protocol/chatGptAuth.ts";
import { ConfirmationDialog } from "./ConfirmationDialog.tsx";
import { uiText } from "./i18n.ts";
import type { RuntimeClient } from "./runtimeClient.ts";

export interface ChatGptCatalog {
  accountId: string;
  models: ChatGptModel[];
}

const accountStatus: Record<ChatGptAccount["status"], string> = {
  signed_out: "已退出 ChatGPT",
  signed_in: "已登录 ChatGPT，尚未授权使用套餐",
  plan_authorized: "已授权使用 ChatGPT 套餐",
  reauthorization_required: "ChatGPT 授权已失效，请重新登录",
};

export function ChatGptUsageLink(): React.JSX.Element {
  return (
    <a href={chatGptUsageUrl} rel="noreferrer" target="_blank">
      {uiText("管理 ChatGPT 用量")}
    </a>
  );
}

export function ChatGptConnectionFields({
  client,
  accountId,
  modelId,
  catalog,
  onAccountChange,
  onModelChange,
  onCatalog,
  onAuthChanged,
}: {
  client: RuntimeClient;
  accountId: string;
  modelId: string;
  catalog: ChatGptCatalog | null;
  onAccountChange: (accountId: string) => void;
  onModelChange: (modelId: string) => void;
  onCatalog: (catalog: ChatGptCatalog | null) => void;
  onAuthChanged: () => Promise<unknown>;
}): React.JSX.Element {
  const [accounts, setAccounts] = useState<ChatGptAccount[] | null>(null);
  const [action, setAction] = useState<
    "sign-in" | "refresh" | "disconnect" | null
  >(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [catalogReload, setCatalogReload] = useState(0);
  const [accountsReload, setAccountsReload] = useState(0);
  const [disconnectOpener, setDisconnectOpener] =
    useState<HTMLButtonElement | null>(null);
  const [showIntro, setShowIntro] = useState(false);
  const account = accounts?.find(({ id }) => id === accountId);
  const authorized = account?.status === "plan_authorized";
  const connected = authorized || account?.status === "signed_in";
  const working = action !== null || attemptId !== null;
  const models =
    catalog?.accountId === accountId && authorized ? catalog.models : null;
  const settled = useRef({ onAccountChange, onAuthChanged, accounts });
  useLayoutEffect(() => {
    settled.current = { onAccountChange, onAuthChanged, accounts };
  }, [onAccountChange, onAuthChanged, accounts]);

  useEffect(() => {
    let current = true;
    void client
      .request<ChatGptAccount[]>({ type: "model.chatgpt.accounts" })
      .then(
        (next) => {
          if (current) setAccounts(next);
        },
        (error: unknown) => {
          if (current) setNotice(errorText(error));
        },
      );
    return () => {
      current = false;
    };
  }, [client, accountsReload]);

  useEffect(() => {
    if (!authorized) return;
    let current = true;
    void client
      .request<ChatGptModel[]>({
        type: "model.chatgpt.models",
        accountId,
      })
      .then(
        (next) => {
          if (current) onCatalog({ accountId, models: next });
        },
        (error: unknown) => {
          if (current) {
            onCatalog(null);
            setNotice(errorText(error));
            setAccountsReload((revision) => revision + 1);
            void settled.current.onAuthChanged();
          }
        },
      );
    return () => {
      current = false;
    };
  }, [accountId, authorized, catalogReload, client, onCatalog]);

  useEffect(() => {
    if (attemptId === null) return;
    let current = true;
    let timer: number | undefined;
    async function poll(id: string): Promise<void> {
      try {
        const result = await client.request<ChatGptSignInResult>({
          type: "model.chatgpt.sign-in-status",
          attemptId: id,
        });
        if (!current) return;
        if (result.status === "pending") {
          timer = window.setTimeout(() => void poll(id), 1_000);
          return;
        }
        setAttemptId(null);
        if (result.account !== undefined) {
          const signedIn = result.account;
          const previous = settled.current.accounts?.find(
            ({ id: existing }) => existing === signedIn.id,
          );
          replaceAccount(signedIn);
          settled.current.onAccountChange(signedIn.id);
          setCatalogReload((revision) => revision + 1);
          if (
            signedIn.status === "plan_authorized" &&
            previous?.status !== "plan_authorized" &&
            !introWasSeen(signedIn.id)
          )
            setShowIntro(true);
        }
        setNotice(
          result.message ??
            (result.status === "denied" ? uiText("ChatGPT 登录已取消。") : ""),
        );
        void settled.current.onAuthChanged();
      } catch (error: unknown) {
        if (!current) return;
        setAttemptId(null);
        setNotice(errorText(error));
        setAccountsReload((revision) => revision + 1);
      }
    }
    void poll(attemptId);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [attemptId, client]);

  function replaceAccount(account: ChatGptAccount): void {
    setAccounts((previous) => [
      ...(previous ?? []).filter(({ id }) => id !== account.id),
      account,
    ]);
  }

  async function signIn(forAccountId?: string): Promise<void> {
    if (working) return;
    setNotice("");
    setAction("sign-in");
    try {
      const result = await client.request<{ attemptId: string }>({
        type: "model.chatgpt.sign-in",
        requestPlanConsent:
          forAccountId !== undefined && account?.status === "signed_in",
        ...(forAccountId === undefined ? {} : { accountId: forAccountId }),
      });
      setAttemptId(result.attemptId);
    } catch (error: unknown) {
      setNotice(errorText(error));
    } finally {
      setAction(null);
    }
  }

  async function updateAccount(kind: "refresh" | "disconnect"): Promise<void> {
    if (account === undefined || working) return;
    setNotice("");
    setAction(kind);
    onCatalog(null);
    try {
      if (kind === "refresh") {
        replaceAccount(
          await client.request<ChatGptAccount>({
            type: "model.chatgpt.refresh",
            accountId: account.id,
          }),
        );
        setCatalogReload((revision) => revision + 1);
        setNotice(uiText("已刷新 ChatGPT 授权。"));
      } else {
        const result = await client.request<ChatGptDisconnectResult>({
          type: "model.chatgpt.disconnect",
          accountId: account.id,
        });
        replaceAccount(result.account);
        setNotice(
          uiText(
            result.remoteRevocationConfirmed
              ? "已断开此工作区的 ChatGPT 账号。"
              : "已从本机移除 ChatGPT 凭据。请在 ChatGPT 设置中确认授权已撤销。",
          ),
        );
      }
    } catch (error: unknown) {
      setNotice(errorText(error));
      setAccountsReload((revision) => revision + 1);
      setCatalogReload((revision) => revision + 1);
    } finally {
      void onAuthChanged();
      setAction(null);
    }
  }

  return (
    <>
      <div>
        <p className="field-note">
          {uiText("符合条件的请求将使用你的 ChatGPT 套餐或额度。")}{" "}
          <ChatGptUsageLink />
        </p>
        <label htmlFor="chatgpt-account">{uiText("ChatGPT 账号")}</label>
        <select
          id="chatgpt-account"
          disabled={accounts === null || working}
          value={account?.id ?? ""}
          onChange={(event) => {
            onCatalog(null);
            onAccountChange(event.target.value);
            setNotice("");
          }}
        >
          <option value="">{uiText("选择 ChatGPT 账号")}</option>
          {accounts?.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.email ?? entry.label}
            </option>
          ))}
        </select>
        <p className="field-note">
          {account === undefined
            ? uiText(
                accounts === null
                  ? "正在读取 ChatGPT 账号…"
                  : "尚未选择 ChatGPT 账号",
              )
            : uiText(accountStatus[account.status])}
        </p>
        <div className="form-actions">
          {!authorized && (
            <button
              className="secondary-button"
              type="button"
              disabled={working}
              onClick={() => void signIn(account?.id)}
            >
              {uiText(
                account?.status === "signed_in"
                  ? "授权使用 ChatGPT 套餐"
                  : "使用 ChatGPT 继续",
              )}
            </button>
          )}
          {account !== undefined && (
            <button
              className="secondary-button"
              type="button"
              disabled={working}
              onClick={() => void signIn()}
            >
              {uiText("登录另一个 ChatGPT 账号")}
            </button>
          )}
          {connected && (
            <button
              className="secondary-button"
              type="button"
              disabled={working}
              onClick={() => void updateAccount("refresh")}
            >
              {uiText("刷新 ChatGPT 授权")}
            </button>
          )}
          {account !== undefined && account.status !== "signed_out" && (
            <button
              className="secondary-button"
              type="button"
              disabled={working}
              onClick={(event) => setDisconnectOpener(event.currentTarget)}
            >
              {uiText("断开 ChatGPT 账号")}
            </button>
          )}
        </div>
        <div className="field-note" role="status">
          {attemptId !== null
            ? uiText("请在系统浏览器完成 ChatGPT 登录。")
            : action === "sign-in"
              ? uiText("正在打开系统浏览器…")
              : action === "refresh"
                ? uiText("正在刷新 ChatGPT 授权…")
                : action === "disconnect"
                  ? uiText("正在断开 ChatGPT 账号…")
                  : notice}
        </div>
      </div>
      {authorized && (
        <div>
          <label htmlFor="chatgpt-model">{uiText("ChatGPT 模型")}</label>
          <select
            id="chatgpt-model"
            value={
              models?.some(({ id }) => id === modelId) === true ? modelId : ""
            }
            disabled={working || models === null}
            onChange={(event) => onModelChange(event.target.value)}
          >
            <option value="">{uiText("选择模型")}</option>
            {models?.map(({ id, displayName }) => (
              <option key={id} value={id}>
                {displayName}
              </option>
            ))}
          </select>
          {models?.length === 0 && (
            <p className="field-note">
              {uiText("此账号没有可用的 ChatGPT 模型。")}
            </p>
          )}
          <button
            className="secondary-button"
            type="button"
            disabled={working}
            onClick={() => {
              setNotice("");
              onCatalog(null);
              setCatalogReload((revision) => revision + 1);
            }}
          >
            {uiText("重新加载 ChatGPT 模型")}
          </button>
        </div>
      )}
      {disconnectOpener !== null && (
        <ConfirmationDialog
          request={{
            action: null,
            message: uiText(
              "断开这个 ChatGPT 账号？使用它的模型连接需要重新登录。",
            ),
            confirmLabel: uiText("断开"),
            opener: disconnectOpener,
          }}
          onDecision={(confirmed) => {
            setDisconnectOpener(null);
            if (confirmed) void updateAccount("disconnect");
          }}
        />
      )}
      {showIntro && (
        <ChatGptPlanIntro
          onDismiss={() => {
            if (account !== undefined) rememberIntro(account.id);
            setShowIntro(false);
          }}
        />
      )}
    </>
  );
}

function ChatGptPlanIntro({
  onDismiss,
}: {
  onDismiss: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="confirmation-dialog"
      aria-labelledby={id}
      onCancel={onDismiss}
    >
      <h3 id={id}>{uiText("你已授权使用 ChatGPT 套餐")}</h3>
      <p>
        {uiText(
          "启用这份连接后，符合条件的请求将使用你的 ChatGPT 套餐或额度。",
        )}
      </p>
      <p>
        <ChatGptUsageLink />
      </p>
      <div className="button-row">
        <button type="button" autoFocus onClick={onDismiss}>
          {uiText("知道了")}
        </button>
      </div>
    </dialog>
  );
}

function introStorageKey(accountId: string): string {
  return `narraeon.chatgpt.intro.${accountId}`;
}

function introWasSeen(accountId: string): boolean {
  try {
    return localStorage.getItem(introStorageKey(accountId)) === "1";
  } catch {
    return false;
  }
}

function rememberIntro(accountId: string): void {
  try {
    localStorage.setItem(introStorageKey(accountId), "1");
  } catch {
    // Private browser storage may be unavailable.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : uiText("ChatGPT 账号操作失败。");
}
