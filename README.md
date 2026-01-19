# Push Voice Tasks

[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-Plugin-blue)](https://github.com/MasslessAI/push-claude-plugin)

Capture coding tasks by voice on your iPhone → work on them in Claude Code.

---

## Install

### Option A: Quick Install (One Command)

```bash
curl -fsSL https://raw.githubusercontent.com/MasslessAI/push-claude-plugin/main/install.sh | bash
```

Then restart Claude Code and run:
```
/push-todo setup
```

### Option B: Marketplace Install

If you prefer automatic updates:

```
/plugin marketplace add MasslessAI/push-claude-plugin
/plugin install push-todo@push-claude-plugin
/push-todo setup
```

> **Tip:** Enable auto-updates via `/plugin` → Marketplaces → push-claude-plugin → Enable auto-update

---

## Usage

| Command | Description |
|---------|-------------|
| `/push-todo` | Show tasks for current project |
| `/push-todo setup` | Connect account, check for updates, fix issues |
| `/push-todo #427` | Jump directly to task #427 |
| `/push-todo review` | Review what you worked on and mark tasks complete |

You can also just say "show my Push tasks" and Claude will understand.

---

## How It Works

1. **Capture** — Speak your task on the Push iOS app
2. **AI Processing** — Push extracts summary and routes to the right project
3. **Notification** — When you start Claude Code: "You have 3 tasks from your iPhone"
4. **Work** — Select a task, Claude helps you implement it
5. **Complete** — Mark done, syncs back to your phone

---

## Updates

| Install Method | How Updates Work |
|----------------|------------------|
| **Marketplace (auto-update ON)** | Automatic at startup |
| **Marketplace (auto-update OFF)** | Run `/push-todo setup` to check |
| **Quick Install (curl)** | Run `/push-todo setup` to check and update |

The `/push-todo setup` command handles everything: checks for updates, validates your connection, and registers your project.

---

## Requirements

- [Push iOS app](https://pushto.do) — voice-powered task capture
- Claude Code

---

## Troubleshooting

**Most issues are fixed by running:**
```
/push-todo setup
```

This will:
- Re-authenticate if your session expired
- Update the plugin if a new version is available
- Re-register your project if needed

**Still having issues?**
- Check that you have active tasks in the Push app (not completed)
- Verify config exists: `cat ~/.config/push/config`

---

## Support

- Website: [pushto.do](https://pushto.do)
- Issues: [GitHub](https://github.com/MasslessAI/push-claude-plugin/issues)

---

MIT License
