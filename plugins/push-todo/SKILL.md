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

## Architecture: Always Fresh

**Version 4.0:** This skill always fetches fresh data from Supabase. No caching.

| Step | Script | What Happens | Latency |
|------|--------|--------------|---------|
| **Session start** | `check_tasks.py` | Fetches task count from API | ~500ms |
| **User runs /push-todo** | `fetch_task.py` | Fetches fresh tasks from API | ~500ms |

This ensures you always see the latest state from the Push app.

### CLI Options
```bash
fetch_task.py [--all] [--all-projects] [--pinned] [--json] [--mark-completed ID]
  --all             Show all active tasks for current project (default: first task only)
  --all-projects    Show tasks from ALL projects (not just current)
  --pinned          Only show pinned (focused) tasks
  --json            Output raw JSON format
  --mark-completed  Mark a task as completed by UUID
```

## Fetching Tasks

When the user wants to see their tasks, run:

```bash
python3 ~/.claude/skills/push-todo/scripts/fetch_task.py
```

Note: The script reads the API key from `~/.config/push/config` automatically.

This returns a list of active tasks. Present them using the **global display number** (same as shown in the Push app):

```
You have N active tasks from Push:

#427 📌 **[Summary]**
   Details: [First 200 chars of content]

#351 **[Summary]**
   Details: ...

Which task would you like to work on? (Use #N to reference)
```

**IMPORTANT:** Always reference tasks by their global number (`#427`, `#351`, etc.), never by relative position (1st, 2nd). This ensures consistency between the Push app and Claude Code.

## Starting a Task

When the user selects a task (e.g., "#427" or "work on 427"):

1. Find the task by its display number from the fetched list

2. Read the full task details from the script output

3. If project_hint is provided, look for that project's CLAUDE.md

4. Begin working on the task immediately

Note: Users reference tasks by their global number (`#427`), which maps to the task's UUID for API calls.

## Completing a Task

When the task is done:

```bash
python3 ~/.claude/skills/push-todo/scripts/fetch_task.py --mark-completed TASK_ID
```

Confirm to the user: "Task marked as complete in Push"

## Reviewing Tasks

When the user runs `/push-todo review`, use **session context** to find completed tasks:

1. **Analyze session context** - Recall what was worked on:
   - Explicitly mentioned tasks (e.g., "work on #701")
   - Features implemented or bugs fixed
   - Files edited and why

2. **Fetch pending tasks** with `--all --json` flag

3. **Match session work against tasks**:
   - **Explicit**: Task number was mentioned → mark complete
   - **Implicit**: Work done matches task content semantically → suggest completion
   - **No match**: Skip (don't search codebase unnecessarily)

4. **Present findings** - Show explicit and implicit matches

5. **Mark confirmed tasks** using `--mark-completed`

**Key insight**: Session context is primary. Don't grep the codebase for every task - use conversation history to identify what was actually worked on. This catches both:
- User said "work on #701" but forgot to mark complete
- User fixed something that matches a task they didn't mention

## Setup Mode

When `/push-todo setup` is invoked or API key is missing:

### First-Time Setup (No API Key)

1. Run the setup script without arguments:
   ```bash
   python3 ~/.claude/skills/push-todo/scripts/setup.py
   ```

2. This opens a browser for Sign in with Apple authentication

3. Once complete, the API key is automatically saved

### Project Registration (API Key Exists)

When the user runs `/push-todo setup` in a project that's already authenticated:

1. **Read CLAUDE.md** to understand the project context

2. **Generate keywords** - Extract 5-15 relevant keywords from CLAUDE.md:
   - Project name and aliases
   - Key technologies (e.g., "swift", "swiftui", "supabase")
   - Domain terms (e.g., "voice", "todo", "sync")
   - Keep keywords lowercase, comma-separated

3. **Generate description** - Create a concise 1-sentence description:
   - What the project does
   - Keep under 100 characters

4. **Run setup with generated values**:
   ```bash
   python3 ~/.claude/skills/push-todo/scripts/setup.py \
     --keywords "keyword1,keyword2,keyword3" \
     --description "Short project description"
   ```

**Example for Push project:**
```bash
python3 ~/.claude/skills/push-todo/scripts/setup.py \
  --keywords "push,voice,todo,whisper,ios,swift,swiftui,swiftdata,cloudkit,realtime,supabase" \
  --description "Voice-powered todo app for iOS with realtime sync"
```

**Why keywords matter:** These keywords help the AI match voice tasks to the correct project. When a user says "add dark mode to Push", the AI uses keywords to route the task to the right action.

## Task Fields

Each task includes:
- `display_number`: **Global task number** (e.g., 427) - use this to reference tasks (`#427`)
- `id`: UUID for API calls (used internally for mark-completed)
- `summary`: Brief description (AI-generated from voice)
- `content`: Full normalized content from voice note
- `transcript`: Original voice transcript (if user wants raw input)
- `project_hint`: Human-readable project name (e.g., "Push", "AppleWhisper")
- `git_remote`: Normalized git remote URL for project scoping (e.g., "github.com/user/repo")
- `is_focused`: Boolean indicating if the task is pinned/focused (prioritized)
- `created_at`: When the task was captured

**Global Numbers:** Every task has a permanent `display_number` that matches the Push app. Always use `#N` format when referencing tasks.

**Pinned Tasks:** Tasks marked as pinned in the Push app will appear with a 📌 indicator and are automatically sorted to the top of the list. Use `--pinned` to filter to only pinned tasks.

## Auto-Updates

The plugin auto-updates by default at each session start:

| Behavior | When |
|----------|------|
| Silent | Plugin is up-to-date |
| Auto-update | Newer version available (default behavior) |
| Manual prompt | Auto-update failed (e.g., local changes) |

**Telemetry output:**
```
[Push] Plugin updated: v1.1.0 → v1.2.0      # Auto-update succeeded
[Push] Update available: v1.1.0 → v1.2.0    # Manual update needed
```

**Disable auto-updates (opt-out):**
```bash
export PUSH_PLUGIN_AUTO_UPDATE=false
```

## Error Handling

If the API returns an error:
- Check if PUSH_API_KEY is set in ~/.config/push/config
- Suggest: "Run `/push-todo setup` to configure your Push connection"
