import { getWebLocale } from "./i18n.ts";

/** The command has a receipt. Only the subsequent view update failed. */
export class ProjectionRefreshError extends Error {
  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      getWebLocale() === "en"
        ? `The operation completed, but the page could not refresh. ${reason}`
        : `操作已完成，但页面刷新失败。${reason}`,
      { cause },
    );
    this.name = "ProjectionRefreshError";
  }
}

export async function readAfterCommit<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (cause) {
    if (cause instanceof ProjectionRefreshError) throw cause;
    throw new ProjectionRefreshError(cause);
  }
}
