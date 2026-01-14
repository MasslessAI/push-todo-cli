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
fetch_task.py [--all] [--refresh] [--json]
  --all       Show all pending tasks (default: first task only)
  --refresh   Force refresh from API (bypass cache)
  --json      Output raw JSON format
```

## Fetching Tasks

When the user wants to see their tasks, run:

```bash
source ~/.config/push/config && python3 ~/.claude/skills/push-todo/scripts/fetch_task.py
```

This returns a list of pending tasks. Present them clearly:

```
You have N pending tasks from Push:

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
- `project_hint`: Which project this relates to (e.g., "Push", "AppleWhisper")
- `created_at`: When the task was captured

## Error Handling

If the API returns an error:
- Check if PUSH_API_KEY is set in ~/.config/push/config
- Suggest: "Run `/push-todo setup` to configure your Push connection"
