# Push Voice Tasks Plugin

[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-Plugin-blue)](https://github.com/MasslessAI/push-claude-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Receive and work on voice tasks captured on your iPhone using the [Push](https://pushto.do) app.

## What is Push?

Push is a voice-powered todo app. Capture tasks by speaking on your phone → work on them in Claude Code.

**Example workflow:**
1. Say: "Fix the login validation bug in the Push app"
2. Task appears in Push with AI-extracted summary
3. Open Claude Code → see notification: "You have 1 pending task"
4. Work on the task → mark complete → syncs back to iPhone

## Installation

### Claude Code

```bash
curl -sL https://raw.githubusercontent.com/MasslessAI/push-claude-plugin/main/install.sh | bash
```

Then restart Claude Code and run `/push-todo setup` to connect your account.

### OpenAI Codex CLI

```bash
curl -sL https://raw.githubusercontent.com/MasslessAI/push-claude-plugin/main/codex/install-codex.sh | bash
```

Then run `$push-todo setup` to connect your account.

## Usage

| Command | Description |
|---------|-------------|
| `/push-todo` | Show your pending tasks |
| `/push-todo setup` | Connect or reconnect your Push account |

Or just say "show my Push tasks" and Claude will activate the skill automatically.

## Session Notifications

When you start a Claude Code session, you'll see:

```
[Push] You have 3 pending tasks from your iPhone. Say 'push-todo' to see them.
```

## Requirements

- [Push iOS app](https://pushto.do) installed on your iPhone
- Push account (free, Sign in with Apple)
- Claude Code or OpenAI Codex CLI

## How It Works

1. **Capture**: Speak your coding task on the Push iOS app
2. **AI Processing**: Push extracts summary, project hint, and normalized content
3. **Sync**: Tasks appear in Claude Code via session-start hook
4. **Work**: Select a task and Claude helps you implement it
5. **Complete**: Mark done → syncs back to your iPhone

## Troubleshooting

### Setup doesn't complete

1. Make sure you're signed into Push on your iPhone
2. Try running setup again: `/push-todo setup`
3. Check browser for any authentication errors

### Tasks don't appear

1. Verify config exists: `cat ~/.config/push/config`
2. Ensure you have pending tasks in the Push app

## Support

- Website: https://pushto.do
- Issues: https://github.com/MasslessAI/push-claude-plugin/issues

## License

MIT
