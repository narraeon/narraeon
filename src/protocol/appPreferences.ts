export const appLocales = ["en", "zh-CN"] as const;

export type AppLocale = (typeof appLocales)[number];

export const readingDensities = ["compact", "standard", "relaxed"] as const;

export type ReadingDensity = (typeof readingDensities)[number];

export interface AppReadingPreferences {
  density: ReadingDensity;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  measure: number;
}

export interface AppPreferences {
  locale: AppLocale;
  reading: AppReadingPreferences;
}

export type AppPreferencesUpdate = Partial<AppPreferences>;

export const defaultAppLocale: AppLocale = "en";

export const defaultAppReadingPreferences: AppReadingPreferences = {
  density: "compact",
  fontSize: 17,
  lineHeight: 1.7,
  letterSpacing: 0.01,
  measure: 48,
};

export function isAppLocale(value: unknown): value is AppLocale {
  return appLocales.includes(value as AppLocale);
}

export function isAppReadingPreferences(
  value: unknown,
): value is AppReadingPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 5 &&
    readingDensities.includes(candidate.density as ReadingDensity) &&
    isNumberInRange(candidate.fontSize, 15, 24) &&
    isNumberInRange(candidate.lineHeight, 1.4, 2.4) &&
    isNumberInRange(candidate.letterSpacing, 0, 0.12) &&
    isNumberInRange(candidate.measure, 32, 72)
  );
}

function isNumberInRange(value: unknown, minimum: number, maximum: number) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}
