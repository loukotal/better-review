import { A } from "@solidjs/router";
import { For, Show, createMemo, createSignal, type ParentProps, type Component } from "solid-js";

import { ThemeToggle } from "../components/ThemeToggle";

type CoverageStatus = "ready" | "partial" | "missing";

const CANONICAL_COMPONENTS = [
  "Accordion",
  "Alert",
  "Avatar",
  "Badge",
  "Breadcrumbs",
  "Button",
  "Button group",
  "Card",
  "Carousel",
  "Checkbox",
  "Color picker",
  "Combobox",
  "Date input",
  "Datepicker",
  "Drawer",
  "Dropdown menu",
  "Empty state",
  "Fieldset",
  "File",
  "File upload",
  "Footer",
  "Form",
  "Header",
  "Heading",
  "Hero",
  "Icon",
  "Image",
  "Label",
  "Link",
  "List",
  "Modal",
  "Navigation",
  "Pagination",
  "Popover",
  "Progress bar",
  "Progress indicator",
  "Quote",
  "Radio button",
  "Rating",
  "Rich text editor",
  "Search input",
  "Segmented control",
  "Select",
  "Separator",
  "Skeleton",
  "Skip link",
  "Slider",
  "Spinner",
  "Stack",
  "Stepper",
  "Table",
  "Tabs",
  "Text input",
  "Textarea",
  "Toast",
  "Toggle",
  "Tooltip",
  "Tree view",
  "Video",
  "Visually hidden",
] as const;

const COVERAGE: Record<string, { status: CoverageStatus; source?: string }> = {
  Alert: { status: "ready", source: "PrListPage, PrStatusBar" },
  Badge: { status: "ready", source: "PrListPage, PrStatusBar" },
  Button: { status: "ready", source: "Across app" },
  "Button group": { status: "ready", source: "ReviewModeToggle" },
  Checkbox: { status: "partial", source: "Filters (button-like)" },
  "Dropdown menu": { status: "ready", source: "SessionSelector, ModelSelector" },
  "Empty state": { status: "ready", source: "PrListPage" },
  Modal: { status: "partial", source: "Description / popover-like overlays" },
  Popover: { status: "ready", source: "SettingsPanel, ApproveButton" },
  "Radio button": { status: "partial", source: "ReviewModeToggle behavior" },
  "Search input": { status: "partial", source: "Model selector search" },
  "Segmented control": { status: "ready", source: "ReviewModeToggle" },
  Select: { status: "ready", source: "Repo filter, settings" },
  Spinner: { status: "ready", source: "Loading states" },
  Table: { status: "partial", source: "PR list semantics currently card-based" },
  Tabs: { status: "partial", source: "Can reuse segmented pattern" },
  "Text input": { status: "ready", source: "PR URL input" },
  Textarea: { status: "ready", source: "Comment flows" },
  Toggle: { status: "partial", source: "Panel/focus toggles" },
  Tooltip: { status: "partial", source: "Mostly native title tooltips" },
};

const statusMeta = {
  ready: { label: "Ready", classes: "text-success border-success/40 bg-success/10" },
  partial: { label: "Partial", classes: "text-warning border-warning/40 bg-warning/10" },
  missing: { label: "Missing", classes: "text-text-faint border-border bg-bg" },
} as const;

const PreviewCard: Component<ParentProps<{ title: string; note?: string }>> = (props) => {
  return (
    <article class="border border-border bg-bg-surface">
      <header class="px-3 py-2 border-b border-border flex items-center justify-between gap-3">
        <h3 class="text-sm text-text">{props.title}</h3>
        <Show when={props.note}>
          <span class="text-xs text-text-faint">{props.note}</span>
        </Show>
      </header>
      <div class="p-4">{props.children}</div>
    </article>
  );
};

const Section: Component<ParentProps<{ title: string; id: string; description?: string }>> = (
  props,
) => {
  return (
    <section id={props.id} class="space-y-3 scroll-mt-4">
      <div>
        <h2 class="text-base text-text">{props.title}</h2>
        <Show when={props.description}>
          <p class="text-sm text-text-faint mt-1">{props.description}</p>
        </Show>
      </div>
      {props.children}
    </section>
  );
};

const DesignSystemPage: Component = () => {
  const [search, setSearch] = createSignal("");
  const [toggleOn, setToggleOn] = createSignal(true);
  const [selectedTab, setSelectedTab] = createSignal<"Overview" | "Checks" | "Activity">(
    "Overview",
  );
  const [dropdownOpen, setDropdownOpen] = createSignal(false);
  const [popoverOpen, setPopoverOpen] = createSignal(false);
  const [modalOpen, setModalOpen] = createSignal(false);

  const filteredComponents = createMemo(() => {
    const q = search().trim().toLowerCase();
    if (!q) return CANONICAL_COMPONENTS;
    return CANONICAL_COMPONENTS.filter((name) => name.toLowerCase().includes(q));
  });

  const countByStatus = createMemo(() => {
    const counts: Record<CoverageStatus, number> = { ready: 0, partial: 0, missing: 0 };
    for (const name of CANONICAL_COMPONENTS) {
      const status = COVERAGE[name]?.status ?? "missing";
      counts[status] += 1;
    }
    return counts;
  });

  const statusBadge = (name: string) => {
    const status = COVERAGE[name]?.status ?? "missing";
    const meta = statusMeta[status];
    return <span class={`px-2 py-0.5 text-xs border ${meta.classes}`}>{meta.label}</span>;
  };

  return (
    <div class="min-h-screen bg-bg text-text">
      <header class="border-b border-border bg-bg-surface">
        <div class="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div>
            <A href="/" class="flex items-center gap-2 hover:opacity-80 transition-opacity">
              <span class="text-accent text-base">●</span>
              <h1 class="text-base text-text">better-review design system</h1>
            </A>
            <p class="text-sm text-text-faint mt-1">
              Naming aligned with{" "}
              <a
                class="text-accent hover:underline"
                href="https://component.gallery/components/"
                target="_blank"
                rel="noopener noreferrer"
              >
                component.gallery/components
              </a>
            </p>
            <p class="text-xs text-text-faint mt-1">Route: /design-system</p>
          </div>
          <div class="flex items-center gap-3 text-sm">
            <A href="/" class="text-text-faint hover:text-text transition-colors">
              PR list
            </A>
            <A href="/review" class="text-text-faint hover:text-text transition-colors">
              Review view
            </A>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main class="max-w-6xl mx-auto px-6 py-6 space-y-8">
        <Section
          id="inventory"
          title="Component inventory"
          description="Coverage of canonical component names. Ready = already represented in app UI."
        >
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="border border-border bg-bg-surface p-3">
              <div class="text-sm text-text-faint">Ready</div>
              <div class="text-xl text-success mt-1">{countByStatus().ready}</div>
            </div>
            <div class="border border-border bg-bg-surface p-3">
              <div class="text-sm text-text-faint">Partial</div>
              <div class="text-xl text-warning mt-1">{countByStatus().partial}</div>
            </div>
            <div class="border border-border bg-bg-surface p-3">
              <div class="text-sm text-text-faint">Missing</div>
              <div class="text-xl text-text-faint mt-1">{countByStatus().missing}</div>
            </div>
          </div>

          <div class="border border-border bg-bg-surface">
            <div class="p-3 border-b border-border">
              <input
                type="text"
                value={search()}
                onInput={(e) => setSearch(e.currentTarget.value)}
                placeholder="Search component name (e.g. Button, Modal, Tabs)"
                class="w-full px-3 py-2 bg-bg border border-border text-sm text-text placeholder:text-text-faint focus:border-accent"
              />
            </div>
            <div class="max-h-[360px] overflow-auto">
              <table class="w-full text-sm">
                <thead class="sticky top-0 bg-bg-surface border-b border-border">
                  <tr>
                    <th class="text-left font-medium text-text-faint px-3 py-2">Name</th>
                    <th class="text-left font-medium text-text-faint px-3 py-2">Status</th>
                    <th class="text-left font-medium text-text-faint px-3 py-2">Current source</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={filteredComponents()}>
                    {(name) => (
                      <tr class="border-b border-border/60 last:border-b-0">
                        <td class="px-3 py-2 text-text">{name}</td>
                        <td class="px-3 py-2">{statusBadge(name)}</td>
                        <td class="px-3 py-2 text-text-faint">{COVERAGE[name]?.source ?? "—"}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </div>
        </Section>

        <Section
          id="core-previews"
          title="Core component previews"
          description="Live states for current primitives we use in the app."
        >
          <div class="grid gap-4 lg:grid-cols-2">
            <PreviewCard title="Button" note="Default / secondary / destructive / disabled">
              <div class="flex flex-wrap gap-2">
                <button class="px-3 py-1.5 bg-accent text-accent-text hover:bg-accent-bright text-sm">
                  Primary
                </button>
                <button class="px-3 py-1.5 border border-border text-text-faint hover:text-text text-sm">
                  Secondary
                </button>
                <button class="px-3 py-1.5 border border-error/50 text-error text-sm">
                  Destructive
                </button>
                <button class="px-3 py-1.5 bg-accent text-accent-text text-sm opacity-40" disabled>
                  Disabled
                </button>
              </div>
            </PreviewCard>

            <PreviewCard title="Button group / Segmented control" note="Exclusive selection">
              <div class="inline-flex border border-border text-sm">
                <button
                  class="px-3 py-1.5 border-r border-border"
                  classList={{ "bg-accent text-accent-text": selectedTab() === "Overview" }}
                  onClick={() => setSelectedTab("Overview")}
                >
                  Overview
                </button>
                <button
                  class="px-3 py-1.5 border-r border-border"
                  classList={{ "bg-accent text-accent-text": selectedTab() === "Checks" }}
                  onClick={() => setSelectedTab("Checks")}
                >
                  Checks
                </button>
                <button
                  class="px-3 py-1.5"
                  classList={{ "bg-accent text-accent-text": selectedTab() === "Activity" }}
                  onClick={() => setSelectedTab("Activity")}
                >
                  Activity
                </button>
              </div>
            </PreviewCard>

            <PreviewCard title="Text input / Search input" note="Default / focused / disabled">
              <div class="space-y-2">
                <input
                  type="text"
                  placeholder="Default text input"
                  class="w-full px-3 py-2 bg-bg border border-border text-sm text-text placeholder:text-text-faint"
                />
                <div class="relative">
                  <span class="absolute left-2 top-2 text-text-faint text-sm">⌕</span>
                  <input
                    type="text"
                    placeholder="Focused search input"
                    class="w-full pl-7 pr-3 py-2 bg-bg border border-accent text-sm text-text placeholder:text-text-faint"
                  />
                </div>
                <input
                  type="text"
                  placeholder="Disabled"
                  disabled
                  class="w-full px-3 py-2 bg-bg border border-border text-sm text-text-faint opacity-50"
                />
              </div>
            </PreviewCard>

            <PreviewCard title="Select" note="Default and disabled">
              <div class="space-y-2">
                <select class="w-full px-3 py-2 bg-bg border border-border text-sm text-text focus:border-accent cursor-pointer">
                  <option>All repos</option>
                  <option>better-review/web</option>
                  <option>better-review/shared</option>
                </select>
                <select
                  disabled
                  class="w-full px-3 py-2 bg-bg border border-border text-sm text-text-faint opacity-50"
                >
                  <option>Disabled select</option>
                </select>
              </div>
            </PreviewCard>

            <PreviewCard title="Textarea" note="Default / error">
              <div class="space-y-2">
                <textarea
                  rows={3}
                  placeholder="Leave a comment…"
                  class="w-full px-3 py-2 bg-bg border border-border text-sm text-text placeholder:text-text-faint"
                />
                <textarea
                  rows={2}
                  value="Validation message example"
                  class="w-full px-3 py-2 bg-bg border border-error/60 text-sm text-text"
                />
              </div>
            </PreviewCard>

            <PreviewCard title="Checkbox / Radio button / Toggle" note="Selection controls">
              <div class="space-y-3 text-sm">
                <label class="flex items-center gap-2 text-text-faint">
                  <input type="checkbox" class="accent-[var(--color-accent)]" checked />
                  Reviewed file
                </label>
                <label class="flex items-center gap-2 text-text-faint">
                  <input type="radio" name="mode" class="accent-[var(--color-accent)]" checked />
                  Full PR mode
                </label>
                <button
                  type="button"
                  onClick={() => setToggleOn(!toggleOn())}
                  class="inline-flex items-center gap-2"
                >
                  <span
                    class={`w-9 h-5 border border-border flex items-center px-0.5 transition-colors ${toggleOn() ? "bg-accent/20" : "bg-bg"}`}
                  >
                    <span
                      class={`w-3.5 h-3.5 bg-accent transition-transform ${toggleOn() ? "translate-x-3.5" : "translate-x-0"}`}
                    />
                  </span>
                  <span class="text-text-faint">{toggleOn() ? "On" : "Off"}</span>
                </button>
              </div>
            </PreviewCard>

            <PreviewCard title="Badge / Alert / Spinner" note="Status and feedback">
              <div class="space-y-3 text-sm">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="px-2 py-0.5 border border-accent/50 text-accent">Approved</span>
                  <span class="px-2 py-0.5 border border-error/50 text-error">Failed</span>
                  <span class="px-2 py-0.5 border border-border text-text-faint">Draft</span>
                </div>
                <div class="px-3 py-2 border border-warning/40 bg-warning/10 text-warning">
                  Alert: waiting for CI checks.
                </div>
                <div class="flex items-center gap-2 text-text-faint">
                  <span class="animate-spin">◷</span>
                  <span>Loading…</span>
                </div>
              </div>
            </PreviewCard>

            <PreviewCard title="Tabs / Table / Empty state" note="Structure components">
              <div class="space-y-3">
                <div class="flex border-b border-border text-sm">
                  <button class="px-3 py-1.5 border-b border-accent text-accent">Files</button>
                  <button class="px-3 py-1.5 text-text-faint">Comments</button>
                </div>
                <table class="w-full text-sm border border-border">
                  <thead class="bg-bg">
                    <tr>
                      <th class="text-left font-medium px-2 py-1.5 border-b border-border">File</th>
                      <th class="text-left font-medium px-2 py-1.5 border-b border-border">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td class="px-2 py-1.5 border-b border-border/60">src/App.tsx</td>
                      <td class="px-2 py-1.5 border-b border-border/60 text-success">Reviewed</td>
                    </tr>
                    <tr>
                      <td class="px-2 py-1.5">src/components/Button.tsx</td>
                      <td class="px-2 py-1.5 text-text-faint">Pending</td>
                    </tr>
                  </tbody>
                </table>
                <div class="border border-border px-3 py-5 text-center text-text-faint text-sm">
                  Empty state: no comments yet.
                </div>
              </div>
            </PreviewCard>

            <PreviewCard title="Dropdown menu / Popover / Modal / Tooltip" note="Overlay patterns">
              <div class="flex flex-wrap items-center gap-2 text-sm">
                <div class="relative">
                  <button
                    type="button"
                    onClick={() => setDropdownOpen(!dropdownOpen())}
                    class="px-3 py-1.5 border border-border text-text-faint hover:text-text"
                  >
                    Dropdown menu
                  </button>
                  <Show when={dropdownOpen()}>
                    <div class="absolute top-full left-0 mt-1 w-44 border border-border bg-bg-surface z-10">
                      <button class="w-full text-left px-3 py-2 hover:bg-bg-elevated">
                        Rename
                      </button>
                      <button class="w-full text-left px-3 py-2 hover:bg-bg-elevated">
                        Duplicate
                      </button>
                      <button class="w-full text-left px-3 py-2 hover:bg-bg-elevated text-error">
                        Delete
                      </button>
                    </div>
                  </Show>
                </div>

                <div class="relative">
                  <button
                    type="button"
                    onClick={() => setPopoverOpen(!popoverOpen())}
                    class="px-3 py-1.5 border border-border text-text-faint hover:text-text"
                  >
                    Popover
                  </button>
                  <Show when={popoverOpen()}>
                    <div class="absolute top-full left-0 mt-1 w-52 border border-border bg-bg-surface p-3 z-10 text-text-faint">
                      Inline details, quick settings, or actions.
                    </div>
                  </Show>
                </div>

                <button
                  type="button"
                  onClick={() => setModalOpen(true)}
                  class="px-3 py-1.5 border border-border text-text-faint hover:text-text"
                >
                  Open modal
                </button>

                <button
                  title="Tooltip example"
                  class="px-3 py-1.5 border border-border text-text-faint"
                >
                  Tooltip
                </button>
              </div>
            </PreviewCard>
          </div>
        </Section>
      </main>

      <Show when={modalOpen()}>
        <div class="fixed inset-0 bg-black/60 z-40" onClick={() => setModalOpen(false)} />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div class="w-full max-w-md border border-border bg-bg-surface">
            <div class="px-4 py-3 border-b border-border flex items-center justify-between">
              <h3 class="text-sm text-text">Modal</h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                class="text-text-faint hover:text-text"
              >
                ×
              </button>
            </div>
            <div class="p-4 text-sm text-text-faint">
              Use for blocking confirmations and multi-step actions.
            </div>
            <div class="px-4 py-3 border-t border-border flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                class="px-3 py-1.5 border border-border text-text-faint"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                class="px-3 py-1.5 bg-accent text-accent-text"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default DesignSystemPage;
