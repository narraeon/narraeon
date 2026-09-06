import { useEffect, useState } from "react";
import type { ContentTreeFile } from "../protocol/v1.ts";
import type { RuntimeClient } from "./runtimeClient.ts";
import { uiText } from "./i18n.ts";

export function CreateWorldScreen({
  client,
  packages,
  selectedId,
  pending,
  modelConfigured,
  onSelect,
  onCreate,
  onEdit,
  onConfigureModel,
}: {
  client: Pick<RuntimeClient, "request">;
  packages: readonly {
    localId: string;
    title: string;
    status: "usable" | "needs_repair";
  }[];
  selectedId: string;
  pending: boolean;
  modelConfigured: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onEdit: () => void;
  onConfigureModel: () => void;
}): React.JSX.Element {
  const selected = packages.find(({ localId }) => localId === selectedId);
  const [preview, setPreview] = useState<{
    packageId: string;
    opening: string;
    failure: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    if (selectedId !== "") {
      void client
        .request<{ files: ContentTreeFile[] }>({
          type: "content.read",
          packageId: selectedId,
        })
        .then(({ files }) => {
          if (active)
            setPreview({
              packageId: selectedId,
              failure: "",
              opening:
                files.find(({ path }) => path === "opening.md")?.contents ?? "",
            });
        })
        .catch((error: unknown) => {
          if (active)
            setPreview({
              packageId: selectedId,
              opening: "",
              failure:
                error instanceof Error
                  ? error.message
                  : uiText("内容包读取失败"),
            });
        });
    }
    return () => {
      active = false;
    };
  }, [client, selectedId]);

  return (
    <main className="create-world-screen">
      <aside>
        <h1>{uiText("新建世界")}</h1>
        <p>{uiText("选择一份内容包，从它的开场开始。")}</p>
        {packages.length === 0 ? (
          <p>{uiText("先新建或导入一份内容包。")}</p>
        ) : (
          <label>
            {uiText("内容包")}
            <select
              aria-label={uiText("创建世界的内容包")}
              value={selectedId}
              disabled={pending}
              onChange={(event) => onSelect(event.currentTarget.value)}
            >
              {packages.map((item) => (
                <option key={item.localId} value={item.localId}>
                  {item.title}
                  {item.status === "needs_repair" ? uiText(" · 需要修复") : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {selected?.status === "needs_repair" && (
          <p role="status">{uiText("内容包需要修复后才能创建世界。")}</p>
        )}
        {!modelConfigured && (
          <button type="button" disabled={pending} onClick={onConfigureModel}>
            {uiText("配置模型连接")}
          </button>
        )}
        <button
          type="button"
          className="primary-button"
          disabled={
            pending || !modelConfigured || selected?.status !== "usable"
          }
          onClick={onCreate}
        >
          {pending ? uiText("正在创建世界…") : uiText("从当前内容包创建")}
        </button>
        <button type="button" disabled={pending} onClick={onEdit}>
          {uiText(selected === undefined ? "新建内容包" : "完善这份内容包")}
        </button>
        <small>{uiText("新世界独立保存，之后的游玩不会修改源内容包。")}</small>
      </aside>
      <article aria-label={uiText("开场白预览")}>
        <span>{uiText("开场白")}</span>
        <h2>{selected?.title}</h2>
        {preview?.packageId === selectedId && preview.failure ? (
          <p role="alert">{preview.failure}</p>
        ) : preview?.packageId === selectedId ? (
          <p className="create-world-opening">
            {preview.opening || uiText("这份内容包还没有开场白。")}
          </p>
        ) : selected !== undefined ? (
          <p role="status">{uiText("正在读取开场白…")}</p>
        ) : null}
      </article>
    </main>
  );
}
