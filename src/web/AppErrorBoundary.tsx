import { Component, type ErrorInfo, type ReactNode } from "react";

import { uiText } from "./i18n.ts";

interface AppErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

/** Replaces a blank page after a render failure with the reason and a reload. */
export class AppErrorBoundary extends Component<
  { children: ReactNode },
  AppErrorBoundaryState
> {
  override state: AppErrorBoundaryState = {
    error: null,
    componentStack: null,
  };

  static getDerivedStateFromError(
    error: unknown,
  ): Partial<AppErrorBoundaryState> {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    console.error(error);
  }

  override render(): ReactNode {
    const { error, componentStack } = this.state;
    if (error === null) return this.props.children;
    const details = [error.stack ?? `${error.name}: ${error.message}`]
      .concat(componentStack === null ? [] : [componentStack.trim()])
      .join("\n\n");
    return (
      <main className="center-card app-error-boundary" role="alert">
        <h1>{uiText("页面出错了")}</h1>
        <p>
          {uiText(
            "页面显示时发生错误，已保存的故事和世界不受影响。请重新加载页面；如果反复出现，请把下面的技术详情发给开发者。",
          )}
        </p>
        <p className="app-error-message">{error.message}</p>
        <div className="app-error-actions">
          <button type="button" onClick={() => window.location.reload()}>
            {uiText("重新加载页面")}
          </button>
        </div>
        <details>
          <summary>{uiText("技术详情")}</summary>
          <pre>{details}</pre>
        </details>
      </main>
    );
  }
}
