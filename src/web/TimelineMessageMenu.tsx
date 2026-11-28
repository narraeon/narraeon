import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useAndroidBack } from "./androidBridge.ts";
import styles from "./PlayTimeline.module.css";

const viewportInset = 8;
const triggerGap = 4;

export function TimelineMessageMenu({
  className,
  label,
  children,
  triggerRef,
}: {
  className?: string | undefined;
  label: string;
  children: ReactNode;
  triggerRef?: RefObject<HTMLButtonElement | null> | undefined;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const localTrigger = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? localTrigger;
  const panel = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  function closeAndFocus(): void {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }

  useAndroidBack(open, closeAndFocus);
  useLayoutEffect(() => {
    const anchor = trigger.current;
    const popup = panel.current;
    if (!open || anchor === null || popup === null) return;

    const viewport = window.visualViewport;
    const reader = anchor.closest(".world-reader-scroll");
    if (typeof popup.showPopover === "function") popup.showPopover();
    else popup.removeAttribute("popover");

    function dismiss(event: PointerEvent): void {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    }

    const place = (): void => {
      const button = anchor.getBoundingClientRect();
      if (button.width === 0 || button.height === 0) return;
      const left = (viewport?.offsetLeft ?? 0) + viewportInset;
      const top = (viewport?.offsetTop ?? 0) + viewportInset;
      const right =
        left + (viewport?.width ?? window.innerWidth) - 2 * viewportInset;
      const bottom =
        top + (viewport?.height ?? window.innerHeight) - 2 * viewportInset;
      const scroll = reader?.getBoundingClientRect();
      if (
        button.bottom <= Math.max(top, scroll?.top ?? top) ||
        button.top >= Math.min(bottom, scroll?.bottom ?? bottom) ||
        button.right <= Math.max(left, scroll?.left ?? left) ||
        button.left >= Math.min(right, scroll?.right ?? right)
      ) {
        setOpen(false);
        return;
      }
      popup.style.maxWidth = `min(20rem, ${right - left}px)`;
      // Use the full content height even after a shorter viewport has clipped it.
      const above = Math.max(0, button.top - triggerGap - top);
      const below = Math.max(0, bottom - button.bottom - triggerGap);
      const contentHeight =
        popup.scrollHeight + popup.offsetHeight - popup.clientHeight;
      const openAbove = contentHeight > below && above > below;
      popup.style.maxHeight = `${openAbove ? above : below}px`;
      popup.style.left = `${Math.max(left, Math.min(right, button.right) - popup.offsetWidth)}px`;
      popup.style.top = `${openAbove ? button.top - triggerGap - popup.offsetHeight : button.bottom + triggerGap}px`;
    };

    place();
    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    resize?.observe(anchor);
    resize?.observe(popup);
    if (reader !== null) resize?.observe(reader);
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    return () => {
      resize?.disconnect();
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
    };
  }, [open, trigger]);

  return (
    <span
      className={
        className
          ? `${styles.messageActions} ${className}`
          : styles.messageActions
      }
      ref={root}
      onBlur={(event) => {
        if (
          event.relatedTarget !== null &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
      onKeyDown={(event) => {
        if (!open || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        closeAndFocus();
      }}
    >
      <button
        type="button"
        className={styles.messageActionsTrigger}
        ref={trigger}
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={(event) => {
          if (open) closeAndFocus();
          else {
            event.currentTarget.focus({ preventScroll: true });
            setOpen(true);
          }
        }}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <span
          className={styles.messageActionsPanel}
          id={panelId}
          ref={panel}
          popover="manual"
          role="group"
          aria-label={label}
          onClick={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest(
                'button[data-close-message-menu]:not(:disabled, [aria-disabled="true"])',
              )
            )
              closeAndFocus();
          }}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}
