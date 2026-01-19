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

### Claude Code (Recommended)

Install via the Claude Code plugin marketplace for automatic updates:

**Step 1:** Add the Push marketplace
```
/plugin marketplace add MasslessAI/push-claude-plugin
```

**Step 2:** Install the plugin
```
/plugin install push-todo@MasslessAI/push-claude-plugin
```

**Step 3:** Enable auto-updates
```
/plugin → Marketplaces → MasslessAI/push-claude-plugin → Enable auto-update
```

**Step 4:** Connect your account
```
/push-todo setup
```

Done! Updates will be applied automatically at startup.

### Quick Install (Legacy)

For a one-liner install (does not support auto-updates):

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

## Auto-Updates

If installed via the marketplace (recommended), updates are **automatic**. Claude Code handles this natively — you don't need to do anything.

When a new version is available, you'll see:
```
Plugin push-todo updated: v1.2.0 → v1.2.1
```

**Legacy installations** (curl) do not support auto-updates. Run `/push-todo setup` to see migration instructions.

## Development

### How Updates Reach Users

```
Push code to main
       ↓
GitHub Actions bumps version in plugin.json
       ↓
User starts Claude Code (with auto-update enabled)
       ↓
Claude Code fetches plugin.json, sees new version
       ↓
Auto-downloads and installs update
```

**The version in `plugin.json` is the only signal.** When it changes, users get the update.

### Version Bumping

Versions follow **X.Y.Z** format with automatic bumping:

| Digit | Range | Overflow Behavior |
|-------|-------|-------------------|
| Z (patch) | 0-9 | Resets to 0, bumps Y |
| Y (minor) | 0-9 | Resets to 0, bumps X |
| X (major) | 0-9 | Increments normally |

Example: `1.1.9` → `1.2.0` (not `1.1.10`)

**Automated via GitHub Actions**: Every push to `main` that changes plugin files automatically bumps the version.

Manual bump (if needed):
```bash
python scripts/bump-version.py           # Bump patch
python scripts/bump-version.py --minor   # Bump minor
python scripts/bump-version.py --major   # Bump major
```

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
