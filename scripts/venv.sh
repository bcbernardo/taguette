#!/usr/bin/env bash
# Create/recreate the .venv using an interpreter INSIDE the project (.python/).
# The project path is identical on the host and inside the sandbox, so the
# venv's symlinks and shebangs work in both contexts.
#
# Usage: scripts/venv.sh [--recreate]
set -euo pipefail
cd "$(dirname "$0")/.."
export UV_PYTHON_INSTALL_DIR="$PWD/.python"

if [ -x .venv/bin/python ] && .venv/bin/python -c '' 2>/dev/null && [ "${1:-}" != "--recreate" ]; then
    echo ".venv ok ($(.venv/bin/python --version)) — nothing to do"
    exit 0
fi

rm -rf .venv
uv venv --python "$(cat .python-version)"
uv pip install -e . 'setuptools<81'   # setuptools: main.py uses pkg_resources (removed in 81)
.venv/bin/taguette --help >/dev/null && echo "OK: .venv/bin/taguette works"
