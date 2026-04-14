#!/usr/bin/env bash
# PostToolUse hook for Bash|Read: marks the plan as read when the agent
# reads the GitHub issue or a plan file.
# Exit code 0 always.
set -euo pipefail

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd')

STATE_FILE="$CWD/.claude/supervision-state.json"

if [[ ! -f "$STATE_FILE" ]]; then
    echo '{"writesSinceTest": 0, "planRead": false}' > "$STATE_FILE"
fi

PLAN_READ=$(jq -r '.planRead // false' "$STATE_FILE")
if [[ "$PLAN_READ" == "true" ]]; then
    exit 0
fi

if [[ "$TOOL_NAME" == "Bash" ]]; then
    COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
    if echo "$COMMAND" | grep -qE "gh issue view"; then
        jq '.planRead = true' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
    fi
fi

if [[ "$TOOL_NAME" == "Read" ]]; then
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
    if echo "$FILE_PATH" | grep -qiE "plan|issue|PLAN|ISSUE"; then
        jq '.planRead = true' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
    fi
fi

exit 0
