#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
TARGET="${BIN_DIR}/better-review"

mkdir -p "${BIN_DIR}"

cat > "${TARGET}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "${ROOT_DIR}/node_modules/.bin/tsx" "${ROOT_DIR}/index.ts" "\$@"
EOF

chmod +x "${TARGET}"

cat <<EOF
Installed better-review launcher at:
  ${TARGET}

Make sure ${BIN_DIR} is on your PATH. For zsh:
  export PATH="${BIN_DIR}:\$PATH"

Then you can run:
  better-review plan
  better-review last
  better-review review
EOF
