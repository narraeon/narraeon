import { beforeEach } from "vitest";

import { setWebLocale } from "../src/web/i18n.ts";

// jsdom needs the open state for rendering. Playwright covers browser modality.
if (typeof HTMLDialogElement !== "undefined") {
  const proto = HTMLDialogElement.prototype as Partial<HTMLDialogElement>;
  if (typeof proto.showModal !== "function")
    Object.defineProperty(proto, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    });
  if (typeof proto.close !== "function")
    Object.defineProperty(proto, "close", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open");
      },
    });
}

// Existing component tests exercise the Chinese UI explicitly. Locale-specific
// tests override this baseline when they verify the English surface.
beforeEach(() => {
  setWebLocale("zh-CN");
  if (typeof window !== "undefined") window.history.replaceState(null, "", "/");
});
