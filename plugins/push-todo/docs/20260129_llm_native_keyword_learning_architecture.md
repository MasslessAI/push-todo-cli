# LLM-Native Keyword Learning Architecture

**Date:** 2026-01-29
**Status:** Analysis & Design
**Related:** Multi-source keyword learning, Push iOS app, Claude Code plugin

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [The Purpose of Keywords](#3-the-purpose-of-keywords)
4. [Current State Analysis](#4-current-state-analysis)
5. [LLM-Native Architecture](#5-llm-native-architecture)
6. [Data Flow Design](#6-data-flow-design)
7. [API Design](#7-api-design)
8. [Prompt Engineering](#8-prompt-engineering)
9. [Integration Points](#9-integration-points)
10. [Implementation Plan](#10-implementation-plan)
11. [Edge Cases & Considerations](#11-edge-cases--considerations)
12. [Success Metrics](#12-success-metrics)

---

## 1. Executive Summary

### The Insight

Keywords in Push are not project tags—they are a **spoken vocabulary bridge** between how users naturally speak in voice notes and what actions actually do. The goal is to help AI match future voice notes to the right action by understanding the user's natural language patterns.

### The Problem with Regex

The initial implementation used Python regex to extract keywords from git diffs:
- CamelCase patterns (`SwiftData`, `RealtimeManager`)
- Dotted names (`whisper.cpp`, `index.ts`)
- ALL_CAPS (`API`, `SDK`, `JWT`)

This approach extracts **code identifiers**, not **spoken vocabulary**. Users don't speak in CamelCase—they speak naturally.

### The LLM-Native Solution

Since the plugin runs inside Claude Code (an LLM-powered agent), we should leverage the LLM's semantic understanding to:
1. Understand what work was completed
2. Reason about how users would naturally SPEAK about similar work
3. Generate vocabulary that bridges code concepts to natural language
4. Update the action's keyword profile intelligently

---

## 2. Problem Statement

### 2.1 The Voice-to-Action Matching Challenge

```
User speaks: "Fix the realtime sync issue"
                    ↓
            AI must match to:
                    ↓
        Action: "claude-code" for AppleWhisper project
```

For accurate matching, the AI needs to understand that "realtime sync" relates to this specific project/action. Keywords provide this context.

### 2.2 Why Regex Fails

| What regex extracts | What user would say |
|---------------------|---------------------|
| `RealtimeManager` | "realtime", "sync", "live updates" |
| `handleWebSocketMessage` | "websocket", "connection issues" |
| `SyncService.swift` | "sync service", "syncing" |
| `applyFullTodoUpdate` | "todo updates", "applying changes" |

Regex captures code artifacts. Users speak in natural language. There's a fundamental mismatch.

### 2.3 The Vocabulary Gap

Consider a project with these code elements:
- `KeywordLearningService`
- `DisplayNumberManager`
- `RealtimeManager`
- `SupabaseAuth`

A user creating voice notes might say:
- "the keyword thing"
- "display numbers"
- "realtime sync"
- "authentication"
- "Supabase login"

The vocabulary gap between code and speech is significant. Only an LLM can bridge it.

---

## 3. The Purpose of Keywords

### 3.1 Not Project Tags

Keywords are NOT meant to:
- Summarize what a project is about
- Provide a limited set of representative terms
- Catalog technical dependencies

### 3.2 Spoken Vocabulary Profile

Keywords ARE meant to:
- Capture how users naturally TALK about their work
- Bridge spoken language to structured actions
- Improve AI's understanding of domain-specific terms in context
- Enable accurate voice-to-action matching

### 3.3 The Mental Model

Think of keywords as teaching the AI a user's "work vocabulary":

```
Action: "claude-code" for Push iOS project

Spoken Vocabulary Profile:
- "push app", "push todo"
- "voice notes", "transcription"
- "whisper", "speech recognition"
- "sync", "realtime", "supabase"
- "swiftdata", "ios", "swift"
- "actions", "reminders"
- ...
```

When the user says "fix the whisper transcription bug", the AI knows this maps to the Push iOS project's claude-code action because "whisper" and "transcription" are in the vocabulary profile.

### 3.4 Source Diversity

Multiple sources contribute to the vocabulary profile:

| Source | Contribution |
|--------|--------------|
| iOS (todo text) | How user describes tasks when recording |
| Claude Code (task completion) | Technical vocabulary from implementation |
| Manual (user input) | Explicit terms user wants recognized |
| Future: Cursor, Windsurf | Additional IDE contexts |

Each source adds vocabulary from a different perspective, building a richer profile.

---

## 4. Current State Analysis

### 4.1 What Exists

**Database:**
```sql
-- actions table
learned_keywords TEXT[] DEFAULT NULL
-- Stores array of learned keywords
-- Shared across all sources (merge semantics)
```

**Edge Function:** `learn-keywords`
```typescript
POST /learn-keywords
{
  "todo_id": "uuid",        // OR action_id
  "keywords": ["term1", "term2"],
  "source": "claude-code",
  "context": {
    "trigger": "task_complete"
  }
}

Response:
{
  "success": true,
  "action_id": "uuid",
  "action_name": "claude-code",
  "keywords_added": ["term1"],
  "keywords_duplicate": ["term2"],
  "total_keywords": 15
}
```

**iOS KeywordLearningService:**
- Extracts patterns from todo text (CamelCase, dotted.names, ALL_CAPS)
- Merges with existing keywords (case-insensitive dedup)
- Runs at sync time and app launch (if stale >7 days)

**Plugin (to be revised):**
- Currently has regex-based extraction (the problem)
- Calls learn-keywords API on task completion
- Needs to be replaced with LLM-native approach

### 4.2 What's Missing

1. **GET endpoint** - No way to fetch current keywords for an action/todo
2. **LLM-native extraction** - Plugin uses regex instead of Claude's reasoning
3. **Vocabulary-focused prompting** - No guidance for spoken language extraction
4. **Context awareness** - LLM doesn't see what vocabulary already exists

---

## 5. LLM-Native Architecture

### 5.1 Core Principle

The LLM (Claude Code) should be the one doing semantic extraction, not Python code. Python handles plumbing (API calls, data formatting); Claude handles reasoning (what vocabulary matters).

### 5.2 Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLAUDE CODE AGENT                           │
│                                                                     │
│  ┌─────────────┐    ┌──────────────────┐    ┌─────────────────┐   │
│  │ Task        │    │ Work Context     │    │ Vocabulary      │   │
│  │ Completion  │───▶│ (what was done)  │───▶│ Reasoning       │   │
│  │ Trigger     │    │                  │    │ (LLM-native)    │   │
│  └─────────────┘    └──────────────────┘    └────────┬────────┘   │
│                                                       │            │
│                           ┌───────────────────────────┘            │
│                           ▼                                        │
│                    ┌──────────────┐                                │
│                    │ Skill Prompt │ "What terms would the user     │
│                    │ Guidance     │  naturally SAY about this?"    │
│                    └──────┬───────┘                                │
│                           │                                        │
└───────────────────────────┼────────────────────────────────────────┘
                            │
                            ▼
                    ┌───────────────┐
                    │ learn-keywords│
                    │ API           │
                    └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │ Supabase      │
                    │ actions table │
                    │ (merge)       │
                    └───────────────┘
                            │
                            ▼
                    ┌───────────────┐
                    │ iOS Sync      │
                    │ (pull)        │
                    └───────────────┘
```

### 5.3 Key Differences from Regex Approach

| Aspect | Regex Approach | LLM-Native Approach |
|--------|----------------|---------------------|
| Extraction logic | Python code | Claude's reasoning |
| Input | Raw git diff text | Semantic understanding of work |
| Output | Code identifiers | Spoken vocabulary |
| Quality | Quantity-based (all matches) | Quality-based (best terms) |
| Context | None | Full task + work context |
| Deduplication | Case-insensitive string match | Semantic similarity |

### 5.4 The Reasoning Process

When Claude completes a task, it should reason:

1. **What did I actually do?**
   - "I fixed a bug in RealtimeManager where websocket reconnection wasn't working"

2. **What concepts are involved?**
   - Realtime synchronization
   - WebSocket connections
   - Reconnection logic
   - Network resilience

3. **How would the user SPEAK about this in a future voice note?**
   - "the realtime bug"
   - "websocket issues"
   - "reconnection"
   - "sync problems"
   - "connection dropping"

4. **What vocabulary should I contribute?**
   - "realtime", "websocket", "reconnection", "sync", "connection"
   - NOT: "RealtimeManager", "handleWebSocketReconnect"

---

## 6. Data Flow Design

### 6.1 Task Completion Flow

```
┌──────────────────────────────────────────────────────────────────┐
│ 1. TASK COMPLETION TRIGGER                                       │
├──────────────────────────────────────────────────────────────────┤
│ Claude completes work on task #427                               │
│ - Files changed: RealtimeManager.swift, SyncService.swift        │
│ - Task: "Fix websocket reconnection bug"                         │
│ - Completion comment: "Added exponential backoff for retries"    │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ 2. VOCABULARY REASONING (LLM-native)                             │
├──────────────────────────────────────────────────────────────────┤
│ Claude reasons about spoken vocabulary:                          │
│                                                                  │
│ "The user might describe similar work as:                        │
│  - 'realtime sync issues'                                        │
│  - 'websocket problems'                                          │
│  - 'connection dropping'                                         │
│  - 'reconnection bug'                                            │
│  - 'network retry logic'                                         │
│                                                                  │
│ Key vocabulary terms: realtime, websocket, reconnection,         │
│                       sync, connection, retry, network"          │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ 3. API CALL                                                      │
├──────────────────────────────────────────────────────────────────┤
│ POST /learn-keywords                                             │
│ {                                                                │
│   "todo_id": "uuid-of-task-427",                                 │
│   "keywords": ["realtime", "websocket", "reconnection",          │
│                "sync", "connection", "retry"],                   │
│   "source": "claude-code",                                       │
│   "context": {                                                   │
│     "trigger": "task_complete",                                  │
│     "task_summary": "Fix websocket reconnection bug"             │
│   }                                                              │
│ }                                                                │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ 4. SERVER-SIDE MERGE                                             │
├──────────────────────────────────────────────────────────────────┤
│ Edge function merges with existing keywords:                     │
│ - Existing: ["swift", "ios", "push", "todo"]                     │
│ - Incoming: ["realtime", "websocket", "reconnection", ...]       │
│ - Merged: ["swift", "ios", "push", "todo", "realtime", ...]      │
│                                                                  │
│ Case-insensitive deduplication, preserves order, caps at 50      │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ 5. iOS SYNC                                                      │
├──────────────────────────────────────────────────────────────────┤
│ On next sync-pull, iOS receives updated learned_keywords         │
│ Local learning (from todo text) also merges in                   │
│ Combined vocabulary used for future voice-to-action matching     │
└──────────────────────────────────────────────────────────────────┘
```

### 6.2 Future Enhancement: Fetch Current Keywords

For more intelligent vocabulary contribution, Claude could first fetch existing keywords:

```
┌─────────────────────────────────────────────────────────────────┐
│ ENHANCED FLOW (Optional)                                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ 1. GET /action-keywords?todo_id=xxx                             │
│    Response: { keywords: ["swift", "ios", "push", "todo"] }     │
│                                                                 │
│ 2. Claude reasons: "This action already knows about swift,      │
│    ios, push, todo. What NEW vocabulary would help?             │
│    The work I did was about websockets and reconnection,        │
│    which aren't in the list yet..."                             │
│                                                                 │
│ 3. POST /learn-keywords with gap-filling vocabulary             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

This prevents redundant contributions and enables smarter vocabulary expansion.

---

## 7. API Design

### 7.1 Current: POST /learn-keywords

Already implemented. Accepts keywords and merges with existing.

```typescript
// Request
POST /learn-keywords
Authorization: Bearer push_xxx
{
  "todo_id": "uuid",           // OR action_id
  "keywords": string[],
  "source": "claude-code" | "cursor" | "windsurf" | "manual",
  "context": {
    "trigger": "task_complete" | "task_start" | "manual",
    "task_summary"?: string,
    "files_changed"?: string[]
  }
}

// Response
{
  "success": true,
  "action_id": "uuid",
  "action_name": "claude-code",
  "keywords_added": string[],
  "keywords_duplicate": string[],
  "total_keywords": number,
  "message": string
}
```

### 7.2 New: GET /action-keywords

Enables Claude to see existing vocabulary before contributing.

```typescript
// Request
GET /action-keywords?todo_id=uuid
Authorization: Bearer push_xxx

// Response
{
  "action_id": "uuid",
  "action_name": "claude-code",
  "keywords": string[],
  "keyword_count": number,
  "last_updated": "ISO timestamp"
}
```

**Why todo_id?**
- Plugin has todo_id from the task
- Server resolves to action via todo_actions junction
- Same pattern as learn-keywords

### 7.3 API Design Considerations

**Option A: Blind Contribution (Current)**
- Claude contributes keywords without seeing existing
- Server handles deduplication
- Simpler, but may contribute redundant terms

**Option B: Informed Contribution (Recommended)**
- Claude fetches existing keywords first
- Reasons about gaps in vocabulary
- Contributes only novel, valuable terms
- More API calls, but higher quality contributions

**Option C: Inline Response Enhancement**
- Enhance learn-keywords response to include full current list
- `"current_keywords": ["all", "keywords", "after", "merge"]`
- Enables future informed contributions without extra call

**Recommendation:** Start with Option A (simple), enhance to Option C (adds current_keywords to response). Option B (separate GET) only if needed for complex reasoning.

---

## 8. Prompt Engineering

### 8.1 The Core Prompt Pattern

The skill instructions should guide Claude to think about SPOKEN vocabulary:

```markdown
## After Completing a Task

When you finish working on a Push task, reflect on the vocabulary:

1. **What work did you do?** (Brief summary)

2. **How would the user naturally DESCRIBE this in a voice note?**
   Think about how they would SPEAK about similar work:
   - What terms would they say aloud?
   - What's the natural language version of technical concepts?
   - What domain-specific words characterize this work?

3. **Contribute vocabulary** by calling the learn-keywords API:
   - Focus on SPOKEN terms, not code identifiers
   - Prefer natural language over CamelCase
   - Include domain-specific terms the user might say
   - 5-10 high-quality terms is better than 50 pattern matches
```

### 8.2 Example Reasoning

**Task completed:** "Implement display number self-healing"

**Bad vocabulary (regex-extracted):**
- `DisplayNumberManager`
- `syncWithSupabase`
- `healDisplayNumbers`
- `maxFromLocalSwiftData`

**Good vocabulary (LLM-reasoned):**
- "display numbers"
- "numbering"
- "self-healing"
- "number sync"
- "counter"
- "duplicate numbers"

The LLM translates code concepts to spoken language.

### 8.3 Vocabulary Quality Guidelines

Include in skill prompt:

```markdown
### Vocabulary Quality

**DO include:**
- Natural spoken terms ("realtime sync" not "RealtimeManager")
- Domain concepts ("authentication" not "AuthService")
- User-facing features ("reminders", "voice notes")
- Common abbreviations users would say ("auth", "sync", "api")

**DON'T include:**
- CamelCase identifiers (unless commonly spoken that way)
- Internal implementation details
- Generic programming terms ("function", "variable", "class")
- File names or paths
```

### 8.4 Context Awareness

The prompt should encourage Claude to consider:

```markdown
### Context for Vocabulary

Consider what makes this project/action unique:
- What technology stack? (iOS, Swift, Supabase, etc.)
- What domain? (productivity, voice, todos, etc.)
- What would distinguish this from OTHER projects?

Vocabulary should help match voice notes to THIS specific action,
not just any coding project.
```

---

## 9. Integration Points

### 9.1 Skill File Modifications

**File:** `.claude/skills/push-todo/push-todo.md` (or equivalent)

Add section for vocabulary learning:

```markdown
## Vocabulary Learning

When you complete a Push task, help improve future voice-to-action matching
by contributing vocabulary.

### After Task Completion

1. Reflect on what you accomplished
2. Think: "If the user recorded a voice note about similar work, what words would they naturally SAY?"
3. Call the learn-keywords API with those spoken-language terms

### API Call Format

```bash
curl -X POST "https://jxuzqcbqhiaxmfitzxlo.supabase.co/functions/v1/learn-keywords" \
  -H "Authorization: Bearer $PUSH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "todo_id": "<task-uuid>",
    "keywords": ["term1", "term2", "term3"],
    "source": "claude-code",
    "context": {
      "trigger": "task_complete"
    }
  }'
```

### Vocabulary Guidelines

- Focus on SPOKEN language, not code identifiers
- 5-10 high-quality terms per task
- Include domain-specific terms
- Think: "What would they SAY in a voice note?"
```

### 9.2 Remove Regex-Based Extraction

**File:** `scripts/fetch_task.py`

Remove or disable:
- `extract_keywords_from_text()` function
- `get_git_diff_for_learning()` function
- `learn_keywords_from_completion()` function
- Automatic call in `mark_task_completed()`

The Python code should only handle:
- API key management
- HTTP calls to learn-keywords endpoint
- Data formatting

Semantic extraction moves to Claude's reasoning.

### 9.3 API Utility Function

Keep a simple API helper for Claude to call:

```python
def call_learn_keywords_api(todo_id: str, keywords: list, source: str = "claude-code") -> dict:
    """
    Call the learn-keywords API endpoint.

    This is a utility for Claude to use after reasoning about vocabulary.
    The LLM determines WHAT keywords to send; this function handles HOW.

    Args:
        todo_id: UUID of the completed todo
        keywords: List of spoken-vocabulary terms (determined by LLM)
        source: Source identifier

    Returns:
        API response dict with keywords_added, keywords_duplicate, etc.
    """
    api_key = get_api_key()
    url = f"{API_BASE_URL}/learn-keywords"

    payload = {
        "todo_id": todo_id,
        "keywords": keywords,
        "source": source,
        "context": {
            "trigger": "task_complete"
        }
    }

    # ... HTTP call implementation
```

### 9.4 Skill Prompt Location

The vocabulary learning guidance should be in the skill prompt that Claude reads when handling push-todo tasks. This ensures Claude has the context needed to reason about vocabulary when completing tasks.

---

## 10. Implementation Plan

### Phase 1: API Enhancement (Optional)

**Goal:** Enable informed vocabulary contribution

**Tasks:**
1. Enhance learn-keywords response to include `current_keywords` array
2. This allows Claude to see what vocabulary already exists
3. Enables gap-filling reasoning

**Effort:** ~1 hour
**Priority:** Medium (can work without this)

### Phase 2: Remove Regex Extraction

**Goal:** Clean up the code-based approach

**Tasks:**
1. Remove `extract_keywords_from_text()` from fetch_task.py
2. Remove `get_git_diff_for_learning()` from fetch_task.py
3. Remove `learn_keywords_from_completion()` from fetch_task.py
4. Remove automatic call in `mark_task_completed()`
5. Keep only the API utility function

**Effort:** ~30 minutes
**Priority:** High

### Phase 3: Skill Prompt Update

**Goal:** Guide Claude to reason about vocabulary

**Tasks:**
1. Add vocabulary learning section to skill prompt
2. Include guidelines for spoken-language focus
3. Provide API call format/example
4. Add quality guidelines

**Effort:** ~1 hour
**Priority:** High

### Phase 4: Testing & Validation

**Goal:** Verify LLM-native approach works

**Tasks:**
1. Complete a task via push-todo
2. Observe Claude's vocabulary reasoning
3. Verify API call is made with reasonable terms
4. Check keywords appear in Supabase
5. Verify iOS sync receives updated keywords

**Effort:** ~1 hour
**Priority:** High

### Phase 5: Documentation

**Goal:** Update architecture docs

**Tasks:**
1. Update multi_source_keyword_learning_architecture.md in AppleWhisper
2. Add cross-references between docs
3. Document the LLM-native philosophy

**Effort:** ~30 minutes
**Priority:** Medium

---

## 11. Edge Cases & Considerations

### 11.1 What if Claude doesn't contribute vocabulary?

The system should be resilient to Claude not always contributing:
- iOS still learns from todo text (backup source)
- Manual contribution possible via future UI
- No vocabulary is better than bad vocabulary

### 11.2 What about vocabulary quality?

Trust the LLM but verify:
- Server-side deduplication handles exact duplicates
- 50-keyword cap prevents unbounded growth
- Periodic review could prune low-value terms (future)

### 11.3 What about different projects/actions?

Each action has its own vocabulary profile:
- Keywords are scoped to action, not global
- Same term in different actions is fine
- Vocabulary reflects how user talks about THAT specific work

### 11.4 What about multilingual users?

Current design assumes English vocabulary. Future considerations:
- User might speak in Chinese but use English tech terms
- Mixed-language vocabulary could be valuable
- No current restrictions on vocabulary language

### 11.5 What if action has no keywords yet?

Fresh actions need vocabulary bootstrapping:
- First few task completions are most valuable
- Claude should be generous with initial contributions
- iOS learning also contributes from todo text

### 11.6 Performance considerations

- API calls are non-blocking (fire-and-forget on completion)
- Vocabulary reasoning is part of Claude's existing task context
- No additional LLM calls needed (uses existing context)

---

## 12. Success Metrics

### 12.1 Quantitative

| Metric | Target | Measurement |
|--------|--------|-------------|
| Keywords per action | 10-30 | Query actions table |
| Vocabulary diversity | >50% unique stems | Linguistic analysis |
| Spoken-language ratio | >80% natural terms | Manual review sample |
| API success rate | >95% | Edge function logs |

### 12.2 Qualitative

- Voice notes match to correct action more often
- Users report "it understands what I mean"
- Keywords read like natural speech, not code
- Vocabulary reflects how users actually talk

### 12.3 Anti-Metrics (What to Avoid)

- CamelCase identifiers in keywords
- Generic programming terms
- Duplicate/near-duplicate terms
- Vocabulary that doesn't help differentiate actions

---

## Appendix A: Example Vocabulary Comparison

### Task: "Fix the sync conflict resolution bug"

**Regex-extracted (bad):**
```
SyncService, ConflictResolver, handleMergeConflict,
applyRemoteChanges, LocalChangeTracker, mergeStrategy
```

**LLM-reasoned (good):**
```
sync, conflict, merge, resolution, sync issues,
data conflict, merge problems, sync bug
```

### Task: "Add push notifications for reminders"

**Regex-extracted (bad):**
```
NotificationService, scheduleNotification, UNUserNotificationCenter,
ReminderNotificationManager, PushNotificationPayload
```

**LLM-reasoned (good):**
```
notifications, reminders, push alerts, reminder notifications,
notify, alert, push notification
```

---

## Appendix B: Related Documents

- `/docs/20260129_multi_source_keyword_learning_architecture.md` (AppleWhisper)
- `/docs/20260128_user_profile_simple_memory_research.md` (AppleWhisper)
- `App/Services/KeywordLearningService.swift` (iOS implementation)
- `supabase/functions/learn-keywords/index.ts` (Edge function)

---

## Appendix C: Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-01-29 | LLM-native over regex | Regex extracts code; LLM understands speech |
| 2026-01-29 | Vocabulary not tags | Purpose is voice matching, not project description |
| 2026-01-29 | Skill prompt guidance | Let Claude reason, don't hardcode extraction |
| 2026-01-29 | Keep server merge | Multiple sources contribute; server dedupes |
