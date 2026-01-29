---
description: Show active voice tasks from Push iOS app
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# Push Voice Tasks

This command fetches and displays your active voice tasks from the Push iOS app.

## Usage

- `/push-todo` - Show active tasks for current project
- `/push-todo 427` - Jump directly to task #427
- `/push-todo login` - Search for tasks matching "login"
- `/push-todo fix the auth bug` - Search for tasks matching those words
- `/push-todo review` - Review existing tasks and mark completed ones
- `/push-todo connect` - Configure your Push connection

> **Note:** To see tasks from all projects, ask explicitly: "show tasks from all projects"

## Smart Input Detection (IMPORTANT)

When `/push-todo <something>` is invoked, **detect the user's intent automatically**:

| Input | Detection | Action |
|-------|-----------|--------|
| `427` or `#427` | Looks like a number | Direct task lookup |
| `login` | Single word, not a number | Search for "login" |
| `fix the bug` | Multiple words | Search for "fix the bug" |
| `review` | Reserved keyword | Run review mode |
| `connect` | Reserved keyword | Run connect mode |
| `status` | Reserved keyword | Show status |
| `watch` | Reserved keyword | Watch daemon |
| `setting` | Reserved keyword | Show settings |

**Reserved keywords:** `review`, `connect`, `status`, `watch`, `setting`, `commands`

**The agent should infer intent** - users shouldn't need to type explicit "search" keyword. If the input is:
- A number → fetch that task directly
- Words (not a reserved keyword) → search for tasks matching those words

### Examples of Smart Detection

```
/push-todo 701          → Fetch task #701
/push-todo authentication → Search for "authentication"
/push-todo realtime sync  → Search for "realtime sync"
/push-todo review        → Run review mode (reserved)
```

## Instructions

When this command is invoked:

1. **Check for connect**: First verify the config exists:
   ```bash
   test -f ~/.config/push/config && echo "configured" || echo "not configured"
   ```

2. **If not configured**: Run the connect flow (see [Connect Mode](#connect-mode) below)

3. **Parse the input** after `/push-todo`:
   - If empty → fetch all active tasks
   - If reserved keyword (`review`, `connect`, etc.) → run that mode
   - If looks like a number → direct task lookup
   - If looks like words → search for matching tasks

4. **For task list**: Present tasks and ask which one to work on

5. **For search results**: Show matching tasks (active first, then completed)

6. When user selects a task, begin working on it

## Search Behavior

When the input looks like search terms (words, not a number):

```bash
python3 ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/fetch_task.py --search "the words"
```

**Search features:**
- Searches BOTH active AND completed tasks
- Active tasks appear first in results
- Searches across: title, summary, content, voice transcript
- Shows match context snippets
- Use `--all-projects` for cross-project search

## Review Mode

When `/push-todo review` is invoked, use **session context** to identify completed tasks:

### Step 1: Analyze Session Context

First, recall what was worked on in this session (or the previous compacted session):
- What tasks were explicitly mentioned? (e.g., "work on #701")
- What features were implemented or bugs fixed?
- What files were edited and why?

### Step 2: Fetch Pending Tasks

```bash
source ~/.config/push/config && python3 ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/fetch_task.py --all --json
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

### ✅ Completed This Session
- #701 "Add review parameter" - We implemented this feature (explicit)
- #427 "Fix login bug" - We fixed the auth issue in LoginView.swift (implicit match)

### ❓ Not Worked On
- #351 "Test on smaller phone" - No related work this session
- #682 "Rework recording overlay" - No related work this session

Should I mark #701 and #427 as completed?
```

### Step 5: Mark Confirmed Tasks

```bash
python3 ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/fetch_task.py --mark-completed TASK_UUID
```

### Key Principle

**Session context is primary** - don't grep the entire codebase for every task. Use conversation history to identify what was actually worked on, then match against tasks semantically. This catches both:
- Explicit: User said "work on #701" but forgot to mark complete
- Implicit: User fixed something that matches a task they didn't mention

## Connect Mode

When `/push-todo connect` is invoked, generate project-specific keywords BEFORE running the connect script.

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

### Step 4: Run Connect with Keywords

```bash
python3 ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/connect.py \
  --keywords "keyword1,keyword2,keyword3,..." \
  --description "Short unique description of this project"
```

### Examples

**For a voice todo app (Push):**
```bash
python3 ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/connect.py \
  --keywords "push,voice,todo,whisper,ios,swiftui,recording,speech,transcription" \
  --description "Voice-powered todo app for iOS with whisper speech recognition"
```

**For a web scraping project:**
```bash
python3 ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/connect.py \
  --keywords "scraper,crawler,beautifulsoup,selenium,extraction,parsing" \
  --description "Web scraping tool for data extraction"
```

**For a game engine:**
```bash
python3 ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/connect.py \
  --keywords "engine,graphics,rendering,physics,ecs,vulkan,gamedev" \
  --description "Custom game engine with Vulkan renderer"
```

### Fallback (No Documentation)

If no CLAUDE.md or README.md exists, generate minimal keywords from:
- Folder name
- Git repo name
- Primary file extensions (`.swift` → iOS, `.py` → Python, `.rs` → Rust)

### Step 5: Configure Permissions (Auto-Heal)

After project registration, check and offer to configure Claude Code permissions:

1. **Check current status:**
   ```bash
   python3 ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/connect.py --check-permissions
   ```

2. **If `configured: false`**, ask the user:
   ```
   To avoid permission prompts in future sessions, I can save Push's
   permissions to your Claude Code settings.

   Pattern: Bash(python3 *push-todo*)
   File: ~/.claude/settings.json

   Save permission? (yes/no)
   ```

3. **If user confirms**, save the permission:
   ```bash
   python3 ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/push-todo}/scripts/connect.py --configure-permissions
   ```

4. **Confirm to user:** "Permission saved. No more prompts for Push commands."

5. **If `configured: true`**, skip silently (already configured).

**Why:** Claude Code has no "Allow always" option. This step saves permissions permanently.

## What is Push?

Push is a voice-powered todo app for iOS. Users capture tasks by speaking on their phone, and those tasks sync to Claude Code for implementation.

Learn more: https://pushto.do
