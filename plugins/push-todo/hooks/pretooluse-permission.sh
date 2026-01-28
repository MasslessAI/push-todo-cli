#!/bin/bash
#
# Push PreToolUse Permission Hook for Claude Code
#
# This hook auto-approves Bash commands that are part of the push-todo plugin.
# It bypasses the permission system for push-todo commands only.
#
# Why this is needed:
# - Claude Code's permissions.allow in settings.json does NOT work for skills/subagents
# - This is a known bug: https://github.com/anthropics/claude-code/issues/18950
# - PreToolUse hooks with permissionDecision: "allow" bypass the permission system
#
# See: /docs/20260128_claude_code_permission_prompt_bypass_failed_experiments_and_solution.md
#

# Read JSON input from stdin
INPUT=$(cat)

# Extract tool name and command using Python (more reliable than jq for edge cases)
read -r TOOL_NAME COMMAND <<< $(python3 -c "
import json
import sys
try:
    data = json.loads('''$INPUT''')
    tool_name = data.get('tool_name', '')
    command = data.get('tool_input', {}).get('command', '')
    print(tool_name, command)
except:
    print('', '')
" 2>/dev/null)

# Only process Bash tool calls
if [ "$TOOL_NAME" != "Bash" ]; then
    exit 0
fi

# Check if command contains push-todo (case-insensitive check for the path)
if [[ "$COMMAND" == *"push-todo"* ]]; then
    # Return JSON to auto-approve this command
    cat << 'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Auto-approved push-todo plugin command"
  }
}
EOF
    exit 0
fi

# For non-push-todo commands, let normal permission flow proceed
exit 0
