export const worldArchiveFormat = "narraeon.world-archive/v1" as const;
export const worldArchiveLimits = {
  archiveBytes: 1024 ** 3,
  extractedBytes: 2 * 1024 ** 3,
  entries: 200_000,
  entryBytes: 256 * 1024 ** 2,
};
export interface WorldArchiveDownload {
  archiveId: string;
  fileName: string;
  bytes: number;
}
export type WorldArchiveErrorCode =
  | "invalid_archive"
  | "unsupported_format"
  | "limit_exceeded"
  | "unsafe_path"
  | "integrity_failed";
