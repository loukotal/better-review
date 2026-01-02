# better-review

Better code review experience for GitHub PRs. Runs locally with your github login using the gh cli - easily access your PRs, data stays local. Uses opencode for ai-assisted code review.

## Prerequisites

- bun
- [gh cli]( https://cli.github.com/ )
- [opencode](https://opencode.ai/)

## How to run

Currently you need to pull the repo and run it locally.

1. `bun install`
2. `bun run dev`

You can update ports with `API_PORT`, `WEB_PORT`, `OPENCODE_PORT` environment variables. Defaults are `3000`, `3001` and `4096`

## License

Licensed under [MIT](LICENSE).

## TODOs

- [ ] virtualization for large files - ~7k line file takes long time to load
- [ ] better handle SSE connection
- [ ] load opencode sessions based on PR link - allow switching between sessions if multiple exist
- [ ] handle "project knowledge base"
- [ ] simpler marks for warning/info UI elements & files (just use filenames instead of \[\[\]\])
- [ ] better mobile ui
- [ ] make it executable using bun
- [ ] start web server on ".local" domain(?)
