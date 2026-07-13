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
  type CreateAgentContextOptions,
  type CreateWorkflowContextOptions,
} from "@flue/runtime/internal";
import { sqlite } from "@flue/runtime/node";
import type { MiddlewareHandler } from "hono";

import { configureFlueOAuthProvidersFromPiAuth } from "./oauth-auth";
import { prReviewerAgent } from "./pr-reviewer";

configureFlueOAuthProvidersFromPiAuth();

const persistence = sqlite(":memory:");
await persistence.migrate?.();
const stores = await persistence.connect();

const exposeOverHttp: MiddlewareHandler = async (_context, next) => next();
const agents = [
  {
    name: "pr-reviewer",
    definition: prReviewerAgent,
    route: exposeOverHttp,
  },
];

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

const createContext = ({
  id,
  agentName,
  request,
  initialEventIndex,
  dispatchId,
}: CreateAgentContextOptions) =>
  createFlueContext({
    id,
    agentName,
    dispatchId,
    env: process.env,
    agentConfig: {
      resolveModel,
    },
    createDefaultEnv,
    req: request,
    initialEventIndex,
    attachmentStore: stores.attachmentStore,
  });

const createWorkflowContext = ({
  runId,
  request,
  initialEventIndex,
}: CreateWorkflowContextOptions) =>
  createFlueContext({
    id: runId,
    runId,
    env: process.env,
    agentConfig: { resolveModel },
    createDefaultEnv,
    req: request,
    initialEventIndex,
    attachmentStore: stores.attachmentStore,
  });

const coordinator = createNodeAgentCoordinator({
  submissions: stores.executionStore.submissions,
  agents,
  createContext,
  conversationStreamStore: stores.conversationStreamStore,
  attachmentStore: stores.attachmentStore,
});

await coordinator.reconcileSubmissions();

let configured = false;

export function createFlueReviewApp() {
  if (!configured) {
    configureFlueRuntime({
      target: "node",
      agents,
      workflows: [],
      createWorkflowContext,
      createAgentAdmission: (agentName, instanceId) =>
        coordinator.createAdmission(agentName, instanceId),
      abortAgentInstance: (agentName, instanceId) =>
        coordinator.abortInstance(agentName, instanceId),
      admitWorkflow: async ({ workflowName }) => {
        throw new Error(`Unknown workflow: ${workflowName}`);
      },
      runStore: stores.runStore,
      eventStreamStore: stores.eventStreamStore,
      conversationStreamStore: stores.conversationStreamStore,
      attachmentStore: stores.attachmentStore,
      dispatchQueue: createNodeDispatchQueue(coordinator),
    });
    configured = true;
  }

  return createDefaultFlueApp();
}
