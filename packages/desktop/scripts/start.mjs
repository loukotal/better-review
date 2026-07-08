import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: desktopDir,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${signal ?? code}`));
    });
  });
}

function findAppBundle(dir) {
  for (const entry of readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    if (entry.endsWith(".app") && statSync(entryPath).isDirectory()) return entryPath;
    if (!statSync(entryPath).isDirectory()) continue;

    const appBundle = findAppBundle(entryPath);
    if (appBundle) return appBundle;
  }
}

function appExecutable(appBundle) {
  const macOsDir = path.join(appBundle, "Contents", "MacOS");
  const preferred = path.join(macOsDir, "Better Review");
  if (existsSync(preferred)) return preferred;

  const executable = readdirSync(macOsDir)[0];
  if (!executable) throw new Error(`No app executable found in ${macOsDir}`);
  return path.join(macOsDir, executable);
}

function launch(command, args) {
  const child = spawn(command, args, {
    cwd: desktopDir,
    env: process.env,
    stdio: "inherit",
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

if (process.platform === "darwin") {
  await run("pnpm", ["run", "package:dir"]);

  const releaseDir = path.join(desktopDir, "release");
  const appBundle = findAppBundle(releaseDir);
  if (!appBundle) throw new Error(`No .app bundle found in ${releaseDir}`);

  launch(appExecutable(appBundle), []);
} else {
  launch("electron", ["."]);
}
