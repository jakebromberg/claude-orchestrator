#!/usr/bin/env bash
# PreToolUse hook for Write|Edit: blocks writes outside allowed paths.
# Reads allowed glob patterns from .claude/issue-policy.json in the worktree.
# Exit code 0 = allow, exit code 2 = block (feedback sent to Claude).
set -euo pipefail

INPUT=$(cat)

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.file // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd')

if [[ -z "$FILE_PATH" ]]; then
    exit 0
fi

POLICY_FILE="$CWD/.claude/issue-policy.json"
if [[ ! -f "$POLICY_FILE" ]]; then
    exit 0
fi

ALLOWED_PATHS=$(jq -r '.allowedPaths[]' "$POLICY_FILE" 2>/dev/null)
if [[ -z "$ALLOWED_PATHS" ]]; then
    exit 0
fi

# Resolve to relative path from worktree root
if [[ "$FILE_PATH" == /* ]]; then
    REL_PATH="${FILE_PATH#$CWD/}"
else
    REL_PATH="$FILE_PATH"
fi

# Check each allowed pattern
while IFS= read -r pattern; do
    # Use bash glob matching (fnmatch-style)
    # Convert ** to a regex-friendly form
    regex=$(echo "$pattern" | sed 's/\*\*/DOUBLESTAR/g' | sed 's/\*/[^\/]*/g' | sed 's/DOUBLESTAR/.*/g')
    if echo "$REL_PATH" | grep -qE "^${regex}$"; then
        exit 0
    fi
done <<< "$ALLOWED_PATHS"

echo "Blocked: '$REL_PATH' is outside the allowed paths for this task. Allowed: $(echo "$ALLOWED_PATHS" | tr '\n' ', '). Work only within your assigned module." >&2
exit 2
