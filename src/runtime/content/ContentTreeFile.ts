export interface ContentTreeFile {
  path: string;
  contents: string;
  encoding?: "base64";
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function contentTreeFileFromBytes(
  path: string,
  bytes: Buffer,
): ContentTreeFile {
  try {
    return { path, contents: utf8.decode(bytes) };
  } catch {
    return { path, contents: bytes.toString("base64"), encoding: "base64" };
  }
}
