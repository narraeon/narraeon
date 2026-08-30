const clientIdByteLength = 16;

export function createClientId(prefix: string): string {
  const bytes = new Uint8Array(clientIdByteLength);
  globalThis.crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${prefix}-${suffix}`;
}
