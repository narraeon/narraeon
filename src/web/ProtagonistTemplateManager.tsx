import {
  idleWorkspaceNavigation,
  type WorkspaceNavigationProtection,
} from "./WorkspaceLocation.ts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  isProtagonistTemplateContent,
  type ProtagonistTemplate,
  type ProtagonistTemplatesView,
} from "../protocol/protagonistTemplates.ts";
import type { V1Request } from "../protocol/v1.ts";
import type { RuntimeClient } from "./runtimeClient.ts";
import { uiText } from "./i18n.ts";
import { useModalDialog } from "./useModalDialog.ts";
import { useReadTarget } from "./useReadTarget.ts";
import { SyncNotice } from "./SyncNotice.tsx";
import {
  ConfirmationDialog,
  type ConfirmationRequest,
} from "./ConfirmationDialog.tsx";

type TemplateAction =
  | { type: "close" }
  | { type: "select"; templateId: string | null }
  | { type: "copy" | "delete"; template: ProtagonistTemplate };

interface TemplateConfirmation {
  next: TemplateAction;
  templateId: string | undefined;
  name: string;
  body: string;
}

export function ProtagonistTemplateManager({
  client,
  templates,
  opener,
  onChange,
  onClose,
  onNavigationProtectionChange,
}: {
  client: Pick<RuntimeClient, "request">;
  templates: ProtagonistTemplate[];
  opener: RefObject<HTMLButtonElement | null>;
  onChange: (view: ProtagonistTemplatesView) => void;
  onClose: () => void;
  onNavigationProtectionChange?: (
    protection: WorkspaceNavigationProtection,
  ) => void;
}): React.JSX.Element {
  const [baseline, setBaseline] = useState<ProtagonistTemplate | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [failure, setFailure] = useState("");
  const [confirmation, setConfirmation] =
    useState<ConfirmationRequest<TemplateConfirmation> | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const applyTemplates = useRef(onChange);
  useEffect(() => {
    applyTemplates.current = onChange;
  }, [onChange]);
  const {
    target: templatesTarget,
    syncFailed,
    syncError,
  } = useReadTarget(
    useCallback(
      () =>
        client.request<ProtagonistTemplatesView>({
          type: "protagonist-templates.read",
        }),
      [client],
    ),
    useCallback(
      (view: ProtagonistTemplatesView) => applyTemplates.current(view),
      [],
    ),
  );
  const dirty =
    name !== (baseline?.name ?? "") || body !== (baseline?.body ?? "");
  useLayoutEffect(() => {
    onNavigationProtectionChange?.({ dirty, busy: pending });
    return () => onNavigationProtectionChange?.(idleWorkspaceNavigation);
  }, [dirty, pending, onNavigationProtectionChange]);
  function perform(action: TemplateAction): void {
    if (pendingRef.current) return;
    if (action.type === "close") {
      onClose();
    } else if (action.type === "select") {
      const template = templates.find(({ id }) => id === action.templateId);
      if (action.templateId === null || template !== undefined)
        select(template ?? null);
    } else {
      const template = templates.find(({ id }) => id === action.template.id);
      if (template === undefined) return;
      if (
        action.type === "delete" &&
        (template.name !== action.template.name ||
          template.body !== action.template.body ||
          template.updatedAt !== action.template.updatedAt)
      )
        return;
      void mutate({
        type:
          action.type === "delete"
            ? "protagonist-templates.delete"
            : "protagonist-templates.copy",
        id: template.id,
      });
    }
  }

  function requestAction(
    next: TemplateAction,
    opener: HTMLElement | null,
  ): void {
    if (pendingRef.current || confirmation !== null) return;
    const deleting = next.type === "delete";
    if (!dirty && !deleting) {
      perform(next);
      return;
    }
    setConfirmation({
      action: { next, templateId: baseline?.id, name, body },
      opener,
      fallback: closeButton.current,
      message: deleting
        ? uiText("删除主角模板“{name}”？", { name: next.template.name })
        : uiText("放弃未保存的主角模板修改？"),
      confirmLabel: uiText(deleting ? "删除" : "放弃"),
    });
  }

  function decideAction(confirmed: boolean): void {
    setConfirmation(null);
    if (!confirmed || confirmation === null) return;
    const {
      next,
      templateId,
      name: shownName,
      body: shownBody,
    } = confirmation.action;
    if (templateId === baseline?.id && shownName === name && shownBody === body)
      perform(next);
  }
  const dialog = useModalDialog({
    open: true,
    busy: pending,
    opener,
    initialFocus: closeButton,
    onDismiss: () => requestAction({ type: "close" }, closeButton.current),
  });
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
      templatesTarget.accept();
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
      await templatesTarget.recover();
      setFailure(
        error instanceof Error ? error.message : uiText("主角模板保存失败"),
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  return (
    <>
      <dialog
        {...dialog}
        className="protagonist-template-manager"
        aria-labelledby="protagonist-templates-title"
      >
        <header>
          <h2 id="protagonist-templates-title">{uiText("管理主角模板")}</h2>
          <button
            ref={closeButton}
            type="button"
            aria-disabled={pending}
            onClick={(event) =>
              requestAction({ type: "close" }, event.currentTarget)
            }
          >
            {uiText("关闭")}
          </button>
        </header>
        <div className="protagonist-template-columns">
          <nav aria-label={uiText("主角模板列表")}>
            <button
              type="button"
              disabled={pending}
              aria-pressed={baseline === null}
              onClick={(event) =>
                requestAction(
                  { type: "select", templateId: null },
                  event.currentTarget,
                )
              }
            >
              {uiText("新建主角模板")}
            </button>
            {templates.map((template) => (
              <button
                type="button"
                key={template.id}
                disabled={pending}
                aria-pressed={baseline?.id === template.id}
                onClick={(event) =>
                  requestAction(
                    { type: "select", templateId: template.id },
                    event.currentTarget,
                  )
                }
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
            <SyncNotice
              failed={syncFailed}
              reason={syncError}
              onRead={() => void templatesTarget.recover()}
            />
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
                onClick={(event) => {
                  if (baseline !== null)
                    requestAction(
                      { type: "copy", template: baseline },
                      event.currentTarget,
                    );
                }}
              >
                {uiText("复制")}
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={pending || baseline === null}
                onClick={(event) => {
                  if (baseline !== null)
                    requestAction(
                      { type: "delete", template: baseline },
                      event.currentTarget,
                    );
                }}
              >
                {uiText("删除")}
              </button>
            </div>
          </form>
        </div>
      </dialog>
      {confirmation !== null && (
        <ConfirmationDialog request={confirmation} onDecision={decideAction} />
      )}
    </>
  );
}
