import type { AppUpdateControl, AppUpdateJob } from "@better-review/shared";

export async function waitForAppUpdate(options: {
  jobId: string;
  instanceId: string;
  read: () => Promise<AppUpdateControl>;
  progress: (job: AppUpdateJob) => void;
  signal: AbortSignal;
  delay: () => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const deadline = now() + (options.timeoutMs ?? 30 * 60_000);
  while (now() < deadline) {
    options.signal.throwIfAborted();
    let control: AppUpdateControl | undefined;
    try {
      control = await options.read();
    } catch {
      /* API disconnects during restart. */
    }
    options.signal.throwIfAborted();
    if (control) {
      if (!control.supported)
        throw new Error(
          "The app restarted without its supervisor. Check the Better Review terminal.",
        );
      if (control.job && control.job.id !== options.jobId)
        throw new Error("Another update replaced this job. Check for updates again.");
      const job = control.job;
      if (job) {
        options.progress(job);
        if (job.phase === "failed")
          throw new Error(job.error ?? "Update failed. Check the Better Review terminal.");
        if (job.phase === "ready" && control.instanceId !== options.instanceId) return;
      }
    }
    await options.delay();
  }
  throw new Error(
    "The update did not finish in time. Check the Better Review terminal, then refresh this page.",
  );
}

export function updatePollDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 1000);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
