# Description Optimization Reference

This document details the automated workflow for improving a skill's description to trigger accurately.

## Why Description Optimization Matters

The skill description is the **only** thing Claude sees when deciding whether to invoke a skill. The SKILL.md body is never read during the triggering decision — only the frontmatter `description` field.

A poorly written description means:
- **Undertriggering**: Skill doesn't activate when it should (more common)
- **Overtriggering**: Skill activates for unrelated requests (less common but disruptive)

## The Optimization Pipeline

### Step 1: Generate Trigger Eval Queries

Create 20 realistic eval queries:
- **8-10 should-trigger**: Realistic requests where the skill should activate
- **8-10 should-not-trigger**: Near-miss requests from adjacent domains

```json
[
  {
    "query": "Help me build a dashboard to track monthly sales by region",
    "should_trigger": true
  },
  {
    "query": "Write a Python script to parse CSV files",
    "should_trigger": false
  }
]
```

**Critical: Make queries realistic and specific.** Not "make a dashboard" but "help me build a dashboard to track monthly sales by region with filtering by quarter." Real user requests have context, detail, and sometimes ambiguity.

**For should-not-trigger queries**: Choose requests that are semantically adjacent but belong to different domains. Keyword matching would incorrectly trigger, but semantic understanding should not. This is what makes good negative examples hard to write.

### Step 2: Review Queries with User

Present the eval queries conversationally:

```
## Trigger Eval Queries

### Should Trigger (8 queries)
1. "Help me build a dashboard to track monthly sales..." ✅
2. "I need a visualization of our user growth metrics..." ✅
...

### Should NOT Trigger (8 queries)
1. "Write a Python script to parse CSV files" ❌
2. "Create a bar chart for my presentation" ❌
...

Any queries you'd like to add, remove, or modify?
```

Let the user edit and approve before proceeding.

### Step 3: Run the Optimization Loop

Use `scripts/run_loop.py` for automated optimization:

```bash
python3 -m scripts.run_loop \
  --skill-path <path/to/skill> \
  --eval-set <path/to/trigger_evals.json> \
  --rounds 5 \
  --verbose
```

The loop:
1. **Splits evals** into train (75%) and test (25%) sets
2. **Evaluates** the current description against all evals using `run_eval.py`
3. **Generates improvement** using `improve_description.py` (Claude with extended thinking)
4. **Re-evaluates** the improved description
5. **Reports** train accuracy, test accuracy, and holdout performance
6. Repeats for the specified number of rounds

### Step 4: Review Results

Generate an HTML report:

```bash
python3 -m scripts.generate_report \
  --loop-output <path/to/loop_results.json> \
  --output <path/to/report.html>
```

The report shows:
- Accuracy progression across rounds
- Per-query trigger/no-trigger decisions
- Train vs test performance (overfitting detection)
- The winning description with its scores

### Step 5: Apply the Result

Update the skill's frontmatter with the optimized description.

## Manual Optimization (Without Scripts)

If you prefer not to use the automated pipeline:

1. **Generate eval queries** as described above
2. **Test mentally**: For each query, does the current description clearly indicate the skill should/shouldn't trigger?
3. **Identify gaps**: Which queries would the current description miss?
4. **Rewrite**: Make the description more "pushy" for missed should-trigger cases
5. **Verify**: Ensure the rewrite doesn't cause overtriggering for should-not cases

## Writing Effective Descriptions

### Be "Pushy"

Descriptions should proactively claim territory:

```yaml
# Good - pushy, specific, comprehensive
description: >
  Create dashboards for internal data visualization. This skill should be used
  whenever the user mentions dashboards, data visualization, internal metrics,
  KPI tracking, or wants to display any kind of company data, even if they
  don't explicitly ask for a "dashboard."

# Bad - passive, vague
description: Helps with data visualization tasks.
```

### Include Near-Miss Context

Explicitly mention adjacent use cases to help Claude distinguish:

```yaml
description: >
  ...Use for interactive dashboards with filtering and drill-down.
  Do NOT use for simple static charts (use data-visualization skill instead)
  or for data analysis queries (use data-analysis skill instead).
```

### Cover Multiple Phrasings

Users don't always use the same words:

```yaml
description: >
  ...Use when user asks to "build a dashboard", "create a metrics view",
  "visualize our data", "make a report with charts", or "track KPIs".
```

## Script Details

### `run_eval.py`

Tests whether a skill description triggers correctly for a set of queries:

```bash
python3 -m scripts.run_eval \
  --skill-path <path/to/skill> \
  --eval-set <path/to/evals.json> \
  --verbose
```

Uses the Anthropic SDK to simulate Claude's triggering decision. Returns accuracy metrics and per-query results.

### `improve_description.py`

Uses Claude with extended thinking to generate an improved description:

```bash
python3 -m scripts.improve_description \
  --skill-path <path/to/skill> \
  --eval-results <path/to/eval_results.json>
```

The improvement process:
1. Analyzes which queries the current description gets wrong
2. Identifies patterns in the failures
3. Generates an improved description that addresses the failures
4. Returns the new description for evaluation

### `run_loop.py`

Combines eval + improve in an iterative loop with train/test split:

```bash
python3 -m scripts.run_loop \
  --skill-path <path/to/skill> \
  --eval-set <path/to/evals.json> \
  --rounds 5
```

The train/test split prevents overfitting — if the description scores well on training queries but poorly on holdout queries, it's memorizing examples rather than learning general patterns.

### `generate_report.py`

Generates an interactive HTML report from loop results:

```bash
python3 -m scripts.generate_report \
  --loop-output <path/to/results.json> \
  --output <path/to/report.html>
```

Open the HTML file in a browser to review results interactively.

## Dependencies

All scripts require:
- Python 3.10+
- `anthropic` SDK: `pip install anthropic`
- `ANTHROPIC_API_KEY` environment variable set

The scripts use Claude's extended thinking capability for high-quality description generation.
