import { useId, useLayoutEffect, useRef } from "react";
import { useAndroidBack } from "./androidBridge.ts";
import { uiText } from "./i18n.ts";

export interface ConfirmationRequest<Action> {
  action: Action;
  message: string;
  confirmLabel: string;
  opener: HTMLElement | null;
  fallback?: HTMLElement | null;
}

export function ConfirmationDialog({
  request: { message, confirmLabel, opener, fallback },
  onDecision,
}: {
  request: ConfirmationRequest<unknown>;
  onDecision: (confirmed: boolean) => void;
}): React.JSX.Element {
  const labelId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const decided = useRef(false);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    // Pointer activation does not focus buttons in every browser.
    opener?.focus({ preventScroll: true });
    dialog.showModal();
    cancelRef.current?.focus();
    return () => {
      dialog.close();
      opener?.focus({ preventScroll: true });
      if (document.activeElement !== opener)
        fallback?.focus({ preventScroll: true });
    };
  }, [opener, fallback]);

  function decide(confirmed: boolean): void {
    if (decided.current) return;
    decided.current = true;
    onDecision(confirmed);
  }

  useAndroidBack(true, () => decide(false));

  return (
    <dialog
      ref={dialogRef}
      className="confirmation-dialog"
      aria-labelledby={labelId}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        decide(false);
      }}
      onKeyDown={(event) => {
        // With two actions, either Tab direction moves to the other button.
        if (event.key !== "Tab" || event.defaultPrevented) return;
        event.preventDefault();
        const next =
          event.target === cancelRef.current ? confirmRef : cancelRef;
        next.current?.focus();
      }}
    >
      <p id={labelId}>{message}</p>
      <div className="button-row">
        <button ref={cancelRef} type="button" onClick={() => decide(false)}>
          {uiText("取消")}
        </button>
        <button
          ref={confirmRef}
          type="button"
          className="danger-button"
          onClick={() => decide(true)}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
