/** A known domain rejection before the requested change was committed. */
export class RuntimeRequestRejection extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeRequestRejection";
  }
}
