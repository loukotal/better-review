import { spawn } from "node:child_process";

export async function readableToText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let timedOut = false;
  const timeout = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs)
    : undefined;

  try {
    const exitCodePromise = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      readableToText(child.stdout),
      readableToText(child.stderr),
      exitCodePromise,
    ]);

    return { stdout, stderr, exitCode, timedOut };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
