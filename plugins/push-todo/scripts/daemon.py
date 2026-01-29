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
import select
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

# Task timeout (1 hour default - prevents stuck tasks from blocking slots)
# See: /docs/20260128_daemon_background_execution_comprehensive_guide.md
TASK_TIMEOUT_SECONDS = 3600

# Retry configuration for transient failures
# See: /docs/20260128_daemon_background_execution_comprehensive_guide.md
RETRY_MAX_ATTEMPTS = 3
RETRY_INITIAL_DELAY = 2  # seconds
RETRY_MAX_DELAY = 30     # seconds
RETRY_BACKOFF_FACTOR = 2  # exponential backoff multiplier

# Retryable error patterns (network, rate limit, temporary failures)
RETRYABLE_ERRORS = [
    "timeout",
    "connection refused",
    "connection reset",
    "network is unreachable",
    "temporary failure",
    "rate limit",
    "429",  # Too Many Requests
    "502",  # Bad Gateway
    "503",  # Service Unavailable
    "504",  # Gateway Timeout
]

# Notification configuration
# Confidence-based: 🟢 High (silent), 🟡 Medium (notify), 🔴 Low (stop)
NOTIFY_ON_START = False      # Don't spam on every task start
NOTIFY_ON_COMPLETE = True    # Always notify completion
NOTIFY_ON_FAILURE = True     # Always notify failures
NOTIFY_ON_NEEDS_INPUT = True # Always notify when input needed

# Stuck detection configuration
# See: /docs/20260128_daemon_background_execution_comprehensive_guide.md
STUCK_IDLE_THRESHOLD = 600   # seconds (10 min) - no output = potentially stuck
STUCK_WARNING_THRESHOLD = 300  # seconds (5 min) - warn before marking stuck

# Patterns that indicate Claude is waiting for something
STUCK_PATTERNS = [
    "waiting for permission",
    "approve this action",
    "permission required",
    "plan ready for approval",
    "waiting for user",
    "enter plan mode",
    "press enter to continue",
    "y/n",
    "[Y/n]",
    "confirm:",
]

PID_FILE = Path.home() / ".push" / "daemon.pid"
LOG_FILE = Path.home() / ".push" / "daemon.log"
VERSION_FILE = Path.home() / ".push" / "daemon.version"
STATUS_FILE = Path.home() / ".push" / "daemon_status.json"
CONFIG_FILE = Path.home() / ".config" / "push" / "config"
PLUGIN_JSON = Path(__file__).parent.parent / ".claude-plugin" / "plugin.json"


def get_plugin_version() -> str:
    """
    Get version from plugin.json (single source of truth).

    Returns:
        Version string (e.g., "1.7.2") or "unknown" if not found
    """
    try:
        with open(PLUGIN_JSON, "r") as f:
            data = json.load(f)
            return data.get("version", "unknown")
    except Exception:
        return "unknown"

# Track running tasks to avoid duplicates
running_tasks: Dict[int, subprocess.Popen] = {}

# Track task details for status reporting (display_num -> task_info)
task_details: Dict[int, Dict[str, Any]] = {}

# Track completed tasks today (for status display)
completed_today: List[Dict[str, Any]] = []

# Track last output time for stuck detection (display_num -> datetime)
task_last_output: Dict[int, datetime] = {}

# Track stdout buffers for pattern matching (display_num -> list of recent lines)
task_stdout_buffer: Dict[int, List[str]] = {}

# Daemon start time
daemon_start_time: Optional[datetime] = None


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


def write_status_file():
    """
    Write current daemon status to JSON file for live monitoring.

    This file is read by `/push-todo watch` to show real-time status.
    Updates on every poll cycle and when task status changes.
    """
    global daemon_start_time

    try:
        now = datetime.now()

        # Build active tasks list
        active_tasks = []
        for display_num, proc in running_tasks.items():
            task_info = task_details.get(display_num, {})
            started_at = task_info.get("started_at")
            elapsed = 0
            if started_at:
                elapsed = int((now - started_at).total_seconds())

            active_tasks.append({
                "display_number": display_num,
                "task_id": task_info.get("task_id", ""),
                "summary": task_info.get("summary", "Unknown task"),
                "status": "running",
                "phase": task_info.get("phase", "executing"),
                "detail": task_info.get("detail", "Running Claude..."),
                "started_at": started_at.isoformat() if started_at else None,
                "elapsed_seconds": elapsed
            })

        # Build queued tasks (from task_details with status=queued)
        for display_num, info in task_details.items():
            if display_num not in running_tasks and info.get("status") == "queued":
                active_tasks.append({
                    "display_number": display_num,
                    "task_id": info.get("task_id", ""),
                    "summary": info.get("summary", "Unknown task"),
                    "status": "queued",
                    "queued_at": info.get("queued_at").isoformat() if info.get("queued_at") else None
                })

        # Sort: running first, then queued
        active_tasks.sort(key=lambda t: (0 if t["status"] == "running" else 1, t["display_number"]))

        status = {
            "daemon": {
                "pid": os.getpid(),
                "version": get_plugin_version(),
                "started_at": daemon_start_time.isoformat() if daemon_start_time else None,
                "machine_name": get_machine_name() if GLOBAL_MODE_ENABLED and get_machine_name else None,
                "machine_id": get_machine_id()[-8:] if GLOBAL_MODE_ENABLED and get_machine_id else None
            },
            "active_tasks": active_tasks,
            "completed_today": completed_today[-10:],  # Last 10 completed
            "stats": {
                "running": len(running_tasks),
                "max_concurrent": MAX_CONCURRENT_TASKS,
                "completed_today": len(completed_today)
            },
            "last_updated": now.isoformat()
        }

        # Write atomically (write to temp, then rename)
        temp_file = STATUS_FILE.with_suffix(".tmp")
        with open(temp_file, "w") as f:
            json.dump(status, f, indent=2)
        temp_file.replace(STATUS_FILE)

    except Exception as e:
        # Don't let status file errors break the daemon
        pass


def update_task_detail(display_num: int, **kwargs):
    """Update task details for status reporting."""
    if display_num not in task_details:
        task_details[display_num] = {}
    task_details[display_num].update(kwargs)
    write_status_file()


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

def is_retryable_error(error: Exception) -> bool:
    """
    Check if an error is retryable (transient network/rate limit issues).

    Args:
        error: The exception that occurred

    Returns:
        True if the error is retryable, False otherwise
    """
    error_str = str(error).lower()

    # Check against known retryable patterns
    for pattern in RETRYABLE_ERRORS:
        if pattern.lower() in error_str:
            return True

    # HTTP errors: check status code
    if isinstance(error, urllib.error.HTTPError):
        # 429 (rate limit), 5xx (server errors) are retryable
        if error.code == 429 or 500 <= error.code < 600:
            return True

    # URLError (network issues) are generally retryable
    if isinstance(error, urllib.error.URLError):
        return True

    return False


def api_request(
    endpoint: str,
    method: str = "GET",
    data: Optional[Dict] = None,
    timeout: int = 15,
    retry: bool = True
) -> Optional[Dict]:
    """
    Make authenticated API request to Supabase with automatic retry.

    Implements exponential backoff for transient failures:
    - Network errors (timeout, connection refused)
    - Rate limits (429)
    - Server errors (5xx)

    Args:
        endpoint: API endpoint path
        method: HTTP method
        data: Request payload
        timeout: Request timeout in seconds
        retry: Whether to retry on transient failures

    Returns:
        Response JSON or None on failure
    """
    api_key = get_api_key()
    if not api_key:
        log("No API key configured")
        return None

    url = f"{API_BASE_URL}/{endpoint}"
    max_attempts = RETRY_MAX_ATTEMPTS if retry else 1
    delay = RETRY_INITIAL_DELAY

    for attempt in range(1, max_attempts + 1):
        req = urllib.request.Request(url, method=method)
        req.add_header("Authorization", f"Bearer {api_key}")
        req.add_header("Content-Type", "application/json")

        if data:
            req.data = json.dumps(data).encode()

        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return json.loads(response.read().decode())

        except (urllib.error.HTTPError, urllib.error.URLError, Exception) as e:
            is_last_attempt = attempt == max_attempts

            if not is_last_attempt and retry and is_retryable_error(e):
                # Retryable error - wait and try again
                log(f"API request failed (attempt {attempt}/{max_attempts}): {e}")
                log(f"Retrying in {delay}s...")
                time.sleep(delay)
                delay = min(delay * RETRY_BACKOFF_FACTOR, RETRY_MAX_DELAY)
            else:
                # Non-retryable or last attempt - log and return None
                if isinstance(e, urllib.error.HTTPError):
                    log(f"API error ({e.code}): {e.reason}")
                else:
                    log(f"Request error: {e}")
                return None

    return None


def send_notification(
    message: str,
    task_id: Optional[str] = None,
    display_number: Optional[int] = None,
    notification_type: str = "daemon",
    priority: str = "normal"
):
    """
    Send push notification to user's iPhone via Supabase.

    Confidence-based notification strategy:
    - 🟢 High confidence: Silent (no notification on start)
    - 🟡 Medium confidence: Notify with status
    - 🔴 Low confidence / Error: Always notify

    Args:
        message: Notification message
        task_id: Task UUID (optional)
        display_number: Task display number (optional)
        notification_type: Type of notification (daemon, task_complete, task_failed, needs_input)
        priority: Notification priority (normal, high)
    """
    payload = {
        "type": notification_type,
        "message": message,
        "timestamp": datetime.now().isoformat()
    }

    if task_id:
        payload["task_id"] = task_id
    if display_number:
        payload["display_number"] = display_number
    if priority == "high":
        payload["priority"] = "high"

    # Use daemon-notification endpoint (will be created if doesn't exist)
    # For now, just log - actual endpoint can be added later
    result = api_request("daemon-notification", method="POST", data=payload, retry=False)

    if result and result.get("success"):
        log(f"Notification sent: {message[:50]}...")
    else:
        # Notification failure is non-critical - just log
        log(f"Notification skipped (endpoint may not exist): {message[:50]}...")


def read_task_stdout(display_num: int, proc: subprocess.Popen) -> Optional[str]:
    """
    Non-blocking read of task stdout for stuck detection.

    Uses select() to check if there's data available without blocking.
    Returns the line read, or None if no data available.

    Args:
        display_num: Task display number
        proc: The subprocess.Popen object

    Returns:
        Line of output if available, None otherwise
    """
    if proc.stdout is None:
        return None

    try:
        # Use select to check if data is available (non-blocking)
        readable, _, _ = select.select([proc.stdout], [], [], 0)

        if readable:
            line = proc.stdout.readline()
            if line:
                return line.strip()
    except Exception:
        # select() may not work on all platforms/file types
        pass

    return None


def check_task_stuck_patterns(display_num: int, line: str) -> Optional[str]:
    """
    Check if a stdout line indicates Claude is stuck waiting for input.

    Args:
        display_num: Task display number
        line: Line of stdout to check

    Returns:
        Stuck reason if pattern matched, None otherwise
    """
    line_lower = line.lower()

    for pattern in STUCK_PATTERNS:
        if pattern.lower() in line_lower:
            return f"Detected: '{pattern}'"

    return None


def monitor_task_stdout(display_num: int, proc: subprocess.Popen):
    """
    Monitor a task's stdout for stuck patterns and track activity.

    Updates task_last_output timestamp and checks for stuck patterns.
    Should be called in the main loop for each running task.

    Args:
        display_num: Task display number
        proc: The subprocess.Popen object
    """
    global task_last_output, task_stdout_buffer

    # Initialize tracking if needed
    if display_num not in task_last_output:
        task_last_output[display_num] = datetime.now()
    if display_num not in task_stdout_buffer:
        task_stdout_buffer[display_num] = []

    # Read any available output
    lines_read = 0
    max_lines_per_check = 100  # Prevent infinite loop

    while lines_read < max_lines_per_check:
        line = read_task_stdout(display_num, proc)
        if line is None:
            break

        lines_read += 1
        task_last_output[display_num] = datetime.now()

        # Keep last 20 lines for context
        buffer = task_stdout_buffer[display_num]
        buffer.append(line)
        if len(buffer) > 20:
            buffer.pop(0)

        # Check for stuck patterns
        stuck_reason = check_task_stuck_patterns(display_num, line)
        if stuck_reason:
            log(f"Task #{display_num} may be stuck: {stuck_reason}")
            log(f"  Line: {line[:100]}...")

            # Update task detail with stuck status
            update_task_detail(
                display_num,
                phase="stuck",
                detail=f"Waiting for input: {stuck_reason}"
            )

            # Send notification
            if NOTIFY_ON_NEEDS_INPUT:
                task_info = task_details.get(display_num, {})
                summary = task_info.get("summary", "Unknown task")
                send_notification(
                    f"🟡 Task #{display_num} waiting: {stuck_reason}",
                    task_id=task_info.get("task_id"),
                    display_number=display_num,
                    notification_type="needs_input",
                    priority="high"
                )


def check_task_idle(display_num: int) -> bool:
    """
    Check if a task has been idle (no output) for too long.

    Args:
        display_num: Task display number

    Returns:
        True if task is idle beyond threshold, False otherwise
    """
    if display_num not in task_last_output:
        return False

    elapsed = (datetime.now() - task_last_output[display_num]).total_seconds()

    if elapsed > STUCK_IDLE_THRESHOLD:
        log(f"Task #{display_num} has been idle for {int(elapsed)}s (threshold: {STUCK_IDLE_THRESHOLD}s)")
        return True

    if elapsed > STUCK_WARNING_THRESHOLD:
        log(f"Task #{display_num} idle warning: {int(elapsed)}s since last output")

    return False


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


def get_worktree_suffix() -> str:
    """
    Get a short machine-specific suffix for worktree names.

    This prevents conflicts when multiple Macs work on the same task
    (e.g., after a stale claim timeout).

    Returns:
        8-char machine identifier suffix (e.g., "a1b2c3d4")
    """
    if GLOBAL_MODE_ENABLED and get_machine_id:
        # Extract the random suffix from machine_id (last 8 chars after hyphen)
        machine_id = get_machine_id()
        if "-" in machine_id:
            return machine_id.split("-")[-1][:8]
        return machine_id[:8]
    return "local"


def get_worktree_path(display_number: int, project_path: Optional[str] = None) -> Path:
    """
    Get the worktree path for a task.

    Branch/worktree naming: push-{display_number}-{machine_suffix}
    Example: push-123-a1b2c3d4

    This prevents conflicts when:
    - Mac A creates push-123-aaaa, crashes
    - Task times out, returns to queued
    - Mac B claims it, creates push-123-bbbb (no conflict!)

    Args:
        display_number: Task display number
        project_path: Optional project path (for global mode)

    Returns:
        Path where worktree should be created
    """
    suffix = get_worktree_suffix()
    worktree_name = f"push-{display_number}-{suffix}"

    if project_path:
        # Global mode: worktree in parent of project directory
        return Path(project_path).parent / worktree_name
    else:
        # Legacy mode: worktree in parent of current working directory
        return Path.cwd().parent / worktree_name


def create_worktree(display_number: int, project_path: Optional[str] = None) -> Optional[Path]:
    """
    Create git worktree for task if it doesn't exist.

    Args:
        display_number: Task display number
        project_path: Project directory to create worktree from (for global mode)

    Returns:
        Worktree path if successful, None if failed
    """
    suffix = get_worktree_suffix()
    branch = f"push-{display_number}-{suffix}"
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

    # Track task details for status reporting
    task_id = task.get("id") or task.get("todo_id") or ""
    summary = task.get("summary") or content[:50]
    update_task_detail(
        display_num,
        task_id=task_id,
        summary=summary,
        status="running",
        phase="analyzing",
        detail="Analyzing task certainty...",
        started_at=datetime.now(),
        git_remote=git_remote
    )

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

        # Send notification for low-certainty task (P2 feature)
        # 🔴 Low confidence = always notify and stop
        if NOTIFY_ON_NEEDS_INPUT:
            summary = task.get("summary") or content[:50]
            send_notification(
                f"🔴 Task #{display_num} needs input: {summary[:30]}... Please clarify.",
                task_id=task.get("id") or task.get("todo_id"),
                display_number=display_num,
                notification_type="needs_input",
                priority="high"
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
        #
        # Expanded --allowedTools to prevent headless mode from hanging on permission prompts.
        # See: /docs/20260128_daemon_background_execution_comprehensive_guide.md
        #
        # Tool categories:
        # - File operations: Read, Edit, Write, Glob, Grep (core)
        # - Git: Bash(git *) for version control
        # - Build tools: Bash(npm *), Bash(npx *), Bash(yarn *) for JS/TS projects
        # - Python: Bash(python *), Bash(pip *), Bash(python3 *), Bash(pip3 *)
        # - Subagents: Task for spawning specialized agents
        #
        allowed_tools = ",".join([
            "Read", "Edit", "Write", "Glob", "Grep",
            "Bash(git *)",
            "Bash(npm *)", "Bash(npx *)", "Bash(yarn *)",
            "Bash(python *)", "Bash(python3 *)", "Bash(pip *)", "Bash(pip3 *)",
            "Task"
        ])

        cmd = [
            "claude",
            "-p", prompt,
            "--allowedTools", allowed_tools,
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

        # Track the running process and project path (for cleanup)
        running_tasks[display_num] = proc
        task_project_paths[display_num] = project_path

        # Initialize stdout tracking for stuck detection
        task_last_output[display_num] = datetime.now()
        task_stdout_buffer[display_num] = []

        # Update task detail for status reporting
        mode_desc = "planning mode" if execution_mode == "planning" else "standard mode"
        update_task_detail(
            display_num,
            phase="executing",
            detail=f"Running Claude in {mode_desc}...",
            claude_pid=proc.pid
        )

        log(f"Started Claude for task #{display_num} in {mode_desc} (PID: {proc.pid})")

    except Exception as e:
        log(f"Error starting Claude for task #{display_num}: {e}")
        update_task_status(display_num, "failed", error=str(e))


def cleanup_worktree(display_number: int, project_path: Optional[str] = None):
    """
    Clean up worktree after task completion.

    IMPORTANT: Branch is PRESERVED for review/PR creation.
    The branch contains all the work Claude did and should be:
    1. Reviewed by the user
    2. Merged via PR
    3. Only deleted AFTER merge

    See: /docs/20260128_daemon_background_execution_comprehensive_guide.md

    Args:
        display_number: Task display number
        project_path: Project path (for determining git cwd)
    """
    worktree_path = get_worktree_path(display_number, project_path)

    if not worktree_path.exists():
        return

    git_cwd = project_path if project_path else str(Path.cwd())
    suffix = get_worktree_suffix()
    branch = f"push-{display_number}-{suffix}"

    try:
        # Remove the worktree only (frees the directory)
        result = subprocess.run(
            ["git", "worktree", "remove", str(worktree_path), "--force"],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=git_cwd
        )

        if result.returncode == 0:
            log(f"Cleaned up worktree: {worktree_path}")
            log(f"Branch preserved for review: {branch}")
        else:
            log(f"Failed to cleanup worktree {worktree_path}: {result.stderr}")

        # NOTE: Branch is intentionally NOT deleted!
        # The branch contains Claude's work and should be reviewed via PR.
        # User can delete it manually after merging:
        #   git branch -D push-{display_number}-{suffix}

    except Exception as e:
        log(f"Worktree cleanup error: {e}")


def create_pr_for_task(display_number: int, summary: str, project_path: Optional[str] = None) -> Optional[str]:
    """
    Create a GitHub PR for the completed task's branch.

    Industry best practice: Agent → Branch → PR → Human Review → Merge
    See: /docs/20260128_daemon_background_execution_comprehensive_guide.md

    Args:
        display_number: Task display number
        summary: Task summary for PR title
        project_path: Project path (for git cwd)

    Returns:
        PR URL if created successfully, None otherwise
    """
    suffix = get_worktree_suffix()
    branch = f"push-{display_number}-{suffix}"
    git_cwd = project_path if project_path else str(Path.cwd())

    try:
        # First, check if branch has any commits different from main
        # (no point creating a PR if Claude didn't make any changes)
        result = subprocess.run(
            ["git", "log", "HEAD..{}".format(branch), "--oneline"],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=git_cwd
        )

        if result.returncode != 0:
            log(f"Could not check branch {branch} for commits")
            return None

        if not result.stdout.strip():
            log(f"Branch {branch} has no new commits, skipping PR creation")
            return None

        commit_count = len(result.stdout.strip().split('\n'))
        log(f"Branch {branch} has {commit_count} new commit(s)")

        # Push branch to remote
        push_result = subprocess.run(
            ["git", "push", "-u", "origin", branch],
            capture_output=True,
            text=True,
            timeout=60,
            cwd=git_cwd
        )

        if push_result.returncode != 0:
            log(f"Failed to push branch {branch}: {push_result.stderr}")
            return None

        log(f"Pushed branch {branch} to origin")

        # Create PR using gh CLI
        pr_title = f"Push Task #{display_number}: {summary[:50]}"
        pr_body = f"""## Summary

Automated PR from Push daemon for task #{display_number}.

**Task:** {summary}

---

*This PR was created automatically by the Push task execution daemon.*
*Review the changes and merge when ready.*
"""

        pr_result = subprocess.run(
            [
                "gh", "pr", "create",
                "--head", branch,
                "--title", pr_title,
                "--body", pr_body
            ],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=git_cwd
        )

        if pr_result.returncode == 0:
            pr_url = pr_result.stdout.strip()
            log(f"Created PR for task #{display_number}: {pr_url}")
            return pr_url
        else:
            # PR might already exist or gh not installed
            if "already exists" in pr_result.stderr.lower():
                log(f"PR already exists for branch {branch}")
            elif "gh: command not found" in pr_result.stderr or "not found" in pr_result.stderr.lower():
                log(f"GitHub CLI (gh) not installed, skipping PR creation")
            else:
                log(f"Failed to create PR: {pr_result.stderr}")
            return None

    except subprocess.TimeoutExpired:
        log(f"PR creation timed out for task #{display_number}")
        return None
    except FileNotFoundError:
        log("GitHub CLI (gh) not installed, skipping PR creation")
        return None
    except Exception as e:
        log(f"PR creation error for task #{display_number}: {e}")
        return None


# Track project paths for cleanup (display_number -> project_path)
task_project_paths: Dict[int, Optional[str]] = {}


def check_running_tasks():
    """
    Check status of running tasks and clean up completed ones.

    Also detects and terminates stuck tasks that exceed TASK_TIMEOUT_SECONDS.
    See: /docs/20260128_daemon_background_execution_comprehensive_guide.md
    """
    completed = []
    timed_out = []
    now = datetime.now()

    for display_num, proc in running_tasks.items():
        task_info = task_details.get(display_num, {})
        started_at = task_info.get("started_at")

        # Check for timeout FIRST (before checking if process exited)
        if started_at:
            elapsed = (now - started_at).total_seconds()
            if elapsed > TASK_TIMEOUT_SECONDS:
                log(f"Task #{display_num} TIMEOUT after {int(elapsed)}s (limit: {TASK_TIMEOUT_SECONDS}s)")
                timed_out.append(display_num)
                continue

        # Monitor stdout for stuck patterns (P2 feature)
        # This detects when Claude is waiting for permission or input
        monitor_task_stdout(display_num, proc)

        # Check if task has been idle (no output) for too long
        if check_task_idle(display_num):
            task_info = task_details.get(display_num, {})
            update_task_detail(
                display_num,
                phase="idle",
                detail="No output detected - may be stuck"
            )

        retcode = proc.poll()

        if retcode is not None:
            # Process completed
            completed.append(display_num)

            duration = 0
            if started_at:
                duration = int((now - started_at).total_seconds())

            if retcode == 0:
                log(f"Task #{display_num} completed (Claude exited cleanly)")

                # Auto-create PR for completed work (P1 feature)
                # This preserves work and enables human review before merge
                project_path = task_project_paths.get(display_num)
                summary = task_info.get("summary", "Unknown task")
                pr_url = create_pr_for_task(display_num, summary, project_path)

                # Send completion notification (P2 feature)
                if NOTIFY_ON_COMPLETE:
                    if pr_url:
                        send_notification(
                            f"✅ Task #{display_num} complete: {summary[:40]}... PR ready for review.",
                            task_id=task_info.get("task_id"),
                            display_number=display_num,
                            notification_type="task_complete"
                        )
                    else:
                        send_notification(
                            f"✅ Task #{display_num} complete: {summary[:40]}...",
                            task_id=task_info.get("task_id"),
                            display_number=display_num,
                            notification_type="task_complete"
                        )

                # Track in completed_today
                completed_today.append({
                    "display_number": display_num,
                    "summary": summary,
                    "completed_at": now.isoformat(),
                    "duration_seconds": duration,
                    "status": "completed",
                    "pr_url": pr_url
                })
            else:
                log(f"Task #{display_num} failed (Claude exit code: {retcode})")
                stderr = proc.stderr.read() if proc.stderr else ""
                error_msg = f"Exit code {retcode}: {stderr[:200]}"
                update_task_status(display_num, "failed", error=error_msg)

                # Send failure notification (P2 feature)
                if NOTIFY_ON_FAILURE:
                    summary = task_info.get("summary", "Unknown task")
                    send_notification(
                        f"❌ Task #{display_num} failed: {summary[:30]}... Error: {stderr[:50]}",
                        task_id=task_info.get("task_id"),
                        display_number=display_num,
                        notification_type="task_failed",
                        priority="high"
                    )

                # Track in completed_today as failed
                completed_today.append({
                    "display_number": display_num,
                    "summary": task_info.get("summary", "Unknown task"),
                    "completed_at": now.isoformat(),
                    "duration_seconds": duration,
                    "status": "failed"
                })

    # Handle timed out tasks - terminate and mark as failed
    for display_num in timed_out:
        proc = running_tasks[display_num]
        task_info = task_details.get(display_num, {})
        started_at = task_info.get("started_at")
        duration = int((now - started_at).total_seconds()) if started_at else 0

        # Terminate the stuck process
        log(f"Terminating stuck task #{display_num} (PID: {proc.pid})")
        try:
            proc.terminate()
            # Give it a moment to clean up
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            log(f"Force killing task #{display_num}")
            proc.kill()
        except Exception as e:
            log(f"Error terminating task #{display_num}: {e}")

        # Mark as failed with timeout error
        timeout_error = f"Task timed out after {duration}s (limit: {TASK_TIMEOUT_SECONDS}s)"
        update_task_status(
            display_num,
            "failed",
            error=timeout_error
        )

        # Send timeout notification (P2 feature)
        if NOTIFY_ON_FAILURE:
            summary = task_info.get("summary", "Unknown task")
            send_notification(
                f"⏱️ Task #{display_num} timed out: {summary[:30]}... ({duration}s)",
                task_id=task_info.get("task_id"),
                display_number=display_num,
                notification_type="task_timeout",
                priority="high"
            )

        # Track in completed_today
        completed_today.append({
            "display_number": display_num,
            "summary": task_info.get("summary", "Unknown task"),
            "completed_at": now.isoformat(),
            "duration_seconds": duration,
            "status": "timeout"
        })

        # Add to completed list for cleanup
        completed.append(display_num)

    # Remove completed tasks from tracking and clean up worktrees
    for display_num in completed:
        del running_tasks[display_num]
        # Remove from task_details
        task_details.pop(display_num, None)
        # Clean up stdout tracking
        task_last_output.pop(display_num, None)
        task_stdout_buffer.pop(display_num, None)

        # Clean up worktree
        project_path = task_project_paths.pop(display_num, None)
        cleanup_worktree(display_num, project_path)

    # Update status file if any tasks completed
    if completed:
        write_status_file()


# ==================== Signal Handling ====================

def cleanup(signum, frame):
    """Handle shutdown gracefully."""
    log("Daemon shutting down...")

    # Terminate any running Claude processes
    for display_num, proc in running_tasks.items():
        log(f"Terminating task #{display_num}")
        proc.terminate()

    # Remove PID file and status file
    try:
        PID_FILE.unlink(missing_ok=True)
        STATUS_FILE.unlink(missing_ok=True)
    except Exception:
        pass

    sys.exit(0)


# ==================== Main Loop ====================

def main():
    """Main daemon loop."""
    global daemon_start_time

    # Set up signal handlers
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    # Create directories
    PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

    # Write PID file and version file (version from plugin.json)
    PID_FILE.write_text(str(os.getpid()))
    VERSION_FILE.write_text(get_plugin_version())

    # Track daemon start time
    daemon_start_time = datetime.now()

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

            # Validate paths exist
            invalid = registry.validate_paths()
            if invalid:
                log("")
                log("⚠️  WARNING: Some project paths are invalid:")
                for entry in invalid:
                    log(f"  - {entry['git_remote']}: {entry['reason']}")
                    log(f"    Path: {entry['local_path']}")
                log("Run '/push-todo connect' in those projects to re-register")
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

            # Update status file for live monitoring
            write_status_file()

        except KeyboardInterrupt:
            cleanup(None, None)
        except Exception as e:
            log(f"Error in main loop: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
