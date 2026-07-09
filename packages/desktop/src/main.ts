import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  session,
  shell,
  WebContentsView,
} from "electron";

interface ApiServerInfo {
  apiUrl: string;
  webUrl: string;
  apiToken: string;
}

type StopFindAction = Parameters<Electron.WebContents["stopFindInPage"]>[0];

interface DesktopTabSnapshot {
  id: number;
  title: string;
  url: string;
}

interface DesktopTabsSnapshot {
  activeTabId: number;
  tabs: DesktopTabSnapshot[];
}

interface DesktopTab {
  id: number;
  title: string;
  url: string;
  view: WebContentsView;
}

interface CreateTabOptions {
  activate?: boolean;
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const discoveryFile = path.join(
  homedir(),
  ".local",
  "share",
  "better-review",
  "desktop-server.json",
);
const appBackgroundColor = "#0a0a0a";

let serverInfo: ApiServerInfo | undefined;
const tabControllers = new Set<DesktopTabController>();

app.setName("Better Review");

function configureFindIpc(): void {
  ipcMain.handle("better-review:find-in-page", (event, text: unknown, options: unknown) => {
    if (typeof text !== "string" || text.length === 0) return 0;

    const rawOptions = options && typeof options === "object" ? options : {};
    const record = rawOptions as Record<string, unknown>;
    return event.sender.findInPage(text, {
      forward: record.forward !== false,
      findNext: record.findNext === true,
      matchCase: record.matchCase === true,
    });
  });

  ipcMain.handle("better-review:stop-find-in-page", (event, action: unknown) => {
    const safeAction: StopFindAction =
      action === "keepSelection" || action === "activateSelection" ? action : "clearSelection";
    event.sender.stopFindInPage(safeAction);
  });
}

function tabControllerForSender(sender: Electron.WebContents): DesktopTabController | undefined {
  for (const controller of tabControllers) {
    if (controller.hasWebContents(sender)) return controller;
  }
}

function configureTabsIpc(): void {
  ipcMain.handle("better-review:tabs:get", (event) => {
    return tabControllerForSender(event.sender)?.snapshot() ?? null;
  });

  ipcMain.handle("better-review:tabs:open", async (event, url: unknown, options: unknown) => {
    const controller = tabControllerForSender(event.sender);
    if (!controller || typeof url !== "string") return null;

    const record =
      options && typeof options === "object" ? (options as Record<string, unknown>) : {};
    return await controller.createTab(url, { activate: record.activate !== false });
  });

  ipcMain.handle("better-review:tabs:switch", (event, tabId: unknown) => {
    const controller = tabControllerForSender(event.sender);
    if (!controller || typeof tabId !== "number") return;
    controller.activateTab(tabId);
  });

  ipcMain.handle("better-review:tabs:close", (event, tabId: unknown) => {
    const controller = tabControllerForSender(event.sender);
    if (!controller || typeof tabId !== "number") return;
    controller.closeTab(tabId);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

async function canListen(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (isValidPort(port) ? resolve(port) : reject(new Error("No free port"))));
    });
  });
}

async function resolveApiPort(): Promise<number> {
  const preferred = Number(process.env.API_PORT ?? 3001);
  if (isValidPort(preferred) && (await canListen(preferred))) {
    return preferred;
  }
  return await getFreePort();
}

function resourcePath(packagedPath: string, devPathFromDesktopDist: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, packagedPath)
    : path.resolve(currentDir, devPathFromDesktopDist);
}

function appFilePath(packagedPath: string, devPathFromDesktopDist: string): string {
  return app.isPackaged
    ? path.join(app.getAppPath(), packagedPath)
    : path.resolve(currentDir, devPathFromDesktopDist);
}

function iconPath(): string {
  return resourcePath("icon.png", "../assets/icon.png");
}

function preloadPath(): string {
  return appFilePath(path.join("dist", "preload.cjs"), "preload.cjs");
}

function appWebPreferences(): Electron.WebPreferences {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    preload: preloadPath(),
    sandbox: true,
  };
}

function resolveAppUrl(info: ApiServerInfo, input: string): string | undefined {
  try {
    const baseUrl = info.webUrl.endsWith("/") ? info.webUrl : `${info.webUrl}/`;
    return new URL(input, baseUrl).href;
  } catch {
    return undefined;
  }
}

function isAppUrl(info: ApiServerInfo, input: string): boolean {
  const url = resolveAppUrl(info, input);
  if (!url) return false;

  try {
    return new URL(url).origin === new URL(info.webUrl).origin;
  } catch {
    return false;
  }
}

function tabTitleFromUrl(info: ApiServerInfo, input: string): string {
  const fallback = "Better Review";
  const url = resolveAppUrl(info, input);
  if (!url) return fallback;

  const parsed = new URL(url);
  if (parsed.pathname === "/") return "Review Requests";
  if (parsed.pathname === "/kanban") return "Kanban";
  if (parsed.pathname === "/design-system" || parsed.pathname === "/_debug/design-system") {
    return "Design System";
  }
  if (parsed.pathname.startsWith("/agent-review/")) return "Agent Review";
  if (parsed.pathname === "/review") {
    const prUrl = parsed.searchParams.get("prUrl");
    const match = prUrl?.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (match) return `${match[1]}/${match[2]}#${match[3]}`;
    return "Review";
  }

  return fallback;
}

function setAppIcon(): void {
  if (process.platform !== "darwin") return;

  const icon = nativeImage.createFromPath(iconPath());
  if (!icon.isEmpty()) {
    app.dock.setIcon(icon);
  }
}

async function waitForHealth(apiUrl: string, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${apiUrl}/api/sessions/healthcheck`);
      if (response.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`API server did not become healthy at ${apiUrl}`);
}

async function writeDiscoveryFile(info: ApiServerInfo): Promise<void> {
  await mkdir(path.dirname(discoveryFile), { recursive: true });
  await writeFile(
    discoveryFile,
    JSON.stringify(
      {
        ...info,
        pid: process.pid,
        startedAt: Date.now(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

async function clearDiscoveryFile(): Promise<void> {
  await rm(discoveryFile, { force: true });
}

async function startApiServer(): Promise<ApiServerInfo> {
  const host = "127.0.0.1";
  const port = await resolveApiPort();
  const apiUrl = `http://${host}:${port}`;
  const apiToken = randomUUID();
  const staticDir = resourcePath("web-dist", "../../web/dist");
  const serverEntry = resourcePath(
    path.join("server", "index.mjs"),
    "../../better-review/dist/index.mjs",
  );

  if (!existsSync(staticDir)) {
    throw new Error(`Missing web build at ${staticDir}. Run pnpm desktop:build first.`);
  }
  if (!existsSync(serverEntry)) {
    throw new Error(`Missing API server bundle at ${serverEntry}. Run pnpm desktop:build first.`);
  }

  process.env.NODE_ENV = "production";
  process.env.API_HOST = host;
  process.env.API_PORT = String(port);
  process.env.BETTER_REVIEW_API_TOKEN = apiToken;
  process.env.BETTER_REVIEW_STATIC_DIR = staticDir;

  void import(pathToFileURL(serverEntry).href).catch((error) => {
    console.error("[desktop] API server failed:", error);
    app.quit();
  });

  await waitForHealth(apiUrl);

  const info = { apiUrl, webUrl: apiUrl, apiToken };
  await writeDiscoveryFile(info);
  return info;
}

function configureApiAuth(info: ApiServerInfo): void {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${info.apiUrl}/api/*`] },
    (details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          Authorization: `Bearer ${info.apiToken}`,
        },
      });
    },
  );
}

function configureFindEvents(webContents: Electron.WebContents): void {
  webContents.on("found-in-page", (_event, result) => {
    webContents.send("better-review:found-in-page", {
      requestId: result.requestId,
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
      finalUpdate: result.finalUpdate,
    });
  });
}

class DesktopTabController {
  private readonly tabs: DesktopTab[] = [];
  private activeTabId = 0;
  private nextTabId = 1;
  private destroyed = false;

  constructor(
    private readonly window: BrowserWindow,
    private readonly info: ApiServerInfo,
  ) {
    window.on("resize", () => this.layoutTabs());
  }

  hasWebContents(webContents: Electron.WebContents): boolean {
    return !this.destroyed && this.tabs.some((tab) => tab.view.webContents === webContents);
  }

  snapshot(): DesktopTabsSnapshot {
    return {
      activeTabId: this.activeTabId,
      tabs: this.tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        url: tab.url,
      })),
    };
  }

  async createTab(
    inputUrl: string,
    options: CreateTabOptions = {},
  ): Promise<DesktopTabSnapshot | null> {
    if (this.destroyed) return null;

    const url = resolveAppUrl(this.info, inputUrl);
    if (!url) return null;

    if (!isAppUrl(this.info, url)) {
      void shell.openExternal(url);
      return null;
    }

    const shouldActivate = options.activate !== false;
    const view = new WebContentsView({ webPreferences: appWebPreferences() });
    view.setBackgroundColor(appBackgroundColor);
    view.setVisible(false);
    const tab: DesktopTab = {
      id: this.nextTabId++,
      title: tabTitleFromUrl(this.info, url),
      url,
      view,
    };

    this.tabs.push(tab);
    this.window.contentView.addChildView(view);
    this.configureTab(tab);
    this.layoutTabs();
    this.broadcastTabs();

    try {
      await view.webContents.loadURL(url);
    } catch (error) {
      if (!this.destroyed && !view.webContents.isDestroyed() && this.tabs.includes(tab)) {
        console.error(`[desktop] Failed to load tab ${url}:`, error);
      }
    }

    if (view.webContents.isDestroyed() || !this.tabs.includes(tab)) return null;

    this.updateTabUrl(tab, view.webContents.getURL() || url);
    if (shouldActivate) this.activateTab(tab.id);

    return { id: tab.id, title: tab.title, url: tab.url };
  }

  activateTab(tabId: number): void {
    if (this.destroyed) return;

    const activeTab = this.tabs.find((tab) => tab.id === tabId);
    if (!activeTab) return;

    this.activeTabId = tabId;
    for (const tab of this.tabs) {
      tab.view.setVisible(tab.id === tabId);
    }

    this.window.contentView.addChildView(activeTab.view);
    this.layoutTabs();
    activeTab.view.webContents.focus();
    this.broadcastTabs();
  }

  closeTab(tabId: number): void {
    if (this.destroyed) return;

    if (this.tabs.length <= 1) return;

    const tabIndex = this.tabs.findIndex((tab) => tab.id === tabId);
    if (tabIndex === -1) return;

    const [tab] = this.tabs.splice(tabIndex, 1);
    this.disposeTab(tab);

    if (this.activeTabId === tabId) {
      const nextTab = this.tabs[Math.max(0, tabIndex - 1)] ?? this.tabs[0];
      this.activateTab(nextTab.id);
      return;
    }

    this.broadcastTabs();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const tab of this.tabs) {
      this.disposeTab(tab);
    }
    this.tabs.length = 0;
  }

  private configureTab(tab: DesktopTab): void {
    const { webContents } = tab.view;
    configureFindEvents(webContents);

    webContents.setWindowOpenHandler(({ url }) => {
      if (isAppUrl(this.info, url)) {
        void this.createTab(url, { activate: true });
      } else {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });

    webContents.on("will-navigate", (event, url) => {
      if (isAppUrl(this.info, url)) return;
      event.preventDefault();
      void shell.openExternal(url);
    });

    webContents.on("did-navigate", (_event, url) => {
      this.updateTabUrl(tab, url);
    });

    webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame) this.updateTabUrl(tab, url);
    });
  }

  private updateTabUrl(tab: DesktopTab, url: string): void {
    if (this.destroyed || !this.tabs.includes(tab) || tab.view.webContents.isDestroyed()) return;
    if (!isAppUrl(this.info, url)) return;
    tab.url = url;
    tab.title = tabTitleFromUrl(this.info, url);
    this.broadcastTabs();
  }

  private disposeTab(tab: DesktopTab): void {
    this.window.contentView.removeChildView(tab.view);
    tab.view.setVisible(false);
    if (!tab.view.webContents.isDestroyed()) {
      tab.view.webContents.close({ waitForBeforeUnload: false });
    }
  }

  private layoutTabs(): void {
    const [width, height] = this.window.getContentSize();
    for (const tab of this.tabs) {
      tab.view.setBounds({ x: 0, y: 0, width, height });
    }
  }

  private broadcastTabs(): void {
    if (this.destroyed) return;

    const snapshot = this.snapshot();
    for (const tab of this.tabs) {
      if (!tab.view.webContents.isDestroyed()) {
        tab.view.webContents.send("better-review:tabs:changed", snapshot);
      }
    }
  }
}

async function createMainWindow(info: ApiServerInfo): Promise<void> {
  const window = new BrowserWindow({
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 16, y: 14 },
        }
      : {}),
    width: 1440,
    height: 1000,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: appBackgroundColor,
    show: false,
    title: "Better Review",
    icon: iconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const tabController = new DesktopTabController(window, info);
  tabControllers.add(tabController);
  window.on("close", () => {
    tabController.destroy();
  });
  window.on("closed", () => {
    tabControllers.delete(tabController);
  });

  await tabController.createTab(info.webUrl, { activate: true });
  window.show();
}

app.on("before-quit", () => {
  void clearDiscoveryFile();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app
  .whenReady()
  .then(async () => {
    configureFindIpc();
    configureTabsIpc();
    setAppIcon();
    serverInfo = await startApiServer();
    configureApiAuth(serverInfo);
    await createMainWindow(serverInfo);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 && serverInfo) {
        void createMainWindow(serverInfo);
      }
    });
  })
  .catch((error) => {
    console.error("[desktop] Startup failed:", error);
    app.quit();
  });
