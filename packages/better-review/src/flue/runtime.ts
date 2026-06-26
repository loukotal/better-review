import {
  Bash,
  createDefaultFlueApp,
  InMemoryFs,
  bashFactoryToSessionEnv,
  configureFlueRuntime,
  createFlueContext,
  createNodeAgentCoordinator,
  createNodeDispatchQueue,
  resolveModel,
} from "@flue/runtime/internal";
import { sqlite } from "@flue/runtime/node";

import { configureFlueOAuthProvidersFromPiAuth } from "./oauth-auth";
import { prReviewerAgent } from "./pr-reviewer";
import { flueAgentSessionStore } from "./session-store";

configureFlueOAuthProvidersFromPiAuth();

const sessionStore = flueAgentSessionStore;
const persistence = sqlite(":memory:");
await persistence.migrate?.();
const stores = await persistence.connect();
const runStore = stores.runStore;
const eventStreamStore = stores.eventStreamStore;

const manifest = {
  agents: [
    {
      name: "pr-reviewer",
      transports: { http: true as const },
      created: true,
    },
  ],
  workflows: [],
};

const createdAgents = {
  "pr-reviewer": prReviewerAgent,
};

const createDefaultEnv = async () => {
  const fs = new InMemoryFs();
  return bashFactoryToSessionEnv(
    () =>
      new Bash({
        fs,
        network: { dangerouslyAllowFullInternetAccess: true },
      }),
  );
};

const createContext = (
  id: string,
  runId: string | undefined,
  payload: unknown,
  request: Request,
  initialEventIndex?: number,
  dispatchId?: string,
) =>
  createFlueContext({
    id,
    runId,
    dispatchId,
    payload,
    env: process.env,
    agentConfig: {
      packagedSkills: {},
      resolveModel,
    },
    createDefaultEnv,
    defaultStore: sessionStore,
    req: request,
    initialEventIndex,
    submissionStore: stores.executionStore.submissions,
  });

const coordinator = createNodeAgentCoordinator({
  submissions: stores.executionStore.submissions,
  sessions: sessionStore,
  agents: createdAgents,
  createContext,
  eventStreamStore,
});

await coordinator.reconcileSubmissions();

let configured = false;

export function createFlueReviewApp() {
  if (!configured) {
    configureFlueRuntime({
      target: "node",
      manifest,
      workflowHandlers: {},
      createContext,
      createAdmission: {
        "pr-reviewer": (instanceId) => coordinator.createAdmission("pr-reviewer", instanceId),
      },
      runStore,
      eventStreamStore,
      dispatchQueue: createNodeDispatchQueue(coordinator),
      resolveDispatchAgentName: (agent) => (agent === prReviewerAgent ? "pr-reviewer" : undefined),
    });
    configured = true;
  }

  return createDefaultFlueApp();
}
