---
description: Send the current git diff to Better Review
---

Use the `review_working_diff` tool to open a Better Review diff session for the current repo.

In the review UI, pick the scope you want to review against, such as:

- unstaged changes
- staged changes
- latest commit
- branch vs main / develop (when available)

Surface the live Tailscale review URL shown by the tool so I can open it from another device.

After the tool returns:

- If approved, briefly confirm approval and mention any annotations worth preserving.
- If changes are requested, summarize the human review feedback and use it to guide the next code revision.
