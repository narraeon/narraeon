import {
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { useAndroidBack } from "./androidBridge.ts";

const viewportMargin = 8;
const triggerGap = 6;

export function HomeCardActions({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}): React.JSX.Element {
  const panelId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  function closeAndFocus() {
    onToggle(false);
    triggerRef.current?.focus({ preventScroll: true });
  }

  useAndroidBack(open, closeAndFocus);
  const close = useEffectEvent(() => onToggle(false));
  const handleEscape = useEffectEvent(closeAndFocus);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!open || wrapper === null || trigger === null || panel === null) return;
    const workspace = wrapper.closest(".workspace-body");
    const viewport = window.visualViewport;
    const url = window.location.href;

    const position = () => {
      const anchor = trigger.getBoundingClientRect();
      if (!anchor.width || !anchor.height) return;
      const frame = workspace?.getBoundingClientRect();
      const left = (viewport?.offsetLeft ?? 0) + viewportMargin;
      const right =
        Math.min(
          (viewport?.offsetLeft ?? 0) +
            (viewport?.width ?? document.documentElement.clientWidth),
          frame?.right ?? Infinity,
        ) - viewportMargin;
      const top = Math.max(
        (viewport?.offsetTop ?? 0) + viewportMargin,
        frame?.top ?? 0,
      );
      const bottom =
        Math.min(
          (viewport?.offsetTop ?? 0) +
            (viewport?.height ?? document.documentElement.clientHeight),
          frame?.bottom ?? Infinity,
        ) - viewportMargin;
      if (
        anchor.bottom <= top ||
        anchor.top >= bottom ||
        anchor.right <= left ||
        anchor.left >= right
      ) {
        close();
        return;
      }
      // Place the panel beside the trigger so it leaves the next row's trigger reachable.
      const before = anchor.left - triggerGap - left;
      const after = right - anchor.right - triggerGap;
      const placeBefore = before >= after;
      panel.style.maxWidth = `${Math.max(before, after)}px`;
      panel.style.maxHeight = `${bottom - top}px`;
      panel.style.left = `${placeBefore ? anchor.left - triggerGap - panel.offsetWidth : anchor.right + triggerGap}px`;
      panel.style.top = `${Math.min(Math.max(top, anchor.top), bottom - panel.offsetHeight)}px`;
    };

    const isInDialog = (target: EventTarget | null) =>
      target instanceof Element && target.closest("dialog[open]") !== null;
    const dismissOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !wrapper.contains(event.target) &&
        !isInDialog(event.target)
      )
        close();
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        isInDialog(event.target)
      )
        return;
      event.preventDefault();
      handleEscape();
    };
    const dismissNavigation = () => {
      if (window.location.href !== url) close();
    };

    position();
    const size =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(position);
    size?.observe(panel);
    size?.observe(trigger);
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    window.addEventListener("popstate", dismissNavigation);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      size?.disconnect();
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("popstate", dismissNavigation);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, [open]);

  return (
    <div
      ref={wrapperRef}
      className="home-world-card-actions"
      onKeyDown={(event) => {
        if (!open || (event.key !== "ArrowDown" && event.key !== "ArrowUp"))
          return;
        const buttons = Array.from(
          panelRef.current?.querySelectorAll<HTMLButtonElement>(
            "button:enabled",
          ) ?? [],
        );
        if (buttons.length === 0) return;
        event.preventDefault();
        const current = buttons.findIndex(
          (button) => button === document.activeElement,
        );
        const next =
          event.key === "ArrowDown"
            ? (current + 1) % buttons.length
            : (Math.max(current, 0) + buttons.length - 1) % buttons.length;
        buttons[next]?.focus();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-controls={panelId}
        aria-expanded={open}
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          onToggle(!open);
        }}
      >
        ⋯
      </button>
      <div
        ref={panelRef}
        id={panelId}
        className="home-card-actions-panel"
        hidden={!open}
      >
        {children}
      </div>
    </div>
  );
}
