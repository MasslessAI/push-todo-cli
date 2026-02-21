# Parallel Execution: Human-in-the-Loop Design

> Task #1574 — Research and design the interaction for reviewing parallel task
> execution results in one shot, without overwhelming the user.

## Problem Statement

When the Push daemon executes up to 5 tasks in parallel, results arrive
near-simultaneously. The current model requires the user to check each task
individually — opening PRs, reviewing confirmations, reading session outputs
one at a time. This creates two failure modes:

1. **Attention fragmentation** — the user context-switches between tasks,
   losing focus on their primary work
2. **Stale queue** — items pile up in `session_finished` because the user
   doesn't check often enough, and auto-merge silently ships code they
   haven't reviewed

We need a single interaction surface — the **Attention Queue** — that lets the
user review all pending items in one shot while maintaining meaningful control.

---

## Current Architecture (as-is)

### Task Lifecycle

```
queued → running → session_finished → completed
                 ↘ awaiting_confirmation (blocks until iPhone approval)
                 ↘ failed
```

### Existing Human-in-the-Loop

| Mechanism | Scope | Surface | Blocking? |
|-----------|-------|---------|-----------|
| Remote Confirmation (`confirm.js`) | Content tasks (tweets, emails) | iOS app | Yes — Claude polls until response |
| PR review (GitHub) | Code tasks | GitHub UI | Only if `auto_merge` OFF |
| `push-todo review` | Completed tasks | CLI | No — retrospective only |
| `push-todo watch` | Running/queued | CLI TUI | No — read-only monitor |

### Gap

No unified review surface exists for items that finished execution and need
human judgment before being finalized. The gap sits between `session_finished`
and `completed` — the daemon either auto-completes (user never sees the work)
or leaves tasks in limbo (user forgets to check).

---

## Proposed Design: The Attention Queue

### Mental Model

Think of the Attention Queue as a **daily standup with your agents**. Instead
of you going to each agent's desk, they all bring their results to one table.
You scan, approve, redirect, or defer — then go back to your own work.

```
┌─────────────────────────────────────────────────────────┐
│                    ATTENTION QUEUE                       │
│                                                         │
│  Items needing your review (newest first):              │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 🟢 #1571 Add user avatar upload                 │   │
│  │    PR ready · 3 files changed · 2 min ago       │   │
│  │    [Approve & Merge]  [View Diff]  [Defer]      │   │
│  └─────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 🟡 #1569 Draft tweet about v4.0 release         │   │
│  │    Confirmation pending · "Excited to announce…" │   │
│  │    [Approve]  [Edit & Approve]  [Reject]         │   │
│  └─────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 🔴 #1570 Fix login redirect bug                 │   │
│  │    Failed · "ENOENT: .env.local not found"      │   │
│  │    [Retry]  [View Log]  [Skip]                   │   │
│  └─────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 🟢 #1568 Refactor API rate limiting             │   │
│  │    PR ready · 1 file changed · 8 min ago        │   │
│  │    [Approve & Merge]  [View Diff]  [Defer]      │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ────────────────────────────────────────────────────   │
│  Bulk: [Approve All PRs]  [Defer All]  [Done]          │
└─────────────────────────────────────────────────────────┘
```

### Core Principle: Items, Not Tasks

The queue doesn't show "tasks." It shows **attention items** — the specific
thing that needs the user's judgment. A single task might produce zero items
(fully auto-completed) or multiple items (PR + confirmation + follow-up
question). This keeps the queue focused on decisions, not status updates.

---

## Attention Item Types

### 1. PR Review (`pr_ready`)

**Trigger:** Task finishes with a PR created, `auto_merge` is OFF or a new
`review_before_merge` setting is ON.

**What the user sees:**
- Task summary + PR title
- File count and lines changed (from `gh pr view`)
- Semantic summary extracted from the session
- Time since completion

**Actions:**
- **Approve & Merge** — merges the PR and marks task complete
- **View Diff** — opens PR URL or shows inline diff summary
- **Request Changes** — adds a review comment, task stays in queue
- **Defer** — removes from current review, resurfaces next time

### 2. Confirmation (`confirmation_pending`)

**Trigger:** Claude calls `push-todo confirm` during execution.

Already implemented in `confirm.js` — the new design surfaces these in the
unified queue alongside PRs and failures, rather than requiring the user
to go to the iOS app.

**Actions:**
- **Approve** — sends approval, Claude continues
- **Edit & Approve** — modify the content before approving
- **Reject** — sends rejection, Claude handles gracefully

### 3. Failure (`failed`)

**Trigger:** Task exits with non-zero code.

**What the user sees:**
- Error summary (from `extractSemanticSummary`)
- Exit code and duration
- Last meaningful output line

**Actions:**
- **Retry** — re-queues the task
- **Retry with Context** — re-queues with additional instructions
- **View Log** — shows full session transcript
- **Skip** — acknowledges failure, removes from queue

### 4. Completed Review (`review_suggested`)

**Trigger:** Task auto-completed (PR merged automatically) but the
`review_auto_completed` setting is ON. A lightweight "did this look right?"
check.

**What the user sees:**
- Task summary + merged PR link
- Semantic summary of what changed

**Actions:**
- **Looks Good** — dismisses from queue
- **Revert** — reverts the merge commit
- **View Changes** — opens the merged PR

---

## New Execution Status: `needs_attention`

Introduce a new execution status that sits between `session_finished` and
`completed`:

```
queued → running → session_finished → needs_attention → completed
                 ↘ awaiting_confirmation ──────────────↗
                 ↘ failed ──────────────────────────────↗
```

### When does a task enter `needs_attention`?

The daemon's `handleTaskCompletion()` logic changes:

```
Current flow:
  session_finished → auto_merge? → auto_complete? → completed

Proposed flow:
  session_finished → should_auto_resolve?
    YES → completed (no human needed)
    NO  → needs_attention (queued for review)
```

### Resolution Policy (configurable)

| Setting | Value | Behavior |
|---------|-------|----------|
| `review_mode` | `"none"` | Current behavior: auto-merge + auto-complete |
| `review_mode` | `"failures_only"` | Only failed tasks enter attention queue |
| `review_mode` | `"prs"` | PRs held for review, failures enter queue |
| `review_mode` | `"all"` | Everything enters the attention queue |

Default: `"prs"` — auto-complete simple tasks, hold PRs and failures for review.

---

## Interaction Surfaces

### Surface 1: CLI (`push-todo attention`)

The primary developer surface. Designed for quick triage.

```
$ push-todo attention

  Push Attention Queue
  ══════════════════════════════════════════════════

  3 items need your attention

  1. 🟢 #1571  Add user avatar upload
     PR ready · +47/-3 across 3 files · 2m ago
     "Added avatar upload with S3 presigned URLs and image resizing"

  2. 🔴 #1570  Fix login redirect bug
     Failed · exit 1 · 5m ago
     "ENOENT: .env.local not found — needs local env setup"

  3. 🟢 #1568  Refactor API rate limiting
     PR ready · +12/-8 in 1 file · 8m ago
     "Extracted rate limit config to environment variables"

  ──────────────────────────────────────────────────
  Actions:
    push-todo approve 1571       Merge PR & complete
    push-todo approve 1571 1568  Merge multiple PRs
    push-todo approve --all      Merge all ready PRs
    push-todo retry 1570         Re-queue failed task
    push-todo defer 1571         Defer to next review
    push-todo attention --resolve 1570  Dismiss failure
```

#### Interactive mode (TTY)

When run in an interactive terminal, `push-todo attention` enters a
TUI similar to `watch` mode but with action keys:

```
  Push Attention Queue                    3 items
  ══════════════════════════════════════════════════

  → 🟢 #1571  Add user avatar upload        2m ago
    PR: +47/-3 across 3 files
    "Added avatar upload with S3 presigned URLs…"

    🔴 #1570  Fix login redirect bug         5m ago
    Failed: exit 1
    "ENOENT: .env.local not found"

    🟢 #1568  Refactor API rate limiting     8m ago
    PR: +12/-8 in 1 file
    "Extracted rate limit config to env vars"

  ──────────────────────────────────────────────────
  ↑↓ navigate  a approve  r retry  d defer  v view
  A approve all PRs   q quit
```

Key bindings:
- `↑`/`↓` or `j`/`k` — navigate items
- `a` — approve/merge the selected item
- `r` — retry (for failed items)
- `d` — defer item
- `v` — view diff or full log
- `A` — approve all PR items at once
- `q` — quit

### Surface 2: iOS App (Push notification)

The iPhone is for quick triage, not deep review.

**Notification:**
> "3 tasks finished — 2 PRs ready, 1 failed. Tap to review."

**In-app view:**
A card-based swipe interface:
- Swipe right = approve
- Swipe left = defer
- Tap = expand details
- "Approve All" button at bottom

This mirrors the existing confirmation UI but extends it to all attention item
types.

### Surface 3: Claude Code Session (`/push-todo` skill)

When a user opens Claude Code and runs `/push-todo`, the skill already fetches
tasks. Extend it to surface attention items:

```
You have 3 items in your attention queue:

1. **#1571 Add user avatar upload** — PR ready (+47/-3, 3 files)
   Approved S3 presigned URL approach with image resizing.

2. **#1570 Fix login redirect bug** — Failed
   Missing .env.local file. Needs NEXT_PUBLIC_BASE_URL set.

3. **#1568 Refactor API rate limiting** — PR ready (+12/-8, 1 file)
   Moved hardcoded rate limits to env vars.

Would you like me to review the diffs, approve the PRs, or retry #1570?
```

This lets the user handle attention items without leaving their coding session.

### Surface 4: macOS Notification (passive)

Already implemented via `sendMacNotification`. Extend to batch:

**Instead of** (current — one notification per task):
> "Task #1571 complete. PR ready for review."
> "Task #1570 failed. Exit code 1."
> "Task #1568 complete. PR ready for review."

**Batch into** (proposed):
> "3 tasks finished — tap to review attention queue"

Use a single summary notification with a 5-second debounce after the last
task completes.

---

## Daemon Changes

### 1. Attention Queue State

Add to `daemon_status.json`:

```json
{
  "running": true,
  "runningTasks": [...],
  "queuedTasks": [...],
  "completedToday": [...],
  "attentionQueue": [
    {
      "displayNumber": 1571,
      "type": "pr_ready",
      "summary": "Add user avatar upload",
      "detail": "+47/-3 across 3 files",
      "prUrl": "https://github.com/…/pull/42",
      "semanticSummary": "Added avatar upload with S3 presigned URLs…",
      "addedAt": "2026-02-21T10:05:00Z",
      "taskId": "uuid-here"
    },
    {
      "displayNumber": 1570,
      "type": "failed",
      "summary": "Fix login redirect bug",
      "detail": "ENOENT: .env.local not found",
      "exitCode": 1,
      "addedAt": "2026-02-21T10:03:00Z",
      "taskId": "uuid-here"
    }
  ]
}
```

### 2. Modified `handleTaskCompletion()` Flow

```javascript
// In daemon.js handleTaskCompletion():

const reviewMode = getReviewMode(); // 'none' | 'failures_only' | 'prs' | 'all'

// Determine if this needs attention
let needsAttention = false;
let attentionType = null;

if (exitCode !== 0) {
  // Failed tasks always enter queue (unless review_mode is 'none')
  needsAttention = reviewMode !== 'none';
  attentionType = 'failed';
} else if (prUrl && !merged) {
  // PR created but not auto-merged
  needsAttention = ['prs', 'all'].includes(reviewMode);
  attentionType = 'pr_ready';
} else if (merged && reviewMode === 'all') {
  // Auto-merged but user wants to review everything
  needsAttention = true;
  attentionType = 'review_suggested';
}

if (needsAttention) {
  addToAttentionQueue({
    displayNumber,
    type: attentionType,
    summary,
    prUrl,
    semanticSummary,
    exitCode,
    error: /* ... */,
  });
  await updateTaskStatus(displayNumber, 'needs_attention', { ... });
} else {
  // Current auto-complete flow
  await markTaskAsCompleted(displayNumber, taskId, comment);
}
```

### 3. Attention Queue Resolution

```javascript
// New function in daemon.js or a new attention-queue.js module

async function resolveAttentionItem(displayNumber, action, options = {}) {
  switch (action) {
    case 'approve':
      // Merge PR if applicable
      if (item.prUrl) {
        await mergePR(item.prUrl);
      }
      await markTaskAsCompleted(displayNumber, item.taskId, options.comment);
      removeFromAttentionQueue(displayNumber);
      break;

    case 'retry':
      await updateTaskStatus(displayNumber, 'queued', { retryReason: options.reason });
      removeFromAttentionQueue(displayNumber);
      break;

    case 'defer':
      // Keep in queue but mark as deferred (won't notify again)
      updateAttentionItem(displayNumber, { deferred: true });
      break;

    case 'dismiss':
      // Acknowledge without completing (for failures user won't fix)
      removeFromAttentionQueue(displayNumber);
      break;
  }
}
```

### 4. Batch Notification Debounce

```javascript
// Replace individual notifications with batched summary

let pendingNotifications = [];
let notificationTimer = null;

function scheduleAttentionNotification(item) {
  pendingNotifications.push(item);

  if (notificationTimer) clearTimeout(notificationTimer);

  notificationTimer = setTimeout(() => {
    const count = pendingNotifications.length;
    const prs = pendingNotifications.filter(i => i.type === 'pr_ready').length;
    const fails = pendingNotifications.filter(i => i.type === 'failed').length;

    const parts = [];
    if (prs) parts.push(`${prs} PR${prs > 1 ? 's' : ''} ready`);
    if (fails) parts.push(`${fails} failed`);

    sendMacNotification(
      `${count} tasks finished`,
      parts.join(', ') + '. Review with: push-todo attention',
      'Glass'
    );

    pendingNotifications = [];
    notificationTimer = null;
  }, 5000); // 5-second debounce
}
```

---

## CLI API Additions

### New Commands

| Command | Description |
|---------|-------------|
| `push-todo attention` | Show attention queue (TUI if interactive) |
| `push-todo attention --json` | Attention queue as JSON |
| `push-todo approve <num> [num…]` | Approve/merge one or more tasks |
| `push-todo approve --all` | Approve all PR-ready tasks |
| `push-todo retry <num>` | Re-queue a failed task |
| `push-todo retry <num> --context "hint"` | Re-queue with additional context |
| `push-todo defer <num>` | Defer item to next review |
| `push-todo dismiss <num>` | Dismiss without completing |

### Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `review_mode` | enum | `"prs"` | What enters the attention queue |
| `attention_notify` | bool | `true` | macOS notification for attention items |
| `attention_batch_delay` | int | `5000` | ms to wait before batching notification |
| `auto_approve_threshold` | int | `0` | Auto-approve PRs under N lines changed |

---

## Edge Cases

### 1. User is offline / AFK

Items accumulate in the attention queue. When the user returns, they see the
full queue. The queue is persistent (stored in `daemon_status.json` and
synced to Supabase) so it survives daemon restarts.

### 2. Multiple machines

Each machine has its own local `daemon_status.json`, but the `needs_attention`
status is stored in Supabase. The iOS app and any machine can resolve items.
Resolution syncs back, and the daemon removes resolved items from local queue
on next poll.

### 3. Queue grows too large

If more than 10 items accumulate, the notification escalates:
> "10+ items waiting for review. Consider adjusting review_mode."

The CLI shows a warning and suggests bulk approve for low-risk items.

### 4. Conflicting PRs

When parallel tasks modify overlapping files, the second merge may fail.
The daemon detects merge conflict and adds a new attention item:
- Type: `merge_conflict`
- Actions: [View Conflict] [Retry After Manual Fix] [Skip]

### 5. Task produces both PR and confirmation

A task might create a PR AND request confirmation (e.g., "write a blog post
and deploy it"). These become two separate attention items with a shared
task number, resolved independently.

---

## Interaction Flow Example

### Scenario: User queues 4 tasks before lunch

```
11:00  User: push-todo --queue 1568,1569,1570,1571
       → 4 tasks queued

11:01  Daemon picks up all 4 (within MAX_CONCURRENT_TASKS=5)
       → 4 Claude sessions start in parallel worktrees

11:08  #1568 finishes → PR created → added to attention queue
11:10  #1571 finishes → PR created → added to attention queue
11:11  #1570 fails    → error captured → added to attention queue
11:15  #1569 finishes → confirmation needed → added to attention queue

11:15  macOS notification (batched):
       "4 tasks finished — 2 PRs ready, 1 failed, 1 needs confirmation"

12:30  User returns from lunch

12:30  User: push-todo attention
       → Interactive TUI shows 4 items

12:31  User presses 'A' (approve all PRs)
       → #1568 and #1571 PRs merged and completed
       → Queue now shows 2 items

12:31  User navigates to #1569, presses 'a' to approve confirmation
       → Confirmation sent, Claude continues, task completes
       → Queue now shows 1 item

12:32  User navigates to #1570, presses 'v' to view log
       → Sees the error, presses 'r' to retry
       → Task re-queued, removed from attention queue

12:32  Queue empty. User back to their own work.
       Total review time: ~2 minutes for 4 tasks.
```

---

## Implementation Phases

### Phase 1: Foundation (attention queue + CLI)

**Files to modify:**
- `daemon.js` — Add `needs_attention` status, attention queue tracking,
  batch notifications
- `fetch.js` — Add `showAttentionQueue()` function
- `cli.js` — Add `attention`, `approve`, `retry`, `defer`, `dismiss` commands
- `config.js` — Add `review_mode` setting
- `api.js` — Add `resolveAttentionItem()` endpoint wrapper

**New files:**
- `lib/attention.js` — Attention queue state management

**Estimated scope:** ~400 lines of new code, ~100 lines modified.

### Phase 2: Interactive TUI

**Files to modify:**
- `watch.js` → refactor into reusable TUI components
- New `lib/attention-tui.js` — Interactive review interface

**Estimated scope:** ~300 lines.

### Phase 3: iOS App Integration

**Backend:**
- New Supabase function: `resolve-attention-item`
- Attention queue sync (bidirectional)

**iOS:**
- Attention queue view with swipe actions
- Batch notification support

### Phase 4: Claude Code Skill Integration

**Files to modify:**
- `SKILL.md` — Add attention queue awareness
- `hooks/session-start.js` — Surface attention items on session start

---

## Design Decisions & Rationale

### Why a separate queue, not extending `push-todo review`?

`review` is retrospective — it shows completed tasks. The attention queue is
**prospective** — it shows items that need action before they can be completed.
Different intent, different UX.

### Why not just use GitHub PR reviews?

Three reasons:
1. Not all attention items are PRs (confirmations, failures)
2. GitHub reviews require context-switching to a browser
3. The queue enables batch operations that GitHub doesn't support

### Why default to `review_mode: "prs"` and not `"all"`?

Most users want the daemon to "just work" for simple tasks. Failures are
already surfaced via notifications. PRs are the sweet spot — significant
enough to review, but not so frequent that they overwhelm. Users who want
full control can switch to `"all"`.

### Why 5-second notification debounce?

Tasks finish within seconds of each other when running in parallel. A
5-second window captures the typical burst without making the user wait
too long. The last task to finish triggers the summary notification.

---

## Open Questions

1. **Should deferred items auto-escalate?** If an item is deferred 3+ times,
   should it be flagged as "stale" with a stronger notification?

2. **Attention queue on the iPhone lock screen?** Using iOS widgets to show
   the attention queue count could reduce the time-to-review.

3. **Auto-approve for low-risk changes?** A setting like
   `auto_approve_threshold: 20` could auto-merge PRs with fewer than 20 lines
   changed. Reduces queue noise but adds risk.

4. **Integration with `push-todo watch`?** Should the watch TUI show a tab
   or section for attention items, or should `attention` remain a separate
   command?
