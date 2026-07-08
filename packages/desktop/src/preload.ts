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
