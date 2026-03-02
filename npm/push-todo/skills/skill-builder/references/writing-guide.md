# Skill Writing Guide

This document provides comprehensive guidance on writing effective skills, merging best practices from the Anthropic Skill Creator methodology with plugin-specific patterns.

## Writing Philosophy

### Theory of Mind Over Rigid Rules

The most important principle: **explain WHY, not just WHAT**.

Skills are instructions for another instance of Claude. Claude responds better to understanding the reasoning behind a rule than to a rigid mandate:

```markdown
# Good - explains the why
Keep SKILL.md under 500 lines. The context window is a shared resource between
the skill, the user's code, and Claude's reasoning. A 2000-line skill crowds
out the actual work.

# Bad - rigid mandate without reasoning
SKILL.md MUST be under 500 lines. NEVER exceed this limit.
```

Heavy-handed "MUST" and "NEVER" patterns without explanation often backfire — they make instructions feel arbitrary and don't help Claude make good judgment calls in edge cases.

### Set Appropriate Degrees of Freedom

Not everything needs to be locked down. Match the constraint level to the task:

| Freedom Level | When | Example |
|---------------|------|---------|
| **High** | Creative decisions, subjective quality | "Choose an appropriate visualization type" |
| **Medium** | Common patterns with acceptable variants | "Use imperative form, though brief explanations can use passive voice" |
| **Low** | Exact format requirements, API contracts | "Output MUST be valid JSON matching this schema exactly" |

Only lock things down when the consequences of deviation are real. For output format of an API? Lock it down. For prose style? Leave room for judgment.

### Concise is Key

The context window is a public good. Every token the skill consumes is a token unavailable for the user's actual work.

- Target 1,500-2,000 words for SKILL.md body
- Maximum 500 lines (including code blocks and tables)
- Move detailed content to `references/` files
- Use references for content over 300 lines that isn't always needed

If your SKILL.md is approaching the limit, add hierarchy:
- Table of contents for sections
- "When to read" annotations for references
- Grep patterns for large reference files

## Frontmatter Description

### The Most Important Field

The `description` field determines when Claude uses the skill. It is the ONLY thing Claude sees during the triggering decision (the body is never consulted).

### Format

Use third-person format with specific trigger phrases:

```yaml
---
name: skill-name
description: >
  This skill should be used when the user asks to "specific phrase 1",
  "specific phrase 2", or mentions related concepts. Use whenever...
version: 0.1.0
---
```

### Be "Pushy"

Skills undertrigger more often than they overtrigger. Combat this by being explicit about when the skill should activate:

```yaml
# Good - pushy, catches near-misses
description: >
  Build interactive dashboards for internal data. Make sure to use this skill
  whenever the user mentions dashboards, data visualization, internal metrics,
  KPI tracking, or wants to display any kind of company data, even if they
  don't explicitly ask for a "dashboard."

# Bad - passive, will miss many valid triggers
description: Provides guidance for dashboard creation.
```

### Include Distinguishing Context

When multiple skills could match, help Claude distinguish:

```yaml
description: >
  ...Use for interactive dashboards with filtering and drill-down.
  Do NOT use for simple static charts (use data-visualization skill)
  or for data analysis queries (use data-analysis skill).
```

### Common Description Mistakes

| Mistake | Example | Fix |
|---------|---------|-----|
| Vague | "Provides guidance for X" | "This skill should be used when..." |
| No trigger phrases | "Helps with development" | Include specific user phrases |
| Wrong person | "Use this skill when you..." | "This skill should be used when the user..." |
| Too narrow | "Used for creating PDF reports" | Include related queries users might make |

## Body Writing Style

### Imperative Form

Write using verb-first instructions, not second person:

```markdown
# Good (imperative)
Parse the frontmatter using YAML.
To accomplish X, do Y.
Configure the server with authentication.

# Bad (second person)
You should parse the frontmatter...
You need to configure the server...
If you want to do X, you can...
```

### Objective, Instructional Language

Focus on what to do, not who should do it:

```markdown
# Good
Start by reading the configuration file.
Validate the input before processing.
Use the grep tool to search for patterns.

# Bad
You can parse the frontmatter...
Claude should extract fields...
The user might validate values...
```

### When to Break the Rules

The imperative form is a strong default, but brief explanations benefit from natural prose:

```markdown
# Step 1: Initialize the Project
Create the directory structure and configure the build system.

Note: The build system uses incremental compilation, so initial setup
is slow but subsequent builds are fast. This is expected behavior.
```

The note uses passive voice and explanation — that's fine for a clarifying aside.

## Progressive Disclosure in Practice

### What Goes in SKILL.md

Content that is **always needed** when the skill triggers:
- Core concepts and overview
- Essential procedures and workflows
- Quick reference tables
- Pointers to references/examples/scripts
- Most common use cases

### What Goes in references/

Content that is **sometimes needed**:
- Detailed patterns and advanced techniques
- Comprehensive API documentation
- Migration guides and edge cases
- Extensive examples and walkthroughs

Each reference file can be large (2,000-5,000+ words).

### What Goes in scripts/

Executable utilities that are **used directly**:
- Validation tools
- Testing helpers
- Parsing utilities
- Automation scripts

Should be executable and documented.

### What Goes in assets/

Files that appear **in the output**:
- Templates (HTML, PPTX, etc.)
- Images and icons
- Boilerplate code
- Sample documents

### Referencing Resources

Always tell Claude where to find additional information and WHEN to read it:

```markdown
## Additional Resources

For detailed patterns and techniques, consult:
- **`references/patterns.md`** - Read when implementing complex workflows
- **`references/advanced.md`** - Read for edge cases and optimization
- **`references/api-reference.md`** - Read when making API calls

Working examples in `examples/`:
- **`examples/basic.sh`** - Minimal working example
- **`examples/advanced.sh`** - Full-featured example
```

## Examples and Output Formats

### Example Pattern

Show input/output pairs to make expectations concrete:

```markdown
## Format Example

**Example 1:**
Input: Added user authentication with JWT tokens
Output: feat(auth): implement JWT-based authentication

**Example 2:**
Input: Fixed null pointer exception in user profile page
Output: fix(profile): handle null user data gracefully
```

### Output Format Definition

When exact format matters, provide a template:

```markdown
## Report Structure

ALWAYS use this exact template:

# [Title]
## Executive Summary
## Key Findings
## Recommendations
```

## Common Mistakes to Avoid

### Mistake 1: Everything in SKILL.md

A single 8,000-word SKILL.md file bloats context every time the skill loads:

```
# Bad
skill-name/
└── SKILL.md  (8,000 words)

# Good
skill-name/
├── SKILL.md  (1,800 words)
└── references/
    ├── patterns.md (2,500 words)
    └── advanced.md (3,700 words)
```

### Mistake 2: Duplicated Content

Information should live in ONE place — either SKILL.md or a reference file, not both. If you summarize a reference in SKILL.md, make it a brief pointer, not a full reproduction.

### Mistake 3: Missing Resource References

Claude can't use files it doesn't know about:

```markdown
# Bad - Claude doesn't know references exist
[Core content with no mention of references/]

# Good - Claude knows where to find more
For detailed patterns, read `references/patterns.md`.
Run `scripts/validate.sh` to check your configuration.
```

### Mistake 4: Overly Rigid Instructions

```markdown
# Bad - rigid without reasoning
MUST use exactly 3 sections. NEVER include more than 5 bullet points.
ALL headings MUST be title case.

# Good - explains reasoning, allows judgment
Use 3-5 sections to keep reports scannable. More than 5 sections
makes it hard for stakeholders to find what matters. Title case
headings are preferred for consistency, but prioritize clarity.
```

## Minimal Skill Template

For simple skills (domain knowledge, no complex resources):

```
skill-name/
└── SKILL.md
```

## Standard Skill Template (Recommended)

For most skills:

```
skill-name/
├── SKILL.md
├── references/
│   └── detailed-guide.md
└── examples/
    └── working-example.sh
```

## Complete Skill Template

For complex domains:

```
skill-name/
├── SKILL.md
├── references/
│   ├── patterns.md
│   └── advanced.md
├── examples/
│   ├── basic.sh
│   └── advanced.json
└── scripts/
    └── validate.sh
```
