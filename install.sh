#!/bin/bash
# Install Push Tasks skill for Claude Code

set -e

echo "Installing Push Tasks for Claude Code..."

CLAUDE_DIR="$HOME/.claude"
SKILLS_DIR="$CLAUDE_DIR/skills/push-tasks"

# Create directories
mkdir -p "$SKILLS_DIR/scripts"
mkdir -p "$SKILLS_DIR/hooks"

# Download files from GitHub
BASE_URL="https://raw.githubusercontent.com/MasslessAI/push-claude-plugin/main/plugins/push-tasks"

echo "Downloading skill files..."
curl -sL "$BASE_URL/skills/push-tasks/SKILL.md" > "$SKILLS_DIR/SKILL.md"
curl -sL "$BASE_URL/scripts/setup.py" > "$SKILLS_DIR/scripts/setup.py"
curl -sL "$BASE_URL/scripts/fetch_task.py" > "$SKILLS_DIR/scripts/fetch_task.py"
curl -sL "$BASE_URL/scripts/check_tasks.py" > "$SKILLS_DIR/scripts/check_tasks.py"
curl -sL "$BASE_URL/hooks/session-start.sh" > "$SKILLS_DIR/hooks/session-start.sh"

chmod +x "$SKILLS_DIR/scripts/"*.py
chmod +x "$SKILLS_DIR/hooks/session-start.sh"

echo ""
echo "Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Restart Claude Code"
echo "  2. Run: /push-tasks setup"
echo "  3. Sign in with your Push account"
echo "  4. Start capturing voice tasks on your iPhone!"
echo ""
echo "Learn more: https://pushto.do"
