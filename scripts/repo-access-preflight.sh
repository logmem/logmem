#!/usr/bin/env bash
# repo-access-preflight.sh — Verify GitHub PR executor access for logmem/logmem.
#
# Non-secret preflight: verifies authentication, write/admin repository
# permissions, and remote connectivity before creating branches or opening PRs.
#
# Exit 0 = safe to execute PR / branch operations.
# Exit 1 = access check failed (exact diagnostic printed).

set -euo pipefail

TARGET_REPO="${1:-logmem/logmem}"

echo "=== GitHub Repo Access Preflight ==="
echo "Target repository: ${TARGET_REPO}"

# 1. Check gh CLI presence
if ! command -v gh >/dev/null 2>&1; then
  echo "FAIL: 'gh' GitHub CLI is not installed or not in PATH."
  exit 1
fi
echo "PASS: 'gh' CLI found."

# 2. Check gh auth status (without echoing credentials)
if ! gh auth status >/dev/null 2>&1; then
  echo "FAIL: 'gh' is not authenticated. Please run 'gh auth login' or provide GH_TOKEN in environment."
  exit 1
fi
ACTIVE_USER="$(gh api user --jq '.login' 2>/dev/null || echo 'unknown')"
echo "PASS: Authenticated to GitHub as '${ACTIVE_USER}'."

# 3. Check repository permissions
REPO_JSON="$(gh api "repos/${TARGET_REPO}" 2>/dev/null || true)"
if [ -z "${REPO_JSON}" ]; then
  echo "FAIL: Cannot access repository '${TARGET_REPO}' (HTTP 404 or insufficient read permission)."
  exit 1
fi

CAN_PUSH="$(echo "${REPO_JSON}" | jq -r '.permissions.push // false' 2>/dev/null || echo 'false')"
IS_ADMIN="$(echo "${REPO_JSON}" | jq -r '.permissions.admin // false' 2>/dev/null || echo 'false')"

if [ "${CAN_PUSH}" != "true" ] && [ "${IS_ADMIN}" != "true" ]; then
  echo "FAIL: Authenticated user '${ACTIVE_USER}' lacks WRITE or ADMIN permissions on '${TARGET_REPO}'."
  exit 1
fi
echo "PASS: Verified repository permissions on '${TARGET_REPO}' (push=${CAN_PUSH}, admin=${IS_ADMIN})."

# 4. Check git ls-remote connectivity
REMOTE_URL="https://github.com/${TARGET_REPO}.git"
if ! git ls-remote "${REMOTE_URL}" HEAD >/dev/null 2>&1; then
  echo "FAIL: 'git ls-remote' failed to reach '${REMOTE_URL}'. Check network connectivity or DNS."
  exit 1
fi
echo "PASS: 'git ls-remote' connectivity verified on '${REMOTE_URL}'."

echo ""
echo "=== Preflight SUCCESS: Shared PR executor verified for ${TARGET_REPO} ==="
exit 0
