import { createTRPCClient, httpLink, splitLink, unstable_httpSubscriptionLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "better-review/src/trpc/routers";

// Create tRPC client with individual requests (no batching)
export const trpc = createTRPCClient<AppRouter>({
  links: [
    splitLink({
      // Use subscription link for SSE subscriptions
      condition: (op) => op.type === "subscription",
      true: unstable_httpSubscriptionLink({
        url: "/api/trpc",
        transformer: superjson,
      }),
      // Use regular http link for queries and mutations (no batching)
      false: httpLink({
        url: "/api/trpc",
        transformer: superjson,
      }),
    }),
  ],
});

// Re-export AppRouter type for consumers
export type { AppRouter };
