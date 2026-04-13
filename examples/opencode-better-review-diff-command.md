---
description: Send the current git diff to better-review
---

Use the `review_working_diff` tool to open a better-review diff session for the current repo.

In the review UI, pick the scope you want to review against, such as:

- unstaged changes
- staged changes
- latest commit
- branch vs main / develop (when available)

After the tool returns:

- If approved, briefly confirm approval and mention any annotations worth preserving.
- If changes are requested, summarize the human review feedback and use it to guide the next code revision.
