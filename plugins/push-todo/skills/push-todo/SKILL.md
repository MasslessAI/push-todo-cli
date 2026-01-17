---
name: push-todo
description: |
  Fetch and work on coding tasks captured via voice on the Push iOS app.

  Activate this skill when the user mentions:
  - "Push tasks" or "Push notes" or "Push queue"
  - "Tasks from my phone" or "phone tasks"
  - "Voice notes I captured" or "what did I record"
  - "My voice tasks" or "voice memos"
  - Following up on "[Push]" notification
---

# Push Voice Tasks

Help the user work on coding tasks they captured via voice on their iPhone.

## Overview

Push is a voice-powered todo app. Users capture coding tasks by speaking on their phone, then work on them later in Claude Code. This skill fetches those tasks and helps complete them.

## Project Scoping (Default Behavior)

**By default, only tasks for the CURRENT PROJECT are shown** (based on git remote URL).

| Scenario | Behavior |
|----------|----------|
| In a git repo | Only shows tasks assigned to this repo |
| Not in a git repo | Shows all tasks |
| User wants all tasks | Use `--all-projects` flag |

This means running `/push-todo` in different projects shows different tasks automatically.

### IMPORTANT: No Automatic Fallback

**DO NOT automatically check other projects when there are no tasks for the current project.**

When the script returns "No active tasks for this project":
- Just tell the user: "No active tasks for this project."
- **DO NOT** automatically run `--all-projects` to check other projects
- **DO NOT** offer to check other projects unless the user explicitly asks

The user can explicitly request all projects with:
- `/push-todo all` (with `--all-projects` flag)
- "Show me tasks from all projects"
- "Check other projects"

## Architecture: Two-Call Caching System

For fast response times, this skill uses a prefetch + cache architecture:

| Step | Script | What Happens | Latency |
|------|--------|--------------|---------|
| **Session start** | `check_tasks.py` | Fetches all tasks from API, caches locally, outputs count | ~1s (network) |
| **User runs /push-todo** | `fetch_task.py` | Reads from cache instantly | ~70ms |

### Cache Details
- **Location:** `~/.config/push/cache/tasks.json`
- **Max age:** 5 minutes (auto-refreshes if stale)
- **Invalidation:** Tasks removed from cache when marked started/completed
- **Fallback:** If API fails, shows stale cache; if cache missing, fetches from API

### CLI Options
```bash
fetch_task.py [--all] [--all-projects] [--pinned] [--refresh] [--json]
  --all           Show all active tasks for current project (default: first task only)
  --all-projects  Show tasks from ALL projects (not just current)
  --pinned        Only show pinned (focused) tasks
  --refresh       Force refresh from API (bypass cache)
  --json          Output raw JSON format
```

## Fetching Tasks

When the user wants to see their tasks, run:

```bash
python3 ~/.claude/skills/push-todo/scripts/fetch_task.py
```

Note: The script reads the API key from `~/.config/push/config` automatically.

This returns a list of active tasks. Present them clearly:

```
You have N active tasks from Push:

1. **[Summary]**
   Project: [project_hint or "Not specified"]
   Details: [First 200 chars of content]

2. **[Summary]**
   ...

Which task would you like to work on?
```

## Starting a Task

When the user selects a task:

1. Mark it as started:
   ```bash
   python3 ~/.claude/skills/push-todo/scripts/fetch_task.py --mark-started TASK_ID
   ```

2. Read the full task details from the script output

3. If project_hint is provided, look for that project's CLAUDE.md

4. Begin working on the task immediately

## Completing a Task

When the task is done:

```bash
python3 ~/.claude/skills/push-todo/scripts/fetch_task.py --mark-completed TASK_ID
```

Confirm to the user: "Task marked as complete in Push"

## Setup Mode

When `$push-todo setup` is invoked or API key is missing:

1. Run the setup script:
   ```bash
   python3 ~/.claude/skills/push-todo/scripts/setup.py
   ```

2. This opens a browser for Sign in with Apple authentication

3. Once complete, the API key is automatically saved

## Task Fields

Each task includes:
- `id`: UUID for API calls
- `summary`: Brief description (AI-generated from voice)
- `content`: Full normalized content from voice note
- `transcript`: Original voice transcript (if user wants raw input)
- `project_hint`: Human-readable project name (e.g., "Push", "AppleWhisper")
- `git_remote`: Normalized git remote URL for project scoping (e.g., "github.com/user/repo")
- `is_focused`: Boolean indicating if the task is pinned/focused (prioritized)
- `created_at`: When the task was captured

**Pinned Tasks:** Tasks marked as pinned in the Push app will appear with a 📌 indicator and are automatically sorted to the top of the list. Use `--pinned` to filter to only pinned tasks.

## Auto-Updates

The plugin checks for updates from GitHub at each session start:

| Behavior | When |
|----------|------|
| Silent | Plugin is up-to-date |
| Notification | Newer version available on GitHub |
| Auto-update | `PUSH_PLUGIN_AUTO_UPDATE=true` is set |

**Update notification example:**
```
[Push] Update available: push-todo v1.0.0 → v1.1.0
[Push] Run: cd ~/.claude/skills/push-todo && git pull
```

**Enable auto-updates:**
```bash
export PUSH_PLUGIN_AUTO_UPDATE=true
```

## Error Handling

If the API returns an error:
- Check if PUSH_API_KEY is set in ~/.config/push/config
- Suggest: "Run `/push-todo setup` to configure your Push connection"
