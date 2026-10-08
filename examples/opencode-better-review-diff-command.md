---
description: Send the current git diff to better-review
---

Use the `review_working_diff` tool to open a better-review diff session for the current repo.

Default to branch commits vs base plus staged and unstaged changes (`scope: "all"`).
If the user specifies a scope or base, pass those overrides to the tool.
Available scopes: `all`, `uncommitted`, `unstaged`, `staged`, `last-commit`, `branch`.
The review UI also lets the user switch scopes.

Requested scope or base: $ARGUMENTS

After the tool returns:

- If approved, briefly confirm approval and mention any annotations worth preserving.
- If changes are requested, summarize the human review feedback and use it to guide the next code revision.
