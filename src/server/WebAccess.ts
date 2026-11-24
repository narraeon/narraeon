import { createHmac, timingSafeEqual } from "node:crypto";
import type { onRequestAsyncHookHandler } from "fastify";

const runtimeApiPath = "/api/runtime/v1";
const mobileCallerCookie = "narraeon_mobile_runtime=";

export function checkMobileRuntimeAccess(
  startupKey: Buffer,
): onRequestAsyncHookHandler {
  // Startup proofs sign challenge + URL. Use a distinct message for the caller credential.
  const expected = createHmac("sha256", startupKey)
    .update("narraeon-mobile-runtime/v1")
    .digest();

  return async (request, reply) => {
    const path = request.routeOptions.url;
    if (path !== runtimeApiPath && !path?.startsWith(`${runtimeApiPath}/`))
      return;

    const credentials = request.headers.cookie
      ?.split(";")
      .map((cookie) => cookie.trim())
      .filter((cookie) => cookie.startsWith(mobileCallerCookie));
    const value = credentials?.[0]?.slice(mobileCallerCookie.length);
    if (
      credentials?.length !== 1 ||
      value === undefined ||
      !/^[a-f0-9]{64}$/.test(value) ||
      !timingSafeEqual(expected, Buffer.from(value, "hex"))
    )
      return reply
        .code(403)
        .send({ error: "Untrusted Android Runtime caller" });
  };
}

export function parseTrustedWebOrigins(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value.split(",").map((entry) => {
    const origin = entry.trim();
    const url = URL.parse(origin);
    if (!/^https?:\/\/[a-z0-9.:[\]-]+\/?$/i.test(origin) || url === null)
      throw new Error(
        "NARRAEON_TRUSTED_ORIGINS must contain comma-separated HTTP or HTTPS origins",
      );
    return url.origin;
  });
}

export function checkWebAccess(
  port: number,
  additionalOrigins: readonly string[],
): onRequestAsyncHookHandler {
  const originsByHost = new Map<string, Set<string>>();
  const origins = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    ...additionalOrigins,
  ];
  for (const origin of origins) {
    const url = new URL(origin);
    const hosts =
      url.port !== ""
        ? [url.host]
        : [url.host, `${url.host}:${url.protocol === "https:" ? 443 : 80}`];
    for (const host of hosts) {
      const allowed = originsByHost.get(host) ?? new Set<string>();
      allowed.add(url.origin);
      originsByHost.set(host, allowed);
    }
  }

  return async (request, reply) => {
    const { host, origin, "sec-fetch-site": fetchSite } = request.headers;
    const allowed =
      host === undefined ? undefined : originsByHost.get(host.toLowerCase());
    if (
      allowed === undefined ||
      (request.raw.headersDistinct?.host?.length ?? 1) !== 1
    )
      return reply.code(403).send({ error: "Untrusted Runtime host" });

    if (
      request.method === "GET" ||
      request.method === "HEAD" ||
      request.method === "OPTIONS"
    )
      return;

    // Native clients can omit Origin. Browsers can omit it on same-origin
    // requests, but a cross-origin browser request must present a trusted Origin.
    const accepted =
      origin === undefined
        ? fetchSite === undefined ||
          fetchSite === "same-origin" ||
          fetchSite === "none"
        : allowed.has(origin);
    if (!accepted)
      return reply.code(403).send({ error: "Untrusted Runtime origin" });
  };
}
