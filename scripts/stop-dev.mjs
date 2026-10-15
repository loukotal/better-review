import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = realpathSync(resolve(import.meta.dirname, ".."));
const ports = [...new Set([process.env.WEB_PORT ?? "3000", process.env.API_PORT ?? "3001"])];
for (const port of ports) {
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error(`Invalid development port: ${port}`);
}

function lsof(args) {
  try {
    return execFileSync("lsof", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (error.status === 1 && !String(error.stderr ?? "").trim()) return "";
    throw error;
  }
}
const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
const processes = new Map();
for (const line of rows.split("\n")) {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
  if (match) processes.set(Number(match[1]), { parent: Number(match[2]), command: match[3] });
}
const protectedPids = new Set();
for (let pid = process.pid; pid && !protectedPids.has(pid); pid = processes.get(pid)?.parent)
  protectedPids.add(pid);

function belongsHere(pid) {
  const cwd = lsof(["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  return cwd && (cwd === root || cwd.startsWith(root + sep));
}
const listeners = new Set(
  lsof(["-nP", "-t", ...ports.map((port) => `-iTCP:${port}`), "-sTCP:LISTEN"])
    .split(/\s+/)
    .filter(Boolean)
    .map(Number),
);
const roots = new Set();
for (const listener of listeners) {
  if (protectedPids.has(listener) || !belongsHere(listener))
    throw new Error(
      `Port ${ports.join(" or ")} is occupied by PID ${listener} outside this checkout. Stop it or choose different ports.`,
    );
  let pid = listener;
  while (true) {
    const parent = processes.get(pid)?.parent;
    const info = processes.get(parent);
    if (
      !info ||
      protectedPids.has(parent) ||
      !/\b(pnpm|concurrently|tsx|vite)\b/.test(info.command) ||
      !belongsHere(parent)
    )
      break;
    pid = parent;
  }
  roots.add(pid);
}
const targets = new Set(roots);
for (let changed = true; changed;) {
  changed = false;
  for (const [pid, info] of processes) {
    if (targets.has(info.parent) && !targets.has(pid) && !protectedPids.has(pid)) {
      targets.add(pid);
      changed = true;
    }
  }
}
function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
if (targets.size) {
  console.log(`[dev] Stopping existing checkout servers on ports ${ports.join(", ")}…`);
  for (const pid of targets) signal(pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while ([...targets].some(alive) && Date.now() < deadline) await sleep(100);
  for (const pid of targets) if (alive(pid)) signal(pid, "SIGKILL");
  const killDeadline = Date.now() + 2000;
  while ([...listeners].some(alive) && Date.now() < killDeadline) await sleep(50);
  if ([...listeners].some(alive)) throw new Error("Existing development server did not stop");
  console.log("[dev] Existing servers stopped.");
}
