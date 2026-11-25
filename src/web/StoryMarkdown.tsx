import { memo, useDeferredValue } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import { openAndroidStoryLink } from "./androidBridge.ts";
import styles from "./StoryMarkdown.module.css";

const components: Components = {
  a: ({ href, title, children }) =>
    href ? (
      <a
        href={href}
        title={title}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          if (event.isTrusted && openAndroidStoryLink(href))
            event.preventDefault();
        }}
      >
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  img: ({ alt }) => <>{alt}</>,
};

const remarkPlugins = [remarkBreaks];
const deferredMarkdownLength = 2_048;

export const StoryMarkdown = memo(function StoryMarkdown({
  text,
  className,
  streaming = false,
}: {
  text: string;
  className?: string;
  streaming?: boolean;
}): React.JSX.Element {
  const defer = streaming && text.length >= deferredMarkdownLength;
  // Prioritize input and timeline updates once an in-flight reply is long.
  const deferredText = useDeferredValue(defer ? text : null);
  return (
    <div className={className ? `${styles.body} ${className}` : styles.body}>
      <MarkdownContent text={defer ? (deferredText ?? text) : text} />
    </div>
  );
});

const MarkdownContent = memo(function MarkdownContent({
  text,
}: {
  text: string;
}): React.JSX.Element {
  // react-markdown escapes raw HTML by default.
  return (
    <Markdown
      components={components}
      remarkPlugins={remarkPlugins}
      urlTransform={storyUrl}
    >
      {text}
    </Markdown>
  );
});

function storyUrl(url: string, key: string): string | undefined {
  if (key !== "href" || !/^https?:\/\//iu.test(url)) return;
  try {
    return new URL(url).href;
  } catch {
    return undefined;
  }
}
