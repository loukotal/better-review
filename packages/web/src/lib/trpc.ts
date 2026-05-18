import { createTRPCClient, httpLink, splitLink, unstable_httpSubscriptionLink } from "@trpc/client";
import type { AppRouter } from "better-review/src/trpc/routers";
import superjson from "superjson";

import { getApiAuthConnectionParams, getApiAuthHeaders, getApiToken } from "./apiAuth";

const trpcUrl = import.meta.env.VITE_TRPC_URL ?? "/api/trpc";

// Native EventSource cannot send custom headers, so the subscription link relies
// on the auth cookie being present before the SSE request is opened.
getApiToken();

// Create tRPC client with individual requests (no batching)
export const trpc = createTRPCClient<AppRouter>({
  links: [
    splitLink({
      // Use subscription link for SSE subscriptions
      condition: (op) => op.type === "subscription",
      true: unstable_httpSubscriptionLink({
        url: trpcUrl,
        transformer: superjson,
        connectionParams: getApiAuthConnectionParams,
      }),
      // Use regular http link for queries and mutations (no batching)
      false: httpLink({
        url: trpcUrl,
        transformer: superjson,
        headers: getApiAuthHeaders,
      }),
    }),
  ],
});

// Re-export AppRouter type for consumers
export type { AppRouter };
