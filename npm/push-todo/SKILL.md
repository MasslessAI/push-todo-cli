---
description: Show active voice tasks from Push iOS app
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# Push Voice Tasks

This command fetches and displays your active voice tasks from the Push iOS app.

## Usage

- `/push-todo` - Show active tasks for current project
- `/push-todo #427` - Jump directly to task #427
- `/push-todo review` - Review existing tasks and mark completed ones
- `/push-todo setup` - Configure your Push connection

> **Note:** To see tasks from all projects, ask explicitly: "show tasks from all projects"

## Instructions

When this command is invoked:

1. **Check for setup**: First verify the config exists:
   ```bash
   test -f ~/.config/push/config && echo "configured" || echo "not configured"
   ```

2. **If not configured**: Run the setup flow (see [Setup Mode](#setup-mode) below)

3. **If configured**: Fetch tasks:
   ```bash
   push-todo
   ```

4. **If no tasks are returned** (output says "No active tasks"): This is **normal and expected** — it means no tasks have been assigned to this project's action yet. Do NOT treat this as an error. Simply tell the user: "No tasks for this project yet. Create tasks in the Push iOS app and assign them to this action." Do NOT spawn diagnostic agents or troubleshoot — empty task lists are the expected state for new or unused actions.

5. **Present ALL tasks** - Do NOT summarize or truncate the list. Show every active task in a table format. Users want to see their complete task list, not a curated subset. If there are 35 tasks, show all 35.

6. Ask which task the user wants to work on

7. **Check if the daemon is currently working on this task:**
   - If the task output shows `**Status:** 🔄 Running`:
     - The daemon is actively working on this task RIGHT NOW
     - Follow the [Live Session Status](#live-session-status) procedure to show progress
     - Do NOT start working on this task — the daemon is already on it
   - If the task output shows `**Status:** ⚡ Queued for Mac execution`:
     - The task is queued and waiting for the daemon to pick it up
     - Tell the user: "This task is queued and will be picked up by the daemon shortly."
     - Do NOT start working on this task

8. **Check for resumable daemon sessions:**
   - If the task output contains `**Session:** Resumable`, the daemon already ran Claude Code on this task
   - Do NOT start working from scratch — automatically load the daemon's session context
   - Follow the [Auto-Resume from Session Transcript](#auto-resume-from-session-transcript) procedure below
   - Only if the session transcript cannot be found should you begin working from scratch

9. **Load task attachments** before starting work:
   - If the task has **screenshot attachments**: Read each image from `~/Library/Mobile Documents/iCloud~ai~massless~push/Documents/Screenshots/<filename>` using the Read tool. These provide essential visual context.
   - If the task has **link attachments**: Use WebFetch to read linked content when relevant to the task.
   - See [Reading Task Attachments](#reading-task-attachments) for full details.

10. If no resumable session exists, begin working on the task normally

## Review Mode

When `/push-todo review` is invoked, use **session context** to identify completed tasks:

### Step 1: Analyze Session Context

First, recall what was worked on in this session (or the previous compacted session):
- What tasks were explicitly mentioned? (e.g., "work on #701")
- What features were implemented or bugs fixed?
- What files were edited and why?

### Step 2: Fetch Pending Tasks

```bash
push-todo --all-projects --json
```

### Step 3: Match Session Work Against Tasks

For each pending task, check if it matches work done in this session:

**Explicit Match**: Task number was mentioned (e.g., "worked on #701")
- These should be marked complete unless work is clearly unfinished

**Implicit Match**: Work done aligns with task content semantically
- Compare task summary/content against session work
- Example: Task says "add review parameter to slash command" and we just added that feature

**No Match**: Task wasn't worked on this session
- Skip these (don't search codebase unnecessarily)

### Step 4: Present Findings

```
## Session Review

Based on this session, I found:

### Completed This Session
- #701 "Add review parameter" - We implemented this feature (explicit)
- #427 "Fix login bug" - We fixed the auth issue in LoginView.swift (implicit match)

### Not Worked On
- #351 "Test on smaller phone" - No related work this session
- #682 "Rework recording overlay" - No related work this session

Should I mark #701 and #427 as completed?
```

### Step 5: Mark Confirmed Tasks

```bash
push-todo --mark-completed TASK_UUID --completion-comment "Completed in Claude Code session"
```

### Step 6: Learn Vocabulary (After Each Completion)

After marking a task complete, contribute vocabulary terms to improve future task routing:

1. **Extract 3-8 keywords from the session context:**
   - File names / class names touched (e.g., `SyncService`, `RealtimeManager`)
   - Technical concepts implemented (e.g., `WebSocket`, `reconnection`, `caching`)
   - Domain-specific terms from the conversation

2. **Call learn-vocabulary:**
   ```bash
   push-todo --learn-vocabulary TASK_UUID --keywords 'term1,term2,term3'
   ```

**Example:** After fixing a sync bug:
```bash
push-todo --learn-vocabulary abc123 --keywords 'SyncService,RealtimeManager,WebSocket,reconnection,realtime'
```

**Why this matters:** These keywords help the AI route future voice todos to the correct project. The more specific the terms, the better the matching.

### Key Principle

**Session context is primary** - don't grep the entire codebase for every task. Use conversation history to identify what was actually worked on, then match against tasks semantically. This catches both:
- Explicit: User said "work on #701" but forgot to mark complete
- Implicit: User fixed something that matches a task they didn't mention

## Setup Mode

When `/push-todo setup` is invoked, generate project-specific keywords BEFORE running the setup script.

### Why Keywords Matter

Keywords help the AI route voice todos to the correct project. Generic keywords like "coding" or "programming" don't differentiate between projects. We need UNIQUE keywords that identify THIS specific project.

### Step 1: Understand the Project

Read the project context to generate meaningful keywords:

1. **Check for CLAUDE.md**:
   ```bash
   test -f CLAUDE.md && echo "found" || echo "not found"
   ```

2. **If CLAUDE.md exists**, read the header section:
   ```bash
   head -80 CLAUDE.md
   ```

3. **If no CLAUDE.md**, check for README.md:
   ```bash
   test -f README.md && head -50 README.md
   ```

### Step 2: Generate Unique Keywords

Based on the project context, generate 5-10 keywords.

**MUST include:**
- Project name and common nicknames users would say
- Domain-specific terms (e.g., "voice todo" for a voice app)
- Distinctive tech if relevant (e.g., "whisper" for speech recognition)

**MUST NOT include (these are useless for differentiation):**
- Generic terms: "coding", "programming", "development"
- Tool terms: "mac", "terminal", "cli", "ai", "task"
- Any term that applies to ALL code projects

**Think:** "What would the user SAY when creating a task for THIS project?"

### Step 3: Generate Description

Generate a short (5-15 words) description that captures what makes this project unique. NOT generic like "coding tasks" or "development work".

### Step 4: Run Setup with Keywords

```bash
push-todo connect --keywords "keyword1,keyword2,keyword3,..." --description "Short unique description"
```

### Examples

**For a voice todo app (Push):**
```bash
push-todo connect --keywords "push,voice,todo,whisper,ios,swiftui,recording,speech,transcription" --description "Voice-powered todo app for iOS with whisper speech recognition"
```

**For a web scraping project:**
```bash
push-todo connect --keywords "scraper,crawler,beautifulsoup,selenium,extraction,parsing" --description "Web scraping tool for data extraction"
```

**For a game engine:**
```bash
push-todo connect --keywords "engine,graphics,rendering,physics,ecs,vulkan,gamedev" --description "Custom game engine with Vulkan renderer"
```

### Fallback (No Documentation)

If no CLAUDE.md or README.md exists, generate minimal keywords from:
- Folder name
- Git repo name
- Primary file extensions (`.swift` -> iOS, `.py` -> Python, `.rs` -> Rust)

## Auto-Resume from Daemon Session

When a task has a resumable daemon session, use the git worktree branch directly instead of starting from scratch. The daemon commits its changes to a worktree branch — use that branch to see exactly what was done.

### Step 1: Find the Worktree Branch

The daemon creates a branch named `push-{number}-{suffix}`:

```bash
# Get machine ID suffix
MACHINE_ID=$(cat ~/.config/push/machine_id 2>/dev/null)
SUFFIX=$(echo "$MACHINE_ID" | rev | cut -d'-' -f1 | rev | cut -c1-8)
TASK_NUM=<display_number>
BRANCH="push-${TASK_NUM}-${SUFFIX}"

# Check if branch exists and has commits
git log master..${BRANCH} --oneline 2>/dev/null
```

### Step 2: Get Semantic Summary from Session Transcript

Read the session transcript for context on *what* and *why* (reasoning, decisions):

```bash
SESSION_DIR="$HOME/.claude/projects/-Users-$(whoami)-projects-push-${TASK_NUM}-${SUFFIX}"
SESSION_ID=<session_id_from_task>

# Extract just the text reasoning (not file edits — we get those from git)
cat "${SESSION_DIR}/${SESSION_ID}.jsonl" 2>/dev/null | node -e "
const lines = [];
process.stdin.on('data', d => lines.push(d));
process.stdin.on('end', () => {
  const entries = Buffer.concat(lines).toString().split('\n')
    .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const texts = entries.filter(e => e.type === 'assistant')
    .flatMap(a => (a.message?.content || []).filter(b => b.type === 'text' && b.text.trim()).map(b => b.text.trim()));
  texts.forEach(t => console.log(t));
});
"
```

### Step 3: Review Changes and Act

1. **Show the user** what the daemon did: semantic summary + `git diff master...${BRANCH}`
2. **If the branch has commits** (daemon committed):
   - Show the diff and ask if user wants to cherry-pick/merge to current branch
   - Use `git cherry-pick <commit>` or `git merge ${BRANCH}` as appropriate
3. **If the branch has NO commits** (daemon didn't commit — older daemon versions):
   - Fall back to reading edits from the session transcript JSONL
4. **If work is incomplete**, continue from where the daemon left off using the context from the transcript and the branch state

## Live Session Status

When a task is currently running (daemon is actively working on it), read the live session transcript to show the user what's happening.

### Step 1: Locate the Live Session File

The daemon runs Claude in a git worktree. Find the active session:

```bash
# Get machine ID suffix for worktree name
MACHINE_ID=$(cat ~/.config/push/machine_id 2>/dev/null)
SUFFIX=$(echo "$MACHINE_ID" | rev | cut -d'-' -f1 | rev | cut -c1-8)
TASK_NUM=<display_number>

# Session files are stored under ~/.claude/projects/ with path-encoded directory names
SESSION_DIR="$HOME/.claude/projects/-Users-$(whoami)-projects-push-${TASK_NUM}-${SUFFIX}"

# Find the most recent .jsonl file (the active session)
ls -t "${SESSION_DIR}"/*.jsonl 2>/dev/null | head -1
```

### Step 2: Extract Recent Activity

Read the last portion of the JSONL transcript to see what Claude is currently doing:

```bash
tail -100 "<session_file>" | node -e "
const lines = [];
process.stdin.on('data', d => lines.push(d));
process.stdin.on('end', () => {
  const entries = Buffer.concat(lines).toString().split('\n')
    .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const assistantMsgs = entries.filter(e => e.type === 'assistant');
  const edits = [];
  const reads = [];
  const texts = [];

  assistantMsgs.forEach(a => {
    (a.message?.content || []).forEach(b => {
      if (b.type === 'text' && b.text.trim()) texts.push(b.text.trim());
      if (b.type === 'tool_use') {
        if (b.name === 'Edit' || b.name === 'Write') edits.push(b.input?.file_path);
        if (b.name === 'Read') reads.push(b.input?.file_path);
      }
    });
  });

  console.log('FILES_READ:', JSON.stringify([...new Set(reads)].slice(-10)));
  console.log('FILES_EDITED:', JSON.stringify([...new Set(edits)]));
  console.log('---RECENT_ACTIVITY---');
  texts.slice(-5).forEach(t => console.log(t.slice(0, 200)));
  console.log('---END---');
});
"
```

### Step 3: Present Status to User

Show a concise summary:
1. "The daemon is currently working on this task"
2. Files it has read so far
3. Files it has edited so far
4. Its most recent reasoning/activity (last few text messages)
5. "Check back in a few minutes, or run `/push-todo <number>` again for an update"

Do NOT offer to start working on the task — the daemon is already handling it.

### Fallback

If the session file cannot be found (daemon just started, no output yet):
- Tell the user: "The daemon just started working on this task. Run `/push-todo <number>` again in a minute for a progress update."

## Reading Task Attachments

Tasks can have **screenshot images** and **reference links** attached. When working on a task, always check for and use these attachments — they provide critical visual and reference context.

### Screenshot Attachments

Screenshots are images captured from the user's phone screen when creating the task. They're stored in **iCloud Documents** and synced to the Mac automatically.

**When the task output shows an Attachments > Screenshots section:**

1. **Get the filename** from the task output (e.g., `ABC123.png`)
2. **Read the image** directly from the iCloud folder:
   ```
   ~/Library/Mobile Documents/iCloud~ai~massless~push/Documents/Screenshots/<filename>
   ```
3. **Use the Read tool** to view the image — Claude Code is multimodal and can interpret screenshots

Example:
```bash
# The task shows: "1. ABC123.png (1170x2532)"
# Read it directly:
```
Then use the Read tool on:
`~/Library/Mobile Documents/iCloud~ai~massless~push/Documents/Screenshots/ABC123.png`

**Why this matters:** Screenshots often contain the actual UI, error message, design mockup, or reference material the user was looking at when they created the task. The voice transcript alone may say "fix this" — the screenshot shows WHAT to fix.

**If the file doesn't exist locally:** iCloud may not have synced it yet. Tell the user: "The screenshot hasn't synced from iCloud yet. Try opening Finder > iCloud Drive > Push > Screenshots to trigger the download."

### Link Attachments

Links are reference URLs the user shared when creating the task (e.g., from Safari, WeChat, or other apps).

**When the task output shows an Attachments > Links section:**

1. Links are displayed as clickable markdown: `🔗 [Title](URL)`
2. **Use WebFetch** to read the linked content when relevant to the task
3. The `contextApp` field shows which app the link came from (e.g., "Safari", "WeChat")

### Programmatic Access (JSON mode)

For scripts or when you need raw attachment data:
```bash
push-todo <number> --json
```

Key JSON fields:
- `screenshotAttachmentsJson` — JSON string array of `{id, imageFilename, width, height, capturedAt, sourceApp}`
- `linkAttachmentsJson` — JSON string array of `{id, url, title, createdAt}`
- `contextApp` — App the user was in when creating the task

## CLI Reference

The `push-todo` CLI supports these commands:

| Command | Description |
|---------|-------------|
| `push-todo` | List active tasks for current project |
| `push-todo <number>` | Show specific task (e.g., `push-todo 427`) |
| `push-todo --all-projects` | List tasks from all projects |
| `push-todo --backlog` | Show backlog items |
| `push-todo --resume <number>` | Resume the daemon's Claude Code session for a task |
| `push-todo connect` | Run connection diagnostics and setup |
| `push-todo search <query>` | Search tasks |
| `push-todo --status` | Show connection status |
| `push-todo --mark-completed <uuid>` | Mark task as completed |
| `push-todo --json` | Output as JSON |

## What is Push?

Push is a voice-powered todo app for iOS. Users capture tasks by speaking on their phone, and those tasks sync to Claude Code for implementation.

Learn more: https://pushto.do
