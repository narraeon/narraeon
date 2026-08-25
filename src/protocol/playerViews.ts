export interface RenderedPlayerView {
  id: string;
  title: string;
  items: { id: string; label: string; value: unknown }[];
}

export interface PlayerViewDiagnostic {
  code: "invalid_control" | "unresolved_selector" | "capacity_exceeded";
  viewId?: string;
  itemId?: string;
  message: string;
}
