import type { ModelUsage } from "./modelUsage.ts";

export interface PromptEncodingSummary {
  provider: string;
  jsonBytes: number;
  contentBlocks: { path: string; bytes: number }[];
  cacheBreakpoints: string[];
  hasCacheKey: boolean;
}

export interface WorldPromptPrefixComparison {
  logical: {
    commonPrefixBytes: number;
    previousBytes: number;
    currentBytes: number;
    firstChangedSource: string | null;
    changedSources: {
      source: string;
      role: string;
      change: "added" | "removed" | "changed" | "moved";
      previousPosition: number | null;
      currentPosition: number | null;
      previousBytes: number;
      currentBytes: number;
    }[];
    currentOrder: {
      source: string;
      role: string;
      position: number;
      bytes: number;
    }[];
  } | null;
  encoding: {
    previous: PromptEncodingSummary | null;
    current: PromptEncodingSummary | null;
    commonJsonPrefixBytes: number | null;
    firstChangedPath: string | null;
    cacheKey: "same" | "different" | "absent" | "unavailable";
  };
  providerUsage: { previous: ModelUsage | null; current: ModelUsage | null };
  suggestions: { source: string; afterSource: string }[];
  cacheBenefit: "not_measured";
}
