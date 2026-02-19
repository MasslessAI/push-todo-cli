# Claude Code & Mac Terminal Development Settings Review

**Date:** 2026-02-19
**Machine:** macOS 26.2 (Tahoe) — Apple Silicon

---

## 1. Claude Code Configuration

### Version & Model
- **Claude Code CLI:** v2.1.47
- **Model:** Claude Opus 4.6
- **Always-thinking:** Enabled

### Permissions
- `Bash` is auto-allowed — all other tools prompt for approval.

### Hooks (Global — `~/.claude/settings.json`)
All lifecycle events route to `claude-island-state.py` (ClaudeIsland.app integration):
- `SessionStart`, `SessionEnd`, `Stop`, `SubagentStop`
- `PreToolUse`, `PostToolUse`, `PreCompact`
- `Notification`, `PermissionRequest`, `UserPromptSubmit`

**Note:** The hook Python script uses `python3` at `/usr/bin/python3` (system Python 3.9.6). This is functional but tied to the macOS system Python. If Apple removes or changes it in a future macOS update, hooks will break. Consider pinning to a Homebrew Python or using a shebang with `env python3` (already done in the script).

### Plugins (38 enabled)
Heavily loaded plugin set including:
- **Core dev:** `feature-dev`, `code-review`, `pr-review-toolkit`, `commit-commands`, `code-simplifier`
- **LSP integrations:** `typescript-lsp`, `pyright-lsp`, `swift-lsp`, `rust-analyzer-lsp`, `gopls-lsp`, `clangd-lsp`, `jdtls-lsp`, `kotlin-lsp`, `lua-lsp`, `php-lsp`, `csharp-lsp`
- **Output styles:** `learning-output-style`, `explanatory-output-style`
- **Knowledge work:** `data`, `finance`, `legal`, `marketing`, `sales`, `product-management`, `customer-support`, `enterprise-search`, `productivity`
- **Other:** `bio-research`, `frontend-design`, `playground`, `hookify`, `ralph-loop`, `agent-sdk-dev`, `plugin-dev`, `claude-code-setup`, `claude-md-management`, `cowork-plugin-management`, `security-guidance`

**Observation:** 38 plugins is a large set. Many LSP and knowledge-work plugins may not be relevant to most sessions. This adds to system prompt size and startup overhead. Consider disabling plugins not actively used (e.g., `csharp-lsp`, `php-lsp`, `lua-lsp`, `kotlin-lsp`, `jdtls-lsp` if not doing Java/Kotlin/C#/PHP/Lua development).

### Push Plugin Hooks
The `push-todo` npm package registers:
- `SessionStart` → `session-start.js` (fetches tasks)
- `SessionEnd` → `session-end.js` (reports completion, 15s timeout)

This is well-structured with appropriate timeouts.

---

## 2. Mac Terminal & Development Environment

### Shell & Terminal
- **Shell:** zsh (default macOS)
- **Terminal:** Apple Terminal.app (Basic profile)
- **No custom prompt / theme detected** (no Oh My Zsh, Starship, etc.)

### .zshrc (19 lines — minimal)
- Adds `~/.local/bin` to PATH
- Sources OpenClaw completions
- `chrome-auto` alias for Chrome automation profile
- `chrome-fix()` function for killing zombie native host processes

**Observation:** Very clean and minimal. No unnecessary bloat.

### Node.js & JavaScript
- **Node.js:** v24.9.0 (via NVM 0.40.3) — current
- **npm:** v11.6.0
- **Bun:** v1.3.9
- **Global npm packages:**
  - `@masslessai/push-todo@4.0.6` — this project
  - `openclaw@2026.2.9`
  - `wrangler@4.53.0` (Cloudflare Workers)
  - `@vscode/vsce@3.7.1` (VS Code extension packaging)
  - `happy-coder@0.11.2`
  - `@steipete/bird@0.8.0`
  - `redbook` (local symlink)

### Build & CLI Tools
- **Git:** v2.50.1 (Apple Git)
- **Homebrew:** v5.0.14
- **Xcode CLI Tools:** v2416 (full Xcode at `/Applications/Xcode.app`)
- **Supabase CLI:** v2.65.5
- **GitHub CLI (gh):** v2.81.0
- **Python:** 3.9.6 (system — `/usr/bin/python3`)

### Homebrew Packages
Core libraries present: `cairo`, `cmake`, `pango`, `librsvg`, `harfbuzz`, `icu4c`, etc.
Developer tools: `gh`, `supabase`, `bun`

### Git Config
```
[user]
    email = yuxianggu@gmail.com
    name = Lucas Gu
```
Minimal — no custom aliases, merge strategy, or GPG signing configured.

---

## 3. Findings & Recommendations

### Good
1. **Clean shell config** — `.zshrc` is minimal with no unnecessary sourcing or plugins that slow startup
2. **Modern Node.js** — v24.9 via NVM is well-managed
3. **Claude Code hooks work** — ClaudeIsland integration covers all lifecycle events
4. **Push plugin well-structured** — SessionStart/End hooks with proper timeouts
5. **Essential CLI tools present** — git, gh, supabase, bun, wrangler all installed

### Suggestions

| # | Area | Finding | Suggestion |
|---|------|---------|------------|
| 1 | Plugins | 38 enabled plugins (11 LSP) adds prompt overhead | Disable LSP plugins for languages not in active use |
| 2 | Python | System Python 3.9.6 is old and Apple-managed | Install Python 3.12+ via Homebrew for reliability |
| 3 | Git | No `.gitignore_global` detected | Add global gitignore for `.DS_Store`, `node_modules`, etc. |
| 4 | Terminal | Using default Terminal.app Basic profile | Consider iTerm2 or Ghostty for better developer features (tabs, split panes, search) — optional preference |
| 5 | CLAUDE.md | No `CLAUDE.md` in push-todo-cli project root | Add one with project conventions, build/test commands, and architecture notes |
| 6 | Git config | No commit signing | Consider GPG or SSH commit signing for verified commits on GitHub |
| 7 | Shell | No prompt customization | Consider Starship for git branch/status in prompt — optional preference |

### No Action Needed
- Node.js version management (NVM works well)
- Homebrew is up to date
- Push CLI at latest version (4.0.6)
- Claude Code at recent version (2.1.47)
