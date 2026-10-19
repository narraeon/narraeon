export class PlayCallChainError extends Error {
  readonly code: "invalid_request" | "model_protocol_mismatch";
  constructor(
    message: string,
    code: PlayCallChainError["code"] = "invalid_request",
  ) {
    super(message);
    this.name = "PlayCallChainError";
    this.code = code;
  }
}
