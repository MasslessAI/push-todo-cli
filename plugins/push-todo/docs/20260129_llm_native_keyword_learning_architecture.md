# LLM-Native Keyword Learning Architecture

**Date:** 2026-01-29
**Status:** Implemented (Core) + Planned (Pruning)
**Related:** Multi-source keyword learning, Push iOS app, Claude Code plugin

> **Implementation Status:**
> - ✅ Section 1-12: Core LLM-native learning - **IMPLEMENTED**
> - 🔲 Section 13: LLM-native pruning - **PLANNED** (implementation phases defined)

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
13. [LLM-Native Pruning](#13-llm-native-pruning)

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

## 13. LLM-Native Pruning

### 13.1 The Problem: Vocabulary Drift

Over time, keywords accumulate from multiple sources:
- iOS learning from todo text
- Claude Code from task completions
- Future: Cursor, Windsurf, manual entry

Without maintenance, several quality issues emerge:

| Issue | Example | Impact |
|-------|---------|--------|
| **Redundancy with Connect keywords** | `actionDescription: "swift, ios"` + `learnedKeywords: ["swift", "iOS"]` | Wasted slots |
| **Semantic duplicates** | "realtime", "real-time", "real time" | Noise |
| **Generic terms** | "code", "bug", "fix", "update" | Don't differentiate actions |
| **Code identifiers** | "RealtimeManager", "SyncService" | Violate spoken-vocabulary philosophy |
| **Stale vocabulary** | Terms from old architecture | No longer relevant |

The 50-keyword cap eventually fills with low-value terms, blocking higher-quality additions.

### 13.2 Why Not Usage-Based Decay?

One approach is to track which keywords actually help match voice notes:

```
User says: "fix the realtime sync"
→ Matches action "claude-code" via keyword "realtime"
→ Increment usage counter for "realtime"
→ Keywords with low usage decay over time
```

**Why this is overengineering (for now):**

1. **Requires matching instrumentation** - Track which keywords contributed to each match
2. **Requires usage persistence** - Store counters, timestamps, decay logic
3. **Delayed feedback loop** - Takes weeks/months to identify unused keywords
4. **Complex maintenance** - Decay rates, thresholds, exceptions

The simpler, more LLM-native approach: **Let Claude review and prune periodically.**

### 13.3 LLM-Native Pruning Philosophy

Just as Claude reasons about vocabulary when *adding* keywords, Claude should reason about vocabulary when *removing* them:

```
┌──────────────────────────────────────────────────────────────┐
│ PRUNING TRIGGER                                               │
│ "This action has 45 keywords. Before adding more,             │
│  let me review the existing vocabulary..."                    │
└──────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│ FETCH FULL CONTEXT                                            │
│ - Connect keywords (actionDescription): "swift, ios, push"    │
│ - Learned keywords: ["realtime", "sync", "RealtimeManager",   │
│     "SwiftData", "authentication", "auth", "authentication",  │
│     "code", "bug", "fix", ...]                                │
└──────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│ PRUNING REASONING                                             │
│                                                               │
│ Claude evaluates each keyword:                                │
│                                                               │
│ ✅ "realtime" - Good: spoken vocabulary, domain-specific      │
│ ✅ "sync" - Good: commonly spoken, relevant                   │
│ ❌ "RealtimeManager" - Bad: code identifier, not spoken       │
│ ✅ "swiftdata" - Good: would say this naturally               │
│ ❌ "authentication" - Duplicate: same meaning as "auth"       │
│ ❌ "code" - Bad: too generic, every project has code          │
│ ❌ "bug" - Bad: too generic, doesn't differentiate            │
│ ❌ "fix" - Bad: too generic, every task fixes something       │
│                                                               │
│ Remove: ["RealtimeManager", "authentication" (keep "auth"),   │
│          "code", "bug", "fix"]                                │
└──────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│ API CALL: PRUNE KEYWORDS                                      │
│ POST /prune-keywords                                          │
│ {                                                             │
│   "action_id": "uuid",                                        │
│   "remove_keywords": ["RealtimeManager", "authentication",    │
│                       "code", "bug", "fix"],                  │
│   "source": "claude-code",                                    │
│   "reason": "Pruned code identifiers, semantic duplicates,    │
│              and generic terms"                               │
│ }                                                             │
└──────────────────────────────────────────────────────────────┘
```

### 13.4 When to Trigger Pruning

| Trigger | Condition | Rationale |
|---------|-----------|-----------|
| **Approaching limit** | `total_keywords >= 40` | Proactive before cap |
| **On-demand** | User requests "/prune-vocabulary" | Manual maintenance |
| **Periodic (future)** | Monthly, quarterly | Hygiene |

**learn-keywords response hint:**
```typescript
{
  "success": true,
  "total_keywords": 42,
  "current_keywords": [...],
  "pruning_recommended": true,  // Signal to Claude
  "message": "Added 3 keywords. Consider pruning - 42/50 capacity."
}
```

When Claude sees `pruning_recommended: true`, it should initiate a pruning cycle.

### 13.5 API Design: prune-keywords

**New Edge Function:** `prune-keywords`

```typescript
// Request
POST /prune-keywords
Authorization: Bearer push_xxx
{
  "action_id": "uuid",
  "remove_keywords": string[],     // Keywords to remove
  "source": "claude-code",
  "reason"?: string                // For logging/audit
}

// Response
{
  "success": true,
  "action_id": "uuid",
  "action_name": "claude-code",
  "keywords_removed": string[],    // Actually removed (case-insensitive match)
  "keywords_not_found": string[],  // Requested but not in list
  "remaining_keywords": string[],  // Full list after prune
  "total_keywords": number,
  "message": string
}
```

**Implementation:**
```typescript
function pruneKeywords(
  existing: string[],
  toRemove: string[]
): { remaining: string[]; removed: string[]; notFound: string[] } {
  const removeSet = new Set(toRemove.map(k => k.toLowerCase()));
  const removed: string[] = [];
  const remaining: string[] = [];

  for (const kw of existing) {
    if (removeSet.has(kw.toLowerCase())) {
      removed.push(kw);
    } else {
      remaining.push(kw);
    }
  }

  const notFound = toRemove.filter(
    k => !removed.some(r => r.toLowerCase() === k.toLowerCase())
  );

  return { remaining, removed, notFound };
}
```

### 13.6 Enhanced API: get-action-context

To enable informed pruning, Claude needs **both** Connect keywords and learned keywords:

**New Edge Function:** `get-action-context`

```typescript
// Request
GET /get-action-context?action_id=uuid
// OR
GET /get-action-context?todo_id=uuid
Authorization: Bearer push_xxx

// Response
{
  "action_id": "uuid",
  "action_name": "claude-code",
  "connect_keywords": string[],     // From actionDescription (Connect-owned)
  "learned_keywords": string[],     // From learnedKeywords (Learning-owned)
  "combined_keywords": string[],    // Deduplicated union
  "total_learned": number,
  "max_learned": 50,
  "pruning_recommended": boolean,   // total_learned >= 40
  "last_updated": "ISO timestamp"
}
```

**Why separate from learn-keywords response?**
- Pruning may happen without learning (pure maintenance)
- Full context needed before pruning decisions
- Connect keywords needed for cross-source deduplication

### 13.7 Cross-Source Deduplication

**The Gap:** Currently, `learn-keywords` only checks `learned_keywords` for duplicates, not `actionDescription` (Connect keywords).

**The Fix:** Check both sources at write time:

```typescript
// In learn-keywords edge function
const connectKeywords = (action.action_description || "")
  .split(",")
  .map(k => k.trim().toLowerCase())
  .filter(k => k.length > 0);

const existingLearned = (action.learned_keywords || [])
  .map(k => k.toLowerCase());

const allExisting = new Set([...connectKeywords, ...existingLearned]);

// Filter incoming keywords
const incoming = validKeywords.filter(kw => !allExisting.has(kw.toLowerCase()));
```

This prevents adding "swift" to learned_keywords when it's already in actionDescription.

### 13.8 Pruning Skill Prompt

Add to SKILL.md:

```markdown
## Vocabulary Pruning (Quality Maintenance)

When you see `pruning_recommended: true` in a learn-keywords response, or when
an action has 40+ keywords, review the vocabulary for quality.

### Pruning Criteria

Remove keywords that are:

1. **Redundant with Connect keywords** - Already in actionDescription
2. **Semantic duplicates** - "realtime" and "real-time" (keep one)
3. **Generic programming terms** - "code", "bug", "fix", "update", "feature"
4. **Code identifiers** - CamelCase class names, function names
5. **No longer relevant** - Old architecture, deprecated features

### Pruning Process

1. **Fetch full context:**
   ```bash
   curl "https://jxuzqcbqhiaxmfitzxlo.supabase.co/functions/v1/get-action-context?action_id=UUID" \
     -H "Authorization: Bearer $PUSH_API_KEY"
   ```

2. **Reason about each keyword:**
   - Would the user SAY this in a voice note?
   - Does it differentiate THIS action from others?
   - Is it redundant with another keyword?

3. **Call prune-keywords API:**
   ```bash
   curl -X POST "https://jxuzqcbqhiaxmfitzxlo.supabase.co/functions/v1/prune-keywords" \
     -H "Authorization: Bearer $PUSH_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "action_id": "UUID",
       "remove_keywords": ["RealtimeManager", "bug", "fix"],
       "source": "claude-code",
       "reason": "Removed code identifier and generic terms"
     }'
   ```

### Quality Over Quantity

A lean vocabulary of 20-30 high-quality spoken terms is better than
50 mixed-quality terms. Prune aggressively.
```

### 13.9 Implementation Plan for Pruning

#### Phase P1: Cross-Source Deduplication (Immediate)

**Goal:** Prevent duplicates between Connect and Learned keywords at write time

**Tasks:**
1. Update `learn-keywords` edge function to fetch `action_description`
2. Build combined set of existing keywords (both sources)
3. Filter incoming keywords against combined set
4. Update response to indicate source of duplicates

**Effort:** ~1 hour
**Priority:** High (fixes current gap)

#### Phase P2: get-action-context Endpoint

**Goal:** Enable Claude to fetch full vocabulary context before pruning

**Tasks:**
1. Create new `get-action-context` edge function
2. Return both `connect_keywords` and `learned_keywords`
3. Include `pruning_recommended` flag
4. Add to plugin's API utilities

**Effort:** ~1.5 hours
**Priority:** High

#### Phase P3: prune-keywords Endpoint

**Goal:** Enable Claude to remove low-quality keywords

**Tasks:**
1. Create new `prune-keywords` edge function
2. Implement case-insensitive removal logic
3. Return remaining keywords for confirmation
4. Add to plugin's API utilities

**Effort:** ~1.5 hours
**Priority:** High

#### Phase P4: learn-keywords Response Enhancement

**Goal:** Signal when pruning is recommended

**Tasks:**
1. Add `pruning_recommended` field (true when `total >= 40`)
2. Add helpful message suggesting pruning
3. Ensure `current_keywords` is returned (already done)

**Effort:** ~30 minutes
**Priority:** Medium

#### Phase P5: Skill Prompt Update for Pruning

**Goal:** Guide Claude through pruning process

**Tasks:**
1. Add pruning section to SKILL.md
2. Include criteria, process, and examples
3. Add CLI helpers if needed

**Effort:** ~30 minutes
**Priority:** Medium

#### Phase P6: Testing & Validation

**Goal:** Verify end-to-end pruning flow

**Test scenarios:**
1. Add keywords until `pruning_recommended` triggers
2. Fetch action context, verify both keyword sources visible
3. Prune some keywords, verify removal
4. Add new keywords, verify space available
5. Verify iOS sync receives pruned list

**Effort:** ~1 hour
**Priority:** High

### 13.10 Future Evolution: Usage-Informed Pruning

If vocabulary quality becomes a persistent issue, usage tracking can be added:

```typescript
// Future: Usage-informed pruning data
{
  "action_id": "uuid",
  "learned_keywords": [
    { "keyword": "realtime", "added_at": "...", "match_count": 12 },
    { "keyword": "sync", "added_at": "...", "match_count": 8 },
    { "keyword": "code", "added_at": "...", "match_count": 0 }  // Never helped
  ],
  "usage_summary": {
    "never_matched": ["code", "bug", "fix"],
    "low_usage": ["authentication"],
    "high_usage": ["realtime", "sync", "swift"]
  }
}
```

**When to add usage tracking:**
- If LLM-native pruning proves insufficient
- If vocabulary quality doesn't improve over time
- If users request data-driven vocabulary management

**For now:** LLM-native pruning is simpler, more aligned with philosophy, and likely sufficient.

### 13.11 Pruning Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-01-29 | LLM-native over usage-based | Simpler, no instrumentation needed |
| 2026-01-29 | Threshold at 40 keywords | Buffer before 50 cap |
| 2026-01-29 | Cross-source dedup at write | Prevent obvious redundancy |
| 2026-01-29 | Separate prune-keywords API | Clear semantics, audit trail |
| 2026-01-29 | get-action-context for full view | Need both sources for informed pruning |

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

**AppleWhisper (iOS App):**
- `/docs/20260129_multi_source_keyword_learning_architecture.md` - Overall architecture
- `/docs/20260128_user_profile_simple_memory_research.md` - User profile research
- `App/Services/KeywordLearningService.swift` - iOS keyword learning
- `App/Data/Action.swift` - `combinedKeywords` computed property

**Supabase Edge Functions:**
- `supabase/functions/learn-keywords/index.ts` - Keyword learning endpoint ✅
- `supabase/functions/get-action-context/index.ts` - Full context endpoint (PLANNED)
- `supabase/functions/prune-keywords/index.ts` - Keyword pruning endpoint (PLANNED)

**Push-Todo Plugin:**
- `scripts/fetch_task.py` - `learn_vocabulary()` utility
- `SKILL.md` - Vocabulary learning & pruning guidance

---

## Appendix C: Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-01-29 | LLM-native over regex | Regex extracts code; LLM understands speech |
| 2026-01-29 | Vocabulary not tags | Purpose is voice matching, not project description |
| 2026-01-29 | Skill prompt guidance | Let Claude reason, don't hardcode extraction |
| 2026-01-29 | Keep server merge | Multiple sources contribute; server dedupes |
| 2026-01-29 | LLM-native pruning over usage-decay | Simpler, no instrumentation, aligned with philosophy |
| 2026-01-29 | Pruning threshold at 40 | Buffer before 50 cap, proactive maintenance |
| 2026-01-29 | Cross-source dedup at write | Prevent obvious redundancy between Connect/Learned |
| 2026-01-29 | Separate prune-keywords API | Clear semantics, audit trail, explicit action |
| 2026-01-29 | get-action-context endpoint | Need both keyword sources for informed pruning |
