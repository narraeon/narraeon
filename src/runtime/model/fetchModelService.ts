const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export class ModelServiceRedirectError extends Error {
  readonly httpStatus: number;

  constructor(message: string, httpStatus: number) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

/** Preserve same-origin routing without forwarding credentials to a new origin. */
export async function fetchModelService(
  fetchImplementation: typeof fetch,
  url: URL,
  init: RequestInit,
): Promise<Response> {
  let current = url;
  let options: RequestInit = { ...init, redirect: "manual" };
  for (let redirects = 0; ; redirects++) {
    const response = await fetchImplementation(current, options);
    const location = response.headers.get("location");
    if (!redirectStatuses.has(response.status) || location === null)
      return response;

    void response.body?.cancel().catch(() => undefined);
    if (redirects >= 20)
      throw new ModelServiceRedirectError(
        "Model service redirect limit exceeded",
        response.status,
      );
    let target: URL;
    try {
      target = new URL(location, current);
    } catch {
      throw new ModelServiceRedirectError(
        "Model service returned an invalid redirect",
        response.status,
      );
    }
    if (
      target.origin !== url.origin ||
      target.protocol !== url.protocol ||
      target.username !== "" ||
      target.password !== ""
    )
      throw new ModelServiceRedirectError(
        "Model service redirect to another origin or a URL with credentials was blocked",
        response.status,
      );

    if (
      options.method === "POST" &&
      (response.status === 301 ||
        response.status === 302 ||
        response.status === 303)
    ) {
      const headers = new Headers(options.headers);
      headers.delete("Content-Type");
      options = { ...options, method: "GET", headers, body: null };
    }
    current = target;
  }
}
