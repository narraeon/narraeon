import { afterEach, expect, test, vi } from "vitest";
import { browserUUID } from "../../src/web/browser-uuid.ts";

afterEach(() => vi.unstubAllGlobals());

test("uses the native UUID generator when available", () => {
  const id = "00112233-4455-4677-8899-aabbccddeeff";
  const randomUUID = vi.fn(() => id);
  vi.stubGlobal("crypto", { randomUUID });
  expect(browserUUID()).toBe(id);
  expect(randomUUID).toHaveBeenCalledOnce();
});

test("uses random bytes with UUID v4 version and variant on plain HTTP", () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => {
    bytes.set(Array.from({ length: 16 }, (_, index) => index));
    return bytes;
  });
  vi.stubGlobal("crypto", { getRandomValues });
  expect(browserUUID()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  expect(getRandomValues).toHaveBeenCalledOnce();
});
