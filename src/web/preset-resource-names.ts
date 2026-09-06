export function resourceTitle(path: string): string {
  const filename = path.split("/").at(-1) ?? path;
  const title = filename.replace(/\.[a-f0-9]{8}-[a-f0-9-]{27}(?=\.)/gu, "");
  return title !== filename && title.startsWith("named-")
    ? title
        .slice(6)
        .replace(/_u([a-f0-9]+)_/gu, (_, code: string) =>
          Number.parseInt(code, 16) <= 0x10ffff
            ? String.fromCodePoint(Number.parseInt(code, 16))
            : `_u${code}_`,
        )
    : title;
}
