import { For, onCleanup, onMount, Show, createSignal } from "solid-js";

interface DesktopTabSnapshot {
  id: number;
  title: string;
  url: string;
}

interface DesktopTabsSnapshot {
  activeTabId: number;
  tabs: DesktopTabSnapshot[];
}

interface OpenTabOptions {
  activate?: boolean;
}

interface DesktopTabsApi {
  getTabs(): Promise<DesktopTabsSnapshot | null>;
  openTab(url: string, options?: OpenTabOptions): Promise<DesktopTabSnapshot | null>;
  switchTab(tabId: number): Promise<void>;
  closeTab(tabId: number): Promise<void>;
  onTabsChanged(callback: (snapshot: DesktopTabsSnapshot) => void): () => void;
}

declare global {
  interface Window {
    betterReviewDesktopTabs?: DesktopTabsApi;
  }
}

function findAnchor(target: EventTarget | null): HTMLAnchorElement | undefined {
  if (!(target instanceof Element)) return;
  return target.closest<HTMLAnchorElement>("a[href]") ?? undefined;
}

function isInternalUrl(href: string): boolean {
  try {
    return new URL(href, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

function shouldOpenLinkInTab(event: MouseEvent): boolean {
  if (event.button === 1) return true;
  if (event.button !== 0) return false;

  const isMac = navigator.platform.toLowerCase().includes("mac");
  return isMac ? event.metaKey : event.ctrlKey || event.metaKey;
}

export function DesktopTabs() {
  const [snapshot, setSnapshot] = createSignal<DesktopTabsSnapshot | null>(null);
  const api = () => window.betterReviewDesktopTabs;

  const openHomeTab = () => {
    void api()?.openTab("/", { activate: true });
  };

  const onLinkClick = (event: MouseEvent) => {
    const tabsApi = api();
    if (!tabsApi || event.defaultPrevented || !shouldOpenLinkInTab(event)) return;

    const anchor = findAnchor(event.target);
    if (!anchor || anchor.hasAttribute("download") || !isInternalUrl(anchor.href)) return;

    event.preventDefault();
    event.stopPropagation();
    void tabsApi.openTab(anchor.href, { activate: event.shiftKey });
  };

  onMount(() => {
    const tabsApi = api();
    if (!tabsApi) return;

    document.documentElement.dataset.desktopTabs = "true";
    void tabsApi.getTabs().then((nextSnapshot) => {
      if (nextSnapshot) setSnapshot(nextSnapshot);
    });

    const removeTabsListener = tabsApi.onTabsChanged(setSnapshot);
    document.addEventListener("click", onLinkClick, true);
    document.addEventListener("auxclick", onLinkClick, true);

    onCleanup(() => {
      removeTabsListener();
      document.removeEventListener("click", onLinkClick, true);
      document.removeEventListener("auxclick", onLinkClick, true);
      delete document.documentElement.dataset.desktopTabs;
    });
  });

  return (
    <Show when={api() && snapshot()}>
      {(state) => (
        <div class="sticky left-0 right-0 top-0 z-[900] flex h-10 items-end border-b border-border bg-bg-surface pl-[96px] pr-2 [-webkit-app-region:drag]">
          <div class="flex min-w-0 flex-1 items-end overflow-hidden">
            <For each={state().tabs}>
              {(tab) => {
                const active = () => tab.id === state().activeTabId;
                return (
                  <div
                    class={`group mb-[-1px] flex h-8 min-w-0 max-w-64 flex-1 items-center border border-border [-webkit-app-region:no-drag] ${
                      active()
                        ? "border-b-bg bg-bg text-text"
                        : "bg-bg-surface text-text-faint hover:bg-bg-elevated hover:text-text"
                    }`}
                    title={tab.url}
                  >
                    <button
                      type="button"
                      class="min-w-0 flex-1 truncate px-3 py-1.5 text-left text-xs"
                      onClick={() => void api()?.switchTab(tab.id)}
                    >
                      {tab.title}
                    </button>
                    <button
                      type="button"
                      disabled={state().tabs.length <= 1}
                      class="mr-1 h-5 w-5 flex-shrink-0 text-xs text-text-faint hover:text-text disabled:pointer-events-none disabled:opacity-20"
                      title="Close tab"
                      onClick={(event) => {
                        event.stopPropagation();
                        void api()?.closeTab(tab.id);
                      }}
                    >
                      x
                    </button>
                  </div>
                );
              }}
            </For>
          </div>
          <button
            type="button"
            class="mb-1 ml-1 h-7 w-7 flex-shrink-0 border border-border text-sm text-text-faint hover:border-text-faint hover:text-text [-webkit-app-region:no-drag]"
            title="New tab"
            onClick={openHomeTab}
          >
            +
          </button>
        </div>
      )}
    </Show>
  );
}
