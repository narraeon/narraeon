import { useId, useRef, useState, type RefObject } from "react";

import type { SampleContentPackageId } from "../protocol/sampleContentPackages.ts";
import { sampleStoryChoices } from "../shared/sample-packages/catalog.ts";
import { getWebLocale, uiText } from "./i18n.ts";
import { useModalDialog } from "./useModalDialog.ts";

export function SampleStoryDialog({
  pending,
  opener,
  onCancel,
  onChoose,
}: {
  pending: boolean;
  opener: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onChoose: (id: SampleContentPackageId) => Promise<void>;
}): React.JSX.Element {
  const initialFocus = useRef<HTMLButtonElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const [failure, setFailure] = useState("");

  const dialog = useModalDialog({
    open: true,
    busy: pending,
    opener,
    initialFocus,
    busyFocus: title,
    onDismiss: onCancel,
  });

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
      {...dialog}
      className="sample-story-dialog"
      aria-labelledby={titleId}
    >
      <div className="sample-story-panel">
        <h2 ref={title} id={titleId} tabIndex={-1}>
          {uiText("选择一个故事")}
        </h2>
        <ul className="sample-story-list">
          {sampleStoryChoices(getWebLocale()).map((story, index) => {
            const id = titleId + "-" + story.id;
            return (
              <li key={story.id}>
                <button
                  ref={index === 0 ? initialFocus : undefined}
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
            onClick={onCancel}
          >
            {uiText("取消")}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
