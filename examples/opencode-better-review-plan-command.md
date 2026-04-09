---
description: Send a markdown plan to better-review
---

Use the `submit_plan` tool to send the plan under discussion to better-review.

Rules:

- If I explicitly provide markdown content in this turn, use that as the plan.
- Otherwise, if there is an obvious current plan file in context, read it and use that.
- If there is no clear plan content or plan file, ask me which plan to review.

After the tool returns:

- If the result is approved, briefly confirm approval and summarize any notable annotations.
- If the result requests changes, summarize the feedback and use it as the next revision input.
