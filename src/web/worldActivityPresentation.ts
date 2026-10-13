import { getWebLocale, uiText } from "./i18n.ts";

export function relativeActivityTime(
  timestamp: number,
  now = Date.now(),
): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return uiText("刚刚");
  const formatter = new Intl.RelativeTimeFormat(getWebLocale(), {
    numeric: "always",
  });
  for (const [unit, duration] of [
    ["year", 365 * 24 * 60 * 60],
    ["month", 30 * 24 * 60 * 60],
    ["day", 24 * 60 * 60],
    ["hour", 60 * 60],
    ["minute", 60],
  ] as const) {
    if (seconds >= duration)
      return formatter.format(-Math.floor(seconds / duration), unit);
  }
  return uiText("刚刚");
}
