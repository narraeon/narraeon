/** Readable historical logical context; never a Provider continuation payload. */
export interface PlayRequestContextMessage {
  role: string;
  text: string;
}

export interface PlayRequestContext {
  status: "available" | "incomplete" | "unavailable";
  messages: PlayRequestContextMessage[];
}
