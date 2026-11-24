import { FileNativeWorldStore } from "../runtime/world/FileNativeWorldStore.ts";

export async function grepHistory(
  dataRoot: string,
  worldId: string,
  query: string,
  writeOutput: (message: string) => void,
  writeError: (message: string) => void,
): Promise<0 | 1 | 2> {
  try {
    const history = await new FileNativeWorldStore(dataRoot).openHistoryQuery(
      worldId,
    );
    let page = history.search({ queries: [query], limit: 50 });
    for (;;) {
      if (!page.ok) {
        writeError(`Narraeon history grep: ${page.recovery}\n`);
        return 2;
      }
      for (const { message, fragments } of page.messages)
        for (const { start, text } of fragments)
          writeOutput(`${message.ref}:${start}: ${JSON.stringify(text)}\n`);
      if (page.nextCursor === null) return page.matches === 0 ? 1 : 0;
      page = history.search({ cursor: page.nextCursor });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    writeError(`Narraeon history grep: ${message}\n`);
    return 2;
  }
}
