#!/bin/bash
# Install Push Tasks plugin for Claude Code

set -e

echo ""
echo "Installing Push Tasks plugin for Claude Code..."
echo ""

# Check if Claude Code is installed
if ! command -v claude &> /dev/null; then
    echo "Error: Claude Code is not installed."
    echo ""
    echo "Install Claude Code first:"
    echo "  curl -fsSL https://claude.ai/install.sh | bash"
    echo ""
    echo "Then run this installer again."
    exit 1
fi

# Add marketplace
echo "Adding Push marketplace..."
claude plugin marketplace add MasslessAI/push-todo-cli 2>/dev/null || true

# Install plugin
echo "Installing push-todo plugin..."
claude plugin install push-todo@push-todo-cli

echo ""
echo "Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Restart Claude Code"
echo "  2. Run: /push-todo connect"
echo ""
echo "Learn more: https://pushto.do"
