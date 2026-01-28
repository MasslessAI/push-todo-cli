#!/usr/bin/env python3
"""
Push Task Execution Daemon

Polls Supabase for queued tasks and executes them via Claude Code.
Auto-heals (starts) on any /push-todo command via daemon_health.py.

Architecture:
- Git branch = worktree = Claude session (1:1:1 mapping)
- Uses Claude's --continue to resume sessions in worktrees
- SessionEnd hook reports completion (no wrapper script needed)
- Certainty analysis determines execution mode (immediate, planning, or clarify)

Certainty-Based Execution:
- High certainty (>= 0.7): Execute immediately in standard mode
- Medium certainty (0.4-0.7): Execute with --plan flag (planning mode first)
- Low certainty (< 0.4): Update todo with clarification questions, skip execution

See: /docs/20260127_parallel_task_execution_research.md
See: /docs/20260127_parallel_task_execution_implementation_plan.md
See: /docs/20260127_certainty_based_execution_architecture.md
"""

import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Dict, Any

# Import certainty analyzer for task evaluation
# Add script directory to path since daemon runs from git repo, not scripts dir
_script_dir = str(Path(__file__).parent)
if _script_dir not in sys.path:
    sys.path.insert(0, _script_dir)

try:
    from certainty_analyzer import CertaintyAnalyzer, CertaintyLevel, CertaintyAnalysis
    CERTAINTY_ENABLED = True
except ImportError:
    CERTAINTY_ENABLED = False
    CertaintyAnalyzer = None
    CertaintyLevel = None
    CertaintyAnalysis = None

# Import project registry and machine ID for global daemon mode
try:
    from project_registry import get_registry
    from machine_id import get_machine_id, get_machine_name
    GLOBAL_MODE_ENABLED = True
except ImportError:
    GLOBAL_MODE_ENABLED = False
    get_registry = None
    get_machine_id = None
    get_machine_name = None

# ==================== Configuration ====================

API_BASE_URL = "https://jxuzqcbqhiaxmfitzxlo.supabase.co/functions/v1"
POLL_INTERVAL = 30  # seconds

# Max parallel Claude sessions
#
# Rate Limit Research (2026-01-27):
# ---------------------------------
# Claude Code can authenticate two ways, each with different limits:
#
# 1. MAX PLAN (claude login with subscription):
#    - Claude Max 20x: ~900 messages per 5-hour rolling window
#    - Shared across ALL parallel sessions
#    - Math: 5 sessions × 30 msgs/hr × 5 hrs = 750 msgs (safe under 900)
#    - Recommendation: 5 concurrent tasks for Max 20x plan
#
# 2. API KEY (ANTHROPIC_API_KEY environment variable):
#    - Tier 1 ($5):   50 RPM    → 2-3 concurrent sessions
#    - Tier 2 ($40):  1000 RPM  → 30-50 concurrent sessions
#    - Tier 3 ($200): 2000 RPM  → 60-100 concurrent sessions
#    - Tier 4 ($400): 4000 RPM  → 100-200 concurrent sessions
#
# Memory considerations (secondary constraint):
#    - Each Claude session uses ~400MB RAM
#    - 16GB Mac: 10-12 sessions max (RAM-bound)
#    - 32GB Mac: 20+ sessions (API-bound)
#
# Sources:
#    - https://platform.claude.com/docs/en/api/rate-limits
#    - https://support.claude.com/en/articles/11014257-about-claude-s-max-plan-usage
#    - https://www.truefoundry.com/blog/claude-code-limits-explained
#
MAX_CONCURRENT_TASKS = 5

# Certainty thresholds
CERTAINTY_HIGH_THRESHOLD = 0.7   # >= 0.7: Execute immediately
CERTAINTY_LOW_THRESHOLD = 0.4   # < 0.4: Request clarification

PID_FILE = Path.home() / ".push" / "daemon.pid"
LOG_FILE = Path.home() / ".push" / "daemon.log"
CONFIG_FILE = Path.home() / ".config" / "push" / "config"

# Track running tasks to avoid duplicates
running_tasks: Dict[int, subprocess.Popen] = {}


# ==================== Logging ====================

def log(message: str):
    """Log with timestamp to both stdout and log file."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] {message}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ==================== Configuration ====================

def get_api_key() -> Optional[str]:
    """Get API key from config file or environment."""
    # Check environment first
    if os.environ.get("PUSH_API_KEY"):
        return os.environ["PUSH_API_KEY"]

    # Then check config file
    if CONFIG_FILE.exists():
        try:
            for line in CONFIG_FILE.read_text().splitlines():
                line = line.strip()
                if line.startswith("export PUSH_API_KEY="):
                    value = line.split("=", 1)[1].strip()
                    return value.strip('"').strip("'")
        except Exception as e:
            log(f"Error reading config: {e}")
    return None


def get_git_remote() -> Optional[str]:
    """Get normalized git remote for current directory."""
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=5
        )
        if result.returncode != 0:
            return None

        url = result.stdout.strip()

        # Normalize: remove protocol prefixes
        for prefix in ["https://", "http://", "git@", "ssh://git@"]:
            if url.startswith(prefix):
                url = url[len(prefix):]
                break

        # Normalize: git@github.com:user/repo -> github.com/user/repo
        if ":" in url and "://" not in url:
            url = url.replace(":", "/", 1)

        # Remove .git suffix
        if url.endswith(".git"):
            url = url[:-4]

        return url
    except Exception:
        return None


# ==================== API Helpers ====================

def api_request(
    endpoint: str,
    method: str = "GET",
    data: Optional[Dict] = None,
    timeout: int = 15
) -> Optional[Dict]:
    """Make authenticated API request to Supabase."""
    api_key = get_api_key()
    if not api_key:
        log("No API key configured")
        return None

    url = f"{API_BASE_URL}/{endpoint}"

    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")

    if data:
        req.data = json.dumps(data).encode()

    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as e:
        log(f"API error ({e.code}): {e.reason}")
        return None
    except Exception as e:
        log(f"Request error: {e}")
        return None


def update_task_status(
    display_number: int,
    status: str,
    summary: Optional[str] = None,
    error: Optional[str] = None,
    certainty_score: Optional[float] = None,
    clarification_questions: Optional[List[Dict]] = None
):
    """Update task execution status via edge function."""
    payload: Dict[str, Any] = {
        "displayNumber": display_number,
        "status": status,
    }
    if summary:
        payload["summary"] = summary
    if error:
        payload["error"] = error
    if certainty_score is not None:
        payload["certaintyScore"] = certainty_score
    if clarification_questions:
        payload["clarificationQuestions"] = clarification_questions

    result = api_request("update-task-execution", method="PATCH", data=payload)
    if result and result.get("success"):
        log(f"Updated task #{display_number} to {status}")
    else:
        log(f"Failed to update task #{display_number}")


# ==================== Task Fetching ====================

def fetch_queued_tasks() -> List[Dict]:
    """
    Fetch tasks with execution_status='queued' from Supabase.

    Global Mode (GLOBAL_MODE_ENABLED=True):
        Fetches ALL queued tasks for the user, regardless of git_remote.
        Project routing happens in execute_task() via the local registry.

    Legacy Mode (GLOBAL_MODE_ENABLED=False):
        Filters by current directory's git_remote (original behavior).
    """
    # Build query params
    params = {"execution_status": "queued"}

    # In global mode, don't filter by git_remote - fetch ALL queued tasks
    # Project routing is handled in execute_task() using the local registry
    if not GLOBAL_MODE_ENABLED:
        # Legacy mode: filter by current directory's git_remote
        git_remote = get_git_remote()
        if git_remote:
            params["git_remote"] = git_remote

    query_string = urllib.parse.urlencode(params)
    endpoint = f"synced-todos?{query_string}"

    result = api_request(endpoint)
    if result:
        return result.get("todos", [])
    return []


# ==================== Certainty Analysis ====================

def analyze_task_certainty(task: Dict) -> Optional[CertaintyAnalysis]:
    """
    Analyze task content to determine execution certainty.

    Returns:
        CertaintyAnalysis if certainty module available, None otherwise
    """
    if not CERTAINTY_ENABLED or CertaintyAnalyzer is None:
        log("Certainty analysis not available, executing directly")
        return None

    content = (
        task.get("normalizedContent") or
        task.get("normalized_content") or
        task.get("summary") or
        ""
    )
    summary = task.get("summary")
    transcript = task.get("originalTranscript") or task.get("original_transcript")

    try:
        analyzer = CertaintyAnalyzer()
        analysis = analyzer.analyze(content, summary, transcript)

        display_num = task.get("displayNumber") or task.get("display_number")
        log(f"Task #{display_num} certainty: {analysis.score:.2f} ({analysis.level.value})")

        if analysis.reasons:
            for reason in analysis.reasons[:3]:  # Log top 3 reasons
                log(f"  - {reason.factor}: {reason.explanation}")

        return analysis

    except Exception as e:
        log(f"Certainty analysis failed: {e}")
        return None


def get_execution_mode(analysis: Optional[CertaintyAnalysis]) -> str:
    """
    Determine execution mode based on certainty analysis.

    Returns:
        "immediate" - Execute without planning
        "planning" - Execute with --plan flag first
        "clarify" - Request clarification, don't execute
    """
    if analysis is None:
        # No analysis available, default to immediate execution
        return "immediate"

    if analysis.score >= CERTAINTY_HIGH_THRESHOLD:
        return "immediate"
    elif analysis.score >= CERTAINTY_LOW_THRESHOLD:
        return "planning"
    else:
        return "clarify"


# ==================== Atomic Task Claiming ====================

def claim_task(display_number: int) -> bool:
    """
    Attempt to atomically claim a task for this machine.

    This prevents multi-Mac race conditions by only succeeding if
    the task's status is still 'queued'.

    Args:
        display_number: Task display number to claim

    Returns:
        True if claimed successfully, False if another machine got it
    """
    if not GLOBAL_MODE_ENABLED:
        # Legacy mode: no atomic claiming needed
        return True

    machine_id = get_machine_id()
    machine_name = get_machine_name()

    payload = {
        "displayNumber": display_number,
        "status": "running",
        "machineId": machine_id,
        "machineName": machine_name,
        "atomic": True  # Enable atomic claiming
    }

    result = api_request("update-task-execution", method="PATCH", data=payload)

    if not result:
        log(f"Task #{display_number} claim request failed (network error)")
        return False

    if result.get("claimed") is True:
        log(f"Task #{display_number} claimed by this machine ({machine_name})")
        return True

    if result.get("claimed") is False:
        claimed_by = result.get("claimedBy", "another machine")
        log(f"Task #{display_number} already claimed by {claimed_by}")
        return False

    # If 'claimed' not in response, treat as success (backward compatibility)
    if result.get("success"):
        return True

    return False


# ==================== Task Execution ====================

def get_project_path_for_task(git_remote: Optional[str]) -> Optional[str]:
    """
    Get local path for a project from the registry.

    Args:
        git_remote: Normalized git remote URL

    Returns:
        Local path or None if project not registered
    """
    if not GLOBAL_MODE_ENABLED or not git_remote:
        # Legacy mode or no git_remote: use current directory
        return str(Path.cwd())

    registry = get_registry()
    path = registry.get_path_without_update(git_remote)

    if path:
        return path

    # Not registered - return None
    return None


def get_worktree_path(display_number: int, project_path: Optional[str] = None) -> Path:
    """
    Get the worktree path for a task.

    Args:
        display_number: Task display number
        project_path: Optional project path (for global mode)

    Returns:
        Path where worktree should be created
    """
    if project_path:
        # Global mode: worktree in parent of project directory
        return Path(project_path).parent / f"push-{display_number}"
    else:
        # Legacy mode: worktree in parent of current working directory
        return Path.cwd().parent / f"push-{display_number}"


def create_worktree(display_number: int, project_path: Optional[str] = None) -> Optional[Path]:
    """
    Create git worktree for task if it doesn't exist.

    Args:
        display_number: Task display number
        project_path: Project directory to create worktree from (for global mode)

    Returns:
        Worktree path if successful, None if failed
    """
    branch = f"push-{display_number}"
    worktree_path = get_worktree_path(display_number, project_path)

    if worktree_path.exists():
        log(f"Worktree already exists: {worktree_path}")
        return worktree_path

    # Determine which directory to run git commands from
    git_cwd = project_path if project_path else str(Path.cwd())

    try:
        result = subprocess.run(
            ["git", "worktree", "add", str(worktree_path), "-b", branch],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=git_cwd  # Run from project directory
        )

        if result.returncode == 0:
            log(f"Created worktree: {worktree_path}")
            return worktree_path
        else:
            # Branch might already exist, try without -b
            result = subprocess.run(
                ["git", "worktree", "add", str(worktree_path), branch],
                capture_output=True,
                text=True,
                timeout=30,
                cwd=git_cwd
            )
            if result.returncode == 0:
                log(f"Created worktree (existing branch): {worktree_path}")
                return worktree_path
            else:
                log(f"Failed to create worktree: {result.stderr}")
                return None

    except Exception as e:
        log(f"Worktree creation error: {e}")
        return None


def execute_task(task: Dict):
    """
    Create worktree and run Claude for a task with certainty-based execution mode.

    Global Mode:
        - Routes task to correct project using local registry
        - Uses atomic claiming to prevent multi-Mac race conditions
        - Creates worktree in the project's parent directory

    Legacy Mode:
        - Uses current working directory
        - No atomic claiming
    """
    display_num = task.get("displayNumber") or task.get("display_number")
    git_remote = task.get("git_remote") or task.get("gitRemote")
    content = (
        task.get("normalizedContent") or
        task.get("normalized_content") or
        task.get("summary") or
        "Work on this task"
    )

    if not display_num:
        log(f"Task has no display number, skipping")
        return

    if display_num in running_tasks:
        log(f"Task #{display_num} already running, skipping")
        return

    if len(running_tasks) >= MAX_CONCURRENT_TASKS:
        log(f"Max concurrent tasks ({MAX_CONCURRENT_TASKS}) reached, skipping #{display_num}")
        return

    # Global mode: resolve project path from registry
    project_path = None
    if GLOBAL_MODE_ENABLED:
        if not git_remote:
            log(f"Task #{display_num} has no git_remote, skipping")
            return

        project_path = get_project_path_for_task(git_remote)
        if not project_path:
            log(f"Task #{display_num}: Project not registered: {git_remote}")
            log(f"Run '/push-todo connect' in the project directory to register")
            # Don't mark as failed - just skip for now
            return

        log(f"Task #{display_num}: Project {git_remote} -> {project_path}")

    # Atomic claiming: prevent multi-Mac race conditions
    if GLOBAL_MODE_ENABLED and not claim_task(display_num):
        # Another machine claimed it, skip
        return

    log(f"Analyzing task #{display_num}: {content[:60]}...")

    # Analyze certainty to determine execution mode
    analysis = analyze_task_certainty(task)
    execution_mode = get_execution_mode(analysis)

    log(f"Task #{display_num} execution mode: {execution_mode}")

    # Handle low-certainty tasks - request clarification instead of executing
    if execution_mode == "clarify":
        log(f"Task #{display_num} requires clarification (certainty too low)")

        # Build clarification message
        questions = []
        if analysis and analysis.clarification_questions:
            questions = [
                {"question": q.question, "options": q.options, "priority": q.priority}
                for q in analysis.clarification_questions
            ]

        # Update task with clarification status
        clarification_summary = "Task requires clarification before execution."
        if analysis:
            clarification_summary += f" Certainty score: {analysis.score:.2f}"
            if analysis.reasons:
                top_reason = analysis.reasons[0]
                clarification_summary += f" ({top_reason.explanation})"

        update_task_status(
            display_num,
            "needs_clarification",
            summary=clarification_summary,
            certainty_score=analysis.score if analysis else None,
            clarification_questions=questions
        )
        return

    # Update status to running (only needed in legacy mode - global mode already claimed)
    if not GLOBAL_MODE_ENABLED:
        certainty_score = analysis.score if analysis else None
        update_task_status(display_num, "running", certainty_score=certainty_score)

    # Create worktree in the correct project location
    worktree_path = create_worktree(display_num, project_path)
    if not worktree_path:
        update_task_status(display_num, "failed", error="Failed to create git worktree")
        return

    # Build prompt for Claude based on execution mode
    if execution_mode == "planning":
        prompt = f"""Work on Push task #{display_num}:

{content}

IMPORTANT: This task has medium certainty (score: {f'{analysis.score:.2f}' if analysis else 'N/A'}).
Please START BY ENTERING PLAN MODE to clarify the approach before implementing.

Reasons for lower certainty:
{chr(10).join(f"- {r.explanation}" for r in (analysis.reasons[:3] if analysis else []))}

After your plan is approved, implement the changes.

When you're done, the SessionEnd hook will automatically report completion to Supabase.

If you need to understand the codebase, start by reading the CLAUDE.md file if it exists."""
    else:
        prompt = f"""Work on Push task #{display_num}:

{content}

IMPORTANT: When you're done, the SessionEnd hook will automatically report completion to Supabase.

If you need to understand the codebase, start by reading the CLAUDE.md file if it exists."""

    try:
        # Build Claude command based on execution mode
        cmd = [
            "claude",
            "-p", prompt,
            "--allowedTools", "Read,Edit,Write,Glob,Grep,Bash(git *)",
            "--output-format", "json"
        ]

        # Add --plan flag for medium certainty tasks to start in planning mode
        if execution_mode == "planning":
            cmd.insert(1, "--plan")

        # Run Claude in headless mode
        # SessionEnd hook will handle reporting completion
        proc = subprocess.Popen(
            cmd,
            cwd=str(worktree_path),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        # Track the running process
        running_tasks[display_num] = proc

        mode_desc = "planning mode" if execution_mode == "planning" else "standard mode"
        log(f"Started Claude for task #{display_num} in {mode_desc} (PID: {proc.pid})")

    except Exception as e:
        log(f"Error starting Claude for task #{display_num}: {e}")
        update_task_status(display_num, "failed", error=str(e))


def check_running_tasks():
    """Check status of running tasks and clean up completed ones."""
    completed = []

    for display_num, proc in running_tasks.items():
        retcode = proc.poll()

        if retcode is not None:
            # Process completed
            completed.append(display_num)

            if retcode == 0:
                log(f"Task #{display_num} completed (Claude exited cleanly)")
                # SessionEnd hook should have already reported completion
                # But we'll set a fallback summary just in case
                # update_task_status(display_num, "completed", summary="Completed via daemon")
            else:
                log(f"Task #{display_num} failed (Claude exit code: {retcode})")
                stderr = proc.stderr.read() if proc.stderr else ""
                update_task_status(display_num, "failed", error=f"Exit code {retcode}: {stderr[:200]}")

    # Remove completed tasks from tracking
    for display_num in completed:
        del running_tasks[display_num]


# ==================== Signal Handling ====================

def cleanup(signum, frame):
    """Handle shutdown gracefully."""
    log("Daemon shutting down...")

    # Terminate any running Claude processes
    for display_num, proc in running_tasks.items():
        log(f"Terminating task #{display_num}")
        proc.terminate()

    # Remove PID file
    try:
        PID_FILE.unlink(missing_ok=True)
    except Exception:
        pass

    sys.exit(0)


# ==================== Main Loop ====================

def main():
    """Main daemon loop."""
    # Set up signal handlers
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    # Create directories
    PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

    # Write PID file
    PID_FILE.write_text(str(os.getpid()))

    log("=" * 60)
    if GLOBAL_MODE_ENABLED:
        log("Push task execution daemon started (GLOBAL MODE)")
        machine_id = get_machine_id()
        machine_name = get_machine_name()
        log(f"Machine: {machine_name} ({machine_id})")
    else:
        log("Push task execution daemon started (LEGACY MODE)")
    log(f"PID: {os.getpid()}")
    log(f"Polling interval: {POLL_INTERVAL}s")
    log(f"Max concurrent tasks: {MAX_CONCURRENT_TASKS}")
    log(f"Log file: {LOG_FILE}")

    # Show registered projects in global mode
    if GLOBAL_MODE_ENABLED:
        registry = get_registry()
        projects = registry.list_projects()
        if projects:
            log(f"Registered projects ({len(projects)}):")
            for remote, path in projects.items():
                log(f"  - {remote}")
                log(f"    -> {path}")
        else:
            log("No projects registered yet")
            log("Run '/push-todo connect' in your project directories")
    else:
        log(f"Working directory: {Path.cwd()}")
    log("=" * 60)

    # Check for API key
    if not get_api_key():
        log("WARNING: No API key configured. Run '/push-todo connect' first.")

    while True:
        try:
            # Check running tasks for completion
            check_running_tasks()

            # Fetch new queued tasks
            tasks = fetch_queued_tasks()

            if tasks:
                log(f"Found {len(tasks)} queued task(s)")
                for task in tasks:
                    execute_task(task)
            elif len(running_tasks) > 0:
                log(f"No new tasks. {len(running_tasks)} task(s) running.")

        except KeyboardInterrupt:
            cleanup(None, None)
        except Exception as e:
            log(f"Error in main loop: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
