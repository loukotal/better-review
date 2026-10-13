import { getApiAuthHeaders } from "./apiAuth";

/** Track each page instance separately; a second tab must keep the review alive. */
export function startReviewPresence(
  sessionId: string,
  events: EventTarget = window,
  send: (active: boolean) => void = (() => {
    const viewerId = crypto.randomUUID();
    const headers = { "Content-Type": "application/json", ...getApiAuthHeaders() };
    return (active: boolean) => {
      // Keepalive survives page teardown, and avoids an authentication prompt during unload.
      void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/presence`, {
        method: "POST",
        headers,
        body: JSON.stringify({ viewerId, active }),
        keepalive: true,
      }).catch(() => {});
    };
  })(),
) {
  let closed = false;
  const heartbeat = () => {
    if (!closed) send(true);
  };
  const leave = () => {
    if (closed) return;
    closed = true;
    send(false);
  };
  const resume = () => {
    closed = false;
    heartbeat();
  };
  heartbeat();
  const timer = setInterval(heartbeat, 15_000);
  events.addEventListener("pagehide", leave);
  events.addEventListener("pageshow", resume);
  return () => {
    clearInterval(timer);
    events.removeEventListener("pagehide", leave);
    events.removeEventListener("pageshow", resume);
    leave();
  };
}
