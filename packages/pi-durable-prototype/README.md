# Pi Durable review prototype

**Question:** can Pi Durable keep one review conversation across rewritten PR revisions and process death, while using Better Review's existing Microsandbox checkout?

Throwaway implementation on `prototype/pi-durable-review`. Entry point: `src/index.ts`.
Pinned to Pi Durable **1.0.3**, matching this repository's Pi AI override. The current upstream README describes newer APIs; use the installed declarations when changing this prototype.

## Run

```sh
pnpm prototype:pi --demo
```

No credentials or VM required. This runs real Pi Durable with SQLite, a scripted provider, and a fixture filesystem. It kills a child process with SIGKILL inside a read tool, reopens the database, resumes the pending review, and changes from A to an unrelated B. It prints the revision state and transcript and checks that the old entries survive, the input is not duplicated, busy revision changes are rejected, and the new tool call reads B.

The printed `PROTOTYPE.sqlite` lives in a temporary directory and can be deleted afterwards.

### Real checkout and sandbox

Use an existing Better Review session ID from a saved review link or `~/.local/share/better-review/flue-review-sessions/`:

```sh
pnpm prototype:pi --session <session-id> --sandbox-smoke
```

This prepares the saved checkout and checks its HEAD, command exit status, read-only repository mount, and a failed outbound network request. It also runs a scripted Pi tool call through the real VM and checks the persisted tool result. The network probe demonstrates a failed request, not a complete network isolation audit.

### Live review

```sh
pnpm prototype:pi --session <session-id> --model anthropic/claude-sonnet-4-6
pnpm prototype:pi --db /absolute/path/to/saved-prototype.sqlite
```

Uses the existing provider credential resolver. Importing a saved session copies its **revision**, not its Flue transcript. Subsequent Pi turns retain the Pi conversation. Reopening resumes interrupted work before accepting input.

- `/pull`: fetch the latest full PR, prepare its checkout, record the transition and continue.
- `/history`: print the model-visible conversation, including earlier revisions.
- `/status`: print persisted revision history and active tasks.
- `/exit`: close the prototype.
- Other text: ask a follow-up.
- Ctrl-C: close the harness while preserving pending work for the next launch.

Commands are processed sequentially; while a review runs, use Ctrl-C to suspend it. Run only **one process per database**, as required by Pi Durable's storage ownership contract. A model selection is persisted when the database is created.

Default databases live under `~/.local/share/better-review/pi-durable-PROTOTYPE/`. Smoke databases use a separate `.smoke.sqlite` filename. Prototype VMs have database-specific names and ownership labels, and cleanup targets only those labels.

## What this establishes

- Stable conversation identity is independent of the selected revision.
- Revision metadata, its transcript event, and a continuation intent can be committed atomically.
- A persisted `requestId` repairs the crash window between the revision commit and submission admission without duplicating input.
- Safe reads replay after a process dies. Arbitrary shell calls are marked unsafe to replay.
- A prompt section reads the committed revision before each model request.
- The real Microsandbox adapter can serve Pi tools. This prototype uses two custom tools (`read`, `bash`); it does **not** implement Pi's full `ExecutionEnv` filesystem contract.

## Findings and next decision

The deterministic SIGKILL/revision walkthrough and the Pi-to-real-VM smoke check passed. The initial real VM check exposed two existing adapter bugs: PID files were created in a root-owned directory after its ownership setup, and BusyBox `setsid` could fork and return success before the command's exit status. The shared adapter now creates the PID directory before chown and runs `setsid` from a waiting parent shell. The smoke check confirmed exit status 37 and successful Git reads, while writes and the outbound request failed.

Live model inference was not exercised. The credential resolver reported expired stored Anthropic, Codex, and Copilot tokens during the smoke run; the scripted provider keeps the durability and sandbox checks independent of those credentials.

This is evidence for continuing a Pi Durable evaluation, not a completed Flue migration. Before replacing the runtime, validate live provider behaviour, cancellation during long commands, compaction over a long PR lifecycle, and UI reconnects. Migration would also need a transport adapter for the existing chat UI, revision-aware historical annotations, and a decision about importing existing Flue transcripts.
