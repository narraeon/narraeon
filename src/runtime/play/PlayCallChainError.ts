import { RuntimeDomainError } from "../RuntimeDomainError.ts";
export class PlayCallChainError extends RuntimeDomainError {
  readonly code: "invalid_request" | "model_protocol_mismatch";
  readonly details: { recovery: "fresh_context" } | undefined;
  constructor(
    message: string,
    code: PlayCallChainError["code"] = "invalid_request",
    details?: { recovery: "fresh_context" },
  ) {
    super(message, {
      receipt: {
        code: code,
        commands: [
          "world.delete",
          "play.chain.revise-player",
          "play.chain.regenerate-narrative",
          "play.chain.start",
          "play.chain.append",
          "play.chain.cancel",
        ],
        ...(details === undefined ? {} : { details }),
      },
    });
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
