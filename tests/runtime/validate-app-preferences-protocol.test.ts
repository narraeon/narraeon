import { expect, test } from "vitest";

import { parseV1Envelope, v1Protocol } from "../../src/protocol/v1.ts";

test("app preference requests accept only supported locales", () => {
  expect(
    parseV1Envelope({
      protocol: v1Protocol,
      request: { type: "preferences.read" },
    }).request,
  ).toEqual({ type: "preferences.read" });
  expect(
    parseV1Envelope({
      protocol: v1Protocol,
      request: { type: "preferences.save", locale: "zh-CN" },
    }).request,
  ).toEqual({ type: "preferences.save", locale: "zh-CN" });
  expect(() =>
    parseV1Envelope({
      protocol: v1Protocol,
      request: { type: "preferences.save", locale: "fr" },
    }),
  ).toThrow("preferences.save.locale must be en or zh-CN");
  expect(
    parseV1Envelope({
      protocol: v1Protocol,
      request: {
        type: "preferences.save",
        reading: {
          density: "compact",
          fontSize: 19,
          lineHeight: 1.8,
          letterSpacing: 0.02,
          measure: 72,
        },
      },
    }).request,
  ).toEqual({
    type: "preferences.save",
    reading: {
      density: "compact",
      fontSize: 19,
      lineHeight: 1.8,
      letterSpacing: 0.02,
      measure: 72,
    },
  });
  expect(() =>
    parseV1Envelope({
      protocol: v1Protocol,
      request: {
        type: "preferences.save",
        reading: {
          density: "compact",
          fontSize: 19,
          lineHeight: 1.8,
          letterSpacing: 0.02,
          measure: 74,
        },
      },
    }),
  ).toThrow("preferences.save.reading is invalid");
});
