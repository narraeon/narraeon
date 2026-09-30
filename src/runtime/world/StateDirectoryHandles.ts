export function stateDirectoryHandle(directory: string): string {
  if (directory === "") return "@dir-/";
  const encoded = directory.split("/").map(encodeURIComponent).join("/");
  return `@dir-/${encoded}`;
}

export function parseStateDirectoryHandle(handle: string): string | null {
  if (handle === "@dir-/") return "";
  if (!handle.startsWith("@dir-/") || handle.length === "@dir-/".length)
    return null;
  try {
    const directory = handle
      .slice("@dir-/".length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    if (
      directory
        .split("/")
        .some(
          (segment) =>
            segment === "" ||
            segment === "." ||
            segment === ".." ||
            segment.includes("\\"),
        ) ||
      stateDirectoryHandle(directory) !== handle
    )
      return null;
    return directory;
  } catch {
    return null;
  }
}
