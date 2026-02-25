# @masslessai/push-todo

Voice tasks from the [Push iOS app](https://pushto.do) for Claude Code, Codex, and OpenClaw.

## Installation

```bash
npm install -g @masslessai/push-todo
push-todo connect --auto
```

The install sets up skill integrations for all detected agents (Claude Code, Codex, OpenClaw). The `connect --auto` command handles authentication, project discovery, and LaunchAgent installation in one step.

## Quick Start

```bash
# List your tasks
push-todo

# Work on a specific task
push-todo 427

# Create a task from the terminal
push-todo create "Fix the auth redirect bug"

# Queue tasks for background execution
push-todo --queue 1,2,3
```

## Features

- **Voice Tasks**: Tasks captured by voice on your iPhone sync to your terminal
- **Background Daemon**: Executes tasks automatically via Claude Code (or Codex/OpenClaw) in git worktrees
- **LaunchAgent**: Daemon starts on login and restarts on crash — no manual babysitting
- **Multi-Agent**: Same CLI works with Claude Code, OpenAI Codex, and OpenClaw
- **Project Routing**: AI routes voice tasks to the right project using learned vocabulary
- **E2EE Support**: End-to-end encrypted tasks decrypted via iCloud Keychain
- **Cron Jobs**: Schedule recurring notifications and health checks

## Commands

| Command | Description |
|---------|-------------|
| `push-todo` | List active tasks for current project |
| `push-todo <number>` | View specific task |
| `push-todo create <title>` | Create a new todo |
| `push-todo connect --auto` | One-command setup (auth + projects + daemon) |
| `push-todo connect` | Run connection diagnostics |
| `push-todo search <query>` | Search tasks |
| `push-todo review` | Review and mark completed tasks |
| `push-todo update` | Update CLI and check agent versions |
| `push-todo --watch` | Live monitoring UI |
| `push-todo --queue 1,2,3` | Queue tasks for daemon execution |
| `push-todo --queue-batch` | Auto-queue a batch of tasks |
| `push-todo --resume <number>` | Resume daemon's Claude session for a task |
| `push-todo --all-projects` | Tasks from all projects |
| `push-todo --backlog` | Show backlog items |
| `push-todo --completed` | Show completed items |
| `push-todo --json` | Output as JSON |

## Daemon Management

```bash
push-todo --daemon-status       # Show daemon + LaunchAgent status
push-todo --daemon-install      # Install LaunchAgent (auto-start on login)
push-todo --daemon-uninstall    # Remove LaunchAgent
push-todo --daemon-start        # Start daemon manually
push-todo --daemon-stop         # Stop daemon
```

The daemon self-updates hourly when idle. Two-layer reliability: LaunchAgent for OS-level lifecycle, self-healing for edge cases.

## Cron Jobs

```bash
push-todo cron add --name "standup" --every 24h --notify "Time for standup"
push-todo cron add --name "weekly-review" --cron "0 9 * * 1" --create-todo "Weekly code review"
push-todo cron add --name "check-deps" --every 7d --health-check /path/to/project --scope deps
push-todo cron list
push-todo cron remove <id>
```

## Claude Code Integration

This package installs as a Claude Code skill (not plugin) for a clean `/push-todo` command:

```
/push-todo              List your voice tasks
/push-todo 427          Work on task #427
/push-todo review       Review completed tasks
/push-todo setup        Configure connection
```

## Configuration

Config stored at `~/.config/push/config`:

```bash
push-todo setting                # Show all settings
push-todo setting auto-commit    # Toggle auto-commit
push-todo setting auto-update    # Toggle daemon self-update
```

## Programmatic API

```javascript
import { listTasks, showTask, searchTasks } from '@masslessai/push-todo';

const tasks = await listTasks({ allProjects: true });
const task = await showTask(427);
const results = await searchTasks('auth bug');
```

## Requirements

- Node.js 18+
- macOS (for LaunchAgent and E2EE)
- [Push iOS app](https://pushto.do)

## Documentation

- [Skill Instructions](./SKILL.md) — how the AI agent uses push-todo
- [Push Website](https://pushto.do)
- [GitHub Issues](https://github.com/MasslessAI/push-todo-cli/issues)

## License

MIT
