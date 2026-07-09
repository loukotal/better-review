import { contextBridge, ipcRenderer } from "electron";

type StopFindAction = "clearSelection" | "keepSelection" | "activateSelection";

interface FindInPageOptions {
  forward?: boolean;
  findNext?: boolean;
  matchCase?: boolean;
}

interface FoundInPageResult {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

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

contextBridge.exposeInMainWorld("betterReviewDesktopFind", {
  findInPage: (text: string, options?: FindInPageOptions): Promise<number> =>
    ipcRenderer.invoke("better-review:find-in-page", text, options),
  stopFindInPage: (action: StopFindAction = "clearSelection"): Promise<void> =>
    ipcRenderer.invoke("better-review:stop-find-in-page", action),
  onFoundInPage: (callback: (result: FoundInPageResult) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: FoundInPageResult) => {
      callback(result);
    };
    ipcRenderer.on("better-review:found-in-page", listener);
    return () => ipcRenderer.off("better-review:found-in-page", listener);
  },
});

contextBridge.exposeInMainWorld("betterReviewDesktopTabs", {
  getTabs: (): Promise<DesktopTabsSnapshot | null> => ipcRenderer.invoke("better-review:tabs:get"),
  openTab: (url: string, options?: OpenTabOptions): Promise<DesktopTabSnapshot | null> =>
    ipcRenderer.invoke("better-review:tabs:open", url, options),
  switchTab: (tabId: number): Promise<void> =>
    ipcRenderer.invoke("better-review:tabs:switch", tabId),
  closeTab: (tabId: number): Promise<void> => ipcRenderer.invoke("better-review:tabs:close", tabId),
  onTabsChanged: (callback: (snapshot: DesktopTabsSnapshot) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: DesktopTabsSnapshot) => {
      callback(snapshot);
    };
    ipcRenderer.on("better-review:tabs:changed", listener);
    return () => ipcRenderer.off("better-review:tabs:changed", listener);
  },
});
