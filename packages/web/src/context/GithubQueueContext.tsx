import { createContext, useContext, type Accessor } from "solid-js";

import type { GithubPrScope } from "@better-review/shared";

import type { BrowserGithubState } from "../lib/github-outbox";

export interface GithubQueueContextValue {
  states: Accessor<readonly BrowserGithubState[]>;
  selectedScope: Accessor<GithubPrScope | undefined>;
  error: Accessor<string | undefined>;
  refresh: () => Promise<void>;
  loadHistory?: () => Promise<void>;
  retryAll?: () => Promise<void>;
  clearAll?: () => Promise<void>;
  batchBusy?: Accessor<"retry" | "clear" | undefined>;
  batchFeedback?: Accessor<string | undefined>;
  operationFeedback?: Accessor<Readonly<Record<string, string>>>;
}
export const GithubQueueContext = createContext<GithubQueueContextValue>();
export function useGithubQueue() {
  return useContext(GithubQueueContext);
}
