import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SessionData, SessionStore } from "@flue/runtime";

import { STORE_BASE_DIR } from "../store";

const FLUE_AGENT_SESSIONS_DIR = path.join(STORE_BASE_DIR, "flue-agent-sessions");

function fileNameForSession(id: string): string {
  // Flue's internal session ids can be composite strings such as
  // `agent-session:["<agent-instance>","default","default"]`. Store them as
  // base64url filenames rather than constraining Flue's id format.
  return `${Buffer.from(id, "utf8").toString("base64url")}.json`;
}

function filePathForSession(id: string): string {
  return path.join(FLUE_AGENT_SESSIONS_DIR, fileNameForSession(id));
}

export function flueInternalSessionId(agentInstanceId: string): string {
  return `agent-session:${JSON.stringify([agentInstanceId, "default", "default"])}`;
}

export class FileSessionStore implements SessionStore {
  async save(id: string, data: SessionData): Promise<void> {
    await mkdir(FLUE_AGENT_SESSIONS_DIR, { recursive: true });
    await writeFile(filePathForSession(id), JSON.stringify(data, null, 2));
  }

  async load(id: string): Promise<SessionData | null> {
    try {
      return JSON.parse(await readFile(filePathForSession(id), "utf8")) as SessionData;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    await rm(filePathForSession(id), { force: true });
  }
}

export const flueAgentSessionStore = new FileSessionStore();

export async function readFlueAgentSession(id: string): Promise<SessionData | null> {
  return flueAgentSessionStore.load(id);
}
