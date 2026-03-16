# Per-Project Configuration Research: The Layer Architecture

**Date:** 2026-02-18
**Task:** #1412
**Status:** Deep research complete — future-oriented agentic design

---

## The Real Question

This isn't "where should we put a push.md file." The real question is:

**When you have 6 layers of configuration all trying to influence agent behavior, what belongs where, what's the priority, and how do they compose?**

The layers are:

```
Layer 6 — Session prompt (ephemeral, per-task)
Layer 5 — Task orchestrator config (push.md? daemon behavior?)
Layer 4 — Skills/plugins (SKILL.md in NPM package)
Layer 3 — Project-level config (CLAUDE.md in repo root)
Layer 2 — Agent-global config (~/.claude/CLAUDE.md, ~/.openclaw/AGENTS.md)
Layer 1 — Platform policy (organization, safety, deny rules)
Layer 0 — System defaults
```

Each layer has a different owner, different scope, and different update frequency.

---

## Part 1: What Exists Today

### The Current Stack (As-Is)

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 6: Session Prompt (buildSmartPrompt in context-engine.js) │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ "Work on Push task #1412: ..."                              │ │
│ │ + Skills list (scanned from .claude/skills/)                │ │
│ │ + Git state (branch, commits, PRs)                          │ │
│ │ + Generic instructions (read CLAUDE.md, commit, etc.)       │ │
│ └─────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│ Layer 4: SKILL.md (in NPM package, symlinked)                   │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ How to use /push-todo command                               │ │
│ │ Interactive usage only (human runs /push-todo)              │ │
│ │ NOT read by daemon during task execution                    │ │
│ └─────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│ Layer 3: CLAUDE.md (per-project, if it exists)                  │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Project architecture, patterns, build commands              │ │
│ │ Claude Code reads it automatically at session start         │ │
│ │ Agent-AGNOSTIC: about the PROJECT, not about Push           │ │
│ └─────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2: ~/.claude/CLAUDE.md (global, if it exists)             │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ User's global coding preferences                            │ │
│ │ Applied to ALL projects, ALL sessions                       │ │
│ └─────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│ (No Layer 5 exists today — no per-project Push config)          │
│ (No Layer 1 exists today — no org policy)                       │
└─────────────────────────────────────────────────────────────────┘
```

### What Each Layer Does and Doesn't Do

| Layer | File | Who Writes It | Who Reads It | When Read | Scope |
|-------|------|---------------|--------------|-----------|-------|
| 6 | (generated) | `context-engine.js` | Claude Code session | Task execution | One task |
| 4 | `SKILL.md` | Push developers | Claude Code (interactive) | User invokes `/push-todo` | All projects |
| 3 | `CLAUDE.md` | Project developer | Claude Code | Session start | One project |
| 2 | `~/.claude/CLAUDE.md` | User | Claude Code | Session start | All projects |

### The Gap

**Layer 5 is empty.** There's no per-project file that tells Push's daemon how to behave for THIS project. The daemon treats all projects identically: spawn Claude Code, pass the prompt, hope for the best.

The keywords and description that differentiate projects? They live only on the Supabase server, set once via `push-todo connect --keywords "..."`. They're invisible in the repo, not version-controlled, and can't be updated by editing a file.

---

## Part 2: How OpenClaw Thinks About This

### OpenClaw's Multi-File Separation of Concerns

OpenClaw doesn't have one "config file." It has **six**, each with a distinct role:

| File | Purpose | Analogy |
|------|---------|---------|
| `AGENTS.md` | Rules, boundaries, workflow conventions | "The contract" |
| `SOUL.md` | Identity, personality, values, tone | "The character" |
| `USER.md` | User preferences (communication style) | "The preferences" |
| `TOOLS.md` | Environment capabilities and tool notes | "The toolbox" |
| `HEARTBEAT.md` | Proactive check-in checklist | "The schedule" |
| `MEMORY.md` | Persistent knowledge distilled over time | "The brain" |

These all live in `~/.openclaw/workspace/` (agent-scoped, not project-scoped).

### The Critical Design Insight

OpenClaw separates **what the agent IS** (`SOUL.md`) from **what the agent DOES** (`AGENTS.md`) from **what the user WANTS** (`USER.md`). These don't belong in the same file because:

1. **Different update frequencies** — SOUL.md changes rarely, AGENTS.md changes per-project, USER.md changes per-user
2. **Different audiences** — SOUL.md is philosophical, AGENTS.md is operational, USER.md is personal
3. **Different inheritance** — SOUL.md is global (one identity), AGENTS.md can be per-project, USER.md can be per-user

### OpenClaw's Priority Model

```
Agent-specific config  >  Global workspace config  >  Defaults
(most specific wins)
```

Sub-agents receive only `AGENTS.md` + `TOOLS.md` — deliberately pruned context. They don't get SOUL.md or USER.md because those are about the primary agent's identity, not the sub-task.

### Cross-Tool Compatibility

OpenClaw's recommendation: **Symlink AGENTS.md to CLAUDE.md.** Both serve the same purpose (project-level agent instructions) but different tools read different filenames. This is a pragmatic acknowledgment that the industry hasn't standardized on one filename yet.

---

## Part 3: The Layer Architecture (Proposed)

### What Belongs Where

The key principle: **each concern has exactly one canonical home.**

```
┌──────────────────────────────────────────────────────────┐
│ "What task should I do?"                                 │
│  → Layer 6: Session prompt (generated by daemon)         │
│  → Source: Supabase todo + voice transcript + attachments │
│  → Owner: Push platform                                  │
├──────────────────────────────────────────────────────────┤
│ "How should Push behave for this project?"               │
│  → Layer 5: push.md (NEW — per-project Push config)      │
│  → Source: Developer writes it, daemon reads it          │
│  → Owner: Project team                                   │
│  → Examples: keywords, auto-PR, test commands, routing   │
├──────────────────────────────────────────────────────────┤
│ "What capabilities does this tool provide?"              │
│  → Layer 4: SKILL.md (in NPM package)                    │
│  → Source: Push developers maintain it globally           │
│  → Owner: Push tool maintainers                          │
│  → NOT per-project: same /push-todo skill everywhere     │
├──────────────────────────────────────────────────────────┤
│ "How should the agent work in this codebase?"            │
│  → Layer 3: CLAUDE.md / AGENTS.md (per-project)          │
│  → Source: Developer writes it for the project           │
│  → Owner: Project team                                   │
│  → Agent-agnostic: architecture, patterns, build cmds    │
├──────────────────────────────────────────────────────────┤
│ "What are this user's global preferences?"               │
│  → Layer 2: ~/.claude/CLAUDE.md or ~/.openclaw/USER.md   │
│  → Source: User writes it once                           │
│  → Owner: Individual user                                │
├──────────────────────────────────────────────────────────┤
│ "What's forbidden?"                                      │
│  → Layer 1: Organization policy                          │
│  → Source: IT/security team                              │
│  → Owner: Organization (cannot be overridden)            │
└──────────────────────────────────────────────────────────┘
```

### The Key Distinction: push.md vs CLAUDE.md

This is the central question: **why not just put Push config in CLAUDE.md?**

| | `CLAUDE.md` | `push.md` (proposed) |
|---|-------------|---------------------|
| **Purpose** | How the agent should work in this codebase | How Push should orchestrate work for this project |
| **Read by** | Claude Code (at session start, always) | Push daemon (at task dispatch time) |
| **Agent-specific?** | Yes (Claude Code only) | No (Push routes to Claude Code, OpenClaw, Codex) |
| **Content** | Architecture, patterns, build commands, testing | Keywords, routing, auto-PR, confirmation policies |
| **Who cares?** | Any developer using Claude Code in this repo | Push platform when dispatching tasks |
| **Update frequency** | Changes with project architecture | Changes with Push workflow preferences |

**They're different layers answering different questions:**
- CLAUDE.md: "Agent, here's how this codebase works"
- push.md: "Push daemon, here's how to orchestrate work in this project"

A developer who doesn't use Push still benefits from CLAUDE.md. A Push user who uses OpenClaw instead of Claude Code still benefits from push.md. They're orthogonal.

### Why Not Put Everything in CLAUDE.md?

1. **Agent portability**: CLAUDE.md is Claude Code-specific. OpenClaw reads `AGENTS.md`. Codex reads `AGENTS.md`. Push needs a file that works regardless of which agent executes the task.

2. **Separation of concerns**: CLAUDE.md describes the project to the agent. push.md describes the project to the orchestrator. Mixing them creates confusion about which instructions are for the agent and which are for the platform.

3. **Read-time difference**: CLAUDE.md is read by Claude Code at session start (after spawn). push.md is read by the daemon BEFORE spawning, to decide HOW to spawn. The daemon needs to know `auto_pr: true` before it builds the prompt. It needs keywords before it decides routing.

4. **Multi-agent reality**: The same project might have both:
   - `CLAUDE.md` → instructions for Claude Code sessions
   - `AGENTS.md` → instructions for OpenClaw/Codex sessions
   - `push.md` → instructions for Push daemon (which spawns EITHER)

### The OpenClaw Symlink Lesson

OpenClaw recommends symlinking `AGENTS.md` → `CLAUDE.md`. This teaches us something: **the project-level agent instructions file (Layer 3) should eventually converge on a single standard.** The industry is moving toward `AGENTS.md` (cross-tool, Linux Foundation steward).

But `push.md` is Layer 5, not Layer 3. It's not agent instructions — it's orchestrator instructions. There's no conflict with AGENTS.md/CLAUDE.md because they serve different purposes.

---

## Part 4: push.md Specification

### File Location and Discovery

```
/project-root/
├── CLAUDE.md          # Layer 3: Agent instructions (Claude Code)
├── AGENTS.md          # Layer 3: Agent instructions (cross-tool)
├── push.md            # Layer 5: Push orchestrator config (NEW)
├── .claude/
│   ├── settings.json
│   └── skills/
│       └── push-todo/ # Layer 4: Skill (symlink to NPM package)
└── ...
```

Discovery: `existsSync(join(projectPath, 'push.md'))` — one line, no tree walking.

### Format

Markdown with YAML frontmatter. The frontmatter contains machine-parsed fields the daemon needs BEFORE spawning. The body contains instructions injected INTO the spawn prompt.

```markdown
---
# ─── Routing ────────────────────────────────────
keywords: push, voice, todo, whisper, ios, swiftui, speech
description: Voice-powered todo app for iOS with whisper speech recognition

# ─── Daemon Behavior ────────────────────────────
auto_commit: true          # Daemon instructs agent to commit (default: true)
auto_pr: false             # Create PR after task completion (default: false)
require_confirmation: false # All tasks go through iOS confirm gate (default: false)
default_branch: main       # Branch to base worktrees on (default: auto-detect)
test_command: swift build  # Run before committing; fail = don't commit (default: none)
---

# Project Instructions

These instructions are injected into every Push daemon task prompt for this
project. They supplement (not replace) CLAUDE.md.

## Coding Rules
- Always run `swift build` before committing
- Create PRs for non-trivial changes
- Never modify SwiftData schema without running migrations

## Task Context
This is an iOS app using SwiftUI and SwiftData with Supabase backend.
When working on Supabase edge functions, deploy with `supabase functions deploy`.
```

### How push.md Gets Read

**By the daemon (context-engine.js) — at task dispatch time:**

```
1. Task arrives from Supabase
2. Daemon resolves: gitRemote + actionType → localPath
3. Daemon reads: push.md at localPath (YAML frontmatter + body)
4. Frontmatter informs DISPATCH decisions:
   - auto_pr → should we instruct agent to PR?
   - test_command → should we instruct agent to test first?
   - require_confirmation → should we gate this task on iOS?
5. Body gets INJECTED into buildSmartPrompt() as "## Project Instructions"
6. Claude Code session spawns with enriched prompt
7. Claude Code ALSO reads CLAUDE.md on its own (Layer 3, automatic)
```

**NOT by Claude Code directly** — push.md is a daemon config file, not an agent config file. The daemon translates push.md content into the prompt. Claude Code never needs to know push.md exists.

**By `push-todo connect`** — reads keywords and description from frontmatter as defaults, so the developer doesn't need to pass `--keywords` every time.

### Priority and Composition

When push.md and CLAUDE.md both exist, they DON'T conflict because they operate at different layers:

```
Agent session receives (in order):
  1. System prompt (Claude Code built-in)
  2. ~/.claude/CLAUDE.md (Layer 2, global user preferences)
  3. CLAUDE.md (Layer 3, project agent instructions — auto-loaded by Claude)
  4. Daemon prompt (Layer 6, generated by buildSmartPrompt):
     a. Task content
     b. Metadata (action, context app)
     c. Project Instructions (from push.md body ← Layer 5)
     d. Available skills (from skill scanner)
     e. Project state (git)
     f. Generic instructions
```

**push.md body becomes part of the daemon prompt (Layer 6), not a separate layer.** The daemon reads push.md and folds its body into the prompt it generates. The agent sees one unified prompt.

**For frontmatter fields** (auto_pr, test_command, etc.), these control daemon behavior OUTSIDE the agent session. The daemon decides whether to create a PR, run tests, or gate on confirmation — the agent doesn't need to know about these policies.

### Relationship to SKILL.md

| | `SKILL.md` (Layer 4) | `push.md` (Layer 5) |
|---|---------------------|---------------------|
| **Lives in** | NPM package (symlinked to ~/.claude/skills/) | Project root (committed to git) |
| **Scope** | Global (same for all projects) | Per-project |
| **Read when** | User invokes `/push-todo` interactively | Daemon dispatches a task |
| **Content** | How to use the CLI, UX flows, review mode | Project routing, daemon behavior, instructions |
| **Maintained by** | Push tool developers | Project team |

They're complementary:
- **SKILL.md** teaches the agent HOW to interact with Push (the tool)
- **push.md** teaches the daemon HOW to orchestrate work for this project

A developer never edits SKILL.md. A Push developer never needs to edit push.md for someone else's project.

---

## Part 5: The Bigger Picture — Agentic Configuration Philosophy

### OpenClaw's Lesson: Separate Concerns by Purpose, Not by Tool

OpenClaw's 6-file system (AGENTS.md, SOUL.md, USER.md, TOOLS.md, HEARTBEAT.md, MEMORY.md) is philosophically important even if Push doesn't need 6 files. The lesson is:

> **Don't put everything in one file just because one file is simpler. Put each concern where it naturally belongs.**

For Push, the natural concerns are:

| Concern | File | Why |
|---------|------|-----|
| Project architecture for agents | `CLAUDE.md` / `AGENTS.md` | Agents need this, Push doesn't |
| Push orchestration config | `push.md` | Push daemon needs this, agents don't |
| Push CLI usage instructions | `SKILL.md` | Interactive use, not daemon use |
| Server-side task routing | Supabase (actions table) | Cloud-native, not file-native |
| Local project registry | `~/.config/push/projects.json` | Machine-specific, not project-specific |

### The Priority Principle

When multiple layers have opinions, the merge strategy is:

| Conflict Type | Resolution |
|--------------|------------|
| Safety (deny rules) | **Deny wins at any layer** — cannot be overridden |
| Behavioral flags | **Most-specific wins** — push.md overrides defaults |
| Instructions/context | **Additive merge** — all layers contribute, none replace |
| Routing data | **push.md > server** — file is source of truth, synced to server |

### Why This Is Future-Oriented

Today, Push dispatches tasks to one agent at a time. Tomorrow:

1. **Multi-agent dispatch**: push.md could specify which task types go to which agents
   ```yaml
   routing:
     code: claude-code
     social: openclaw
     research: openai-codex
   ```

2. **Proactive scheduling** (from daemon evolution doc): push.md could include heartbeat-like checks
   ```yaml
   heartbeat:
     - check: "git status --porcelain"
       if_output: "notify user of uncommitted changes"
       every: 1h
   ```

3. **Skill routing**: push.md could declare which skills are mandatory for which task patterns
   ```yaml
   skill_routing:
     - pattern: "reply|respond|tweet"
       skill: /reply-composer
       require_confirmation: true
   ```

4. **Cross-project orchestration**: A monorepo could have push.md at the root AND in subdirectories
   ```
   /monorepo/
   ├── push.md              # Routing for the whole monorepo
   ├── packages/web/push.md # Web-specific overrides
   └── packages/api/push.md # API-specific overrides
   ```

None of this should be in CLAUDE.md because CLAUDE.md is about the AGENT's understanding of the codebase, not about the PLATFORM's orchestration of tasks.

---

## Part 6: Implementation Phases

### Phase 0: No code changes (now)
- Document the layer architecture (this doc)
- Establish the principle: push.md is Layer 5 (orchestrator config), NOT Layer 3 (agent config)

### Phase 1: Read-only daemon support
- Add `readPushConfig(projectPath)` to `context-engine.js`
- Parse YAML frontmatter + markdown body
- Inject body into `buildSmartPrompt()` as `## Project Instructions` section
- Use frontmatter keywords/description as defaults in `push-todo connect`

### Phase 2: Generation via setup
- During `push-todo setup`, offer to create push.md
- Claude reads CLAUDE.md/README.md to generate keywords and description
- User reviews before committing

### Phase 3: Behavioral flags
- `auto_pr` → daemon creates PR after task (via `gh pr create`)
- `test_command` → daemon instructs agent to run before committing
- `require_confirmation` → all tasks route through iOS confirm gate

### Phase 4: Advanced orchestration
- Skill routing (pattern → skill mapping)
- Multi-agent routing (task type → agent type)
- Heartbeat/proactive checks
- Monorepo subdirectory support

---

## Summary

| Question | Answer |
|----------|--------|
| Do we need push.md? | **Yes** — Layer 5 (orchestrator config) is currently empty |
| Why not use CLAUDE.md? | Different layer, different reader, different purpose, not agent-portable |
| What's the relationship to SKILL.md? | SKILL.md = tool instructions (Layer 4), push.md = project config (Layer 5) |
| How does priority work? | Deny wins; most-specific wins for config; additive merge for instructions |
| Where does push.md content end up? | Daemon reads it → injects body into prompt → agent sees it as instructions |
| Is this future-proof? | Yes — supports multi-agent routing, proactive scheduling, skill routing |
| What's OpenClaw's approach? | Separate files by concern (6 files), not one mega-file |

The key insight: **push.md is not about the project. It's about how Push should orchestrate work for the project.** That's a fundamentally different concern from what CLAUDE.md describes, and it deserves its own file.

---

## References

### Push Architecture
- `push-todo-cli/lib/context-engine.js` — Current prompt builder
- `push-todo-cli/lib/project-registry.js` — Global project registry
- `push-todo-cli/lib/connect.js` — Project registration flow
- `push-todo-cli/lib/daemon.js` — Task dispatch logic
- `push-todo-cli/SKILL.md` — Claude Code skill instructions
- `docs/20260214_push_daemon_evolution_complete_architecture.md` — Daemon architecture (§11: Prompt as Control Plane)

### Industry
- Claude Code: CLAUDE.md + .claude/ directory + settings hierarchy
- OpenClaw: AGENTS.md, SOUL.md, USER.md, TOOLS.md, HEARTBEAT.md, MEMORY.md
- AGENTS.md standard: Linux Foundation / Agentic AI Foundation (cross-tool)
- Cursor: .cursor/rules/*.mdc (YAML frontmatter + markdown body)
- GitHub Copilot: .github/copilot-instructions.md
- OpenAI Codex: AGENTS.md + .codex/config.toml
