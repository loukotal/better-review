import { createTRPCClient, httpLink, splitLink, unstable_httpSubscriptionLink } from "@trpc/client";
import type { AppRouter } from "better-review/src/trpc/routers";
import superjson from "superjson";

const trpcUrl =
  import.meta.env.VITE_TRPC_URL ??
  (import.meta.env.DEV ? "http://127.0.0.1:3001/api/trpc" : "/api/trpc");

// Create tRPC client with individual requests (no batching)
export const trpc = createTRPCClient<AppRouter>({
  links: [
    splitLink({
      // Use subscription link for SSE subscriptions
      condition: (op) => op.type === "subscription",
      true: unstable_httpSubscriptionLink({
        url: trpcUrl,
        transformer: superjson,
      }),
      // Use regular http link for queries and mutations (no batching)
      false: httpLink({
        url: trpcUrl,
        transformer: superjson,
      }),
    }),
  ],
});

// Re-export AppRouter type for consumers
export type { AppRouter };
