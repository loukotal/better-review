import type { FileDiffMetadata } from "@pierre/diffs";
import { createSignal, createMemo, For, Show } from "solid-js";

interface FileTreePanelProps {
  files: FileDiffMetadata[];
  onFileSelect: (fileName: string) => void;
  reviewOrder?: string[] | null;
  readFiles?: Set<string>;
  onToggleRead?: (fileName: string) => void;
}

interface TreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  children: TreeNode[];
  file?: FileDiffMetadata;
}

function buildTree(files: FileDiffMetadata[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const file of files) {
    const parts = file.name.split("/");
    let currentLevel = root;
    let currentPath = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let existing = currentLevel.find((n) => n.name === part);

      if (!existing) {
        existing = {
          name: part,
          path: currentPath,
          isFolder: !isLast,
          children: [],
          file: isLast ? file : undefined,
        };
        currentLevel.push(existing);
      }

      if (!isLast) {
        currentLevel = existing.children;
      }
    }
  }

  // Sort: folders first, then alphabetically
  const sortNodes = (nodes: TreeNode[]): TreeNode[] => {
    return nodes
      .map((n) => ({ ...n, children: sortNodes(n.children) }))
      .sort((a, b) => {
        if (a.isFolder && !b.isFolder) return -1;
        if (!a.isFolder && b.isFolder) return 1;
        return a.name.localeCompare(b.name);
      });
  };

  return sortNodes(root);
}

function getMatchingPaths(files: FileDiffMetadata[], query: string): Set<string> {
  const matches = new Set<string>();
  const lowerQuery = query.toLowerCase();

  for (const file of files) {
    if (file.name.toLowerCase().includes(lowerQuery)) {
      // Add the file path and all its ancestor paths
      const parts = file.name.split("/");
      let path = "";
      for (const part of parts) {
        path = path ? `${path}/${part}` : part;
        matches.add(path);
      }
    }
  }

  return matches;
}

function FileStatusIndicator(props: { type: FileDiffMetadata["type"] }) {
  const indicator = () => {
    switch (props.type) {
      case "new":
        return { char: "+", class: "text-success" };
      case "deleted":
        return { char: "−", class: "text-error" };
      default:
        return { char: "~", class: "text-accent" };
    }
  };

  return <span class={`text-base w-3 text-center ${indicator().class}`}>{indicator().char}</span>;
}

function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" class="text-success">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z" />
    </svg>
  );
}

function CircleIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
    >
      <circle cx="8" cy="8" r="5" />
    </svg>
  );
}

function TreeNodeView(props: {
  node: TreeNode;
  depth: number;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onFileSelect: (fileName: string) => void;
  matchingPaths: Set<string> | null;
  readFiles?: Set<string>;
  onToggleRead?: (fileName: string) => void;
}) {
  const isExpanded = () => props.expandedFolders.has(props.node.path);
  const isVisible = () => !props.matchingPaths || props.matchingPaths.has(props.node.path);
  const isRead = () => props.readFiles?.has(props.node.file?.name ?? "") ?? false;

  const handleToggleRead = (e: MouseEvent) => {
    e.stopPropagation();
    if (props.node.file && props.onToggleRead) {
      props.onToggleRead(props.node.file.name);
    }
  };

  return (
    <Show when={isVisible()}>
      <div>
        {props.node.isFolder ? (
          <>
            <button
              type="button"
              onClick={() => props.onToggleFolder(props.node.path)}
              class="w-full flex items-center gap-1 px-2 py-0.5 hover:bg-bg-elevated text-left text-xs group transition-colors"
              style={{ "padding-left": `${props.depth * 10 + 8}px` }}
            >
              <span
                class="text-text-faint text-[9px] transition-transform w-3 text-center"
                classList={{ "rotate-90": isExpanded() }}
              >
                ▶
              </span>
              <span class="text-text-faint group-hover:text-text-muted truncate">
                {props.node.name}
              </span>
            </button>
            <Show when={isExpanded()}>
              <For each={props.node.children}>
                {(child) => (
                  <TreeNodeView
                    node={child}
                    depth={props.depth + 1}
                    expandedFolders={props.expandedFolders}
                    onToggleFolder={props.onToggleFolder}
                    onFileSelect={props.onFileSelect}
                    matchingPaths={props.matchingPaths}
                    readFiles={props.readFiles}
                    onToggleRead={props.onToggleRead}
                  />
                )}
              </For>
            </Show>
          </>
        ) : (
          <button
            type="button"
            onClick={() => props.onFileSelect(props.node.file!.name)}
            class="w-full flex items-center gap-1.5 px-2 py-0.5 hover:bg-bg-elevated text-left text-xs group transition-colors"
            style={{ "padding-left": `${props.depth * 10 + 8}px` }}
            classList={{ "opacity-60": isRead() }}
          >
            <FileStatusIndicator type={props.node.file!.type} />
            <span
              class="flex-1 truncate"
              classList={{
                "text-text-muted group-hover:text-text": !isRead(),
                "text-text-faint": isRead(),
              }}
            >
              {props.node.name}
            </span>
            <Show when={props.onToggleRead}>
              <span
                onClick={handleToggleRead}
                class="w-4 h-4 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                classList={{ "!opacity-100": isRead() }}
                title={isRead() ? "Mark as unread" : "Mark as read"}
              >
                <Show when={isRead()} fallback={<CircleIcon />}>
                  <CheckIcon />
                </Show>
              </span>
            </Show>
          </button>
        )}
      </div>
    </Show>
  );
}

// Collect all folder paths from the tree
function getAllFolderPaths(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.isFolder) {
      paths.push(node.path);
      paths.push(...getAllFolderPaths(node.children));
    }
  }
  return paths;
}

export function FileTreePanel(props: FileTreePanelProps) {
  const [searchQuery, setSearchQuery] = createSignal("");
  const [manuallyCollapsed, setManuallyCollapsed] = createSignal<Set<string>>(new Set());

  const tree = createMemo(() => buildTree(props.files));

  const matchingPaths = createMemo(() => {
    const query = searchQuery().trim();
    if (!query) return null;
    return getMatchingPaths(props.files, query);
  });

  // All folders expanded by default, minus manually collapsed ones
  // When searching, force expand all matching folders
  const effectiveExpandedFolders = createMemo(() => {
    const allFolders = new Set(getAllFolderPaths(tree()));
    const matching = matchingPaths();

    if (matching) {
      // When searching, expand all folders that are in the matching paths
      const expanded = new Set<string>();
      for (const path of matching) {
        const parts = path.split("/");
        let parentPath = "";
        for (let i = 0; i < parts.length - 1; i++) {
          parentPath = parentPath ? `${parentPath}/${parts[i]}` : parts[i];
          expanded.add(parentPath);
        }
      }
      return expanded;
    }

    // Default: all folders expanded, minus manually collapsed
    const collapsed = manuallyCollapsed();
    const expanded = new Set<string>();
    for (const folder of allFolders) {
      if (!collapsed.has(folder)) {
        expanded.add(folder);
      }
    }
    return expanded;
  });

  const toggleFolder = (path: string) => {
    // Only allow manual toggle when not searching
    if (matchingPaths()) return;

    setManuallyCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <div class="w-[220px] border-l border-border flex flex-col bg-bg-surface">
      {/* Panel Header */}
      <div class="px-2 py-2 border-b border-border">
        <input
          type="text"
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
          placeholder="Filter..."
          class="w-full px-2 py-1 bg-bg border border-border text-xs text-text placeholder:text-text-faint hover:border-text-faint focus:border-accent"
        />
      </div>

      {/* AI Order indicator */}
      <Show when={props.reviewOrder && props.reviewOrder.length > 0}>
        <div class="px-2 py-1.5 border-b border-accent/30 bg-accent/5">
          <div class="flex items-center gap-1.5 text-base text-accent">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <path d="M7 5.75A.75.75 0 0 1 7.75 5h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 7 5.75zm0 4A.75.75 0 0 1 7.75 9h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 7 9.75zM3.5 6a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zM4.25 10a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0z" />
            </svg>
            <span>AI review order applied</span>
          </div>
        </div>
      </Show>

      {/* File Tree */}
      <div class="flex-1 overflow-y-auto py-1">
        <For each={tree()}>
          {(node) => (
            <TreeNodeView
              node={node}
              depth={0}
              expandedFolders={effectiveExpandedFolders()}
              onToggleFolder={toggleFolder}
              onFileSelect={props.onFileSelect}
              matchingPaths={matchingPaths()}
              readFiles={props.readFiles}
              onToggleRead={props.onToggleRead}
            />
          )}
        </For>
      </div>

      {/* Footer Stats */}
      <div class="px-3 py-1.5 border-t border-border text-xs text-text-faint flex items-center justify-between">
        <span>
          {props.files.length} file{props.files.length !== 1 ? "s" : ""}
        </span>
        <Show when={props.readFiles && props.readFiles.size > 0}>
          <span class="text-success">
            {props.readFiles!.size}/{props.files.length} read
          </span>
        </Show>
      </div>
    </div>
  );
}
