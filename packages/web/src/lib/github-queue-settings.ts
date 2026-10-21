import { DEFAULT_GITHUB_QUEUE_TIMEOUT_MS, isGithubQueueTimeoutMs } from "@better-review/shared";

export const GITHUB_QUEUE_SETTINGS_KEY = "better-review:github-queue-settings:v1";
export const DEFAULT_GITHUB_SYNC_TIMEOUT_MS = DEFAULT_GITHUB_QUEUE_TIMEOUT_MS;
type StorageAccess = Pick<Storage, "getItem" | "setItem">;
let fallbackTimeoutMs = DEFAULT_GITHUB_SYNC_TIMEOUT_MS;

function validTimeout(value: unknown): value is number {
  return isGithubQueueTimeoutMs(value);
}

/** Capture once when creating a new intent or explicitly retrying an old one. */
export function getGithubSyncTimeoutMs(storage?: StorageAccess): number {
  let raw: string | null;
  try {
    raw = (storage ?? localStorage).getItem(GITHUB_QUEUE_SETTINGS_KEY);
  } catch {
    return fallbackTimeoutMs;
  }
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    return value &&
      typeof value === "object" &&
      "version" in value &&
      value.version === 1 &&
      "timeoutMs" in value &&
      validTimeout(value.timeoutMs)
      ? value.timeoutMs
      : DEFAULT_GITHUB_SYNC_TIMEOUT_MS;
  } catch {
    return DEFAULT_GITHUB_SYNC_TIMEOUT_MS;
  }
}

export function setGithubSyncTimeoutMs(timeoutMs: number, storage?: StorageAccess): void {
  if (!validTimeout(timeoutMs))
    throw new RangeError("GitHub sync timeout must be between 1 and 60 minutes.");
  fallbackTimeoutMs = timeoutMs;
  try {
    (storage ?? localStorage).setItem(
      GITHUB_QUEUE_SETTINGS_KEY,
      JSON.stringify({ version: 1, timeoutMs }),
    );
  } catch {
    /* Keep this session's choice when storage is unavailable. */
  }
}
