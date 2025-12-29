import { type Component, createSignal, createEffect, Show } from "solid-js";
import type { FileDiffMetadata } from "@pierre/diffs";
import { DiffViewer, getFileElementId, type PRComment, type DiffSettings, DEFAULT_DIFF_SETTINGS } from "./DiffViewer";
import { FileTreePanel } from "./FileTreePanel";
import { SettingsPanel } from "./diff/SettingsPanel";
import { THEME_LABELS, type DiffTheme } from "./diff/types";

const SETTINGS_STORAGE_KEY = "diff-settings";

// Valid theme keys for validation
const VALID_THEMES = new Set(Object.keys(THEME_LABELS));

function loadSettings(): DiffSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Validate theme - if invalid, use default
      if (parsed.theme && !VALID_THEMES.has(parsed.theme)) {
        parsed.theme = DEFAULT_DIFF_SETTINGS.theme;
      }
      return { ...DEFAULT_DIFF_SETTINGS, ...parsed };
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_DIFF_SETTINGS;
}

function saveSettings(settings: DiffSettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage errors
  }
}

const App: Component = () => {
  const [prUrl, setPrUrl] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [loadingComments, setLoadingComments] = createSignal(false);
  const [diff, setDiff] = createSignal<string | null>(null);
  const [files, setFiles] = createSignal<FileDiffMetadata[]>([]);
  const [comments, setComments] = createSignal<PRComment[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [settings, setSettings] = createSignal<DiffSettings>(loadSettings());

  const scrollToFile = (fileName: string) => {
    const elementId = getFileElementId(fileName);
    const element = document.getElementById(elementId);
    if (element) {
      element.scrollIntoView({ behavior: "instant", block: "start" });
    }
  };

  // Persist settings to localStorage when they change
  createEffect(() => {
    saveSettings(settings());
  });

  const loadPr = async (e: Event) => {
    e.preventDefault();
    if (!prUrl() || loading()) return;

    setLoading(true);
    setError(null);
    setDiff(null);
    setComments([]);

    try {
      // Load diff first
      const diffRes = await fetch(`/api/pr/diff?url=${encodeURIComponent(prUrl())}`);
      const diffData = await diffRes.json();

      if (diffData.error) {
        setError(diffData.error);
        return;
      }
      
      setDiff(diffData.diff);
      setLoading(false);

      // Then load comments
      setLoadingComments(true);
      const commentsRes = await fetch(`/api/pr/comments?url=${encodeURIComponent(prUrl())}`);
      const commentsData = await commentsRes.json();
      
      if (!commentsData.error) {
        setComments(commentsData.comments ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load PR");
    } finally {
      setLoading(false);
      setLoadingComments(false);
    }
  };

  const addComment = async (filePath: string, line: number, side: "LEFT" | "RIGHT", body: string) => {
    const res = await fetch("/api/pr/comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prUrl: prUrl(), filePath, line, side, body }),
    });
    const data = await res.json();
    if (data.comment) {
      setComments([...comments(), data.comment]);
    }
    return data;
  };

  const replyToComment = async (commentId: number, body: string) => {
    const res = await fetch("/api/pr/comment/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prUrl: prUrl(), commentId, body }),
    });
    const data = await res.json();
    if (data.comment) {
      setComments([...comments(), data.comment]);
    }
    return data;
  };

  return (
    <div class="h-screen bg-bg text-text flex flex-col">
      {/* Header Bar */}
      <header class="border-b border-border bg-bg-surface">
        {/* Main Header */}
        <div class="px-4 py-3">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <span class="text-accent text-xs">●</span>
              <h1 class="text-sm text-text">better-review</h1>
            </div>
            <SettingsPanel settings={settings()} onChange={setSettings} />
          </div>

          <form onSubmit={loadPr} class="flex gap-2">
            <div class="flex-1">
              <input
                type="text"
                value={prUrl()}
                onInput={(e) => setPrUrl(e.currentTarget.value)}
                placeholder="github.com/owner/repo/pull/123"
                class="w-full px-3 py-2 bg-bg border border-border text-text text-xs placeholder:text-text-faint hover:border-text-faint focus:border-accent"
              />
            </div>
            <button
              type="submit"
              disabled={loading() || !prUrl()}
              class="px-4 py-2 bg-accent text-black font-medium hover:bg-accent-bright active:bg-accent disabled:opacity-30 disabled:cursor-not-allowed text-xs"
            >
              {loading() ? "..." : "Load"}
            </button>
          </form>

          {error() && (
            <div class="mt-3 px-3 py-2 border border-error/50 bg-diff-remove-bg text-error text-xs">
              {error()}
            </div>
          )}
        </div>
      </header>

      {/* Main content */}
      <Show
        when={diff()}
        fallback={
          <Show when={!loading()}>
            <div class="flex-1 flex items-center justify-center">
              <div class="text-center">
                <div class="text-text-faint text-xs">
                  Enter a GitHub PR URL to start
                </div>
              </div>
            </div>
          </Show>
        }
      >
        <div class="flex-1 flex overflow-hidden">
          {/* File tree panel */}
          <FileTreePanel files={files()} onFileSelect={scrollToFile} />

          {/* Diff viewer */}
          <div class="flex-1 overflow-y-auto px-4 py-3">
            <DiffViewer
              rawDiff={diff()!}
              comments={comments()}
              loadingComments={loadingComments()}
              onAddComment={addComment}
              onReplyToComment={replyToComment}
              settings={settings()}
              onFilesLoaded={setFiles}
            />
          </div>
        </div>
      </Show>
    </div>
  );
};

export default App;
