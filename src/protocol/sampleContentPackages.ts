export const sampleContentPackageIds = [
  "rainy-inn",
  "tide-vault",
  "missing-reel",
  "lost-signal",
  "screening-night",
  "last-proof",
  "fogbell-harbor",
  "qingzhou-tales",
  "treasure-island",
  "baker-street-fog",
  "canal-escort",
  "driftline-echoes",
] as const;

export type SampleContentPackageId = (typeof sampleContentPackageIds)[number];
