import { useLayoutEffect, useRef, type RefObject } from "react";
import { useAndroidBack } from "./androidBridge.ts";

export function useModalDialog({
  open,
  busy,
  opener,
  initialFocus,
  onDismiss,
}: {
  open: boolean;
  busy: boolean;
  opener: RefObject<HTMLElement | null>;
  initialFocus: RefObject<HTMLElement | null>;
  onDismiss: () => void;
}): React.ComponentPropsWithRef<"dialog"> {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!open || dialog === null) return;
    const returnTo = opener.current;
    dialog.showModal();
    initialFocus.current?.focus();
    return () => {
      dialog.close();
      returnTo?.focus({ preventScroll: true });
      // A nested confirmation may still be closing during the same commit.
      if (returnTo && document.activeElement !== returnTo)
        queueMicrotask(() => {
          if (document.activeElement === document.body)
            returnTo.focus({ preventScroll: true });
        });
    };
  }, [open, opener, initialFocus]);

  useLayoutEffect(() => {
    // Starting a command can disable the control that had focus.
    if (open && busy && !ref.current?.contains(document.activeElement))
      initialFocus.current?.focus();
  }, [open, busy, initialFocus]);

  function dismiss(): void {
    if (!busy) onDismiss();
  }
  useAndroidBack(open, dismiss);

  return {
    ref,
    onCancel(event) {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    },
    onKeyDown(event) {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      const stops = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(
          "button, input, select, textarea, a[href], summary, [tabindex]",
        ),
      ).filter(
        (element) =>
          (element.tabIndex >= 0 || element.matches("summary:first-of-type")) &&
          !element.matches(":disabled") &&
          element.getClientRects().length > 0 &&
          getComputedStyle(element).visibility === "visible",
      );
      const edge = event.shiftKey ? stops[0] : stops.at(-1);
      // Native modality makes the page inert, but Tab can still reach browser chrome.
      if (event.target !== edge && event.target !== event.currentTarget) return;
      event.preventDefault();
      (event.shiftKey ? stops.at(-1) : stops[0])?.focus();
    },
  };
}
