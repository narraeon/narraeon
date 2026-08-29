export const appLocales = ["en", "zh-CN"] as const;

export type AppLocale = (typeof appLocales)[number];

export interface AppPreferences {
  locale: AppLocale;
}

export const defaultAppLocale: AppLocale = "en";

export function isAppLocale(value: unknown): value is AppLocale {
  return appLocales.includes(value as AppLocale);
}
