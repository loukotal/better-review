import { execFile } from "node:child_process";

export interface PrDetailHttpOptions {
  fetch?: typeof globalThis.fetch;
  token?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxPages?: number;
  maxResponseBytes?: number;
}
/** Only these HTTP responses prove GitHub refused this write. Never expose raw response text. */
export class PrDetailHttpError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? "GitHub authentication failed."
        : status === 403
          ? "GitHub permission or rate limit denied the request."
          : status === 409 || status === 412
            ? "GitHub rejected the expected head or a merge precondition."
            : status === 422
              ? "GitHub rejected the merge parameters or branch requirements."
              : `GitHub request failed (HTTP ${status}).`,
    );
  }
  get definitiveRejection() {
    return [401, 403, 409, 412, 422].includes(this.status);
  }
}
export function bounded<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    run(controller.signal),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("GitHub request timed out."));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
export async function credential(options: PrDetailHttpOptions): Promise<string> {
  const env = options.env ?? process.env;
  const token = options.token
    ? await bounded(() => options.token!(), options.timeoutMs ?? 15000)
    : env.GH_TOKEN ||
      env.GITHUB_TOKEN ||
      (await new Promise<string>((resolve, reject) => {
        execFile(
          "gh",
          ["auth", "token", "--hostname", "github.com"],
          { env, timeout: options.timeoutMs ?? 15000, killSignal: "SIGKILL", maxBuffer: 65536 },
          (error, stdout) =>
            error ? reject(new Error("GitHub credentials unavailable.")) : resolve(stdout.trim()),
        );
      }));
  if (!token || /[\r\n]/.test(token)) throw new Error("GitHub credentials unavailable.");
  return token;
}
export function createPrDetailHttp(options: PrDetailHttpOptions, token: string) {
  return async (path: string, method: string, body: unknown): Promise<unknown> =>
    bounded(async (signal) => {
      const response = await (options.fetch ?? globalThis.fetch)(`https://api.github.com${path}`, {
        method,
        signal,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new PrDetailHttpError(response.status);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("GitHub returned an empty response.");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          if (signal.aborted) throw new Error("GitHub request timed out.");
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > (options.maxResponseBytes ?? 8 * 1024 * 1024)) {
            cancel();
            throw new Error("GitHub response exceeded the configured size limit.");
          }
          chunks.push(chunk.value);
        }
        if (signal.aborted) throw new Error("GitHub request timed out.");
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } finally {
        signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
    }, options.timeoutMs ?? 15000);
}
export function parsePrDetailUrl(url: string) {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url);
  if (!match || !Number.isSafeInteger(Number(match[3])))
    throw new Error("Expected a canonical github.com pull request URL.");
  return {
    owner: match[1]!,
    repo: match[2]!,
    number: Number(match[3]),
    url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
  };
}
