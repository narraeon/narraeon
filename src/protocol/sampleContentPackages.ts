export const sampleContentPackageIds = [
  "rainy-inn",
  "missing-reel",
  "screening-night",
  "last-proof",
] as const;

export type SampleContentPackageId = (typeof sampleContentPackageIds)[number];
