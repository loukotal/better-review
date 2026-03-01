import { A, useSearchParams } from "@solidjs/router";
import { useQuery } from "@tanstack/solid-query";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";

import type { ProjectBoard, ProjectBoardItem } from "@better-review/shared";

import { Badge, Button, Card, Select, TextInput } from "../design-system";
import { CheckIcon } from "../icons/check-icon";
import { CircleIcon } from "../icons/circle-icon";
import { ExternalLinkIcon } from "../icons/external-link-icon";
import { SpinnerIcon } from "../icons/spinner-icon";
import { parseMarkdown } from "../lib/markdown";
import { api, queryClient, queryKeys } from "../lib/query";

type KanbanCardStyle = "readable" | "compact" | "split";

interface QueuedMove {
  owner: string;
  number: number;
  itemId: string;
  statusOptionId: string | null;
  projectId?: string;
  statusFieldId?: string;
}

const getTypeBadgeVariant = (type: string | null | undefined): "accent" | "warning" | "neutral" => {
  const normalized = (type ?? "").toLowerCase();
  if (normalized.includes("pullrequest")) return "accent";
  if (normalized.includes("draft")) return "warning";
  return "neutral";
};

const isDoneStatus = (status: string | null): boolean => {
  const normalized = (status ?? "").toLowerCase();
  return ["done", "closed", "complete", "completed", "merged", "shipped"].some((keyword) =>
    normalized.includes(keyword),
  );
};

const statusIconClass = (status: string | null): string => {
  const normalized = (status ?? "").toLowerCase();
  if (isDoneStatus(status)) return "text-success";
  if (["blocked", "stuck"].some((keyword) => normalized.includes(keyword))) return "text-warning";
  if (["progress", "review", "qa"].some((keyword) => normalized.includes(keyword))) {
    return "text-accent";
  }
  return "text-text-faint";
};

const getStatusBadgeVariant = (
  status: string | null,
): "neutral" | "success" | "warning" | "accent" => {
  const normalized = (status ?? "").toLowerCase();
  if (isDoneStatus(status)) return "success";
  if (["blocked", "stuck"].some((keyword) => normalized.includes(keyword))) return "warning";
  if (["progress", "review", "qa"].some((keyword) => normalized.includes(keyword))) return "accent";
  return "neutral";
};

const parseRepositoryContext = (
  repository: string | null | undefined,
): { owner: string; repo: string } | null => {
  if (!repository) return null;
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) return null;
  return { owner, repo };
};

const isRateLimitError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /rate limit/i.test(message) || /API rate limit already exceeded/i.test(message);
};

const formatResetAt = (resetAt: string | null | undefined): string | null => {
  if (!resetAt) return null;
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const formatTargetWeekBadgeText = (targetWeek: string): string => {
  const trimmed = targetWeek.trim();
  const withoutPrefix = trimmed.replace(/^target\s*week\s*:?\s*/i, "").trim();
  if (withoutPrefix.length > 0 && withoutPrefix.length < trimmed.length) {
    return `TW ${withoutPrefix}`;
  }
  return `TW ${trimmed}`;
};

const KanbanPage: Component = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const ownerFromUrl = () => {
    const raw = searchParams.owner;
    if (typeof raw === "string" && raw.trim().length > 0) {
      return raw.trim();
    }
    return "@me";
  };

  const [ownerInput, setOwnerInput] = createSignal(ownerFromUrl());
  const [owner, setOwner] = createSignal(ownerFromUrl());
  const [selectedProjectNumber, setSelectedProjectNumber] = createSignal<number | null>(null);
  const [movingItemId, setMovingItemId] = createSignal<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = createSignal<string | null>(null);
  const [selectedRepo, setSelectedRepo] = createSignal("");
  const [selectedAssignee, setSelectedAssignee] = createSignal("");
  const [targetWeekFilter, setTargetWeekFilter] = createSignal<"all" | "lte-next">("all");
  const [cardStyle, setCardStyle] = createSignal<KanbanCardStyle>("readable");
  const [selectedItemId, setSelectedItemId] = createSignal<string | null>(null);
  const [pendingMoves, setPendingMoves] = createSignal<QueuedMove[]>([]);
  const [isFlushingQueue, setIsFlushingQueue] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    const nextOwner = ownerFromUrl();
    if (nextOwner === owner()) return;

    setOwner(nextOwner);
    setOwnerInput(nextOwner);
    setSelectedProjectNumber(null);
    setSelectedRepo("");
    setSelectedAssignee("");
    setSelectedItemId(null);
    setPendingMoves([]);
    setError(null);
  });

  const projectsQuery = useQuery(() => ({
    queryKey: queryKeys.projects.list(owner()),
    queryFn: ({ signal }) => api.fetchProjects(owner(), signal),
  }));

  const quotaQuery = useQuery(() => ({
    queryKey: queryKeys.projects.rateLimit,
    queryFn: ({ signal }) => api.fetchProjectsGraphqlRateLimit(signal),
    refetchInterval: pendingMoves().length > 0 ? 5000 : 15000,
  }));

  createEffect(() => {
    const projects = projectsQuery.data ?? [];
    if (projects.length === 0) {
      setSelectedProjectNumber(null);
      return;
    }

    const current = selectedProjectNumber();
    if (current !== null && projects.some((project) => project.number === current)) {
      return;
    }

    const firstOpen = projects.find((project) => !project.closed);
    setSelectedProjectNumber(firstOpen?.number ?? projects[0].number);
  });

  const selectedProject = createMemo(() => {
    const number = selectedProjectNumber();
    return (projectsQuery.data ?? []).find((project) => project.number === number) ?? null;
  });

  const boardItemQuery = createMemo(() =>
    targetWeekFilter() === "lte-next" ? "target-week:<=@next" : undefined,
  );

  const boardQuery = useQuery(() => ({
    enabled: selectedProjectNumber() !== null,
    queryKey: queryKeys.projects.board(owner(), selectedProjectNumber() ?? -1, boardItemQuery()),
    queryFn: ({ signal }) =>
      api.fetchProjectBoard(owner(), selectedProjectNumber()!, signal, boardItemQuery()),
  }));

  const repoOptions = createMemo(() => {
    const board = boardQuery.data;
    if (!board) return [] as string[];

    const repos = new Set<string>();
    for (const column of board.columns) {
      for (const item of column.items) {
        if (item.content?.repository) {
          repos.add(item.content.repository);
        }
      }
    }

    return [...repos].sort();
  });

  const assigneeOptions = createMemo(() => {
    const board = boardQuery.data;
    if (!board) return [] as string[];

    const assignees = new Set<string>();
    for (const column of board.columns) {
      for (const item of column.items) {
        for (const assignee of item.assignees ?? []) {
          assignees.add(assignee);
        }
      }
    }

    return [...assignees].sort((a, b) => a.localeCompare(b));
  });

  createEffect(() => {
    const current = selectedRepo();
    if (!current) return;
    const repos = repoOptions();
    if (!repos.includes(current)) {
      setSelectedRepo("");
    }
  });

  createEffect(() => {
    const current = selectedAssignee();
    if (!current) return;
    const assignees = assigneeOptions();
    if (!assignees.includes(current)) {
      setSelectedAssignee("");
    }
  });

  const visibleColumns = createMemo(() => {
    const board = boardQuery.data;
    if (!board) return [];

    const repo = selectedRepo();
    const assignee = selectedAssignee();

    return board.columns.map((column) => ({
      ...column,
      items: column.items.filter((item) => {
        if (repo && item.content?.repository !== repo) return false;
        if (assignee && !(item.assignees ?? []).includes(assignee)) return false;
        return true;
      }),
    }));
  });

  const allBoardItems = createMemo(
    () => boardQuery.data?.columns.flatMap((column) => column.items) ?? [],
  );

  const selectedItem = createMemo(() => {
    const itemId = selectedItemId();
    if (!itemId) return null;
    return allBoardItems().find((item) => item.id === itemId) ?? null;
  });

  const selectedItemBodyHtml = createMemo(() => {
    const item = selectedItem();
    const body = item?.content?.body?.trim();
    if (!body) return "";

    const context = parseRepositoryContext(item?.content?.repository);
    return parseMarkdown(body, context);
  });

  createEffect(() => {
    const itemId = selectedItemId();
    if (!itemId) return;
    if (!selectedItem()) {
      setSelectedItemId(null);
    }
  });

  const cardStyleConfig = createMemo(() => {
    const style = cardStyle();
    if (style === "compact") {
      return {
        cardVariant: "subtle" as const,
        padding: "sm" as const,
        rootClass: "space-y-1.5",
        headerClass: "",
        titleClass: "text-[13px] leading-snug",
        metaClass: "text-[11px] text-text-faint flex items-center gap-1.5 flex-wrap",
        footerClass: "",
      };
    }

    if (style === "split") {
      return {
        cardVariant: "outline" as const,
        padding: "md" as const,
        rootClass: "space-y-2",
        headerClass: "pb-2 border-b border-border/70",
        titleClass: "text-sm leading-snug",
        metaClass: "text-xs text-text-faint flex items-center gap-2 flex-wrap",
        footerClass: "pt-2 border-t border-border/70",
      };
    }

    return {
      cardVariant: "raised" as const,
      padding: "md" as const,
      rootClass: "space-y-2.5",
      headerClass: "",
      titleClass: "text-sm font-medium leading-snug",
      metaClass: "text-xs text-text-faint flex items-center gap-2 flex-wrap",
      footerClass: "",
    };
  });

  const refreshBoard = async () => {
    const number = selectedProjectNumber();
    if (number === null) return;
    await queryClient.invalidateQueries({
      queryKey: queryKeys.projects.board(owner(), number, boardItemQuery()),
    });
  };

  const graphqlRemaining = createMemo(() => quotaQuery.data?.remaining ?? null);
  const graphqlResetLabel = createMemo(() => formatResetAt(quotaQuery.data?.resetAt));
  const hasGraphqlQuota = createMemo(() => {
    const remaining = graphqlRemaining();
    return remaining === null ? true : remaining > 0;
  });

  const enqueueMove = (move: QueuedMove) => {
    setPendingMoves((current) => {
      const withoutSameItem = current.filter((queued) => queued.itemId !== move.itemId);
      return [...withoutSameItem, move];
    });
  };

  const flushOneQueuedMove = async () => {
    if (isFlushingQueue()) return;
    if (!hasGraphqlQuota()) return;

    const next = pendingMoves()[0];
    if (!next) return;

    setIsFlushingQueue(true);
    setMovingItemId(next.itemId);

    try {
      await api.moveProjectItem(
        next.owner,
        next.number,
        next.itemId,
        next.statusOptionId,
        next.projectId,
        next.statusFieldId,
      );
      setPendingMoves((current) => current.slice(1));
      setError(null);
    } catch (err) {
      if (isRateLimitError(err)) {
        setError("GraphQL quota exhausted. Pending moves will auto-apply after reset.");
      } else {
        setPendingMoves((current) => current.slice(1));
        setError(err instanceof Error ? err.message : "Failed to apply queued move");
      }
    } finally {
      setMovingItemId(null);
      setIsFlushingQueue(false);
      void quotaQuery.refetch();
    }
  };

  createEffect(() => {
    if (pendingMoves().length === 0) return;
    if (!hasGraphqlQuota()) return;
    if (isFlushingQueue()) return;
    void flushOneQueuedMove();
  });

  const moveItem = async (item: ProjectBoardItem, targetStatusOptionId: string | null) => {
    const number = selectedProjectNumber();
    if (!number) return;

    const boardKey = queryKeys.projects.board(owner(), number, boardItemQuery());
    const currentBoard = queryClient.getQueryData<ProjectBoard>(boardKey);

    if (currentBoard) {
      const sourceColumn = currentBoard.columns.find((column) =>
        column.items.some((candidate) => candidate.id === item.id),
      );
      if (sourceColumn?.id === targetStatusOptionId) {
        setDragOverColumn(null);
        return;
      }
    }

    setError(null);
    setMovingItemId(item.id);

    const previousBoard = queryClient.getQueryData<ProjectBoard>(boardKey) ?? null;

    if (previousBoard) {
      const targetColumn =
        previousBoard.columns.find((column) => column.id === targetStatusOptionId) ?? null;

      queryClient.setQueryData<ProjectBoard>(boardKey, (board) => {
        if (!board) return board;

        const optimisticItem: ProjectBoardItem = {
          ...item,
          status: targetStatusOptionId === null ? null : (targetColumn?.name ?? item.status),
        };

        const nextColumns = board.columns.map((column) => ({
          ...column,
          items: column.items.filter((candidate) => candidate.id !== item.id),
        }));

        const targetIndex = nextColumns.findIndex((column) => column.id === targetStatusOptionId);
        if (targetIndex >= 0) {
          const target = nextColumns[targetIndex];
          nextColumns[targetIndex] = {
            ...target,
            items: [optimisticItem, ...target.items],
          };
        }

        return {
          ...board,
          columns: nextColumns,
        };
      });
    }

    const movePayload: QueuedMove = {
      owner: owner(),
      number,
      itemId: item.id,
      statusOptionId: targetStatusOptionId,
      projectId: currentBoard?.project.id,
      statusFieldId: currentBoard?.statusField?.id,
    };

    if (!hasGraphqlQuota()) {
      enqueueMove(movePayload);
      setError("GraphQL quota exhausted. Move queued and will auto-apply after reset.");
      setMovingItemId(null);
      setDragOverColumn(null);
      return;
    }

    try {
      await api.moveProjectItem(
        movePayload.owner,
        movePayload.number,
        movePayload.itemId,
        movePayload.statusOptionId,
        movePayload.projectId,
        movePayload.statusFieldId,
      );

      setError(null);
      setMovingItemId(null);
      setDragOverColumn(null);
      void quotaQuery.refetch();
    } catch (err) {
      if (isRateLimitError(err)) {
        enqueueMove(movePayload);
        setError("GraphQL quota exhausted. Move queued and will auto-apply after reset.");
      } else {
        if (previousBoard) {
          queryClient.setQueryData(boardKey, previousBoard);
        }
        setError(err instanceof Error ? err.message : "Failed to move item");
      }
      setMovingItemId(null);
      setDragOverColumn(null);
    }
  };

  const handleDrop = async (columnId: string | null, event: DragEvent) => {
    event.preventDefault();
    const raw = event.dataTransfer?.getData("application/x-better-review-project-item");
    if (!raw) return;

    let payload: { itemId: string } | null = null;
    try {
      payload = JSON.parse(raw) as { itemId: string };
    } catch {
      payload = null;
    }
    if (!payload) return;

    const board = boardQuery.data;
    if (!board) return;

    const allItems = board.columns.flatMap((column) => column.items);
    const item = allItems.find((candidate) => candidate.id === payload.itemId);
    if (!item) return;

    await moveItem(item, columnId);
  };

  const handleOwnerSubmit = async () => {
    const nextOwner = ownerInput().trim() || "@me";
    setOwner(nextOwner);
    setSearchParams({ owner: nextOwner });
    setSelectedProjectNumber(null);
    setSelectedRepo("");
    setSelectedAssignee("");
    setSelectedItemId(null);
    setPendingMoves([]);
    setError(null);
  };

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!selectedItemId()) return;
      setSelectedItemId(null);
    };

    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  return (
    <div class="h-screen bg-bg text-text flex flex-col overflow-hidden">
      <header class="border-b border-border bg-bg-surface flex-shrink-0">
        <div class="px-6 py-4 space-y-3">
          <div class="flex items-center justify-between gap-4">
            <A href="/" class="flex items-center gap-2 hover:opacity-80 transition-opacity">
              <span class="text-accent text-base">●</span>
              <h1 class="text-base text-text">better-review kanban</h1>
            </A>
            <div class="flex items-center gap-4 text-sm">
              <A href="/review" class="text-text-faint hover:text-text transition-colors">
                Review
              </A>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <div class="w-44">
              <TextInput
                value={ownerInput()}
                onInput={(e) => setOwnerInput(e.currentTarget.value)}
                placeholder="@me or org"
                size="sm"
              />
            </div>
            <Button variant="secondary" size="sm" onClick={handleOwnerSubmit}>
              Load owner
            </Button>

            <Show
              when={(projectsQuery.data ?? []).length > 0}
              fallback={
                <span class="text-sm text-text-faint">
                  No projects yet. Create one with <code>gh project create --owner @me</code>
                </span>
              }
            >
              <Select
                compact
                value={selectedProjectNumber() ?? ""}
                onChange={(e) => {
                  setSelectedProjectNumber(Number(e.currentTarget.value));
                  setSelectedRepo("");
                  setSelectedAssignee("");
                  setSelectedItemId(null);
                  setPendingMoves([]);
                }}
                class="min-w-[320px]"
              >
                <For each={projectsQuery.data ?? []}>
                  {(project) => (
                    <option value={project.number}>
                      #{project.number} {project.title}
                      {project.closed ? " (closed)" : ""}
                    </option>
                  )}
                </For>
              </Select>
            </Show>

            <Select
              compact
              value={selectedRepo()}
              onChange={(e) => setSelectedRepo(e.currentTarget.value)}
              class="min-w-[260px]"
              disabled={!boardQuery.data}
            >
              <option value="">All repos</option>
              <For each={repoOptions()}>{(repo) => <option value={repo}>{repo}</option>}</For>
            </Select>

            <Select
              compact
              value={cardStyle()}
              onChange={(e) => setCardStyle(e.currentTarget.value as KanbanCardStyle)}
              class="min-w-[220px]"
            >
              <option value="readable">Card style: Readable</option>
              <option value="compact">Card style: Compact</option>
              <option value="split">Card style: Split</option>
            </Select>

            <Button variant="secondary" size="sm" onClick={() => projectsQuery.refetch()}>
              Refresh projects
            </Button>
            <Button variant="secondary" size="sm" onClick={refreshBoard}>
              Refresh board
            </Button>
          </div>

          <Show when={selectedProject()}>
            {(project) => (
              <div class="flex items-center gap-2 text-sm text-text-faint">
                <Badge variant={project().closed ? "warning" : "accent"}>
                  {project().closed ? "Closed" : "Open"}
                </Badge>
                <span>{project().owner.login}</span>
                <span>•</span>
                <a
                  href={project().url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-accent hover:underline"
                >
                  open on GitHub
                </a>
              </div>
            )}
          </Show>

          <Show when={quotaQuery.data}>
            {(quota) => (
              <div class="text-xs text-text-faint flex items-center gap-2 flex-wrap">
                <span>
                  GraphQL: <span class="text-text">{quota().remaining}</span> / {quota().limit}
                </span>
                <Show when={graphqlResetLabel()}>
                  {(label) => (
                    <span>
                      reset ~ <span class="text-text">{label()}</span>
                    </span>
                  )}
                </Show>

                <div class="flex items-center gap-1">
                  <span>assignee:</span>
                  <Select
                    compact
                    value={selectedAssignee()}
                    onChange={(e) => setSelectedAssignee(e.currentTarget.value)}
                    class="min-w-[190px]"
                    disabled={!boardQuery.data}
                  >
                    <option value="">All</option>
                    <For each={assigneeOptions()}>
                      {(assignee) => <option value={assignee}>@{assignee}</option>}
                    </For>
                  </Select>
                </div>

                <div class="flex items-center gap-1">
                  <span>target-week:</span>
                  <Select
                    compact
                    value={targetWeekFilter()}
                    onChange={(e) =>
                      setTargetWeekFilter(e.currentTarget.value as "all" | "lte-next")
                    }
                    class="min-w-[160px]"
                    disabled={!selectedProjectNumber()}
                  >
                    <option value="all">All</option>
                    <option value="lte-next">&lt;=@next</option>
                  </Select>
                </div>

                <Show when={pendingMoves().length > 0}>
                  <Badge variant="warning">{pendingMoves().length} queued move(s)</Badge>
                </Show>
              </div>
            )}
          </Show>

          <Show when={error()}>
            <div class="px-3 py-2 border border-error/50 bg-diff-remove-bg text-error text-sm">
              {error()}
            </div>
          </Show>

          <Show when={boardQuery.data?.statusField}>
            {(statusField) => (
              <p class="text-xs text-text-faint">
                Drag cards between columns. Field:{" "}
                <span class="text-text">{statusField().name}</span> • card variants:{" "}
                <span class="text-text">Readable / Compact / Split</span> • GraphQL saver mode:{" "}
                <span class="text-text">queued auto-apply + manual board refresh</span>
                <Show when={selectedRepo()}>
                  {(repo) => (
                    <>
                      {" "}
                      • repo: <span class="text-text">{repo()}</span>
                    </>
                  )}
                </Show>
                <Show when={selectedAssignee()}>
                  {(assignee) => (
                    <>
                      {" "}
                      • assignee: <span class="text-text">@{assignee()}</span>
                    </>
                  )}
                </Show>
                <Show when={targetWeekFilter() === "lte-next"}>
                  <>
                    {" "}
                    • target-week: <span class="text-text">&lt;=@next</span>
                  </>
                </Show>
              </p>
            )}
          </Show>
        </div>
      </header>

      <main class="flex-1 min-h-0 flex">
        <div class="flex-1 h-full overflow-auto p-4">
          <Show
            when={!boardQuery.isPending}
            fallback={
              <div class="h-full flex items-center justify-center gap-2 text-text-faint">
                <SpinnerIcon size={16} class="animate-spin" />
                Loading board...
              </div>
            }
          >
            <Show
              when={boardQuery.data}
              fallback={
                <div class="text-text-faint text-sm">Pick a project to load its board.</div>
              }
            >
              {(_board) => (
                <div class="h-full flex gap-4 overflow-x-auto pb-2">
                  <For each={visibleColumns()}>
                    {(column) => (
                      <section
                        class={`w-[320px] min-w-[320px] h-full border border-border bg-bg flex flex-col ${
                          dragOverColumn() === (column.id ?? "none") ? "border-accent" : ""
                        }`}
                        onDragOver={(e) => {
                          e.preventDefault();
                          setDragOverColumn(column.id ?? "none");
                        }}
                        onDragLeave={() => setDragOverColumn(null)}
                        onDrop={(e) => handleDrop(column.id, e)}
                      >
                        <header class="px-3 py-2 border-b border-border flex items-center justify-between">
                          <h2 class="text-sm text-text">{column.name}</h2>
                          <Badge variant="neutral">{column.items.length}</Badge>
                        </header>

                        <div class="p-2 space-y-2 overflow-y-auto min-h-[120px]">
                          <Show
                            when={column.items.length > 0}
                            fallback={
                              <div class="p-3 border border-dashed border-border text-xs text-text-faint">
                                Drop cards here
                              </div>
                            }
                          >
                            <For each={column.items}>
                              {(item) => (
                                <Card
                                  draggable={movingItemId() !== item.id}
                                  onClick={() => setSelectedItemId(item.id)}
                                  onDragStart={(e) => {
                                    e.dataTransfer?.setData(
                                      "application/x-better-review-project-item",
                                      JSON.stringify({ itemId: item.id }),
                                    );
                                    e.dataTransfer!.effectAllowed = "move";
                                  }}
                                  variant={cardStyleConfig().cardVariant}
                                  padding={cardStyleConfig().padding}
                                  interactive
                                  class={`text-sm group cursor-grab active:cursor-grabbing bg-bg-surface ${
                                    cardStyleConfig().rootClass
                                  } ${
                                    movingItemId() === item.id ? "opacity-50" : ""
                                  } ${selectedItemId() === item.id ? "border-accent" : ""}`}
                                >
                                  <div
                                    class={`flex items-center justify-between gap-2 ${
                                      cardStyleConfig().headerClass
                                    }`}
                                  >
                                    <div class="flex items-center gap-2 flex-wrap">
                                      <Show
                                        when={isDoneStatus(item.status)}
                                        fallback={
                                          <CircleIcon
                                            size={12}
                                            class={statusIconClass(item.status)}
                                          />
                                        }
                                      >
                                        <CheckIcon size={12} class={statusIconClass(item.status)} />
                                      </Show>
                                      <Badge variant={getTypeBadgeVariant(item.content?.type)}>
                                        {item.content?.type ?? "Item"}
                                      </Badge>
                                      <Badge variant={getStatusBadgeVariant(item.status)}>
                                        {item.status ?? "No status"}
                                      </Badge>
                                    </div>

                                    <div class="flex items-center gap-1">
                                      <Show when={movingItemId() === item.id}>
                                        <SpinnerIcon size={12} class="animate-spin text-accent" />
                                      </Show>
                                      <Show when={item.content?.url}>
                                        <a
                                          href={item.content!.url!}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          onClick={(e) => e.stopPropagation()}
                                          class="inline-flex items-center justify-center text-text-faint hover:text-accent transition-colors"
                                          aria-label="Open item on GitHub"
                                          title="Open on GitHub"
                                        >
                                          <ExternalLinkIcon size={13} />
                                        </a>
                                      </Show>
                                    </div>
                                  </div>

                                  <div class={cardStyleConfig().titleClass}>
                                    {item.content?.title ?? "Untitled"}
                                  </div>

                                  <div class={cardStyleConfig().metaClass}>
                                    <Show when={item.content?.repository}>
                                      <span>{item.content?.repository}</span>
                                    </Show>
                                    <Show when={item.content?.number}>
                                      <span>#{item.content?.number}</span>
                                    </Show>
                                  </div>

                                  <div
                                    class={`flex items-center gap-1.5 flex-wrap ${cardStyleConfig().footerClass}`}
                                  >
                                    <Show when={item.targetWeek}>
                                      {(targetWeek) => (
                                        <Badge
                                          variant="accent"
                                          class="text-[11px]"
                                          title="Target week"
                                        >
                                          {formatTargetWeekBadgeText(targetWeek())}
                                        </Badge>
                                      )}
                                    </Show>
                                    <Show
                                      when={(item.assignees?.length ?? 0) > 0}
                                      fallback={
                                        <span class="text-[11px] text-text-faint">Unassigned</span>
                                      }
                                    >
                                      <For each={item.assignees?.slice(0, 3) ?? []}>
                                        {(assignee) => (
                                          <Badge variant="neutral" class="text-[11px]">
                                            @{assignee}
                                          </Badge>
                                        )}
                                      </For>
                                      <Show when={(item.assignees?.length ?? 0) > 3}>
                                        <Badge variant="neutral" class="text-[11px]">
                                          +{(item.assignees?.length ?? 0) - 3}
                                        </Badge>
                                      </Show>
                                    </Show>
                                  </div>
                                </Card>
                              )}
                            </For>
                          </Show>
                        </div>
                      </section>
                    )}
                  </For>
                </div>
              )}
            </Show>
          </Show>
        </div>

        <Show when={selectedItem()}>
          {(item) => (
            <aside class="w-[380px] h-full border-l border-border bg-bg-surface p-4 overflow-y-auto space-y-4">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="text-xs text-text-faint uppercase tracking-wide">Item details</p>
                  <h2 class="text-base text-text mt-1">{item().content?.title ?? "Untitled"}</h2>
                </div>
                <Button variant="ghost" size="xs" onClick={() => setSelectedItemId(null)}>
                  Close
                </Button>
              </div>

              <div class="flex items-center gap-2 flex-wrap">
                <Badge variant={getTypeBadgeVariant(item().content?.type)}>
                  {item().content?.type ?? "Item"}
                </Badge>
                <Badge variant={getStatusBadgeVariant(item().status)}>
                  {item().status ?? "No status"}
                </Badge>
                <Show when={item().targetWeek}>
                  {(targetWeek) => (
                    <Badge variant="accent">{formatTargetWeekBadgeText(targetWeek())}</Badge>
                  )}
                </Show>
              </div>

              <Card padding="md" variant="subtle" class="space-y-3 bg-bg">
                <div class="text-xs text-text-faint">Assignees</div>
                <div class="flex items-center gap-1.5 flex-wrap">
                  <Show
                    when={(item().assignees?.length ?? 0) > 0}
                    fallback={<span class="text-sm text-text-faint">Unassigned</span>}
                  >
                    <For each={item().assignees ?? []}>
                      {(assignee) => <Badge variant="neutral">@{assignee}</Badge>}
                    </For>
                  </Show>
                </div>
              </Card>

              <Card padding="md" variant="subtle" class="space-y-3 bg-bg">
                <div class="text-xs text-text-faint">Metadata</div>
                <div class="space-y-1 text-sm text-text-faint">
                  <Show when={item().content?.repository}>
                    <div>
                      Repository: <span class="text-text">{item().content?.repository}</span>
                    </div>
                  </Show>
                  <Show when={item().content?.number}>
                    <div>
                      Number: <span class="text-text">#{item().content?.number}</span>
                    </div>
                  </Show>
                  <Show when={item().targetWeek}>
                    {(targetWeek) => (
                      <div class="flex items-center gap-2">
                        <Badge variant="accent">{formatTargetWeekBadgeText(targetWeek())}</Badge>
                      </div>
                    )}
                  </Show>
                  <div>
                    Item ID: <span class="text-text break-all">{item().id}</span>
                  </div>
                </div>
              </Card>

              <Card padding="md" variant="subtle" class="space-y-3 bg-bg">
                <div class="text-xs text-text-faint">Description</div>
                <Show
                  when={selectedItemBodyHtml().length > 0}
                  fallback={<div class="text-sm text-text-faint">No description provided.</div>}
                >
                  <div
                    class="text-sm text-text leading-relaxed markdown-content"
                    innerHTML={selectedItemBodyHtml()}
                  />
                </Show>
              </Card>

              <Card padding="md" variant="subtle" class="space-y-3 bg-bg">
                <div class="text-xs text-text-faint">Move item</div>
                <div class="flex items-center gap-1.5 flex-wrap">
                  <For each={boardQuery.data?.statusField?.options ?? []}>
                    {(option) => (
                      <Button
                        size="xs"
                        variant={item().status === option.name ? "primary" : "secondary"}
                        disabled={movingItemId() === item().id}
                        onClick={() => moveItem(item(), option.id)}
                      >
                        {option.name}
                      </Button>
                    )}
                  </For>
                  <Button
                    size="xs"
                    variant={item().status === null ? "primary" : "secondary"}
                    disabled={movingItemId() === item().id}
                    onClick={() => moveItem(item(), null)}
                  >
                    No status
                  </Button>
                </div>
              </Card>

              <Show when={item().content?.url}>
                <a
                  href={item().content!.url!}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-2 text-sm text-accent hover:underline"
                >
                  <ExternalLinkIcon size={14} />
                  Open on GitHub
                </a>
              </Show>
            </aside>
          )}
        </Show>
      </main>
    </div>
  );
};

export default KanbanPage;
