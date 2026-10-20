import type { GithubPrScope } from "@better-review/shared";

import type { GithubEditorJournal } from "./github-outbox-journal";

/** Low-level editor/form state depends on storage, never on tRPC/runtime composition. */
let service:
  | {
      journal: GithubEditorJournal;
      scope: (url: string) => GithubPrScope;
      beginSaving?: (scope: GithubPrScope) => () => void;
    }
  | undefined;
export function configureGithubEditorService(
  journal: GithubEditorJournal,
  scope: (url: string) => GithubPrScope,
  beginSaving?: (scope: GithubPrScope) => () => void,
) {
  service = { journal, scope, beginSaving };
}
export function githubEditorService() {
  if (!service) throw new Error("GitHub durable editor storage is not configured");
  return service;
}
