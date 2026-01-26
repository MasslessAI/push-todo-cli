#!/bin/bash
# Install Push Tasks skill for Clawdbot
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/MasslessAI/push-todo-cli/main/clawdbot/install-clawdbot.sh | bash

set -e

echo "Installing Push Tasks for Clawdbot..."

CLAWDBOT_DIR="$HOME/.clawdbot"
SKILLS_DIR="$CLAWDBOT_DIR/skills/push-todo"

# Create directories
mkdir -p "$SKILLS_DIR/scripts"
mkdir -p "$SKILLS_DIR/.claude-plugin"

# Download files from GitHub
BASE_URL="https://raw.githubusercontent.com/MasslessAI/push-todo-cli/main"

echo "Downloading skill files..."

# Download canonical SKILL.md and transform paths for Clawdbot
curl -sL "$BASE_URL/plugins/push-todo/SKILL.md" | \
  sed 's|\${CLAUDE_PLUGIN_ROOT:-\$HOME/\.claude/skills/push-todo}|$HOME/.clawdbot/skills/push-todo|g' \
  > "$SKILLS_DIR/SKILL.md"

# Download plugin.json for version checking
curl -sL "$BASE_URL/plugins/push-todo/.claude-plugin/plugin.json" > "$SKILLS_DIR/.claude-plugin/plugin.json"

# Download Python scripts
curl -sL "$BASE_URL/plugins/push-todo/scripts/connect.py" > "$SKILLS_DIR/scripts/connect.py"
curl -sL "$BASE_URL/plugins/push-todo/scripts/fetch_task.py" > "$SKILLS_DIR/scripts/fetch_task.py"
curl -sL "$BASE_URL/plugins/push-todo/scripts/check_tasks.py" > "$SKILLS_DIR/scripts/check_tasks.py"

chmod +x "$SKILLS_DIR/scripts/"*.py

echo ""
echo "Installation complete!"
echo ""

# Check if already configured
if [ -f "$HOME/.config/push/config" ]; then
    echo "Found existing Push configuration."
    echo ""
    echo "You're all set! Say 'push-todo' or '/push-todo' in Clawdbot to see your tasks."
else
    echo "Next steps:"
    echo "  1. In Clawdbot, say '/push-todo connect'"
    echo "  2. Sign in with your Push account"
    echo "  3. Start capturing voice tasks on your iPhone!"
fi
echo ""
echo "Learn more: https://pushto.do"
