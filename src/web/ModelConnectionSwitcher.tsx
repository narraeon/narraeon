import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { ModelConnectionLibraryView } from "../protocol/modelConnections.ts";
import { DismissibleNotice } from "./DismissibleNotice.tsx";
import { useAndroidBack } from "./androidBridge.ts";
import { uiText } from "./i18n.ts";

export function ModelConnectionSwitcher({
  model,
  busy,
  onOpen,
  onSelect,
}: {
  model: ModelConnectionLibraryView;
  busy: boolean;
  onOpen: () => void;
  onSelect: (id: string) => Promise<boolean>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const label = uiText("快速切换模型连接");

  function close(): void {
    setError(null);
    setOpen(false);
  }
  function closeAndFocus(): void {
    close();
    trigger.current?.focus();
  }
  useAndroidBack(open, closeAndFocus);
  useEffect(() => {
    if (!open) return;
    const selected = menu.current?.querySelector<HTMLButtonElement>(
      '[aria-checked="true"]',
    );
    (selected ?? menu.current?.querySelector("button"))?.focus();
    function dismiss(event: PointerEvent): void {
      if (!root.current?.contains(event.target as Node)) close();
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  async function select(id: string): Promise<void> {
    if (busy) return;
    setError(null);
    try {
      if (id === model.activeConnectionId || (await onSelect(id))) {
        if (root.current?.contains(document.activeElement)) closeAndFocus();
        else close();
      }
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : uiText("操作失败"));
    }
  }

  function moveFocus(event: KeyboardEvent<HTMLDivElement>): void {
    const items = Array.from(event.currentTarget.querySelectorAll("button"));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case "Tab":
        if (event.shiftKey) {
          event.preventDefault();
          closeAndFocus();
        }
        return;
      case "ArrowDown":
        next = (index + 1) % items.length;
        break;
      case "ArrowUp":
        next = (index - 1 + items.length) % items.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    <div
      className="workspace-model-switcher"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.stopPropagation();
          closeAndFocus();
        }
      }}
    >
      <button
        type="button"
        className="workspace-model-toggle"
        ref={trigger}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "workspace-model-menu" : undefined}
        disabled={busy && !open}
        onClick={() => {
          if (open) close();
          else {
            onOpen();
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            onOpen();
            setOpen(true);
          }
        }}
      />
      {(open || error !== null) && (
        <div className="workspace-model-popover">
          {open && (
            <div
              id="workspace-model-menu"
              className="workspace-model-menu"
              ref={menu}
              role="menu"
              aria-label={label}
              aria-busy={busy}
              onKeyDown={moveFocus}
            >
              {model.connections.map(({ id, name, modelId }) => (
                <button
                  type="button"
                  key={id}
                  role="menuitemradio"
                  aria-checked={id === model.activeConnectionId}
                  aria-disabled={busy}
                  tabIndex={-1}
                  onClick={() => void select(id)}
                >
                  <span className="workspace-model-option-text">
                    <strong>{name}</strong>
                    <small>{modelId}</small>
                  </span>
                  {id === model.activeConnectionId && (
                    <span aria-hidden="true">✓</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {error !== null && (
            <DismissibleNotice
              className="workspace-model-switch-error"
              text={error}
              role="alert"
              onDismiss={() => setError(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
