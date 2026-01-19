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

The user can explicitly request all projects by saying:
- "Show me tasks from all projects"
- "Check all my projects"
- "Show tasks across all projects"

When user explicitly asks for all projects, use the `--all-projects` flag.

## Architecture: Always Fresh

**Version 4.0:** This skill always fetches fresh data from Supabase. No caching.

| Step | Script | What Happens | Latency |
|------|--------|--------------|---------|
| **Session start** | `check_tasks.py` | Fetches task count from API | ~500ms |
| **User runs /push-todo** | `fetch_task.py` | Fetches fresh tasks from API | ~500ms |

This ensures you always see the latest state from the Push app.

### CLI Options
```bash
fetch_task.py [TASK_NUMBER] [--all-projects] [--pinned] [--json] [--mark-completed ID]
  TASK_NUMBER       Fetch a specific task by number (e.g., 5 or #5) - fast direct lookup
  --all-projects    Show tasks from ALL projects (not just current)
  --pinned          Only show pinned (focused) tasks
  --json            Output raw JSON format
  --mark-completed  Mark a task as completed by UUID
```

### Direct Task Lookup (Fast Path)

When the user specifies a task number directly (e.g., `/push-todo 5` or `/push-todo #427`):

1. **Script fetches immediately** - No project filtering, no list scanning
2. **API call goes directly** - Uses `?display_number=N` query param
3. **Returns single task** - Ready to work on instantly

This is the fastest path - use it when the user knows their task number.

## Fetching Tasks

When the user wants to see their tasks, run:

```bash
# Fetch all tasks for current project
python3 "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/fetch_task.py"

# Fetch a specific task by number (fast direct lookup)
python3 "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/fetch_task.py" 427
python3 "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/fetch_task.py" "#427"
```

Note: The script reads the API key from `~/.config/push/config` automatically.

This returns all active tasks for the current project. Present them using the **global display number** (same as shown in the Push app):

```
You have N active tasks from Push:

#427 📌 **[Summary]**
   Details: [First 200 chars of content]

#351 **[Summary]**
   Details: ...

Which task would you like to work on? (Use #N to reference, e.g., /push-todo 427)
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
python3 "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/fetch_task.py" --mark-completed TASK_ID
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

## Setup Mode (Doctor Flow)

When `/push-todo setup` is invoked, run a comprehensive health check. This is the ONE command users need to run - it handles everything.

### Full Doctor Flow

Execute these steps **in order**. Stop early if a critical issue needs user action.

#### Step 1: Check Plugin Version

```bash
python3 "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/setup.py" --check-version
```

> **Note:** `$CLAUDE_PLUGIN_ROOT` is set by Claude Code to the plugin's directory. Falls back to `~/.claude/skills/push-todo` for development.

**JSON Response:**
```json
{
  "status": "up_to_date" | "update_available" | "unknown",
  "local_version": "1.2.6",
  "remote_version": "1.3.0",
  "message": "Update available: 1.2.6 → 1.3.0"
}
```

**If `update_available`:**
1. Tell the user: "A new version of the Push plugin is available (1.2.6 → 1.3.0). Would you like me to update?"
2. **Wait for user confirmation** (semantic response like "yes", "sure", "go ahead")
3. If confirmed, run update:
   ```bash
   python3 "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/setup.py" --update
   ```
4. Handle update result:
   - `"status": "success"` → Continue to Step 2
   - `"status": "manual_required"` → Tell user to run the command in `"command"` field, also mention the `"hint"` for enabling auto-updates, then continue
   - `"status": "failed"` → Warn user, but continue
   - `"status": "skipped"` → Continue silently (marketplace with auto-update ON, or development installs)

**If `up_to_date` or `unknown`:** Continue silently.

#### Step 2: Validate API Key

```bash
python3 "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/setup.py" --validate-key
```

**JSON Response:**
```json
{
  "status": "valid" | "invalid" | "revoked" | "missing" | "error",
  "message": "API key is valid",
  "email": "user@example.com"
}
```

**If `missing` or `invalid` or `revoked`:**
1. Tell the user: "Your Push connection needs to be set up. I'll open a browser for Sign in with Apple."
2. Run full setup (opens browser):
   ```bash
   python3 "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/setup.py"
   ```
3. After auth completes, continue to Step 3.

**If `valid`:** Continue to Step 3 with existing credentials.

**If `error`:** Warn user about network issue, but continue.

#### Step 3: Register Project with Keywords

1. **Read CLAUDE.md** to understand the project context

2. **Generate keywords** - Extract 5-15 relevant keywords:
   - Project name and aliases
   - Key technologies (e.g., "swift", "swiftui", "supabase")
   - Domain terms (e.g., "voice", "todo", "sync")
   - Keep keywords lowercase, comma-separated

3. **Generate description** - Concise 1-sentence (<100 chars)

4. **Run setup with generated values**:
   ```bash
   python3 "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/setup.py" \
     --keywords "keyword1,keyword2,keyword3" \
     --description "Short project description"
   ```

**Example for Push project:**
```bash
python3 "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/setup.py" \
  --keywords "push,voice,todo,whisper,ios,swift,swiftui,swiftdata,cloudkit,realtime,supabase" \
  --description "Voice-powered todo app for iOS with realtime sync"
```

### Why This Matters

- **Version check:** Ensures users have latest bug fixes
- **API validation:** Catches revoked keys before tasks fail
- **Keywords:** Help AI route voice tasks to the correct project

Users only need to remember one command: `/push-todo setup`

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

## Updates

Updates are handled via the doctor flow in `/push-todo setup`.

### User Installation Types

| Installation Type | Update Method | Doctor Flow Behavior |
|-------------------|---------------|---------------------|
| **Marketplace (auto-update ON)** | Automatic | Skips silently |
| **Marketplace (auto-update OFF)** | `claude plugin update push-todo@push-claude-plugin` | Shows command + hint to enable auto-update |
| **Legacy (curl)** | Re-runs install script | Runs automatically |

> **Note:** "Development" installs (symlinks) are internal only for plugin maintainers, not a user scenario.

**How we detect marketplace auto-update status:**
The setup script reads `~/.claude/plugins/known_marketplaces.json` and checks the `autoUpdate` field for our marketplace. Third-party marketplaces default to auto-update OFF.

**Important:** Claude Code does NOT notify users about updates when auto-update is disabled. The doctor flow fills this gap by checking versions and guiding users to update.

**Manual update check:**
```bash
python3 "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/setup.py" --check-version
python3 "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/setup.py" --update
```

## Error Handling

If the API returns an error:
- Check if PUSH_API_KEY is set in ~/.config/push/config
- Suggest: "Run `/push-todo setup` to configure your Push connection"
