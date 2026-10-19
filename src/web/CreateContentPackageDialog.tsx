import { useEffect, useId, useRef, useState } from "react";

import type { Gameplay, ResolutionScheme } from "../protocol/gameplay.ts";
import { resolutionSchemeChoices } from "./gameplayChoices.ts";
import { uiText } from "./i18n.ts";

type GameplayMode = Gameplay["mode"];

/** The creation step for a content package: the gameplay mode, and the scheme when tabletop. */
export function CreateContentPackageDialog({
  pending,
  onCancel,
  onCreate,
}: {
  pending: boolean;
  onCancel: () => void;
  onCreate: (gameplay: Gameplay) => Promise<void>;
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [mode, setMode] = useState<GameplayMode>("interactive-fiction");
  const [scheme, setScheme] = useState<ResolutionScheme>("d100");
  const [failure, setFailure] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open === true) dialog.close();
    };
  }, []);

  async function submit(): Promise<void> {
    if (pending) return;
    setFailure("");
    try {
      await onCreate(
        mode === "tabletop"
          ? { mode: "tabletop", scheme }
          : { mode: "interactive-fiction" },
      );
    } catch (error: unknown) {
      setFailure(
        error instanceof Error ? error.message : uiText("内容包创建失败"),
      );
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="create-package-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        // Escape closes the dialog only through the parent, and never while a create is pending.
        event.preventDefault();
        if (!pending) onCancel();
      }}
    >
      <form
        className="create-package-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header>
          <h2 id={`${id}-title`}>{uiText("新建内容包")}</h2>
          <p>{uiText("内容包的玩法在创建时确定，之后不能切换。")}</p>
        </header>

        <fieldset className="create-package-choices" disabled={pending}>
          <legend>{uiText("玩法")}</legend>
          <label className="create-package-choice">
            <input
              type="radio"
              name={`${id}-mode`}
              value="interactive-fiction"
              checked={mode === "interactive-fiction"}
              onChange={() => setMode("interactive-fiction")}
            />
            <span>{uiText("互动式小说")}</span>
          </label>
          <label className="create-package-choice">
            <input
              type="radio"
              name={`${id}-mode`}
              value="tabletop"
              checked={mode === "tabletop"}
              onChange={() => setMode("tabletop")}
            />
            <span>{uiText("跑团")}</span>
          </label>
        </fieldset>

        {mode === "tabletop" ? (
          <fieldset className="create-package-choices" disabled={pending}>
            <legend>{uiText("判定方案")}</legend>
            {resolutionSchemeChoices().map((choice) => (
              <div className="create-package-choice-block" key={choice.scheme}>
                <label className="create-package-choice">
                  <input
                    type="radio"
                    name={`${id}-scheme`}
                    value={choice.scheme}
                    checked={scheme === choice.scheme}
                    aria-describedby={`${id}-${choice.scheme}-description`}
                    onChange={() => setScheme(choice.scheme)}
                  />
                  <span>{choice.label}</span>
                </label>
                <p
                  className="field-note"
                  id={`${id}-${choice.scheme}-description`}
                >
                  {choice.description}
                </p>
              </div>
            ))}
          </fieldset>
        ) : null}

        {failure === "" ? null : (
          <p className="create-package-failure" role="alert">
            {failure}
          </p>
        )}
        {pending ? <p role="status">{uiText("正在创建内容包…")}</p> : null}

        <footer className="button-row">
          <button
            type="button"
            className="secondary-button"
            disabled={pending}
            onClick={onCancel}
          >
            {uiText("取消")}
          </button>
          <button type="submit" disabled={pending}>
            {uiText("创建")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
