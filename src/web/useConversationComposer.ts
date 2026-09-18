import { useRef, useSyncExternalStore, type KeyboardEvent } from "react";

const touchComposerQuery = "(hover: none) and (pointer: coarse)";

function touchKeyboardPreferred(): boolean {
  return globalThis.matchMedia?.(touchComposerQuery).matches ?? false;
}

function subscribeInputMode(onChange: () => void): () => void {
  const media = globalThis.matchMedia?.(touchComposerQuery);
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}

/** One submission path for buttons and keyboards, including IME confirmation
 * and the synchronous gap before React renders the disabled state. */
export function useConversationComposer(
  enabled: boolean,
  send: () => void | Promise<void>,
) {
  const enterInsertsNewline = useSyncExternalStore(
    subscribeInputMode,
    touchKeyboardPreferred,
    () => false,
  );
  const inFlight = useRef(false);
  const submit = async (): Promise<void> => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    try {
      await send();
    } finally {
      inFlight.current = false;
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      (enterInsertsNewline && !event.ctrlKey && !event.metaKey) ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return;
    event.preventDefault();
    if (!event.repeat) void submit();
  };
  return { submit, onKeyDown, enterInsertsNewline };
}
