import { V1ProtocolError, type V1Request } from "../protocol/v1.ts";

type Command = V1Request["type"];

export interface RuntimeDomainErrorOptions extends ErrorOptions {
  receipt?: {
    code: V1ProtocolError["code"];
    commands?: readonly Command[];
    details?: Readonly<Record<string, unknown>>;
  };
}

/** A domain failure can opt into a client-visible rejection for specific commands. */
export class RuntimeDomainError extends Error {
  readonly #receipt: RuntimeDomainErrorOptions["receipt"];

  constructor(message: string, options: RuntimeDomainErrorOptions = {}) {
    super(message, options);
    this.#receipt = options.receipt;
  }

  toProtocolError(command: Command): V1ProtocolError | undefined {
    const receipt = this.#receipt;
    if (receipt === undefined || receipt.commands?.includes(command) === false)
      return undefined;
    return this.protocolError(receipt.code, receipt.details);
  }

  protected protocolError(
    code: V1ProtocolError["code"],
    details?: Readonly<Record<string, unknown>>,
  ): V1ProtocolError {
    return new V1ProtocolError(code, this.message, {
      cause: this,
      ...(details === undefined ? {} : { details }),
    });
  }
}
