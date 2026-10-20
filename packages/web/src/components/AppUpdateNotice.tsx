import { useQuery } from "@tanstack/solid-query";
import { Match, Show, Switch } from "solid-js";

import type { AppUpdateStatus } from "@better-review/shared";

import { Popover } from "../design-system";
import { fetchWithApiAuth } from "../lib/apiAuth";

export function AppUpdateNotice() {
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

  return (
    <Show when={status.isSuccess && status.data?.updateAvailable}>
      <Popover
        label="Update Better Review"
        align="left"
        width={340}
        triggerSize="sm"
        trigger={
          <span class="app-update-nudge inline-flex items-center gap-2 rounded-md border border-accent-bright bg-accent px-2.5 py-1 text-xs font-semibold text-accent-text">
            <span>{status.data?.updateAction === "restart" ? "Restart needed" : "Pls update"}</span>
            <span aria-hidden="true" class="text-base leading-none">
              🙏
            </span>
          </span>
        }
      >
        <div class="space-y-3 text-sm">
          <Show when={fakeUpdate}>
            <p class="text-xs text-accent">Development preview — this update is simulated.</p>
          </Show>
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
                An upstream revision is available on <code>origin/main</code>. Your current checkout
                can fast-forward to the checked revision. Save any local changes, then run:
              </p>
              <pre class="rounded bg-bg-elevated p-2 text-xs overflow-x-auto">
                git pull --ff-only origin main
              </pre>
            </Match>
            <Match when={status.data?.updateAction === "diverged"}>
              <p>
                Your checkout and <code>origin/main</code> have diverged: both contain changes the
                other does not. Reconcile the local and upstream changes manually before updating. A
                fast-forward pull cannot apply this update.
              </p>
            </Match>
          </Switch>
          <p class="text-text-muted">
            Once the checkout is ready, run <code>pnpm install</code> and restart Better Review. For
            production, run <code>pnpm start:production</code> to rebuild and restart.
          </p>
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
