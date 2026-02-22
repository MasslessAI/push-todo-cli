# Claude Code & LLM Performance Research

Research into Claude Code ("CloudCode") and its underlying LLM models — architecture, performance, and implementation patterns relevant to the Push Voice Tasks project.

**Date:** February 2026
**Task:** Push #1579

---

## Table of Contents

1. [Claude Code Architecture](#1-claude-code-architecture)
2. [Underlying LLM Models](#2-underlying-llm-models)
3. [Performance Benchmarks](#3-performance-benchmarks)
4. [Implementation Patterns](#4-implementation-patterns)
5. [Competitive Landscape](#5-competitive-landscape)
6. [Implications for Push](#6-implications-for-push)

---

## 1. Claude Code Architecture

Claude Code is Anthropic's agentic coding tool — a full autonomous agent that understands codebases, executes commands, edits files, and orchestrates multi-file changes through natural language.

### Core Design

The architecture is built around a **single-threaded master agent loop** with:

- **~18 built-in tools** (Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, Task, TodoWrite, etc.)
- **Subagent spawning** for parallel/isolated work via the `Task` tool
- **Human-in-the-loop steering** via an attention queue for real-time interruption
- **Memory persistence** through CLAUDE.md files and auto-memory directories

### Agentic Loop

The core execution is minimal by design:

```
while (response includes tool_call):
    execute tool → feed results back → get next response
```

When given a task, Claude works cyclically through three phases:
1. **Gather context** — search files, read code, understand the problem
2. **Take action** — edit files, run commands
3. **Verify results** — run tests, check output, validate

### Permission Model

Multiple layers of protection:
- Write operations and risky commands require explicit approval
- Declarative rules in `settings.json`: deny → allow → ask (priority order)
- Hooks system for programmatic enforcement (PreToolUse, PostToolUse, etc.)

### Deployment Modes

| Mode | Use Case | Key Feature |
|------|----------|-------------|
| **Interactive CLI** | Developer workstation | Full human-in-the-loop |
| **Headless (`-p`)** | CI/CD, scripts | `maxTurns` limits, JSON output |
| **Agent SDK** | Programmatic | Python & TypeScript libraries |
| **IDE Extension** | VS Code, JetBrains, Xcode | Inline diffs, proposals |

### Extensibility Stack

| Layer | What It Provides |
|-------|------------------|
| **Plugins** | Shareable bundles of skills, agents, hooks, MCP servers |
| **Subagents** | Markdown-defined specialists in `.claude/agents/` |
| **Skills** | Model-invoked capabilities with SKILL.md definitions |
| **Hooks** | Deterministic lifecycle callbacks (shell, prompt, or agent-based) |
| **MCP Servers** | External tool integration via Model Context Protocol |

---

## 2. Underlying LLM Models

### Current Model Lineup (February 2026)

| Model | Released | Context | Max Output | Pricing (per 1M tokens) |
|-------|----------|---------|------------|-------------------------|
| **Opus 4.6** | Feb 5, 2026 | 200K | 128K | $5 in / $25 out |
| **Sonnet 4.6** | Feb 17, 2026 | 200K | 64K | $3 in / $15 out |
| **Opus 4.5** | Nov 24, 2025 | 200K | 64K | $5 in / $25 out |
| **Sonnet 4.5** | Sep 29, 2025 | 200K | 64K | $3 in / $15 out |
| **Haiku 4.5** | Oct 2025 | 200K | 64K | $1 in / $5 out |

All models support prompt caching (up to 90% input cost reduction) and Batch API (50% discount).

A **1M token context window** is available in beta for Opus 4.6, Sonnet 4.6, and Sonnet 4.5.

### Architecture

- **Dense transformer** (not mixture-of-experts)
- Trained with **Constitutional AI (CAI)**: self-critique + revision → RLAIF + RLHF
- Parameter count not officially disclosed
- Supports **extended thinking** — internal chain-of-thought reasoning before answering

### Extended Thinking

Extended thinking lets Claude produce internal reasoning before its final answer:
- Minimum budget: 1,024 thinking tokens
- Dramatically improves benchmark scores (e.g., +17 points on Arena Code for Opus 4.5)
- **Adaptive thinking** (new in 4.6): Claude dynamically determines thinking depth based on complexity

### Key Capabilities

| Capability | Details |
|------------|---------|
| **Tool use** | Structured JSON function calling with `strict: true` for schema guarantees |
| **Streaming** | Fine-grained tool parameter streaming (Sonnet 4.5+) |
| **Context awareness** | Models track remaining context window (Sonnet 4.6, Sonnet 4.5, Haiku 4.5) |
| **Interleaved thinking** | Think between tool calls for multi-step reasoning |

---

## 3. Performance Benchmarks

### SWE-bench Verified (Real-world GitHub Issue Resolution)

| Model | Score |
|-------|-------|
| **Claude Opus 4.5** | **80.9%** (first to exceed 80%) |
| Claude Opus 4.6 (Thinking) | 80.8% |
| Claude Sonnet 4.6 | 79.6% |
| Gemini 3 Pro | 76.8% |
| GPT-5.2 | 74.9% |
| Claude Haiku 4.5 | 73.3% |

### Other Coding Benchmarks

| Benchmark | Model | Score |
|-----------|-------|-------|
| HumanEval (code gen) | Opus 4.6 | 95.0% |
| Aider Polyglot (8 languages) | Opus 4.5 | 89.4% |
| Terminal-Bench 2.0 | Opus 4.6 | 65.4% |

### Reasoning Benchmarks

| Benchmark | Model | Score |
|-----------|-------|-------|
| ARC-AGI 2 (pattern reasoning) | Opus 4.6 | 68.8% |
| GPQA Diamond (PhD-level science) | Opus 4.6 | 91.3% |
| OSWorld (agentic computer use) | Opus 4.6 | 72.7% |

### Context Window Management

- **Auto-compaction** triggers at ~92-95% utilization
- Manual compaction via `/compact` command
- **ToolSearch** reduces context usage by up to 95% with lazy tool loading
- Advanced tool use optimizations: 43,588 → 27,297 tokens average (37% reduction)

### Cost Efficiency

| Tier | Monthly Price |
|------|---------------|
| Claude Pro | $20/mo |
| Claude Max 5x | $100/mo (Opus access) |
| Claude Max 20x | $200/mo |

---

## 4. Implementation Patterns

### Agent SDK (Programmatic Access)

Available in Python (`claude-agent-sdk`) and TypeScript (`@anthropic-ai/claude-agent-sdk`).

**Python example:**
```python
from claude_agent_sdk import query, ClaudeAgentOptions

async for message in query(
    prompt="Find and fix the bug in auth.py",
    options=ClaudeAgentOptions(allowed_tools=["Read", "Edit", "Bash"]),
):
    print(message)
```

**TypeScript example:**
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Find and fix the bug in auth.py",
  options: { allowedTools: ["Read", "Edit", "Bash"] }
})) {
  console.log(message);
}
```

### Headless / CI Mode

```bash
# Simple query
claude -p "What does the auth module do?"

# JSON output with tool restrictions
claude -p "Fix test failures" --output-format json --allowedTools "Bash,Read,Edit"

# Resume a conversation
claude -p "Continue the review" --resume "$session_id"
```

### Hooks System

Hooks fire at lifecycle points for enforcement and automation:

| Event | Purpose | Can Block? |
|-------|---------|------------|
| `SessionStart` | Initialize environment | No |
| `PreToolUse` | Gate tool execution | Yes |
| `PostToolUse` | React to results | No (feedback) |
| `Stop` | Verify completion | Yes |
| `SessionEnd` | Cleanup, reporting | No |

Configuration in `.claude/settings.json`:
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": ".claude/hooks/validate-command.sh"
      }]
    }]
  }
}
```

### MCP Integration

```bash
# Add an MCP server
claude mcp add --transport http notion https://mcp.notion.com/mcp

# Stdio-based local server
claude mcp add --transport stdio my-tool -- npx -y my-mcp-server
```

### Subagent Definition

Place in `.claude/agents/my-agent.md`:
```markdown
---
name: my-agent
description: Specialist for specific tasks
tools: Read, Glob, Grep
model: sonnet
---

Your instructions here.
```

### Performance Optimization Strategies

1. **Prompt caching** — 90% reduction on cached input tokens (1-hour TTL)
2. **Model selection** — Haiku for exploration, Sonnet for implementation, Opus for complex reasoning
3. **Reasoning effort** — `low`/`medium`/`high`/`max` controls thinking depth
4. **Subagent delegation** — offload verbose tasks to isolated contexts
5. **Tool search** — lazy load MCP tools to preserve context
6. **Batch API** — 50% discount for non-time-sensitive workloads
7. **Compaction tuning** — `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` for earlier compaction

---

## 5. Competitive Landscape

| Dimension | Claude Code | GitHub Copilot | Cursor | OpenAI Codex CLI |
|-----------|-------------|----------------|--------|------------------|
| **Type** | Terminal-native agent | IDE extension | AI-native IDE | Terminal agent |
| **Autonomy** | Full agentic, self-correcting | Autocomplete + chat | Composer mode | Agentic with sandbox |
| **Context** | 200K tokens (1M beta) | Varies by model | Project-wide | 200K tokens |
| **Model** | Claude (Sonnet/Opus) | Multi-model | Multi-model | GPT-4.1 / o3/o4-mini |
| **Best For** | Complex refactors, CI/CD | Pattern-based coding | Rapid prototyping | Terminal tasks |
| **SWE-bench** | 80.9% (Opus 4.5) | N/A | N/A | ~75% (GPT-5.2) |
| **Pricing** | $20-200/mo or API | $10-19/user/mo | $20-40/user/mo | API-based |

### Key Differentiators

- **Benchmark leadership**: Opus 4.5/4.6 hold #1 and #2 globally on SWE-bench Verified
- **Deepest terminal integration**: Operates as a peer in your shell
- **Most extensible**: Plugins, subagents, hooks, MCP, Agent SDK composition
- **Agent Teams** (Opus 4.6): 16 parallel agents built a 100K-line C compiler in Rust in two weeks
- **Revenue validation**: $1B annualized run-rate by November 2025

---

## 6. Implications for Push

### Current Integration Points

Push Voice Tasks already integrates with Claude Code via:
- **Plugin system** — `/push-todo` slash command
- **SessionStart/SessionEnd hooks** — task lifecycle management
- **Skill definitions** — SKILL.md for task display and management

### Performance Considerations

| Factor | Impact on Push |
|--------|----------------|
| **Context window (200K)** | Task descriptions and transcripts easily fit; compaction handles long sessions |
| **Subagent isolation** | Push tasks can delegate to specialized subagents without polluting main context |
| **Hooks lifecycle** | SessionStart/SessionEnd hooks enable reliable task tracking and completion reporting |
| **Model tiering** | Haiku for task listing/search, Sonnet for task implementation, Opus for complex tasks |
| **Prompt caching** | System prompts and plugin instructions cached, reducing per-task overhead |

### Opportunities

1. **Agent SDK integration** — Programmatic task execution via `query()` for automated workflows
2. **MCP servers** — Push could expose tasks as an MCP resource for deeper integration
3. **Headless mode** — Automated task processing in CI/CD pipelines
4. **Subagent patterns** — Dedicated task-execution subagents with domain-specific tools
5. **Multi-model strategy** — Route tasks to appropriate model tier based on complexity

### Architecture Alignment

Push's plugin architecture (hooks + skills + MCP) aligns well with Claude Code's extensibility stack. The `SessionStart` hook for task notification and `SessionEnd` hook for completion reporting leverage the most appropriate lifecycle events. The E2EE design for task sync is orthogonal to Claude Code's permission model and adds a security layer that Claude Code doesn't provide natively.

---

## Sources

### Official Documentation
- [Claude Code Overview](https://code.claude.com/docs/en/overview)
- [How Claude Code Works](https://code.claude.com/docs/en/how-claude-code-works)
- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Models Overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Context Windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)
- [Extended Thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Adaptive Thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)
- [Tool Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)
- [Hooks Reference](https://code.claude.com/docs/en/hooks)
- [MCP Integration](https://code.claude.com/docs/en/mcp)
- [Plugins](https://code.claude.com/docs/en/plugins)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Headless Mode](https://code.claude.com/docs/en/headless)
- [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)

### Announcements & Analysis
- [Introducing Claude 4 — Anthropic](https://www.anthropic.com/news/claude-4)
- [Claude Opus 4.5 — Anthropic](https://www.anthropic.com/news/claude-opus-4-5)
- [Claude Opus 4.6 — TechCrunch](https://techcrunch.com/2026/02/05/anthropic-releases-opus-4-6-with-new-agent-teams/)
- [Claude Sonnet 4.6 — Simon Willison](https://simonwillison.net/2026/Feb/17/claude-sonnet-46/)
- [Opus 4.6 Benchmarks — Vellum](https://www.vellum.ai/blog/claude-opus-4-6-benchmarks)
- [SWE-bench — Vals.ai](https://www.vals.ai/benchmarks/swebench)
- [Claude Code Agent Loop — PromptLayer](https://blog.promptlayer.com/claude-code-behind-the-scenes-of-the-master-agent-loop/)
- [Xcode Agentic Coding — Apple](https://www.apple.com/newsroom/2026/02/xcode-26-point-3-unlocks-the-power-of-agentic-coding/)
