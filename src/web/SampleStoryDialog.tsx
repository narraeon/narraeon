import { useLayoutEffect, useId, useRef, useState } from "react";

import type { SampleContentPackageId } from "../protocol/sampleContentPackages.ts";
import { sampleStoryChoices } from "../shared/sample-packages/catalog.ts";
import { useAndroidBack } from "./androidBridge.ts";
import { getWebLocale, uiText } from "./i18n.ts";

export function SampleStoryDialog({
  pending,
  opener,
  onCancel,
  onChoose,
}: {
  pending: boolean;
  opener: HTMLButtonElement;
  onCancel: () => void;
  onChoose: (id: SampleContentPackageId) => Promise<void>;
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [failure, setFailure] = useState("");

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    opener.focus({ preventScroll: true });
    dialog?.showModal();
    return () => {
      dialog?.close();
      opener.focus({ preventScroll: true });
    };
  }, [opener]);

  function cancel(): void {
    if (!pending) onCancel();
  }

  useAndroidBack(true, cancel);

  async function choose(id: SampleContentPackageId): Promise<void> {
    if (pending) return;
    setFailure("");
    try {
      await onChoose(id);
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : uiText("内容包创建失败"),
      );
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="sample-story-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      <div className="sample-story-panel">
        <h2 id={titleId}>{uiText("选择一个故事")}</h2>
        <ul className="sample-story-list">
          {sampleStoryChoices(getWebLocale()).map((story) => {
            const id = titleId + "-" + story.id;
            return (
              <li key={story.id}>
                <button
                  type="button"
                  disabled={pending}
                  aria-labelledby={id + "-title"}
                  aria-describedby={id + "-genre " + id + "-premise"}
                  onClick={() => void choose(story.id)}
                >
                  <span className="sample-story-genre" id={id + "-genre"}>
                    {story.genre}
                  </span>
                  <strong id={id + "-title"}>{story.title}</strong>
                  <span className="sample-story-premise" id={id + "-premise"}>
                    {story.premise}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {failure !== "" && (
          <p className="create-package-failure" role="alert">
            {failure}
          </p>
        )}
        <footer className="button-row">
          {pending && <p role="status">{uiText("正在准备故事…")}</p>}
          <button
            type="button"
            className="secondary-button"
            disabled={pending}
            onClick={cancel}
          >
            {uiText("取消")}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
