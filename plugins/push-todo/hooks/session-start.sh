#!/bin/bash
#
# Push Session Start Hook for Claude Code
#
# This hook runs at the start of each Claude Code session and:
# 1. Checks for plugin updates from GitHub
# 2. Checks for pending tasks from the Push iOS app
#
# Installation:
#   Add to ~/.claude/settings.json:
#   {
#     "hooks": {
#       "SessionStart": [
#         { "matcher": "", "hooks": [{ "type": "command", "command": "/path/to/session-start.sh" }] }
#       ]
#     }
#   }
#
# Environment:
#   PUSH_PLUGIN_AUTO_UPDATE=true  - Enable auto-updates (default: notify only)
#

# Get the directory where this script lives
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"

# Check for plugin updates (runs in background, output captured)
UPDATE_MSG=$(python3 "$PLUGIN_DIR/scripts/check_updates.py" 2>/dev/null)
if [ -n "$UPDATE_MSG" ]; then
    echo "$UPDATE_MSG"
fi

# Check if API key is configured
if [ -z "$PUSH_API_KEY" ]; then
    # Try to load from config file
    CONFIG_FILE="$HOME/.config/push/config"
    if [ -f "$CONFIG_FILE" ]; then
        source "$CONFIG_FILE"
    fi
fi

# Skip if still no API key (plugin not configured)
if [ -z "$PUSH_API_KEY" ]; then
    exit 0
fi

# Check for pending tasks
COUNT=$(python3 "$PLUGIN_DIR/scripts/check_tasks.py" 2>/dev/null)

# Only output if there are tasks
if [ -n "$COUNT" ] && [ "$COUNT" -gt 0 ]; then
    if [ "$COUNT" -eq 1 ]; then
        echo "[Push] You have 1 pending task from your iPhone. Say 'push-todo' to see it."
    else
        echo "[Push] You have $COUNT pending tasks from your iPhone. Say 'push-todo' to see them."
    fi
fi
