#!/usr/bin/env bash
# PreToolUse hook for Write|Edit: blocks writes if the plan hasn't been read yet.
# Tracks whether the agent has read the issue/plan via .claude/supervision-state.json.
# Exit code 0 = allow, exit code 2 = block.
set -euo pipefail

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd')

POLICY_FILE="$CWD/.claude/issue-policy.json"
STATE_FILE="$CWD/.claude/supervision-state.json"

if [[ ! -f "$POLICY_FILE" ]]; then
    exit 0
fi

REQUIRE_PLAN=$(jq -r '.requirePlanRead // false' "$POLICY_FILE")
if [[ "$REQUIRE_PLAN" != "true" ]]; then
    exit 0
fi

# Initialize state if missing
if [[ ! -f "$STATE_FILE" ]]; then
    echo '{"writesSinceTest": 0, "planRead": false}' > "$STATE_FILE"
fi

PLAN_READ=$(jq -r '.planRead // false' "$STATE_FILE")

if [[ "$PLAN_READ" == "true" ]]; then
    exit 0
fi

# Block writes if plan hasn't been read
if [[ "$TOOL_NAME" == "Write" || "$TOOL_NAME" == "Edit" ]]; then
    echo "Blocked: Read the implementation plan (via 'gh issue view' or reading the plan file) before writing code." >&2
    exit 2
fi

exit 0
