import { useLayoutEffect, useRef, type RefObject } from "react";
import { useAndroidBack } from "./androidBridge.ts";

function isVisible(element: HTMLElement): boolean {
  if (
    element.getClientRects().length === 0 ||
    getComputedStyle(element).visibility !== "visible"
  )
    return false;

  // WebKit can give children of collapsed disclosures a layout rectangle.
  for (
    let parent = element.parentElement;
    parent !== null;
    parent = parent.parentElement
  ) {
    if (parent instanceof HTMLDialogElement) break;
    if (
      parent instanceof HTMLDetailsElement &&
      !parent.open &&
      !parent.querySelector(":scope > summary")?.contains(element)
    )
      return false;
  }
  return true;
}

function isRadio(control: HTMLElement): control is HTMLInputElement {
  return control instanceof HTMLInputElement && control.type === "radio";
}

function isRadioTabStop(control: HTMLElement, ordered: HTMLElement[]): boolean {
  if (!isRadio(control) || control.name === "") return true;
  const group = ordered.filter(
    (other): other is HTMLInputElement =>
      isRadio(other) &&
      other.name === control.name &&
      other.form === control.form,
  );
  return (group.find((radio) => radio.checked) ?? group[0]) === control;
}

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
    // Move focus before the browser reacts to the disabled controls.
    if (open && busy) initialFocus.current?.focus();
  }, [open, busy, initialFocus]);

  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (open && (focused === document.body || focused === ref.current))
      initialFocus.current?.focus();
  });

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
      if (
        event.key !== "Tab" ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      const stops = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(
          "button, input, select, textarea, a[href], summary, [tabindex]",
        ),
      ).filter(
        (element) =>
          (element.tabIndex >= 0 || element.matches("summary:first-of-type")) &&
          !element.matches(":disabled") &&
          isVisible(element),
      );
      // WebKit's native sequence can omit buttons. Use the same order on every Tab.
      if (event.shiftKey) stops.reverse();
      const focused = stops.findIndex((stop) => stop === event.target);
      const cycle = [
        ...stops.slice(focused + 1),
        ...stops.slice(0, focused + 1),
      ];
      event.preventDefault();
      cycle.find((stop) => isRadioTabStop(stop, stops))?.focus();
    },
  };
}
