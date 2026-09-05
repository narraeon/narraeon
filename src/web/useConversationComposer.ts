import { useRef, type KeyboardEvent } from "react";

/** One submission path for buttons and keyboards, including IME confirmation
 * and the synchronous gap before React renders the disabled state. */
export function useConversationComposer(
  enabled: boolean,
  send: () => void | Promise<void>,
) {
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
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return;
    event.preventDefault();
    if (!event.repeat) void submit();
  };
  return { submit, onKeyDown };
}
