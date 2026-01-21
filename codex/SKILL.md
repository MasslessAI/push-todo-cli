---
name: push-todo
description: |
  Fetch and work on coding tasks captured via voice on the Push iOS app.

  Activate this skill when the user mentions:
  - "Push tasks" or "Push notes" or "Push queue"
  - "Tasks from my phone" or "phone tasks"
  - "Voice notes I captured" or "what did I record"
  - "My voice tasks" or "voice memos"
---

# Push Voice Tasks (OpenAI Codex)

Help the user work on coding tasks they captured via voice on their iPhone.

## Overview

Push is a voice-powered todo app. Users capture coding tasks by speaking on their phone, then work on them later in Codex. This skill fetches those tasks and helps complete them.

## Fetching Tasks

When the user wants to see their tasks, run:

```bash
source ~/.config/push/config && python3 ~/.codex/skills/push-todo/scripts/fetch_task.py
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
   python3 ~/.codex/skills/push-todo/scripts/fetch_task.py --mark-started TASK_ID
   ```

2. Read the full task details from the script output

3. If project_hint is provided, look for that project's context files

4. Begin working on the task immediately

## Completing a Task

When the task is done:

```bash
python3 ~/.codex/skills/push-todo/scripts/fetch_task.py --mark-completed TASK_ID
```

Confirm to the user: "Task marked as complete in Push"

## Connect Mode

When `$push-todo connect` is invoked or API key is missing:

1. Run the connect script:
   ```bash
   python3 ~/.codex/skills/push-todo/scripts/connect.py
   ```

2. This opens a browser for Sign in with Apple authentication

3. Once complete, the API key is automatically saved

## Task Fields

Each task includes:
- `id`: UUID for API calls
- `summary`: Brief description (AI-generated from voice)
- `content`: Full normalized content from voice note
- `transcript`: Original voice transcript (if user wants raw input)
- `project_hint`: Which project this relates to
- `created_at`: When the task was captured

## Error Handling

If the API returns an error:
- Check if PUSH_API_KEY is set in ~/.config/push/config
- Suggest: "Run `$push-todo connect` to configure your Push connection"
