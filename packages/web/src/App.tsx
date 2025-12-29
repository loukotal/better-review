import { type Component, createSignal, createEffect, Show } from "solid-js";
import type { FileDiffMetadata } from "@pierre/diffs";
import { DiffViewer, getFileElementId, type PRComment, type DiffSettings, DEFAULT_DIFF_SETTINGS } from "./DiffViewer";
import { FileTreePanel } from "./FileTreePanel";
import { SettingsPanel } from "./diff/SettingsPanel";

const SETTINGS_STORAGE_KEY = "diff-settings";

function loadSettings(): DiffSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_DIFF_SETTINGS, ...JSON.parse(stored) };
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

  return (
    <div class="h-screen bg-bg text-text flex flex-col">
      {/* Header */}
      <div class="p-4 border-b border-border">
        <div class="flex items-center justify-between mb-4">
          <h1 class="text-xl font-semibold">Better Review</h1>
          <SettingsPanel settings={settings()} onChange={setSettings} />
        </div>

        <form onSubmit={loadPr} class="flex gap-3">
          <input
            type="text"
            value={prUrl()}
            onInput={(e) => setPrUrl(e.currentTarget.value)}
            placeholder="GitHub PR URL (e.g. https://github.com/owner/repo/pull/123)"
            class="flex-1 px-4 py-2 bg-bg-surface border border-border rounded-lg text-text placeholder:text-text-faint focus:outline-none focus:border-border-focus transition-colors"
          />
          <button
            type="submit"
            disabled={loading() || !prUrl()}
            class="px-5 py-2 bg-primary text-bg font-medium rounded-lg hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading() ? "Loading..." : "Load PR"}
          </button>
        </form>

        {error() && (
          <div class="p-4 mt-4 bg-diff-remove-bg border border-error/30 rounded-lg text-error">
            {error()}
          </div>
        )}
      </div>

      {/* Main content */}
      <Show
        when={diff()}
        fallback={
          <Show when={!loading()}>
            <div class="flex-1 flex items-center justify-center text-text-faint">
              Enter a PR URL to start reviewing
            </div>
          </Show>
        }
      >
        <div class="flex-1 flex overflow-hidden">
          {/* File tree panel */}
          <FileTreePanel files={files()} onFileSelect={scrollToFile} />

          {/* Diff viewer */}
          <div class="flex-1 overflow-y-auto p-6">
            <DiffViewer
              rawDiff={diff()!}
              comments={comments()}
              loadingComments={loadingComments()}
              onAddComment={addComment}
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
