# How Electron Skills Work in agent-browser

## Investigation Summary

Analyzed the `vercel-labs/agent-browser` Electron skill to understand its architecture
and evaluate whether it truly understands Electron internals or is just a generic wrapper.

## Architecture Overview

### Three-Tier System

```
┌─────────────┐     ┌──────────────┐     ┌────────────────┐
│  Rust CLI    │────▶│  Node.js     │────▶│  Browser /     │
│  (parser)    │sock │  Daemon      │CDP  │  Electron App  │
│  <1ms parse  │     │  (Playwright)│     │  (renderer)    │
└─────────────┘     └──────────────┘     └────────────────┘
```

1. **Rust CLI** — Parses commands in sub-millisecond, routes via Unix socket / TCP
2. **Node.js Daemon** — Persistent process managing browser state via Playwright
3. **Browser / App** — Controlled via Chrome DevTools Protocol (CDP)

### The "Skill" Layer

A **skill** in this system is NOT code — it's a `SKILL.md` markdown file injected into
the agent's context. It teaches the agent HOW to use the `agent-browser` CLI tool
to accomplish tasks. Think of it as a detailed instruction manual the LLM reads,
not a library it imports.

```
npx skills add vercel-labs/agent-browser --skill electron
  → Downloads SKILL.md to .claude/skills/electron/SKILL.md
  → Agent reads this at activation time
  → Contains: launch commands, connection patterns, troubleshooting
```

## How Electron Control Actually Works

### Step 1: Launch with Remote Debugging

The agent is told to launch Electron apps with `--remote-debugging-port`:

```bash
# macOS
open -a "Slack" --args --remote-debugging-port=9222
open -a "Visual Studio Code" --args --remote-debugging-port=9223
open -a "Discord" --args --remote-debugging-port=9224
```

This is a standard Chromium feature. Every Electron app inherits it because Electron
IS Chromium. The app exposes a CDP endpoint at `localhost:{port}`.

### Step 2: Connect via CDP

```bash
agent-browser connect 9222
# or per-command:
agent-browser --cdp 9222 snapshot -i
```

Internally, Playwright's `connectOverCDP()` connects to the exposed debugging port.
The daemon wraps this connection identically to a regular browser instance.

### Step 3: Accessibility Tree Snapshot

```bash
agent-browser snapshot -i
# Returns:
# @e1 button "Send Message"
# @e2 textbox "Type a message..."
# @e3 link "General"
```

The snapshot mechanism:
1. Calls Playwright's `ariaSnapshot()` API on the connected page
2. Also detects elements with `onclick` handlers or `cursor:pointer` CSS
3. `processTree()` assigns stable `@e1`, `@e2` refs to interactive elements
4. Refs map to role-name pairs in an in-memory `RefMap`
5. When you `click @e1`, `resolveLocator()` converts back to a Playwright locator

### Step 4: Interact

```bash
agent-browser click @e1
agent-browser fill @e2 "Hello world"
agent-browser screenshot
```

After any significant DOM change, re-snapshot to get fresh refs.

## Is the System Too General?

### Verdict: Yes — it's deliberately generic, and that's both its strength and weakness.

### What It DOES Understand

1. **CDP is universal across Chromium** — The core insight is correct: Electron apps
   are Chromium under the hood, so CDP works on all of them identically.

2. **Accessibility tree as the interaction model** — Using ARIA roles/names instead
   of CSS selectors is genuinely smart. It's more stable across DOM changes and
   naturally semantic.

3. **Practical launch patterns** — The skill knows the exact macOS/Linux/Windows
   commands to launch each app with debugging enabled.

4. **Multi-webview awareness** — Electron apps often have multiple webviews
   (main window, settings panel, etc.). The skill teaches `agent-browser tab` for
   switching between them.

### What It Does NOT Understand (Electron-Specific Gaps)

1. **No Electron IPC awareness** — Electron apps communicate between main process
   and renderer via IPC (`ipcMain`/`ipcRenderer`). CDP only sees the renderer side.
   The agent cannot trigger main-process actions (file dialogs, native menus,
   system tray, etc.) that aren't exposed in the DOM.

2. **No native module access** — Many Electron apps use native Node.js modules
   (`fs`, `child_process`, etc.) in the main process. These are completely invisible
   to CDP.

3. **No BrowserWindow lifecycle control** — Cannot create/close/resize windows
   programmatically through the Electron API. Only sees what's already rendered.

4. **No preload script awareness** — Electron apps often inject APIs via preload
   scripts (`contextBridge.exposeInMainWorld`). The skill doesn't know which custom
   APIs are available in each app.

5. **No app-specific DOM knowledge** — The skill doesn't know Discord's component
   structure, Figma's canvas internals, or VS Code's extension host. It discovers
   everything at runtime through accessibility snapshots, which is flexible but
   means it has zero domain-specific knowledge.

6. **Security sandboxing limitations** — Some Electron apps run with
   `contextIsolation: true` and `sandbox: true`, which limits what CDP can access
   in the renderer.

7. **Custom rendering (Canvas/WebGL)** — Apps like Figma render to `<canvas>`,
   which has no accessibility tree. The snapshot would show a single canvas element
   with no internal structure. The skill doesn't address this limitation.

## The "Skill" Paradigm Analysis

### How Skills Differ from MCP Servers or Plugins

| Aspect | Skill (SKILL.md) | MCP Server | Plugin |
|--------|------------------|------------|--------|
| What it is | Markdown instructions | Running process | Code package |
| Loaded when | Agent activates it | Always connected | Always loaded |
| Executes code | No (agent runs CLI) | Yes (server-side) | Yes (host-side) |
| Can extend tools | No | Yes (new tools) | Yes (hooks, commands) |
| Knowledge type | Procedural ("do X") | Functional (API) | Functional (API) |

A skill is essentially a **prompt engineering artifact** — it's an expertly-written
instruction manual that teaches the agent a workflow. The agent-browser CLI does
the actual heavy lifting.

### Implications

**Strengths of the approach:**
- Zero runtime overhead when skill isn't active
- Works across any agent that reads SKILL.md (Claude Code, Cursor, Copilot, etc.)
- Easy to create and share (it's just markdown)
- Agent can adapt instructions to novel situations

**Weaknesses:**
- Agent must interpret and execute instructions correctly every time
- No type safety, no compilation, no validation
- Agent might hallucinate steps or misremember the workflow
- No feedback loop — if the agent does something wrong, the skill can't correct it
- Entirely dependent on the agent's ability to use CLI tools reliably

## Key Takeaways

1. **The Electron "skill" is really a CDP usage guide** — There is no Electron-specific
   code or protocol. It's using the same CDP that works on any Chromium instance.

2. **The accessibility tree approach is genuinely clever** — Refs based on ARIA
   roles/names are more robust than CSS selectors and naturally align with how LLMs
   think about UI elements.

3. **It's general by design** — The system treats all Electron apps identically
   because, at the CDP level, they ARE identical. This means it works everywhere
   but has no deep understanding of any specific app.

4. **The gap is in main-process interaction** — The biggest limitation is that CDP
   only reaches renderer processes. Anything in Electron's main process (native
   menus, file dialogs, system tray, IPC handlers) is invisible.

5. **Skills are prompt engineering, not code** — The entire "skill" is a markdown
   file that teaches the agent a workflow. The underlying mechanism is Playwright
   connecting to CDP. The innovation is in packaging this knowledge for agents.

## Sources

- [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)
- [vercel-labs/skills](https://github.com/vercel-labs/skills)
- [Vercel Skills Ecosystem Announcement](https://vercel.com/changelog/introducing-skills-the-open-agent-skills-ecosystem)
- [Agent Skills FAQ](https://vercel.com/blog/agent-skills-explained-an-faq)
- [DeepWiki: agent-browser Architecture](https://deepwiki.com/vercel-labs/agent-browser)
- [Zylos: agent-browser Analysis](https://zylos.ai/research/2026-01-14-vercel-agent-browser)
- [Electron Remote Debugging](https://www.electronjs.org/docs/latest/tutorial/application-debugging)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
