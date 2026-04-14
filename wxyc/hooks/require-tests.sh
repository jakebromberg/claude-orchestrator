#!/usr/bin/env bash
# PostToolUse hook for Write|Edit|Bash: tracks writes and test runs.
# After maxWritesBeforeTest consecutive writes without a test run,
# sends additionalContext reminding Claude to run tests.
# Exit code 0 always (PostToolUse hooks don't block, they advise).
set -euo pipefail

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd')

POLICY_FILE="$CWD/.claude/issue-policy.json"
STATE_FILE="$CWD/.claude/supervision-state.json"

if [[ ! -f "$POLICY_FILE" ]]; then
    exit 0
fi

MAX_WRITES=$(jq -r '.maxWritesBeforeTest // 5' "$POLICY_FILE")
TEST_CMD=$(jq -r '.testCommand // ""' "$POLICY_FILE")

# Initialize state file if missing
if [[ ! -f "$STATE_FILE" ]]; then
    echo '{"writesSinceTest": 0, "planRead": false}' > "$STATE_FILE"
fi

WRITES_SINCE_TEST=$(jq -r '.writesSinceTest // 0' "$STATE_FILE")

if [[ "$TOOL_NAME" == "Write" || "$TOOL_NAME" == "Edit" ]]; then
    WRITES_SINCE_TEST=$((WRITES_SINCE_TEST + 1))
    jq --argjson w "$WRITES_SINCE_TEST" '.writesSinceTest = $w' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"

    if [[ "$WRITES_SINCE_TEST" -ge "$MAX_WRITES" ]]; then
        echo "{\"additionalContext\": \"You have made $WRITES_SINCE_TEST file changes without running tests. Run '$TEST_CMD' now before making more changes.\"}"
        exit 0
    fi
fi

if [[ "$TOOL_NAME" == "Bash" ]]; then
    COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
    if echo "$COMMAND" | grep -qE "cargo test|pytest|npm test|vitest"; then
        jq '.writesSinceTest = 0' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
    fi
fi

exit 0
