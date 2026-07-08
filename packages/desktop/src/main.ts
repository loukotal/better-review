import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BrowserWindow, nativeImage, session, shell } from "electron";

interface ApiServerInfo {
  apiUrl: string;
  webUrl: string;
  apiToken: string;
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const discoveryFile = path.join(
  homedir(),
  ".local",
  "share",
  "better-review",
  "desktop-server.json",
);

let serverInfo: ApiServerInfo | undefined;

app.setName("Better Review");

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

function iconPath(): string {
  return resourcePath("icon.png", "../assets/icon.png");
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

async function createMainWindow(info: ApiServerInfo): Promise<void> {
  const window = new BrowserWindow({
    width: 1440,
    height: 1000,
    minWidth: 900,
    minHeight: 650,
    title: "Better Review",
    icon: iconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(info.webUrl)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(info.webUrl)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  await window.loadURL(info.webUrl);
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
