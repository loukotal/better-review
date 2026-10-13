import { useQuery } from "@tanstack/solid-query";
import { Show } from "solid-js";

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
        };
      }
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
          <span class="app-update-nudge inline-flex items-center gap-2 rounded-md border border-accent-bright bg-accent px-2.5 py-1 text-xs font-semibold text-accent-text">
            <span>Pls update</span>
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
