/* @refresh reload */
import "./index.css";
import { Router, Route } from "@solidjs/router";
import { QueryClientProvider } from "@tanstack/solid-query";
import { render } from "solid-js/web";

import App from "./App";
import { queryClient, restoreCache } from "./lib/query";
import { initializeUiTheme } from "./lib/theme";
import AgentReviewPage from "./pages/AgentReviewPage";
import DesignSystemPage from "./pages/DesignSystemPage";
import KanbanPage from "./pages/KanbanPage";
import PrListPage from "./pages/PrListPage";

const SWIPE_NAV_RESET_MS = 220;
const SWIPE_NAV_COOLDOWN_MS = 700;
const SWIPE_NAV_THRESHOLD_PX = 120;

function canScrollHorizontally(target: EventTarget | null, deltaX: number): boolean {
  if (!(target instanceof Element)) return false;

  for (let element: Element | null = target; element; element = element.parentElement) {
    if (!(element instanceof HTMLElement)) continue;

    const maxScrollLeft = element.scrollWidth - element.clientWidth;
    if (maxScrollLeft <= 1) continue;

    const overflowX = getComputedStyle(element).overflowX;
    if (overflowX !== "auto" && overflowX !== "scroll" && overflowX !== "overlay") continue;

    if (deltaX < 0 && element.scrollLeft > 1) return true;
    if (deltaX > 0 && element.scrollLeft < maxScrollLeft - 1) return true;
  }

  return false;
}

function enableDesktopSwipeNavigation(): void {
  let accumulatedX = 0;
  let accumulatedY = 0;
  let lastWheelAt = 0;
  let lastNavigationAt = 0;

  window.addEventListener(
    "wheel",
    (event) => {
      if (event.defaultPrevented || event.deltaX === 0) return;
      if (canScrollHorizontally(event.target, event.deltaX)) return;

      const now = performance.now();
      if (now - lastNavigationAt < SWIPE_NAV_COOLDOWN_MS) return;
      if (now - lastWheelAt > SWIPE_NAV_RESET_MS) {
        accumulatedX = 0;
        accumulatedY = 0;
      }

      lastWheelAt = now;
      accumulatedX += event.deltaX;
      accumulatedY += event.deltaY;

      const absX = Math.abs(accumulatedX);
      const absY = Math.abs(accumulatedY);
      if (absX < SWIPE_NAV_THRESHOLD_PX || absX < absY * 1.25) return;

      if (accumulatedX < 0 && history.length > 1) {
        event.preventDefault();
        history.back();
        lastNavigationAt = now;
      } else if (accumulatedX > 0) {
        event.preventDefault();
        history.forward();
        lastNavigationAt = now;
      }

      accumulatedX = 0;
      accumulatedY = 0;
    },
    { passive: false },
  );
}

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
    enableDesktopSwipeNavigation();
  }

  await restoreCache().catch((error) => {
    console.error("Failed to restore query cache:", error);
  });

  render(
    () => (
      <QueryClientProvider client={queryClient}>
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
