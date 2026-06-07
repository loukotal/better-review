import { flue } from "@flue/runtime/app";
import {
  Bash,
  InMemoryFs,
  InMemoryRunRegistry,
  InMemoryRunStore,
  bashFactoryToSessionEnv,
  configureFlueRuntime,
  createDirectAgentHandler,
  createFlueContext,
  createRunSubscriberRegistry,
  resolveModel,
  type AgentHandler,
} from "@flue/runtime/internal";
import { createNodeWebSocketTransport } from "@flue/runtime/node";

import { configureFlueOAuthProvidersFromPiAuth } from "./oauth-auth";
import { prReviewerAgent } from "./pr-reviewer";
import { flueAgentSessionStore } from "./session-store";

configureFlueOAuthProvidersFromPiAuth();

const sessionStore = flueAgentSessionStore;
const runStore = new InMemoryRunStore();
const runSubscribers = createRunSubscriberRegistry();
const runRegistry = new InMemoryRunRegistry();

const manifest = {
  agents: [
    {
      name: "pr-reviewer",
      transports: { http: true as const, websocket: true as const },
      created: true,
    },
  ],
  workflows: [],
};

const agentHandlers: Record<string, AgentHandler> = {
  "pr-reviewer": createDirectAgentHandler(prReviewerAgent),
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
      systemPrompt: "",
      skills: {},
      packagedSkills: {},
      model: undefined,
      resolveModel,
    },
    createDefaultEnv,
    defaultStore: sessionStore,
    req: request,
    initialEventIndex,
  });

const websocketTransport = createNodeWebSocketTransport({
  manifest,
  agentHandlers,
  workflowHandlers: {},
  createContext,
  runStore,
  runSubscribers,
  runRegistry,
});

export const flueWebSocketServer = websocketTransport.server;

let configured = false;

export function createFlueReviewApp() {
  if (!configured) {
    configureFlueRuntime({
      target: "node",
      manifest,
      handlers: agentHandlers,
      workflowHandlers: {},
      nodeWebSocketAgentRoute: websocketTransport.agentRoute,
      nodeWebSocketWorkflowRoute: websocketTransport.workflowRoute,
      createContext,
      runStore,
      runSubscribers,
      runRegistry,
    });
    configured = true;
  }

  return flue();
}
