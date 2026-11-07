import { useCallback, useLayoutEffect, useRef, useState } from "react";

function resizeTextarea(element: HTMLTextAreaElement): void {
  element.style.height = "0px";
  const style = getComputedStyle(element);
  const borders =
    (parseFloat(style.borderTopWidth) || 0) +
    (parseFloat(style.borderBottomWidth) || 0);
  element.style.height = `${element.scrollHeight + borders}px`;
  element.style.overflowY =
    element.clientHeight > 0 && element.scrollHeight > element.clientHeight
      ? "auto"
      : "hidden";
}

/** Size the attached textarea for its value and available width. CSS owns the limits. */
export function useAutosizeTextarea(value: string): {
  ref: (element: HTMLTextAreaElement | null) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
} {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [element, setElement] = useState<HTMLTextAreaElement | null>(null);
  const ref = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node;
    setElement(node);
  }, []);

  const resize = useCallback(() => {
    if (element === null) return;
    resizeTextarea(element);
  }, [element]);

  useLayoutEffect(() => {
    resize();
  }, [resize, value]);

  useLayoutEffect(() => {
    if (element === null || typeof ResizeObserver === "undefined") return;
    let width: number | undefined;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width;
      if (nextWidth === undefined || nextWidth === width) return;
      width = nextWidth;
      resize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, resize]);

  return { ref, textareaRef };
}
