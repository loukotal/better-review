import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { PRComment, PrCommit } from "../diff/types";
import type { PrStatus } from "../components/PrStatusBar";

// ============ Cache Types ============

export interface CachedPrData {
  url: string;
  diff: string;
  info: {
    owner: string;
    repo: string;
    number: string;
  };
  updatedAt: number;
}

export interface CachedCommits {
  prUrl: string;
  commits: PrCommit[];
  updatedAt: number;
}

export interface CachedComments {
  prUrl: string;
  comments: PRComment[];
  updatedAt: number;
}

export interface CachedStatus {
  prUrl: string;
  status: PrStatus;
  updatedAt: number;
}

// ============ Database Schema ============

interface BetterReviewDB extends DBSchema {
  prs: {
    key: string;
    value: CachedPrData;
    indexes: { "by-updated": number };
  };
  commits: {
    key: string;
    value: CachedCommits;
    indexes: { "by-updated": number };
  };
  comments: {
    key: string;
    value: CachedComments;
    indexes: { "by-updated": number };
  };
  status: {
    key: string;
    value: CachedStatus;
    indexes: { "by-updated": number };
  };
}

// ============ Database Instance ============

const DB_NAME = "better-review";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<BetterReviewDB>> | null = null;

function getDB(): Promise<IDBPDatabase<BetterReviewDB>> {
  if (!dbPromise) {
    dbPromise = openDB<BetterReviewDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // PRs store
        if (!db.objectStoreNames.contains("prs")) {
          const prStore = db.createObjectStore("prs", { keyPath: "url" });
          prStore.createIndex("by-updated", "updatedAt");
        }
        // Commits store
        if (!db.objectStoreNames.contains("commits")) {
          const commitsStore = db.createObjectStore("commits", { keyPath: "prUrl" });
          commitsStore.createIndex("by-updated", "updatedAt");
        }
        // Comments store
        if (!db.objectStoreNames.contains("comments")) {
          const commentsStore = db.createObjectStore("comments", { keyPath: "prUrl" });
          commentsStore.createIndex("by-updated", "updatedAt");
        }
        // Status store
        if (!db.objectStoreNames.contains("status")) {
          const statusStore = db.createObjectStore("status", { keyPath: "prUrl" });
          statusStore.createIndex("by-updated", "updatedAt");
        }
      },
    });
  }
  return dbPromise;
}

// ============ Cache API ============

export const prCache = {
  async get(url: string): Promise<CachedPrData | undefined> {
    const db = await getDB();
    return db.get("prs", url);
  },

  async set(data: Omit<CachedPrData, "updatedAt">): Promise<void> {
    const db = await getDB();
    await db.put("prs", { ...data, updatedAt: Date.now() });
  },

  async delete(url: string): Promise<void> {
    const db = await getDB();
    await db.delete("prs", url);
  },

  async getAll(): Promise<CachedPrData[]> {
    const db = await getDB();
    return db.getAll("prs");
  },
};

export const commitsCache = {
  async get(prUrl: string): Promise<PrCommit[] | undefined> {
    const db = await getDB();
    const data = await db.get("commits", prUrl);
    return data?.commits;
  },

  async set(prUrl: string, commits: PrCommit[]): Promise<void> {
    const db = await getDB();
    await db.put("commits", { prUrl, commits, updatedAt: Date.now() });
  },

  async delete(prUrl: string): Promise<void> {
    const db = await getDB();
    await db.delete("commits", prUrl);
  },
};

export const commentsCache = {
  async get(prUrl: string): Promise<PRComment[] | undefined> {
    const db = await getDB();
    const data = await db.get("comments", prUrl);
    return data?.comments;
  },

  async set(prUrl: string, comments: PRComment[]): Promise<void> {
    const db = await getDB();
    await db.put("comments", { prUrl, comments, updatedAt: Date.now() });
  },

  async delete(prUrl: string): Promise<void> {
    const db = await getDB();
    await db.delete("comments", prUrl);
  },
};

export const statusCache = {
  async get(prUrl: string): Promise<PrStatus | undefined> {
    const db = await getDB();
    const data = await db.get("status", prUrl);
    return data?.status;
  },

  async set(prUrl: string, status: PrStatus): Promise<void> {
    const db = await getDB();
    await db.put("status", { prUrl, status, updatedAt: Date.now() });
  },

  async delete(prUrl: string): Promise<void> {
    const db = await getDB();
    await db.delete("status", prUrl);
  },
};

// ============ Unified Cache API ============

export interface FullPrCache {
  pr?: CachedPrData;
  commits?: PrCommit[];
  comments?: PRComment[];
  status?: PrStatus;
}

export const cache = {
  /** Get all cached data for a PR */
  async getPr(url: string): Promise<FullPrCache> {
    const [pr, commits, comments, status] = await Promise.all([
      prCache.get(url),
      commitsCache.get(url),
      commentsCache.get(url),
      statusCache.get(url),
    ]);
    return { pr, commits, comments, status };
  },

  /** Save all PR data at once */
  async savePr(
    url: string,
    data: {
      diff?: string;
      info?: { owner: string; repo: string; number: string };
      commits?: PrCommit[];
      comments?: PRComment[];
      status?: PrStatus;
    }
  ): Promise<void> {
    const promises: Promise<void>[] = [];

    if (data.diff && data.info) {
      promises.push(prCache.set({ url, diff: data.diff, info: data.info }));
    }
    if (data.commits) {
      promises.push(commitsCache.set(url, data.commits));
    }
    if (data.comments) {
      promises.push(commentsCache.set(url, data.comments));
    }
    if (data.status) {
      promises.push(statusCache.set(url, data.status));
    }

    await Promise.all(promises);
  },

  /** Delete all cached data for a PR */
  async deletePr(url: string): Promise<void> {
    await Promise.all([
      prCache.delete(url),
      commitsCache.delete(url),
      commentsCache.delete(url),
      statusCache.delete(url),
    ]);
  },

  /** Clear entire cache */
  async clear(): Promise<void> {
    const db = await getDB();
    await Promise.all([
      db.clear("prs"),
      db.clear("commits"),
      db.clear("comments"),
      db.clear("status"),
    ]);
  },

  /** Get cache stats */
  async stats(): Promise<{ prs: number; totalSize: string }> {
    const db = await getDB();
    const prs = await db.count("prs");
    // Rough size estimate
    const allPrs = await db.getAll("prs");
    const size = new Blob([JSON.stringify(allPrs)]).size;
    const totalSize = size > 1024 * 1024
      ? `${(size / 1024 / 1024).toFixed(1)} MB`
      : `${(size / 1024).toFixed(1)} KB`;
    return { prs, totalSize };
  },
};
