import { useEffect, useRef, useState } from "react";
import {
  isProtagonistTemplateContent,
  type ProtagonistTemplate,
  type ProtagonistTemplatesView,
} from "../protocol/protagonistTemplates.ts";
import type { V1Request } from "../protocol/v1.ts";
import type { RuntimeClient } from "./runtimeClient.ts";
import { uiText } from "./i18n.ts";

export function ProtagonistTemplateManager({
  client,
  templates,
  onChange,
  onClose,
  onNavigationLockChange,
}: {
  client: Pick<RuntimeClient, "request">;
  templates: ProtagonistTemplate[];
  onChange: (view: ProtagonistTemplatesView) => void;
  onClose: () => void;
  onNavigationLockChange?: (locked: boolean) => void;
}): React.JSX.Element {
  const [baseline, setBaseline] = useState<ProtagonistTemplate | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [failure, setFailure] = useState("");
  const dirty =
    name !== (baseline?.name ?? "") || body !== (baseline?.body ?? "");
  useEffect(() => {
    onNavigationLockChange?.(dirty || pending);
    return () => onNavigationLockChange?.(false);
  }, [dirty, pending, onNavigationLockChange]);
  function mayLeave(): boolean {
    return (
      !pendingRef.current &&
      (!dirty || globalThis.confirm(uiText("放弃未保存的主角模板修改？")))
    );
  }
  function select(template: ProtagonistTemplate | null): void {
    setBaseline(template);
    setName(template?.name ?? "");
    setBody(template?.body ?? "");
    setFailure("");
  }
  async function mutate(request: V1Request): Promise<void> {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setFailure("");
    try {
      const view = await client.request<ProtagonistTemplatesView>(request);
      onChange(view);
      select(
        request.type === "protagonist-templates.delete"
          ? null
          : request.type === "protagonist-templates.save" &&
              request.id !== undefined
            ? (view.templates.find(({ id }) => id === request.id) ?? null)
            : (view.templates.at(-1) ?? null),
      );
    } catch (error: unknown) {
      setFailure(
        error instanceof Error ? error.message : uiText("主角模板保存失败"),
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  return (
    <div className="protagonist-template-scrim">
      <section
        className="protagonist-template-manager"
        role="dialog"
        aria-modal="true"
        aria-labelledby="protagonist-templates-title"
      >
        <header>
          <h2 id="protagonist-templates-title">{uiText("管理主角模板")}</h2>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (mayLeave()) onClose();
            }}
          >
            {uiText("关闭")}
          </button>
        </header>
        <div className="protagonist-template-columns">
          <nav aria-label={uiText("主角模板列表")}>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (mayLeave()) select(null);
              }}
            >
              {uiText("新建主角模板")}
            </button>
            {templates.map((template) => (
              <button
                type="button"
                key={template.id}
                disabled={pending}
                aria-pressed={baseline?.id === template.id}
                onClick={() => {
                  if (mayLeave()) select(template);
                }}
              >
                {template.name}
              </button>
            ))}
          </nav>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (isProtagonistTemplateContent(name, body))
                void mutate({
                  type: "protagonist-templates.save",
                  ...(baseline === null ? {} : { id: baseline.id }),
                  name,
                  body,
                });
            }}
          >
            <label>
              {uiText("模板名称")}
              <input
                aria-label={uiText("模板名称")}
                value={name}
                disabled={pending}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <label>
              {uiText("模板正文")}
              <textarea
                aria-label={uiText("模板正文")}
                value={body}
                disabled={pending}
                onChange={(event) => setBody(event.currentTarget.value)}
              />
            </label>
            <small>
              {uiText("名称为 1–80 个字符；正文为自由 Markdown，最多 16 KiB。")}
            </small>
            {failure && <p role="alert">{failure}</p>}
            <div className="button-row">
              <button
                className="primary-button"
                type="submit"
                disabled={
                  pending || !dirty || !isProtagonistTemplateContent(name, body)
                }
              >
                {uiText("保存")}
              </button>
              <button
                type="button"
                disabled={pending || baseline === null}
                onClick={() => {
                  if (baseline !== null && mayLeave())
                    void mutate({
                      type: "protagonist-templates.copy",
                      id: baseline.id,
                    });
                }}
              >
                {uiText("复制")}
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={pending || baseline === null}
                onClick={() => {
                  if (
                    baseline !== null &&
                    !pendingRef.current &&
                    globalThis.confirm(uiText("删除这个主角模板？"))
                  )
                    void mutate({
                      type: "protagonist-templates.delete",
                      id: baseline.id,
                    });
                }}
              >
                {uiText("删除")}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
