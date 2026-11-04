import { useQuery } from "@tanstack/solid-query";
import { createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js";

import type { AppUpdateControl, AppUpdateJob, AppUpdateStatus } from "@better-review/shared";

import { Button, Popover } from "../design-system";
import { fetchWithApiAuth } from "../lib/apiAuth";
import { updatePollDelay, waitForAppUpdate } from "../lib/app-update-client";

export function AppUpdateNotice() {
  const pendingKey = "better-review:pending-app-update";
  const [busy, setBusy] = createSignal(false);
  const [job, setJob] = createSignal<AppUpdateJob>();
  const [error, setError] = createSignal<string>();
  let requestId: string | undefined;
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());
  const requestSignal = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]);
  const clearPending = () => {
    try {
      sessionStorage.removeItem(pendingKey);
    } catch {}
  };
  const follow = async (jobId: string, instanceId: string) => {
    await waitForAppUpdate({
      jobId,
      instanceId,
      signal: lifetime.signal,
      progress: setJob,
      delay: () => updatePollDelay(lifetime.signal),
      read: async () => {
        const response = await fetchWithApiAuth("/api/app/update-job", { signal: requestSignal() });
        if (!response.ok) throw new Error("Restart in progress");
        return response.json() as Promise<AppUpdateControl>;
      },
    });
    clearPending();
    window.location.reload();
  };
  const fail = (cause: unknown) => {
    if (lifetime.signal.aborted) return;
    setError(cause instanceof Error ? cause.message : "Update failed");
    setBusy(false);
    if (job()?.phase === "failed") requestId = undefined;
    clearPending();
  };
  onMount(() => {
    try {
      const pending = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null");
      if (typeof pending?.jobId === "string" && typeof pending?.instanceId === "string") {
        setBusy(true);
        void follow(pending.jobId, pending.instanceId).catch(fail);
      }
    } catch {
      clearPending();
    }
  });
  const fakeUpdate =
    import.meta.env.DEV && new URLSearchParams(window.location.search).get("fakeUpdate") === "1";
  const status = useQuery(() => ({
    queryKey: fakeUpdate ? ["app", "update-status", "preview"] : ["app", "update-status"],
    queryFn: async (): Promise<AppUpdateStatus> => {
      if (fakeUpdate) {
        return {
          updateAvailable: true,
          currentRevision: "1234567890abcdef1234567890abcdef12345678",
          latestRevision: "abcdef1234567890abcdef1234567890abcdef12",
          updateAction: "unknown",
        };
      }
      const response = await fetchWithApiAuth("/api/app/update-status");
      if (!response.ok) throw new Error("Update check failed");
      return response.json();
    },
    staleTime: 0,
    gcTime: 24 * 60 * 60_000,
    refetchInterval: false,
    // Refresh checkout advice on return; the server caches only the remote lookup for a day.
    refetchOnWindowFocus: true,
    retry: false,
  }));

  const start = async () => {
    if (busy() || fakeUpdate) return;
    setBusy(true);
    setError(undefined);
    setJob(undefined);
    requestId ??= crypto.randomUUID();
    try {
      const response = await fetchWithApiAuth("/api/app/update-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: requestSignal(),
        body: JSON.stringify({
          requestId,
          checkoutRevision: status.data?.checkoutRevision,
          targetRevision: status.data?.latestRevision,
        }),
      });
      const control = (await response.json()) as AppUpdateControl & { error?: string };
      if (!response.ok || !control.job) {
        if (response.status >= 400 && response.status < 500) requestId = undefined;
        void status.refetch();
        throw new Error(
          control.error ?? "Could not start the update. Check the Better Review terminal.",
        );
      }
      setJob(control.job);
      try {
        sessionStorage.setItem(
          pendingKey,
          JSON.stringify({ jobId: control.job.id, instanceId: control.instanceId }),
        );
      } catch {}
      await follow(control.job.id, control.instanceId);
    } catch (cause) {
      // A restart can sever the acknowledgement. Discover the same request,
      // rather than silently submitting another install/restart job.
      if (!lifetime.signal.aborted && requestId && !job()) {
        try {
          const response = await fetchWithApiAuth("/api/app/update-job", {
            signal: requestSignal(),
          });
          if (response.ok) {
            const control = (await response.json()) as AppUpdateControl;
            if (control.job?.id === requestId) {
              setJob(control.job);
              const instanceId = control.job.previousInstanceId ?? control.instanceId;
              try {
                sessionStorage.setItem(
                  pendingKey,
                  JSON.stringify({ jobId: control.job.id, instanceId }),
                );
              } catch {}
              await follow(control.job.id, instanceId);
              return;
            }
          }
        } catch (recoveryError) {
          fail(recoveryError);
          return;
        }
      }
      fail(cause);
    }
  };
  const phaseLabel = () =>
    ({
      preparing: "Checking checkout…",
      fetching: "Downloading update…",
      installing: "Installing dependencies…",
      building: "Building app…",
      restarting: "Restarting…",
      ready: "Reloading…",
      failed: "Update failed",
    })[job()?.phase ?? "preparing"];

  return (
    <Show when={(status.isSuccess && status.data?.updateAvailable) || busy() || error()}>
      <Popover
        label="Update Better Review"
        align="left"
        width={340}
        triggerSize="sm"
        trigger={
          <span class="app-update-nudge inline-flex items-center gap-2 rounded-md border border-accent-bright bg-accent px-2.5 py-1 text-xs font-semibold text-accent-text">
            <span>
              {busy()
                ? phaseLabel()
                : status.data?.updateAction === "restart"
                  ? "Restart needed"
                  : "Pls update"}
            </span>
            <span aria-hidden="true" class="text-base leading-none">
              🙏
            </span>
          </span>
        }
      >
        <div class="space-y-3 text-sm">
          <Show when={busy()}>
            <p role="status" aria-live="polite">
              {phaseLabel()} This page will reload when Better Review is ready.
            </p>
          </Show>
          <Show when={error()}>
            <p
              role="alert"
              class="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-error"
            >
              {error()}
            </p>
            <Button
              size="sm"
              disabled={busy()}
              onClick={() => {
                setError(undefined);
                void status.refetch();
              }}
            >
              Check again
            </Button>
          </Show>
          <Show when={fakeUpdate}>
            <p class="text-xs text-accent">Development preview — this update is simulated.</p>
          </Show>
          <Show
            when={!status.data?.oneClickUpdate || status.data?.updateAction === "diverged"}
            fallback={
              <p>
                {status.data?.updateAction === "restart"
                  ? "Your checkout is ready to restart."
                  : "Download the checked upstream revision, install dependencies, and restart Better Review."}
              </p>
            }
          >
            <Switch
              fallback={
                <p>
                  An upstream revision is available, but its history is not known locally. Fetch{" "}
                  <code>origin/main</code> and check the history before updating manually.
                </p>
              }
            >
              <Match when={status.data?.updateAction === "restart"}>
                <p>Your checkout already includes the upstream revision. Restart to use it.</p>
              </Match>
              <Match when={status.data?.updateAction === "fast-forward"}>
                <p>
                  An upstream revision is available on <code>origin/main</code>. Your current
                  checkout can fast-forward to the checked revision. Save any local changes, then
                  run:
                </p>
                <pre class="rounded bg-bg-elevated p-2 text-xs overflow-x-auto">
                  git pull --ff-only origin main
                </pre>
              </Match>
              <Match when={status.data?.updateAction === "diverged"}>
                <p>
                  Your checkout and <code>origin/main</code> have diverged: both contain changes the
                  other does not. Reconcile the local and upstream changes manually before updating.
                  A fast-forward pull cannot apply this update.
                </p>
              </Match>
            </Switch>
          </Show>
          <Show
            when={
              status.data?.oneClickUpdate && status.data?.updateAction !== "diverged" && !fakeUpdate
            }
            fallback={
              <p class="text-text-muted">
                Once the checkout is ready, run <code>pnpm install</code> and restart Better Review.
                For production, run <code>pnpm start:production</code> to rebuild and restart.
                <span class="block mt-2">
                  Starting through these commands enables one-click updates for future releases.
                </span>
              </p>
            }
          >
            <p class="text-text-muted">
              Save unsent drafts first. Restart briefly disconnects open tabs. Saved reviews and
              local edits are kept.
            </p>
            <Button
              variant="primary"
              fullWidth
              disabled={busy()}
              aria-busy={busy()}
              onClick={() => void start()}
            >
              {busy()
                ? phaseLabel()
                : status.data?.updateAction === "restart"
                  ? "Install & restart"
                  : "Update & restart"}
            </Button>
          </Show>
          <div class="text-xs text-text-faint font-mono">
            Running {status.data?.currentRevision?.slice(0, 7)} → available{" "}
            {status.data?.latestRevision?.slice(0, 7)}
            <Show when={status.data?.checkoutRevision}>
              <br />
              Checkout {status.data?.checkoutRevision?.slice(0, 7)}
            </Show>
          </div>
        </div>
      </Popover>
    </Show>
  );
}
