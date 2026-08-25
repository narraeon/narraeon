/**
 * Server-sent event framing shared by every streaming provider.
 *
 * Providers disagree about payload shape but agree about framing, so the split
 * is here: this module turns bytes into events and never interprets `data`.
 * Chunk boundaries fall anywhere — mid-line, mid-UTF-8 — so lines are buffered
 * until a terminator arrives rather than parsed per chunk.
 */
export interface ProviderStreamEvent {
  readonly event: string | null;
  readonly data: string;
}

export async function* providerStreamEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ProviderStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let event: string | null = null;
  let data: string[] = [];
  let reachedEof = false;
  const flush = (): ProviderStreamEvent | null => {
    if (data.length === 0) {
      event = null;
      return null;
    }
    const framed = { event, data: data.join("\n") };
    event = null;
    data = [];
    return framed;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) reachedEof = true;
      // `stream: true` keeps a split multi-byte character pending in the
      // decoder instead of emitting a replacement character for each half.
      pending += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/u, "");
        pending = pending.slice(newline + 1);
        if (line === "") {
          const framed = flush();
          if (framed !== null) {
            yield framed;
          }
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const rawValue = colon < 0 ? "" : line.slice(colon + 1);
          const value_ = rawValue.startsWith(" ")
            ? rawValue.slice(1)
            : rawValue;
          if (field === "event") event = value_;
          else if (field === "data") data.push(value_);
        }
        newline = pending.indexOf("\n");
      }
      if (done) break;
    }
    // A stream that ends without a trailing blank line still carries an event.
    if (pending.trim() !== "") {
      const line = pending.replace(/\r$/u, "");
      if (line.startsWith("data:")) {
        const rawValue = line.slice(5);
        data.push(rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue);
      }
    }
    const framed = flush();
    if (framed !== null) yield framed;
  } finally {
    if (!reachedEof) {
      try {
        await reader.cancel();
      } catch {
        // The terminal Provider event already decides the result; a transport
        // cancellation failure must not replace it.
      }
    }
    reader.releaseLock();
  }
}

/** Parses one `data` payload, skipping the `[DONE]` sentinel and junk. */
export function providerStreamJson(data: string): unknown {
  if (data === "" || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
