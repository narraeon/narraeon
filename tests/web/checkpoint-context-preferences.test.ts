// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  hasHandledCheckpoint,
  rememberHandledCheckpoint,
} from "../../src/web/CheckpointContextPreferences.ts";

beforeEach(() => {
  // Node's native localStorage can shadow the browser storage in jsdom.
  const browser = globalThis as unknown as {
    jsdom: { window: { localStorage: Storage } };
  };
  vi.stubGlobal("localStorage", browser.jsdom.window.localStorage);
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

test("checkpoint UI choices persist independently by world and immutable endpoint", () => {
  rememberHandledCheckpoint("world-one", "commit:3");
  expect(hasHandledCheckpoint("world-one", "commit:3")).toBe(true);
  expect(hasHandledCheckpoint("world-one", "commit:4")).toBe(false);
  expect(hasHandledCheckpoint("fork-world", "commit:3")).toBe(false);
  expect(window.localStorage.length).toBe(1);
  expect(window.localStorage.getItem(window.localStorage.key(0)!)).toBe(
    "handled",
  );
});

test("clearing browser site data resets checkpoint UI choices", () => {
  rememberHandledCheckpoint("world-one", "commit:3");
  window.localStorage.clear();
  expect(hasHandledCheckpoint("world-one", "commit:3")).toBe(false);
});

test("unavailable browser storage does not prevent playing", () => {
  vi.spyOn(window.Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Browser storage unavailable");
  });
  vi.spyOn(window.Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Browser storage unavailable");
  });
  expect(hasHandledCheckpoint("world-one", "commit:3")).toBe(false);
  expect(() =>
    rememberHandledCheckpoint("world-one", "commit:3"),
  ).not.toThrow();
});
