import { beforeEach } from "vitest";

import { setWebLocale } from "../src/web/i18n.ts";

// Existing component tests exercise the Chinese UI explicitly. Locale-specific
// tests override this baseline when they verify the English surface.
beforeEach(() => {
  setWebLocale("zh-CN");
});
