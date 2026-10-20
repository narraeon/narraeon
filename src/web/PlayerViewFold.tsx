export function FoldToggle({
  open,
  onToggle,
  label,
  hint,
}: {
  open: boolean;
  onToggle: () => void;
  label: React.ReactNode;
  hint?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="player-fold-toggle"
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="player-fold-chevron" aria-hidden="true" />
      <span className="player-fold-label">{label}</span>
      {open || hint === undefined ? null : (
        <small className="player-fold-hint">{hint}</small>
      )}
    </button>
  );
}
