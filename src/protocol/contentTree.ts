/** Case/Unicode folding used when comparing portable current-tree paths. */
export function portableContentTreePathKey(path: string): string {
  return path.normalize("NFKC").toLocaleLowerCase("en-US");
}

export interface PortableContentTreeLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const defaultPortableContentTreeLimits = {
  maxFiles: 1_024,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
} as const satisfies PortableContentTreeLimits;

export function maximumPortableContentArchiveBytes(
  limits: PortableContentTreeLimits,
): number {
  return limits.maxTotalBytes + limits.maxFiles * 1_024 + 65_557;
}

export const maxPortableContentArchiveBytes =
  maximumPortableContentArchiveBytes(defaultPortableContentTreeLimits);

export const maxPortableContentArchiveBase64Characters =
  Math.ceil(maxPortableContentArchiveBytes / 3) * 4;
