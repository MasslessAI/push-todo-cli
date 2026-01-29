#!/bin/bash
#
# Push SessionEnd Hook for Claude Code
#
# Called automatically by Claude when a session ends.
# Reports completion status to Supabase via update-task-execution endpoint.
#
# Auto-commit feature (v1.3.0):
# - When PUSH_AUTO_COMMIT is enabled (default: true), auto-commits changes
# - Creates descriptive commit message including task info
# - Does NOT push to remote (user controls that)
#
# This hook only fires for sessions running in push-* worktrees.
# It detects the display number from the worktree path and reports status.
#
# Input (JSON via stdin):
# {
#   "session_id": "abc123",
#   "cwd": "/path/to/push-123",
#   "transcript_path": "~/.claude/projects/.../transcript.jsonl",
#   "hook_event_name": "SessionEnd",
#   "reason": "exit" | "interrupt" | "timeout"
# }
#
# See: /docs/20260127_parallel_task_execution_research.md
# See: /docs/20260127_parallel_task_execution_implementation_plan.md

set -o pipefail

# Get the directory where this script lives
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Read input from stdin
INPUT=$(cat)

# Extract fields using jq
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
REASON=$(echo "$INPUT" | jq -r '.reason // "exit"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# Check if this is a push-* worktree
# Pattern: /some/path/push-123 or /some/path/push-123/
if [[ ! "$CWD" =~ /push-([0-9]+)/?$ ]]; then
    # Not a push task worktree, exit silently
    exit 0
fi

# Extract display number from path
DISPLAY_NUM=$(echo "$CWD" | grep -oE 'push-([0-9]+)' | grep -oE '[0-9]+')

if [ -z "$DISPLAY_NUM" ]; then
    echo "[Push] Could not extract display number from: $CWD" >&2
    exit 0
fi

# Load config from file
CONFIG_FILE="$HOME/.config/push/config"
if [ -f "$CONFIG_FILE" ]; then
    # Source the config file (exports PUSH_API_KEY, PUSH_AUTO_COMMIT, etc.)
    # shellcheck source=/dev/null
    source "$CONFIG_FILE"
fi

if [ -z "$PUSH_API_KEY" ]; then
    echo "[Push] No API key configured, skipping completion report" >&2
    exit 0
fi

# Check auto-commit setting (default: enabled)
AUTO_COMMIT="${PUSH_AUTO_COMMIT:-true}"

# Determine status based on reason
STATUS="completed"
ERROR=""
SUMMARY=""

case "$REASON" in
    "interrupt")
        STATUS="failed"
        ERROR="Session interrupted by user"
        ;;
    "timeout")
        STATUS="failed"
        ERROR="Session timed out"
        ;;
    "exit"|"")
        STATUS="completed"
        SUMMARY="Task completed via Claude Code"
        ;;
    *)
        STATUS="completed"
        SUMMARY="Session ended (reason: $REASON)"
        ;;
esac

# Auto-commit if enabled and task completed successfully
COMMIT_MSG=""
if [[ "$AUTO_COMMIT" == "true" && "$STATUS" == "completed" ]]; then
    # Change to worktree directory
    if [ -d "$CWD" ]; then
        cd "$CWD" || exit 0

        # Check if there are any changes to commit
        if ! git diff --quiet HEAD 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
            echo "[Push] Auto-committing changes for task #$DISPLAY_NUM" >&2

            # Stage all changes
            git add -A 2>/dev/null

            # Get summary of changes for commit message
            CHANGED_FILES=$(git diff --cached --name-only 2>/dev/null | head -10)
            FILE_COUNT=$(git diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')

            # Build commit message
            COMMIT_MSG="[Push #$DISPLAY_NUM] Task completed

Files changed: $FILE_COUNT
$(echo "$CHANGED_FILES" | sed 's/^/  - /')

Co-Authored-By: Claude <noreply@anthropic.com>"

            # Create commit
            if git commit -m "$COMMIT_MSG" 2>/dev/null; then
                COMMIT_HASH=$(git rev-parse --short HEAD 2>/dev/null)
                echo "[Push] Created commit $COMMIT_HASH (not pushed)" >&2
                SUMMARY="Task completed. Auto-committed as $COMMIT_HASH"
            else
                echo "[Push] Auto-commit failed (pre-commit hook or other issue)" >&2
            fi
        else
            echo "[Push] No changes to commit for task #$DISPLAY_NUM" >&2
        fi
    fi
fi

# Build JSON payload
# Using jq to properly escape strings and handle nulls
PAYLOAD=$(jq -n \
    --arg displayNumber "$DISPLAY_NUM" \
    --arg status "$STATUS" \
    --arg summary "$SUMMARY" \
    --arg error "$ERROR" \
    '{
        displayNumber: ($displayNumber | tonumber),
        status: $status,
        summary: (if $summary != "" then $summary else null end),
        error: (if $error != "" then $error else null end)
    }')

# Log what we're doing
echo "[Push] Reporting task #$DISPLAY_NUM as $STATUS" >&2

# Call edge function
API_URL="https://jxuzqcbqhiaxmfitzxlo.supabase.co/functions/v1/update-task-execution"

RESPONSE=$(curl -s -X PATCH "$API_URL" \
    -H "Authorization: Bearer $PUSH_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    --connect-timeout 10 \
    --max-time 15 \
    2>&1) || true

# Check if successful
if echo "$RESPONSE" | jq -e '.success' >/dev/null 2>&1; then
    echo "[Push] Successfully reported task #$DISPLAY_NUM as $STATUS" >&2
else
    echo "[Push] Failed to report task #$DISPLAY_NUM: $RESPONSE" >&2
fi

# Always exit 0 to not block Claude
exit 0
