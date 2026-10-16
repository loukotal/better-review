import { createRoot } from "solid-js";

import { useStreamingChat } from "../hooks/useStreamingChat";

/** Mounted by the real-HTTP multi-page transport runner, not a fetch mock. */
export function mountTransportChat() {
  return createRoot((dispose) => ({
    dispose,
    chat: useStreamingChat({ getSessionId: () => "hook-session" }),
  }));
}
