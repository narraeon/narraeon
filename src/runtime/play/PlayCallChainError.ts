export class PlayCallChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayCallChainError";
  }
}
