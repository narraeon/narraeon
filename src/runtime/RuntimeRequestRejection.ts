import { RuntimeDomainError } from "./RuntimeDomainError.ts";

/** A known domain rejection before the requested change was committed. */
export class RuntimeRequestRejection extends RuntimeDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, { ...options, receipt: { code: "invalid_request" } });
    this.name = "RuntimeRequestRejection";
  }
}
