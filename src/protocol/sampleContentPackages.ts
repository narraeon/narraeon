export const sampleContentPackageIds = [
  "rainy-inn",
  "tide-vault",
  "missing-reel",
  "lost-signal",
  "screening-night",
  "last-proof",
] as const;

export type SampleContentPackageId = (typeof sampleContentPackageIds)[number];
