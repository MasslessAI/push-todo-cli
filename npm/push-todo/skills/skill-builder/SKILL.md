---
name: skill-builder
description: Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, update or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, optimize a skill's description for better triggering, or improve an existing skill's quality. This skill should be used whenever the user mentions "create a skill", "build a skill", "improve skill", "test skill", "eval skill", "benchmark skill", "skill description", "skill triggering", or asks to turn a workflow into a reusable skill.
version: 1.0.0
---

# Skill Builder

This skill guides the complete lifecycle of building, testing, and improving Claude Code skills — from initial idea through quantitative benchmarking and iterative refinement.

## The Core Loop

Skill development follows an iterative cycle:

1. **Capture Intent** — Understand what the skill should do and when it should trigger
2. **Interview & Research** — Gather details about edge cases, formats, and dependencies
3. **Write SKILL.md** — Create the skill with metadata and instructions
4. **Test** — Run eval cases to measure skill performance
5. **Evaluate** — Grade outputs, aggregate benchmarks, review with user
6. **Improve** — Refine based on feedback and data, then loop back to step 4

The job when using this skill is to figure out where in this loop the user currently is and help them move forward. Not every skill needs the full eval pipeline — a simple domain knowledge skill might only need steps 1-3, while a complex workflow skill benefits from the complete cycle.

## Communicating with the User

Adapt communication level to the user's context. If they're casually asking "help me make a skill," keep things simple. If they're asking about "eval assertions" and "benchmark variance," they want the full technical depth.

Brief explanations of technical terms are always appropriate:
- "assertions" = specific pass/fail checks on skill output
- "trigger eval" = test whether a description causes the skill to activate for the right queries
- "benchmark" = statistical comparison across multiple test runs

## About Skills

Skills are modular, self-contained packages that extend Claude's capabilities with specialized knowledge, workflows, and tools. They transform Claude from a general-purpose agent into a specialized agent equipped with procedural knowledge that no model can fully possess.

### What Skills Provide

1. **Specialized workflows** — Multi-step procedures for specific domains
2. **Tool integrations** — Instructions for working with specific file formats or APIs
3. **Domain expertise** — Company-specific knowledge, schemas, business logic
4. **Bundled resources** — Scripts, references, and assets for complex and repetitive tasks

### Anatomy of a Skill

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/     - Executable code (Python/Bash/etc.)
    ├── references/  - Documentation loaded as needed
    └── assets/      - Files used in output (templates, icons, fonts)
```

### Progressive Disclosure

Skills use a three-level loading system to manage context efficiently:

1. **Metadata (name + description)** — Always in context (~100 words)
2. **SKILL.md body** — When skill triggers (<500 lines ideal)
3. **Bundled resources** — As needed by Claude (unlimited)

This matters because the context window is a shared resource. Keep SKILL.md lean (under 500 lines) and use references/ for detailed content.

## Creating a Skill

### Step 1: Capture Intent

Start by understanding concrete examples of how the skill will be used. Good questions:

- "What functionality should the skill support?"
- "Can you give examples of how this skill would be used?"
- "What would a user say that should trigger this skill?"

Avoid asking too many questions at once. Start with the most important ones and follow up as needed.

### Step 2: Interview & Research

Analyze each example to identify reusable resources:

- Does the task require **rewriting the same code** each time? → Bundle a `scripts/` utility
- Does the task need **domain knowledge** to reference? → Create a `references/` file
- Does the task use **templates or assets** in its output? → Add to `assets/`

### Step 3: Write the SKILL.md

Initialize the skill directory:

```bash
mkdir -p skill-name/{references,scripts}
touch skill-name/SKILL.md
```

#### Frontmatter

The description is the most important part — it determines when Claude will use the skill:

```yaml
---
name: skill-name
description: Create new X, modify existing X, and optimize X performance. This skill should be used when the user asks to "specific phrase 1", "specific phrase 2", or mentions related concepts. Use whenever the user wants to...
version: 0.1.0
---
```

Make descriptions **"pushy"** — explicitly state when to use the skill, including near-miss scenarios:

> "Make sure to use this skill whenever the user mentions dashboards, data visualization, internal metrics, or wants to display any kind of company data, even if they don't explicitly ask for a 'dashboard.'"

This combats undertriggering, which is the more common failure mode.

#### Body

Write using **imperative form** (verb-first instructions). Use objective, instructional language:

```markdown
# Good
Parse the frontmatter using sed.
To accomplish X, do Y.

# Bad
You should parse the frontmatter...
If you need to do X, you can...
```

For detailed writing guidance including progressive disclosure patterns, degrees of freedom, and common mistakes, read `references/writing-guide.md`.

For plugin-specific skill patterns (auto-discovery, testing with `--plugin-dir`, packaging), read `references/plugin-skill-patterns.md`.

### Step 4: Create Test Cases

Draft 2-3 realistic test prompts that exercise the skill's core functionality. Save them in a workspace:

```json
{
  "skill_name": "my-skill",
  "evals": [
    {
      "id": 0,
      "prompt": "Realistic user request...",
      "expected_output": "Description of expected result",
      "assertions": ["Output contains X", "Format is correct", "Edge case Y handled"]
    }
  ]
}
```

## Running and Evaluating Test Cases

This is the heart of skill improvement. For the full eval framework details, read `references/eval-framework.md`.

### Overview

For each test case, spawn **two subagent runs simultaneously**:

- **With-skill run**: Uses the skill being developed
- **Baseline run**: Either no skill (new skills) or previous version (iterations)

While runs execute, draft assertions — specific pass/fail criteria for each test case.

After runs complete:

1. **Grade** outputs using the grader agent (`agents/grader.md`)
2. **Aggregate** results into benchmark statistics
3. **Review** with user — present findings conversationally
4. **Collect feedback** for the next iteration

### Workspace Structure

```
<skill-name>-workspace/
├── iteration-1/
│   ├── eval-0-name/
│   │   ├── with_skill/outputs/
│   │   ├── baseline/outputs/
│   │   └── eval_metadata.json
│   ├── benchmark.json
│   └── feedback.json
├── iteration-2/
│   └── [same structure]
└── skill-snapshot/  (previous version when improving)
```

## Improving the Skill

After reviewing eval results, apply improvements following these principles:

1. **Generalize from feedback** — Don't overfit to specific test cases. The skill must work across future uses.
2. **Keep the prompt lean** — Remove instructions that don't pull their weight.
3. **Explain the WHY** — Help Claude understand reasoning rather than following rigid rules. Prefer "This format matters because X" over "MUST use this format."
4. **Look for repeated work** — If all test runs independently wrote the same helper script, bundle it in `scripts/`.
5. **Set appropriate degrees of freedom** — High-stakes formatting? Lock it down. Creative decisions? Leave room for judgment.

### The Iteration Loop

1. Apply improvements to the skill
2. Rerun all test cases into `iteration-<N+1>/`
3. Compare against previous iteration
4. Read feedback and repeat until satisfied

For advanced comparison, use the **blind comparator** (`agents/comparator.md`) to eliminate bias — it judges two outputs without knowing which version produced them. Then use the **analyzer** (`agents/analyzer.md`) to explain why the winner won and generate actionable improvement suggestions.

## Description Optimization

After the skill is working well, optimize the description for accurate triggering.

### Quick Method

Generate 20 realistic eval queries:
- 8-10 that **should** trigger the skill
- 8-10 that **should not** (near-misses from adjacent domains)

Review with the user, then iteratively improve the description. For the full automated optimization pipeline using `scripts/run_loop.py`, read `references/description-optimization.md`.

### How Triggering Works

Claude decides whether to invoke a skill based on the skill's name and description (always in context) matched against the user's request. The SKILL.md body is never read during the triggering decision — only the frontmatter description matters.

## Validation

Before finalizing, validate the skill:

```bash
python3 scripts/quick_validate.py <path/to/skill>
```

This checks frontmatter format, required fields, description quality, and file organization.

### Manual Checklist

**Structure:**
- [ ] SKILL.md exists with valid YAML frontmatter
- [ ] `name` and `description` fields present
- [ ] Referenced files actually exist

**Description:**
- [ ] Includes specific trigger phrases users would say
- [ ] Lists concrete scenarios
- [ ] "Pushy" enough to combat undertriggering

**Content:**
- [ ] Body under 500 lines (use references/ for details)
- [ ] Imperative form, objective language
- [ ] Progressive disclosure applied

**Resources:**
- [ ] Scripts are executable and documented
- [ ] References don't duplicate SKILL.md content
- [ ] Examples are complete and working

## Bundled Scripts

This skill includes Python scripts for automated evaluation:

| Script | Purpose | Dependencies |
|--------|---------|-------------|
| `quick_validate.py` | Validate skill structure | `pyyaml` |
| `run_eval.py` | Test description triggering | `anthropic` |
| `improve_description.py` | Improve descriptions with Claude | `anthropic` |
| `run_loop.py` | Iterative eval + improve loop | `anthropic` |
| `generate_report.py` | HTML report generation | stdlib |
| `aggregate_benchmark.py` | Benchmark statistics | stdlib |

**Requirements:** Python 3.10+, `pip install anthropic pyyaml`

## Reference Files

For detailed documentation on specific topics:

| File | When to Read |
|------|-------------|
| `references/eval-framework.md` | Setting up and running the full eval pipeline |
| `references/description-optimization.md` | Automated description improvement workflow |
| `references/json-schemas.md` | JSON format specifications for all tracking files |
| `references/writing-guide.md` | Skill writing style, philosophy, and common mistakes |
| `references/plugin-skill-patterns.md` | Building skills within Claude Code plugins |

## Push Integration

This skill is bundled with the `push-todo` CLI. When working on a Push voice task (invoked via `/push-todo`), skills can report progress back to the Push iOS app using CLI commands.

### Available Callbacks

| Command | Purpose |
|---------|---------|
| `push-todo --mark-completed <uuid>` | Mark a task as done |
| `push-todo --mark-completed <uuid> --completion-comment "..."` | Mark done with summary |
| `push-todo --learn-vocabulary <uuid> --keywords 'term1,term2'` | Teach routing keywords |

### When to Use

These callbacks are relevant when:
- The user invoked `/push-todo` and selected a task to work on
- A skill completes work that resolves a Push task
- The daemon is executing a task autonomously

For skill-builder specifically: after creating or improving a skill as part of a Push task, mark it complete and contribute vocabulary terms (e.g., `skill,SKILL.md,eval,benchmark,frontmatter`).

### Not Always Relevant

Many skill-builder invocations have nothing to do with Push — the user just wants to create a skill. The Push callbacks only matter when there's an active Push task context. Don't call them unprompted.

## Agent Files

Specialized subagent instructions (read when spawning subagents for evaluation):

| File | Purpose |
|------|---------|
| `agents/grader.md` | Assertion-based output grading (8-step process) |
| `agents/comparator.md` | Blind A/B comparison between skill versions |
| `agents/analyzer.md` | Post-hoc analysis and improvement suggestions |
