# Push Voice Tasks

[![npm version](https://img.shields.io/npm/v/@masslessai/push-todo)](https://www.npmjs.com/package/@masslessai/push-todo)
[![Claude Code Skill](https://img.shields.io/badge/Claude%20Code-Skill-blue)](https://github.com/MasslessAI/push-todo-cli)

Capture coding tasks by voice on your iPhone, work on them in Claude Code, Codex, or OpenClaw.

---

## Setup (2 commands)

```bash
npm install -g @masslessai/push-todo
push-todo connect --auto
```

That's it. The second command:
- Opens browser for Sign in with Apple (one click, no codes)
- Scans your machine for all Claude Code, Codex, and OpenClaw projects
- Registers them with AI-generated keywords for voice routing
- Installs a LaunchAgent so the daemon starts automatically on login

---

## Usage

| Command | Description |
|---------|-------------|
| `push-todo` | List tasks for current project |
| `push-todo 427` | Show task #427 |
| `push-todo create "Fix auth bug"` | Create a new todo |
| `push-todo search "auth"` | Search tasks |
| `push-todo review` | Review completed tasks |
| `push-todo update` | Update CLI + check agent versions |
| `push-todo --watch` | Live daemon monitor |
| `push-todo --help` | All options |

**In Claude Code**, use `/push-todo` or just say "show my Push tasks".

---

## How It Works

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   iPhone    │───▶│    Push     │───▶│   Agent     │
│  (voice)    │    │   (sync)    │    │  (execute)  │
└─────────────┘    └─────────────┘    └─────────────┘
```

1. **Capture** — Speak your task on the Push iOS app
2. **AI Processing** — Push extracts summary and routes to the right project
3. **Daemon Picks Up** — Background daemon claims the task automatically
4. **Execute** — Agent (Claude Code / Codex / OpenClaw) implements it in a git worktree
5. **Complete** — Results sync back to your phone with PR links and summaries

---

## Background Daemon

The daemon runs continuously and executes tasks automatically:

```bash
push-todo --daemon-status       # Check daemon and LaunchAgent status
push-todo --daemon-install      # Install LaunchAgent (auto-start on login)
push-todo --daemon-uninstall    # Remove LaunchAgent
push-todo --daemon-stop         # Stop daemon
```

**Two-layer reliability:**
- **LaunchAgent** — starts daemon on login, restarts on crash (installed by `connect --auto`)
- **Self-healing** — every `push-todo` command checks if daemon is alive

---

## Multi-Agent Support

One `npm install` sets up all detected agents:

| Agent | Integration | Slash Command |
|-------|-------------|---------------|
| Claude Code | `~/.claude/skills/push-todo` | `/push-todo` |
| OpenAI Codex | `~/.codex/skills/push-todo` | `$push-todo` |
| OpenClaw | `~/.openclaw/skills/push-todo` | `/push-todo` |

Each agent gets its own action — tasks assigned to Claude Code are NOT visible to OpenClaw's daemon, even for the same repo.

---

## Scheduled Jobs (Cron)

```bash
push-todo cron add --name "standup" --every 24h --notify "Time for standup"
push-todo cron add --name "check-deps" --every 7d --health-check /path/to/project
push-todo cron list
push-todo cron remove <id>
```

---

## Updates

The daemon self-updates hourly (when idle). Manual update:

```bash
npm update -g @masslessai/push-todo
```

Or run `push-todo update` to check CLI + agent versions.

---

## Requirements

- [Push iOS app](https://pushto.do) — voice-powered task capture
- Node.js 18+
- macOS (for LaunchAgent and E2EE features)
- Claude Code, OpenAI Codex, or OpenClaw

---

## Troubleshooting

**Most issues fixed by:**
```bash
push-todo connect --auto
```

This re-authenticates, re-scans projects, and reinstalls the LaunchAgent.

**Check daemon:**
```bash
push-todo --daemon-status
```

**View daemon logs:**
```bash
tail -100 ~/.push/daemon.log
```

**Uninstall:**
```bash
push-todo --daemon-uninstall
npm uninstall -g @masslessai/push-todo
```

---

## Support

- Website: [pushto.do](https://pushto.do)
- Issues: [GitHub Issues](https://github.com/MasslessAI/push-todo-cli/issues)

---

MIT License
