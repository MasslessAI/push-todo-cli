# Eval Framework Reference

This document details the full evaluation pipeline for testing and benchmarking skills.

## Overview

The eval framework measures skill quality through parallel A/B testing: running the same task with and without the skill, then grading the outputs against predefined assertions. This provides quantitative evidence of whether a skill actually improves Claude's performance.

## Setting Up Evals

### Define Test Cases

Create an `evals.json` file in your workspace:

```json
{
  "skill_name": "my-skill",
  "evals": [
    {
      "id": 0,
      "prompt": "Realistic user request that exercises core functionality",
      "expected_output": "Description of what a good output looks like",
      "files": [],
      "assertions": [
        "Output contains the required X section",
        "Format matches the specified template",
        "Edge case Y is handled correctly"
      ]
    },
    {
      "id": 1,
      "prompt": "Another realistic request, ideally covering a different aspect",
      "expected_output": "Description of expected result",
      "assertions": [
        "Assertion 1",
        "Assertion 2"
      ]
    }
  ]
}
```

**Tips for good test cases:**
- Use realistic prompts that a real user would type
- Cover different aspects of the skill (not just the happy path)
- Make assertions specific and verifiable (not "output is good")
- Include edge cases where the skill might struggle

### Workspace Directory Layout

```
<skill-name>-workspace/
├── evals/
│   └── evals.json
├── iteration-1/
│   ├── eval-0-descriptive-name/
│   │   ├── with_skill/
│   │   │   ├── outputs/          # Files produced by the with-skill run
│   │   │   ├── transcript.md     # Execution trace
│   │   │   ├── metrics.json      # Tool call counts, output size
│   │   │   └── timing.json       # Tokens, duration
│   │   ├── baseline/
│   │   │   ├── outputs/
│   │   │   ├── transcript.md
│   │   │   ├── metrics.json
│   │   │   └── timing.json
│   │   ├── eval_metadata.json    # Eval prompt, assertions, files
│   │   └── grading.json          # Grader output
│   ├── benchmark.json            # Aggregated statistics
│   ├── benchmark.md              # Human-readable summary
│   └── feedback.json             # User feedback from review
├── iteration-2/
│   └── [same structure]
└── skill-snapshot/               # Previous skill version (when improving)
```

## Running Evals

### Step 1: Spawn Parallel Runs

For each test case, spawn **two subagent runs simultaneously** (in the same turn):

**With-skill run:**
```
Execute this task:
- Skill path: <path-to-skill>
- Task: <eval prompt from evals.json>
- Input files: <files from eval, or "none">
- Save outputs to: <workspace>/iteration-<N>/eval-<ID>/with_skill/outputs/
- Outputs to save: <description of what the user cares about>
```

**Baseline run:**
```
Execute this task:
- Skill path: <old-skill-snapshot> (for improving) OR none (for new skills)
- Task: <same eval prompt>
- Input files: <same files>
- Save outputs to: <workspace>/iteration-<N>/eval-<ID>/baseline/outputs/
- Outputs to save: <same outputs>
```

Spawning both in the same turn ensures they finish simultaneously. This saves time and makes comparison fair (same model, similar timing).

### Step 2: Draft Assertions While Runs Execute

While waiting for runs to complete, create quantitative assertions:

```json
{
  "eval_id": 0,
  "eval_name": "descriptive-name",
  "prompt": "The user's task",
  "assertions": [
    {
      "text": "Output contains required field X",
      "passed": null,
      "evidence": null
    }
  ]
}
```

Save to `eval_metadata.json` in the eval directory.

### Step 3: Capture Timing Data

When each run completes, immediately capture timing metrics:

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.3
}
```

Save to `timing.json` in the run's directory. This data is not persisted elsewhere — capture it immediately from the task completion notification.

### Step 4: Grade Outputs

Read `agents/grader.md` and follow its instructions to grade each run's outputs against the assertions. The grader produces `grading.json` with:

- Pass/fail for each assertion with evidence
- Summary statistics (pass rate)
- Execution metrics (tool calls, steps, errors)
- Claim verification (factual, process, quality claims)
- Eval feedback (suggestions for improving the assertions themselves)

**Key grading principles:**
- **PASS** requires clear evidence AND genuine task completion (not surface compliance)
- **FAIL** when no evidence, contradicting evidence, or superficial match
- Burden of proof is on the assertion to pass

### Step 5: Aggregate Benchmarks

After grading all evals, aggregate results:

```bash
python3 -m scripts.aggregate_benchmark <workspace>/iteration-<N> --skill-name <name>
```

This produces `benchmark.json` with:
- Per-run details (pass rate, timing, token usage)
- Aggregated statistics (mean, stddev)
- Delta measurements (with-skill vs baseline)
- Statistical comparisons

### Step 6: Review with User

Present findings conversationally:

1. **Summary**: "The skill improved pass rate from X% to Y% across N test cases"
2. **Per-eval breakdown**: Which tests improved, which regressed
3. **Timing impact**: Did the skill add significant token/time overhead?
4. **Specific examples**: Show the most interesting pass/fail cases

### Step 7: Collect Feedback

Record user feedback:

```json
{
  "reviews": [
    {
      "run_id": "eval-0-with_skill",
      "feedback": "the chart is missing axis labels",
      "timestamp": "2026-03-02T..."
    }
  ],
  "status": "complete"
}
```

Save to `feedback.json` in the iteration directory.

## Advanced: Blind Comparison

For rigorous comparison between skill versions, use the blind comparator (`agents/comparator.md`):

1. The comparator receives two outputs labeled "A" and "B" (not "with-skill" and "baseline")
2. It creates a rubric and scores both on content and structure (1-5 each)
3. It determines a winner based on quality, not knowledge of which version produced it

Follow up with the analyzer (`agents/analyzer.md`) to understand:
- Why the winner won (specific strengths with quotes)
- Why the loser lost (specific weaknesses)
- Prioritized improvement suggestions across 6 categories

## Benchmark Analysis Mode

When analyzing results across multiple iterations, the analyzer can identify:

- **Always-pass assertions**: Low differentiation value (both versions pass)
- **Always-fail assertions**: May indicate unrealistic expectations
- **Variable results**: Flaky assertions that need investigation
- **Difficulty patterns**: Which evals are hardest across all iterations
- **Resource variance**: Outliers in token/time usage

## Iterating

After collecting feedback:

1. Apply improvements to the skill (generalize, don't overfit)
2. Rerun ALL test cases into `iteration-<N+1>/`
3. Compare against previous iteration using benchmarks
4. Optionally run blind comparison for rigorous A/B
5. Review and iterate until satisfied

Each iteration builds on the last. The `benchmark.json` format supports iteration comparison out of the box.
