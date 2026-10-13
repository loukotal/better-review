import { useQuery } from "@tanstack/solid-query";
import { Show } from "solid-js";

import type { AppUpdateStatus } from "@better-review/shared";

import { Popover } from "../design-system";
import { fetchWithApiAuth } from "../lib/apiAuth";

export function AppUpdateNotice() {
  const status = useQuery(() => ({
    queryKey: ["app", "update-status"],
    queryFn: async (): Promise<AppUpdateStatus> => {
      const response = await fetchWithApiAuth("/api/app/update-status");
      if (!response.ok) throw new Error("Update check failed");
      return response.json();
    },
    staleTime: 24 * 60 * 60_000,
    gcTime: 24 * 60 * 60_000,
    refetchInterval: false,
    // Opening or returning to the app checks only if the cached result is a day old.
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
          <span class="rounded border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs text-accent">
            Update available
          </span>
        }
      >
        <div class="space-y-3 text-sm">
          <p>
            A newer revision is available on <code>origin/main</code>.
          </p>
          <p class="text-text-muted">
            In your Better Review checkout, save any local changes, then run:
          </p>
          <pre class="rounded bg-bg-elevated p-2 text-xs overflow-x-auto">
            git pull --ff-only origin main{"\n"}pnpm install
          </pre>
          <p class="text-text-muted">
            Restart Better Review. For a production setup, run <code>pnpm start:production</code> to
            rebuild and restart.
          </p>
          <div class="text-xs text-text-faint font-mono">
            Running {status.data?.currentRevision?.slice(0, 7)} → available{" "}
            {status.data?.latestRevision?.slice(0, 7)}
          </div>
        </div>
      </Popover>
    </Show>
  );
}
