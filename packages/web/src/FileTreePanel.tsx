import { createSignal, createMemo, For, Show } from "solid-js";
import type { FileDiffMetadata } from "@pierre/diffs";

interface FileTreePanelProps {
  files: FileDiffMetadata[];
  onFileSelect: (fileName: string) => void;
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
        return { char: "+", class: "text-diff-add-text" };
      case "deleted":
        return { char: "-", class: "text-diff-remove-text" };
      default:
        return { char: "•", class: "text-primary" };
    }
  };

  return (
    <span class={`font-bold ${indicator().class}`}>{indicator().char}</span>
  );
}

function TreeNodeView(props: {
  node: TreeNode;
  depth: number;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onFileSelect: (fileName: string) => void;
  matchingPaths: Set<string> | null;
}) {
  const isExpanded = () => props.expandedFolders.has(props.node.path);
  const isVisible = () => !props.matchingPaths || props.matchingPaths.has(props.node.path);

  return (
    <Show when={isVisible()}>
      <div>
        {props.node.isFolder ? (
          <>
            <button
              type="button"
              onClick={() => props.onToggleFolder(props.node.path)}
              class="w-full flex items-center gap-1.5 px-2 py-1 hover:bg-bg-elevated rounded text-left text-sm"
              style={{ "padding-left": `${props.depth * 12 + 8}px` }}
            >
              <span
                class="text-text-muted text-xs transition-transform"
                classList={{ "rotate-90": isExpanded() }}
              >
                ▶
              </span>
              <span class="text-text-muted truncate">{props.node.name}</span>
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
                  />
                )}
              </For>
            </Show>
          </>
        ) : (
          <button
            type="button"
            onClick={() => props.onFileSelect(props.node.file!.name)}
            class="w-full flex items-center gap-2 px-2 py-1 hover:bg-bg-elevated rounded text-left text-sm"
            style={{ "padding-left": `${props.depth * 12 + 8}px` }}
          >
            <FileStatusIndicator type={props.node.file!.type} />
            <span class="text-text truncate">{props.node.name}</span>
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
    <div class="w-[280px] border-r border-border flex flex-col bg-bg-surface">
      <div class="p-3 border-b border-border">
        <input
          type="text"
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
          placeholder="Search files..."
          class="w-full px-3 py-1.5 bg-bg border border-border rounded text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-border-focus transition-colors"
        />
      </div>
      <div class="flex-1 overflow-y-auto py-2">
        <For each={tree()}>
          {(node) => (
            <TreeNodeView
              node={node}
              depth={0}
              expandedFolders={effectiveExpandedFolders()}
              onToggleFolder={toggleFolder}
              onFileSelect={props.onFileSelect}
              matchingPaths={matchingPaths()}
            />
          )}
        </For>
      </div>
      <div class="px-3 py-2 border-t border-border text-xs text-text-faint">
        {props.files.length} file{props.files.length !== 1 ? "s" : ""} changed
      </div>
    </div>
  );
}
