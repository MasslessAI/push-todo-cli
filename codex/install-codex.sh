#!/bin/bash
# Install Push Tasks skill for OpenAI Codex

set -e

echo "Installing Push Tasks for OpenAI Codex..."

CODEX_DIR="$HOME/.codex"
SKILLS_DIR="$CODEX_DIR/skills/push-todo"
AGENTS_FILE="$CODEX_DIR/AGENTS.md"

# Create directories
mkdir -p "$SKILLS_DIR/scripts"

# Download files from GitHub
BASE_URL="https://raw.githubusercontent.com/MasslessAI/push-claude-plugin/main"

echo "Downloading skill files..."
curl -sL "$BASE_URL/codex/SKILL.md" > "$SKILLS_DIR/SKILL.md"
curl -sL "$BASE_URL/plugins/push-todo/scripts/setup.py" > "$SKILLS_DIR/scripts/setup.py"
curl -sL "$BASE_URL/plugins/push-todo/scripts/fetch_task.py" > "$SKILLS_DIR/scripts/fetch_task.py"
curl -sL "$BASE_URL/plugins/push-todo/scripts/check_tasks.py" > "$SKILLS_DIR/scripts/check_tasks.py"

chmod +x "$SKILLS_DIR/scripts/"*.py

# Add bootstrap to AGENTS.md
BOOTSTRAP='
## Push Tasks Integration

At the start of each session, check for pending tasks:
```bash
source ~/.config/push/config 2>/dev/null && python3 ~/.codex/skills/push-todo/scripts/check_tasks.py 2>/dev/null
```
If tasks > 0, inform: "You have X task(s) from Push. Type $push-todo to see them."
'

if [ -f "$AGENTS_FILE" ]; then
    if ! grep -q "Push Tasks Integration" "$AGENTS_FILE"; then
        echo "$BOOTSTRAP" >> "$AGENTS_FILE"
        echo "Added Push bootstrap to existing AGENTS.md"
    else
        echo "Push bootstrap already exists in AGENTS.md"
    fi
else
    echo "$BOOTSTRAP" > "$AGENTS_FILE"
    echo "Created AGENTS.md with Push bootstrap"
fi

echo ""
echo "Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Run: \$push-todo setup"
echo "  2. Sign in with your Push account"
echo "  3. Start capturing voice tasks on your iPhone!"
echo ""
echo "Learn more: https://pushto.do"
