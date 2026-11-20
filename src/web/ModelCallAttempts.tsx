import { useState, type ReactNode } from "react";
import { uiText } from "./i18n.ts";

/** Old attempts are mounted only after an explicit disclosure, never prefetched. */
export function ModelCallAttempts<T>({
  attempts,
  render,
}: {
  attempts: readonly T[];
  render: (item: T) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const current = attempts.at(-1);
  if (current === undefined) return null;
  return (
    <div className="model-call-attempts">
      {render(current)}
      {attempts.length > 1 ? (
        <details
          className="model-call-attempt-history"
          onToggle={(event) => setOpen(event.currentTarget.open)}
        >
          <summary>
            {uiText("历史尝试")} ·{" "}
            {uiText("{count} 次尝试", { count: attempts.length - 1 })}
          </summary>
          {open ? (
            <div className="model-call-attempt-list">
              {attempts.slice(0, -1).map(render)}
            </div>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
