# Push Voice Tasks for Clawdbot

Receive and work on voice tasks captured on your iPhone using the Push app.

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/MasslessAI/push-todo-cli/main/clawdbot/install-clawdbot.sh | bash
```

## Setup

After installation, authenticate with your Push account:

1. In Clawdbot, say "connect to Push" or run `/push-todo connect`
2. A browser window will open for Sign in with Apple
3. After authentication, you're ready to go!

## Usage

| Command | Description |
|---------|-------------|
| "Show my Push tasks" | List active voice tasks |
| "Push tasks" | Same as above |
| `/push-todo` | Explicit skill invocation |
| `/push-todo connect` | Re-authenticate or register new project |
| `/push-todo #427` | Jump directly to task #427 |

## Shared Configuration

This skill shares configuration with Claude Code and Codex installations:
- Config file: `~/.config/push/config`
- One authentication works for all three clients

## Updates

To update the skill, either:

1. Run `/push-todo connect` in Clawdbot (checks and applies updates)
2. Re-run the install script:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/MasslessAI/push-todo-cli/main/clawdbot/install-clawdbot.sh | bash
   ```

## Troubleshooting

**Most issues are fixed by running:**
```
/push-todo connect
```

This will:
- Re-authenticate if your session expired
- Update the skill if a new version is available
- Re-register your project if needed

**Still having issues?**
- Check that you have active tasks in the Push app (not completed)
- Verify config exists: `cat ~/.config/push/config`

## Support

- Website: [pushto.do](https://pushto.do)
- Issues: [GitHub](https://github.com/MasslessAI/push-todo-cli/issues)

---

MIT License
