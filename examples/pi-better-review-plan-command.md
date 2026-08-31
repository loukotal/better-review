---
description: Send a markdown plan to Better Review
---

Use the `submit_plan` tool to send the plan under discussion to Better Review.

Rules:

- If I explicitly provide markdown content in this turn, use that as the plan.
- Otherwise, if there is an obvious current plan file in context, read it and use that.
- If there is no clear plan content or plan file, ask me which plan to review.
- Surface the live Tailscale review URL shown by the tool so I can open it from another device.

After the tool returns:

- If approved, briefly confirm approval and summarize any notable annotations.
- If changes are requested, summarize the feedback and use it as the next revision input.
