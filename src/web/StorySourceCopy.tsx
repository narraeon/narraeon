import { useState } from "react";
import { uiText } from "./i18n.ts";

export function StorySourceCopy({
  text,
  className,
}: {
  text: string;
  className: string;
}): React.JSX.Element {
  const [status, setStatus] = useState<"copied" | "failed" | null>(null);
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        void copySource(text).then(
          () => setStatus("copied"),
          () => setStatus("failed"),
        );
      }}
    >
      <span aria-live="polite">
        {status === "copied"
          ? uiText("已复制原文")
          : status === "failed"
            ? uiText("复制失败，重试")
            : uiText("复制原文")}
      </span>
    </button>
  );
}

async function copySource(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Older WebViews can expose the Clipboard API without granting access.
    }
  }

  // A browser connected to Narraeon over local-network HTTP has no Clipboard API.
  let copied = false;
  function write(event: ClipboardEvent): void {
    if (event.clipboardData === null) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    copied = true;
  }
  document.addEventListener("copy", write);
  try {
    if (!document.execCommand("copy") || !copied)
      throw new Error("Copy failed");
  } finally {
    document.removeEventListener("copy", write);
  }
}
