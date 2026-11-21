const maxRejectionBytes = 64 * 1024;
const maxDiagnosticLength = 4096;
const redacted = "[redacted]";
const privateFieldName =
  /(?:authorization|(?:x[-_](?:goog[-_])?)?api[-_]?key|(?:access|refresh)[-_]?token|signature|thought[-_]?signature|encrypted[-_]?content|continuation[-_]?token|redacted[-_]?thinking)/iu;
const privateField = new RegExp("^" + privateFieldName.source + "$", "iu");
const privateAssignment = new RegExp(
  "\\b(" + privateFieldName.source + ')"?[ \\t]*[:=][^\\r\\n]*',
  "giu",
);

/** An unreadable or oversized rejection has no safe body to project. */
export async function readProviderRejectionBody(
  response: Response,
): Promise<string | null> {
  if (response.body === null) return "";
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let body = "";
  let bytes = 0;
  let complete = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        return body + decoder.decode();
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxRejectionBytes) return null;
      body += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Keep useful rejection text without projecting credentials or opaque fields. */
export function providerRejectionText(
  body: string,
  apiKey: string,
  contentType: string | null,
): string {
  const encodedKey = encodeURIComponent(apiKey.toWellFormed());
  const lowerEscapes = encodedKey.replace(/%[0-9A-F]{2}/gu, (part) =>
    part.toLowerCase(),
  );
  const redactKey = (value: string) =>
    apiKey === ""
      ? value
      : value
          .replaceAll(apiKey, redacted)
          .replaceAll(encodedKey, redacted)
          .replaceAll(lowerEscapes, redacted);
  const redactText = (value: string) =>
    redactKey(value).replace(privateAssignment, "$1: [redacted]");
  const text = body.trim();
  const mediaType = contentType?.split(";", 1)[0]?.trim();
  const structured =
    /(?:\/|\+)json$/iu.test(mediaType ?? "") ||
    /^(?:\{|\[\s*[{["]|")/u.test(text);
  if (!structured) return redactText(text).slice(0, maxDiagnosticLength);
  try {
    const payload: unknown = JSON.parse(text);
    let changed = false;
    const safe = JSON.stringify(payload, (key, value: unknown) => {
      if (
        privateField.test(key) ||
        (typeof value === "object" &&
          value !== null &&
          "type" in value &&
          value.type === "redacted_thinking")
      ) {
        changed = true;
        return redacted;
      }
      if (typeof value !== "string") return value;
      const clean = redactText(value);
      if (clean !== value) changed = true;
      return clean;
    });
    return redactKey(changed ? safe : text).slice(0, maxDiagnosticLength);
  } catch {
    return "";
  }
}
