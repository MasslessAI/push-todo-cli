---
description: Show pending voice tasks from Push iOS app
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# Push Voice Tasks

This command fetches and displays your pending voice tasks from the Push iOS app.

## Usage

- `/push-tasks` - Show the next pending task
- `/push-tasks all` - Show all pending tasks
- `/push-tasks setup` - Configure your Push connection

## Instructions

When this command is invoked:

1. **Check for setup**: First verify the config exists:
   ```bash
   test -f ~/.config/push/config && echo "configured" || echo "not configured"
   ```

2. **If not configured**: Run the setup flow:
   ```bash
   python3 ~/.claude/skills/push-tasks/scripts/setup.py
   ```

3. **If configured**: Fetch tasks:
   ```bash
   source ~/.config/push/config && python3 ~/.claude/skills/push-tasks/scripts/fetch_task.py
   ```

4. Present the tasks and ask which one to work on

5. When user selects a task, mark it as started and begin working

## What is Push?

Push is a voice-powered todo app for iOS. Users capture tasks by speaking on their phone, and those tasks sync to Claude Code for implementation.

Learn more: https://pushto.do
