import { type Component, createSignal, Show } from "solid-js";
import { DiffViewer } from "./DiffViewer";

const App: Component = () => {
  const [prUrl, setPrUrl] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [diff, setDiff] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const loadPr = async (e: Event) => {
    e.preventDefault();
    if (!prUrl() || loading()) return;

    setLoading(true);
    setError(null);
    setDiff(null);

    try {
      const res = await fetch(`/api/pr?url=${encodeURIComponent(prUrl())}`);
      const data = await res.json();

      if (data.error) {
        setError(data.error);
      } else {
        setDiff(data.diff);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load PR");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="min-h-screen bg-bg text-text p-6">
      <div class="max-w-7xl mx-auto">
        <h1 class="text-2xl font-semibold mb-6">Better Review</h1>

        <form onSubmit={loadPr} class="flex gap-3 mb-6">
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
          <div class="p-4 bg-diff-remove-bg border border-error/30 rounded-lg mb-6 text-error">
            {error()}
          </div>
        )}

        <Show when={diff()}>
          <DiffViewer rawDiff={diff()!} />
        </Show>

        {!diff() && !error() && !loading() && (
          <div class="text-center py-16 text-text-faint">
            Enter a PR URL to start reviewing
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
