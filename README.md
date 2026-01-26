# Push Voice Tasks

[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-Plugin-blue)](https://github.com/MasslessAI/push-todo-cli)

Capture coding tasks by voice on your iPhone → work on them in Claude Code.

---

## Install

### Option A: Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/MasslessAI/push-todo-cli/main/install.sh | bash
```

Then restart Claude Code and run `/push-todo connect`.

### Option B: Manual Install

If you prefer to run the commands yourself:

```
/plugin marketplace add MasslessAI/push-todo-cli
/plugin install push-todo@push-todo-cli
/push-todo connect
```

> **Tip:** Enable auto-updates via `/plugin` → Marketplaces → push-todo-cli → Enable auto-update

---

## Usage

| Command | Description |
|---------|-------------|
| `/push-todo` | Show tasks for current project |
| `/push-todo connect` | Connect account, check for updates, fix issues |
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

Both install methods use the marketplace, so updates work the same way:

| Setting | How Updates Work |
|---------|------------------|
| **Auto-update ON** | Automatic at startup |
| **Auto-update OFF** | Run `/push-todo connect` to check |

Enable auto-updates: `/plugin` → Marketplaces → push-todo-cli → Enable auto-update

The `/push-todo connect` command handles everything: checks for updates, validates your connection, and registers your project.

---

## Requirements

- [Push iOS app](https://pushto.do) — voice-powered task capture
- Claude Code, OpenAI Codex, or Clawdbot

---

## OpenAI Codex Support

Full feature parity with Claude Code. Install with:

```bash
curl -fsSL https://raw.githubusercontent.com/MasslessAI/push-todo-cli/main/codex/install-codex.sh | bash
```

Then run `$push-todo connect` to get started.

**Updates:** Run `$push-todo connect` to check for updates and apply them automatically.

---

## Clawdbot Support

Full feature parity with Claude Code. Install with:

```bash
curl -fsSL https://raw.githubusercontent.com/MasslessAI/push-todo-cli/main/clawdbot/install-clawdbot.sh | bash
```

Then say `/push-todo connect` in Clawdbot to get started.

**Updates:** Say `/push-todo connect` to check for updates and apply them automatically.

---

## Troubleshooting

**Most issues are fixed by running:**
```
/push-todo connect
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
- Issues: [GitHub](https://github.com/MasslessAI/push-todo-cli/issues)

---

MIT License
