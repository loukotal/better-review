/* @refresh reload */
import "./index.css";
import { Router, Route } from "@solidjs/router";
import { QueryClientProvider } from "@tanstack/solid-query";
import { render } from "solid-js/web";

import App from "./App";
import { DesktopFindBar } from "./components/DesktopFindBar";
import { queryClient, restoreCache } from "./lib/query";
import { initializeUiTheme } from "./lib/theme";
import AgentReviewPage from "./pages/AgentReviewPage";
import DesignSystemPage from "./pages/DesignSystemPage";
import KanbanPage from "./pages/KanbanPage";
import PrListPage from "./pages/PrListPage";

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?",
  );
}

async function start(): Promise<void> {
  initializeUiTheme();

  if (navigator.userAgent.includes(" Electron/")) {
    document.documentElement.dataset.desktopApp = "true";
  }

  await restoreCache().catch((error) => {
    console.error("Failed to restore query cache:", error);
  });

  render(
    () => (
      <QueryClientProvider client={queryClient}>
        <DesktopFindBar />
        <Router>
          <Route path="/" component={PrListPage} />
          <Route path="/agent-review/:sessionId" component={AgentReviewPage} />
          <Route path="/review" component={App} />
          <Route path="/kanban" component={KanbanPage} />
          <Route path="/design-system" component={DesignSystemPage} />
          <Route path="/_debug/design-system" component={DesignSystemPage} />
        </Router>
      </QueryClientProvider>
    ),
    root!,
  );
}

void start();
