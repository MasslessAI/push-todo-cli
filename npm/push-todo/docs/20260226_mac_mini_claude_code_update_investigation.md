# Mac Mini Claude Code Update Investigation

**Date:** 2026-02-26
**Versions:** push-todo 4.2.5 → 4.2.9, Claude Code 2.1.44 (Mac mini, stale)

## Problem

Multiple daemon tasks failed on the Mac mini with:
```
Exit code 1: error: unknown option '--worktree'
```

Tasks affected: #1621, #1634, #1635, #1636 (all within a 2-minute window on 2026-02-26).

## Root Cause Analysis

### Layer 1: Immediate cause — Claude Code too old for `--worktree`

The daemon (v4.2.5+) passes `--worktree <name>` to Claude Code. The Mac mini's Claude Code (v2.1.44) rejected it. However, `--worktree` has been available since ~v2.0.0, so 2.1.44 should support it. The failures likely occurred during a transient state where `claude` was temporarily unavailable (seen in logs as `claude code=not found` during updates).

### Layer 2: Why Claude Code wasn't auto-updating on Mac mini

The daemon has had `checkAndApplyAgentUpdates()` since before these failures. It runs every cycle and calls `performAgentUpdate()`. But **before v4.2.6**, `performAgentUpdate()` only tried one strategy:

```javascript
// Pre-4.2.6 — only npm
execFileSync('npm', ['install', '-g', `@anthropic-ai/claude-code@${targetVersion}`]);
```

On the Mac mini, Claude Code was NOT installed via `npm install -g @anthropic-ai/claude-code`. It was likely installed via:
- The standalone installer
- Homebrew (`brew install claude-code`)
- Bundled inside `happy-coder` wrapper

So `npm install -g` has been **silently failing every cycle** — the catch block returns `false`, the caller logs an error, but never retries with a different method.

Meanwhile, the MacBook Air has Claude Code installed as a standalone npm global AND via happy-coder, so `npm install -g` works there and it stays current (2.1.61).

### Layer 3: No pre-flight check before task execution

Before v4.2.6, the daemon would claim a task and immediately try to spawn Claude Code without verifying the CLI version. If the version was too old or missing, the task would fail with a cryptic error.

## Fixes Applied

### v4.2.6 — Pre-flight check + `claude update` fallback

**`agent-versions.js`:**
- `performAgentUpdate()` now tries `npm install -g` first, then falls back to `claude update` for `claude-code` agent type. Strips `CLAUDECODE` env var to avoid nested session guard.
- New `ensureAgentReady(agentType)` function — checks version meets `minVersion`, attempts auto-update if below, returns clear error if update fails.

**`daemon.js`:**
- Added pre-flight call to `ensureAgentReady()` before claiming any task. If agent is too old and can't be updated, task fails immediately with actionable error message.

### v4.2.7 — `--print` output format fix

**Separate bug:** `extractSemanticSummary()` and `extractVisualArtifact()` use `--resume --print` which inherits `--output-format stream-json` from the original session. But `stream-json` requires `--verbose`, which `--print` doesn't pass.

Error: `"When using --print, --output-format=stream-json requires --verbose"`

Tasks affected: #1745, #1645.

**Fix:** Added `--output-format text` to both `--print` calls to override inherited format.

### v4.2.8 — Agent versions in heartbeat

Added `agent_versions` to `detectCapabilities()` so agent CLI versions are reported via heartbeat and visible in `machine_registry.capabilities` JSONB column.

Query:
```sql
SELECT
  machine_name,
  daemon_version,
  capabilities->'agent_versions' as agent_versions
FROM machine_registry
ORDER BY last_heartbeat_at DESC;
```

### v4.2.9 — Faster update cycles

Reduced all update intervals from 1 hour to 30 minutes:
- `self-update.js`: `UPDATE_CHECK_INTERVAL` 3600000 → 1800000
- `agent-versions.js`: `AGENT_UPDATE_CHECK_INTERVAL` and `AGENT_VERSION_AGE_GATE` 3600000 → 1800000

## Current State (needs manual investigation on Mac mini)

As of 2026-02-26 evening:
- Mac mini daemon: **v4.2.9** (current)
- Mac mini Claude Code: **v2.1.44** (stale — other machines are on 2.1.61)
- Mac mini OpenClaw: **2026.2.6** (stale — MacBook Air is on 2026.2.9)

The `claude update` fallback (added in v4.2.6) should have triggered by now but Claude Code remains at 2.1.44. Possible causes:

### Things to check on Mac mini

1. **How was Claude Code installed?**
   ```bash
   which claude
   ls -la $(which claude)
   # Check if it's a symlink to npm, brew, or standalone
   ```

2. **Does `claude update` work interactively?**
   ```bash
   claude update
   # May require interactive confirmation (Y/N) that execFileSync can't provide
   ```

3. **Check daemon log for update attempts:**
   ```bash
   cat ~/.push/daemon.log | grep -i "update\|agent.*version\|claude.*code" | tail -30
   ```

4. **Check if npm install works:**
   ```bash
   npm install -g @anthropic-ai/claude-code@latest
   # If this fails, what's the error?
   ```

5. **Check the throttle file:**
   ```bash
   cat ~/.push/last_agent_update_check
   # Compare timestamp to now — is the throttle blocking?
   ```

6. **Test `claude update` non-interactively:**
   ```bash
   claude update --yes  # or claude update -y
   # The daemon uses execFileSync with stdio: 'pipe' — if update needs stdin confirmation, it hangs/fails
   ```

### Most likely issue

`claude update` probably requires interactive confirmation (`Do you want to update? [Y/n]`), and `execFileSync` with `stdio: 'pipe'` can't provide that. If so, fix is to pass `--yes` or `-y` flag, or pipe `echo y` to stdin.

## Architecture Diagram

```
Daemon Poll Loop (every 15s)
    │
    ├── fetchTasks() → heartbeat headers include agent_versions
    │
    ├── checkAndApplyAgentUpdates() [every 30min]
    │   ├── npm view → check latest version
    │   ├── Age gate (>30min since publish)
    │   └── performAgentUpdate()
    │       ├── Try 1: npm install -g @anthropic-ai/claude-code@X
    │       └── Try 2: claude update (v4.2.6+, claude-code only)
    │
    └── executeTask()
        ├── ensureAgentReady() [PRE-FLIGHT, v4.2.6+]
        │   ├── detectAgentVersion() → check minVersion
        │   ├── If below: attempt immediate update
        │   └── If still below: fail task with clear error
        └── spawn('claude', ['--worktree', ...])
```

## Files Changed

| Version | File | Change |
|---------|------|--------|
| 4.2.6 | `lib/agent-versions.js` | `performAgentUpdate()` fallback, `ensureAgentReady()` |
| 4.2.6 | `lib/daemon.js` | Pre-flight check before task claim |
| 4.2.7 | `lib/daemon.js` | `--output-format text` on `--print` calls |
| 4.2.8 | `lib/daemon.js` | `agent_versions` in `detectCapabilities()` |
| 4.2.9 | `lib/self-update.js` | 1hr → 30min update intervals |
| 4.2.9 | `lib/agent-versions.js` | 1hr → 30min update intervals |
