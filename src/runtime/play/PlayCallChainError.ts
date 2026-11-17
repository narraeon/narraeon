export class PlayCallChainError extends Error {
  readonly code: "invalid_request" | "model_protocol_mismatch";
  readonly details: { recovery: "fresh_context" } | undefined;
  constructor(
    message: string,
    code: PlayCallChainError["code"] = "invalid_request",
    details?: { recovery: "fresh_context" },
  ) {
    super(message);
    this.name = "PlayCallChainError";
    this.code = code;
    this.details = details;
  }

  static requiresFreshContext(message: string): PlayCallChainError {
    return new PlayCallChainError(message, "invalid_request", {
      recovery: "fresh_context",
    });
  }
}
