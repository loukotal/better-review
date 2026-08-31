#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_AGENT_DIR="${PI_AGENT_DIR:-${HOME}/.pi/agent}"
EXTENSION_DIR="${PI_AGENT_DIR}/extensions"
PROMPT_DIR="${PI_AGENT_DIR}/prompts"

mkdir -p "${EXTENSION_DIR}" "${PROMPT_DIR}"

install -m 0644 \
  "${ROOT_DIR}/examples/pi-better-review-extension.ts" \
  "${EXTENSION_DIR}/better-review.ts"
install -m 0644 \
  "${ROOT_DIR}/examples/pi-better-review-plan-command.md" \
  "${PROMPT_DIR}/better-review-plan.md"
install -m 0644 \
  "${ROOT_DIR}/examples/pi-better-review-last-command.md" \
  "${PROMPT_DIR}/better-review-last.md"
install -m 0644 \
  "${ROOT_DIR}/examples/pi-better-review-diff-command.md" \
  "${PROMPT_DIR}/better-review-diff.md"

cat <<EOF
Installed Better Review for Pi:
  ${EXTENSION_DIR}/better-review.ts
  ${PROMPT_DIR}/better-review-plan.md
  ${PROMPT_DIR}/better-review-last.md
  ${PROMPT_DIR}/better-review-diff.md

Run /reload in an active Pi session, then use:
  /better-review-plan
  /better-review-last
  /better-review-diff
EOF
