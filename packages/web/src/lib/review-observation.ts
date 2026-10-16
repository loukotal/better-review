// HTTP/1.1 browsers share six connections across all tabs on an origin. Reserve
// only two for review streams so admissions, GitHub comments and navigation work.
const STREAM_SLOTS = ["better-review:review-stream:0", "better-review:review-stream:1"];
const POLL_INTERVAL = 1500;
const POLL_TIMEOUT = 10000;

export function observeReview(options: {
  stream: (signal: AbortSignal, current: () => boolean, healthy: () => void) => Promise<void>;
  poll: (signal: AbortSignal, current: () => boolean) => Promise<void>;
  error: (message: string) => void;
}) {
  let disposed = false;
  let suspended = false;
  let generation = 0;
  let attempt = 0;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let locks: LockManager | undefined = navigator.locks;

  const cancel = () => {
    generation++;
    clearTimeout(timer);
    controller?.abort();
  };
  const visible = () => !disposed && !suspended && document.visibilityState !== "hidden";
  async function run() {
    if (!visible()) return;
    const version = ++generation;
    const request = new AbortController();
    controller = request;
    const current = () => visible() && generation === version && !request.signal.aborted;
    let delay = POLL_INTERVAL + Math.random() * 500;
    try {
      let streamed = false;
      if (locks) {
        for (const name of STREAM_SLOTS) {
          if (!current()) return;
          // Never queue for a lock: a waiting viewer must still receive snapshots.
          await locks
            .request(name, { ifAvailable: true }, async (lock) => {
              if (!lock || !current()) return;
              streamed = true;
              await options.stream(request.signal, current, () => {
                attempt = 0;
              });
            })
            .catch((cause) => {
              if (streamed) throw cause;
              // Unsupported/denied Web Locks must fail closed to polling, not SSE.
              locks = undefined;
            });
          if (streamed || !locks) break;
        }
      }
      if (!current()) return;
      if (!streamed) {
        const timeout = setTimeout(() => request.abort(), POLL_TIMEOUT);
        try {
          await options.poll(request.signal, current);
        } finally {
          clearTimeout(timeout);
        }
      }
      attempt = 0;
    } catch (cause) {
      if (generation !== version || !visible()) return;
      options.error(cause instanceof Error ? cause.message : "Review connection failed");
      delay = Math.min(1000 * 2 ** attempt++, 10000);
    } finally {
      if (generation === version && visible()) timer = setTimeout(() => void run(), delay);
    }
  }
  const resume = () => {
    cancel();
    attempt = 0;
    if (visible()) void run();
  };
  const hide = () => {
    suspended = true;
    cancel();
  };
  const show = () => {
    suspended = false;
    resume();
  };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", show);
  void run();
  return () => {
    disposed = true;
    cancel();
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("pagehide", hide);
    window.removeEventListener("pageshow", show);
  };
}
