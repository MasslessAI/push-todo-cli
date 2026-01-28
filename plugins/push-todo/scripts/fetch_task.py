#!/usr/bin/env python3
"""
Fetch and display active Push tasks.
Version: 6.0.0 (backlog items excluded by default)

This script retrieves active tasks from the Push iOS app and outputs them
in a format suitable for Claude Code to process.

## Unified Hub Architecture (v3.0 - 2026-01-16)

Uses the synced-todos endpoint ONLY (normalized tables: todos + todo_actions).
The legacy claude-tasks endpoint has been removed.

Tasks become visible when:
1. User assigns a Claude Code action to a todo in Push
2. Action has completionBehavior = .automatic (auto-sync enabled)
3. Todo syncs to Supabase via sync-push with sync_enabled = true
4. CLI queries synced-todos which filters by sync_enabled

## Project Scoping (Default)
By default, only tasks for the CURRENT PROJECT are shown (based on git remote).
Use --all-projects to see tasks from all projects.

## Backlog (v6.0.0 - 2026-01-27)
Items marked as backlog (is_backlog=true) are EXCLUDED from active fetch by default.
These are items the user wants to defer - not work on now.
Use --backlog to see only backlog items, or --include-backlog to see all items.

Usage:
    python fetch_task.py [TASK_NUMBER] [--all-projects] [--backlog] [--include-backlog] [--mark-completed TASK_ID]

Arguments:
    TASK_NUMBER        Optional task number to fetch directly (e.g., 5 or #5)

Options:
    --all-projects     Fetch tasks from ALL projects (not just current)
    --backlog          Only show backlog items
    --include-backlog  Include backlog items in the active list (don't filter them out)
    --mark-completed ID Mark a task as completed (syncs back to Push)
    --completion-comment TEXT  Comment to include when marking completed (appears in Push timeline)
    --json             Output raw JSON

Environment:
    PUSH_API_KEY: API key for Push authentication (required)

Output format (JSON):
    {
        "tasks": [
            {
                "id": "uuid",
                "display_number": "Human-readable number (#1, #2, #3...)",
                "summary": "Task summary",
                "content": "Full task content",
                "transcript": "Optional voice transcript",
                "project_hint": "Optional project hint",
                "git_remote": "Optional git remote for project scoping",
                "is_backlog": "Boolean indicating if task is in the backlog",
                "created_at": "ISO timestamp"
            }
        ]
    }

See: /docs/20260116_unified_hub_action_execution_architecture.md
     /docs/20260116_unified_hub_gap_analysis.md
"""

import os
import sys
import json
import argparse
import subprocess
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional, List

# Self-healing daemon: auto-starts on any /push-todo command
from daemon_health import ensure_daemon_running, get_daemon_status

# Project registry for status display
from project_registry import get_registry

# Machine ID for status display
from machine_id import get_machine_id, get_machine_name

# Configuration
API_BASE_URL = "https://jxuzqcbqhiaxmfitzxlo.supabase.co/functions/v1"
DEFAULT_MAX_BATCH_SIZE = 5


def get_max_batch_size() -> int:
    """
    Get the maximum batch size from config file.

    Reads PUSH_MAX_BATCH_SIZE from ~/.config/push/config.
    Defaults to 5 if not configured.

    Returns:
        Maximum number of tasks to offer for batch queue.
    """
    config_path = Path.home() / ".config" / "push" / "config"
    if config_path.exists():
        try:
            for line in config_path.read_text().splitlines():
                line = line.strip()
                if line.startswith("export PUSH_MAX_BATCH_SIZE="):
                    value = line.split("=", 1)[1].strip().strip('"').strip("'")
                    return int(value)
        except (ValueError, Exception):
            pass
    return DEFAULT_MAX_BATCH_SIZE


def set_max_batch_size(size: int) -> bool:
    """
    Set the maximum batch size in config file.

    Args:
        size: New batch size (must be 1-20)

    Returns:
        True if successful, False otherwise.
    """
    if size < 1 or size > 20:
        return False

    config_path = Path.home() / ".config" / "push" / "config"

    # Read existing config
    lines = []
    if config_path.exists():
        lines = config_path.read_text().splitlines()

    # Update or add PUSH_MAX_BATCH_SIZE
    found = False
    for i, line in enumerate(lines):
        if line.strip().startswith("export PUSH_MAX_BATCH_SIZE="):
            lines[i] = f'export PUSH_MAX_BATCH_SIZE="{size}"'
            found = True
            break

    if not found:
        lines.append(f'export PUSH_MAX_BATCH_SIZE="{size}"')

    # Write back
    try:
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text("\n".join(lines) + "\n")
        return True
    except Exception:
        return False


def get_git_remote() -> Optional[str]:
    """
    Get the normalized git remote URL for the current directory.

    Returns:
        Normalized git remote (e.g., "github.com/user/repo") or None if not a git repo.
    """
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
        if not url:
            return None

        # Normalize: remove protocol, convert : to /, remove .git
        # git@github.com:user/repo.git → github.com/user/repo
        # https://github.com/user/repo.git → github.com/user/repo

        # Remove protocol prefixes
        for prefix in ["https://", "http://", "git@", "ssh://git@"]:
            if url.startswith(prefix):
                url = url[len(prefix):]
                break

        # Convert : to / (for git@ style)
        if ":" in url and "://" not in url:
            url = url.replace(":", "/", 1)

        # Remove .git suffix
        if url.endswith(".git"):
            url = url[:-4]

        return url
    except Exception:
        return None


def get_api_key() -> str:
    """
    Get API key from config file or environment.

    Priority:
    1. Environment variable (for CI/testing)
    2. Config file at ~/.config/push/config (production)
    3. Error with helpful message

    Returns:
        The API key string.

    Raises:
        ValueError: If API key is not found in either location.
    """
    # 1. Try environment first (for CI/testing, backward compatibility)
    key = os.environ.get("PUSH_API_KEY")
    if key:
        return key

    # 2. Read from config file (production - more reliable)
    config_path = Path.home() / ".config" / "push" / "config"
    if config_path.exists():
        try:
            # Parse bash-style config (export VAR="value")
            for line in config_path.read_text().splitlines():
                line = line.strip()
                if line.startswith("export PUSH_API_KEY="):
                    # Extract value after = and remove quotes
                    value = line.split("=", 1)[1].strip()
                    # Remove surrounding quotes if present
                    key = value.strip('"').strip("'")
                    if key:
                        return key
        except Exception:
            # Config file exists but couldn't parse - fall through to error
            pass

    # 3. Not found - provide helpful error message
    raise ValueError(
        "PUSH_API_KEY not configured.\n"
        "Run: /push-todo connect\n"
        "Or manually add to ~/.config/push/config:\n"
        '  export PUSH_API_KEY="your-key-here"'
    )


def fetch_tasks_from_api(git_remote: Optional[str] = None, backlog_filter: Optional[str] = None) -> List:
    """
    Fetch active tasks from the synced-todos endpoint.

    Uses the unified hub architecture - all tasks come from the normalized
    tables (todos + todo_actions with sync_enabled=true).

    Args:
        git_remote: If provided, only fetch tasks for this project.
                   The endpoint looks up the action_id from cli_action_registrations.
                   If None, fetches ALL synced tasks across all projects.
        backlog_filter: Controls backlog item filtering:
                     - None or "exclude": Exclude backlog items (default for active work)
                     - "only": Only show backlog items
                     - "include": Include all items (backlog + active)

    Returns:
        List of tasks for this project, or all synced tasks if no git_remote.
    """
    api_key = get_api_key()

    # Build URL - with git_remote for project-scoped, without for all projects
    params = []
    if git_remote:
        encoded_remote = urllib.parse.quote(git_remote, safe="")
        params.append(f"git_remote={encoded_remote}")

    # Add backlog filter param (API uses "later" terminology for backward compat)
    if backlog_filter == "only":
        params.append("later_only=true")
    elif backlog_filter == "include":
        params.append("include_later=true")
    # Default (exclude) doesn't need a param - API excludes by default

    query_string = "&".join(params)
    url = f"{API_BASE_URL}/synced-todos"
    if query_string:
        url = f"{url}?{query_string}"

    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.loads(response.read().decode())
            # Convert synced-todos response format to match expected format
            todos = data.get("todos", [])
            return [
                {
                    "id": t.get("id"),
                    "display_number": t.get("displayNumber"),  # Human-readable #1, #2, #3...
                    "summary": t.get("summary") or t.get("title", "No summary"),
                    "content": t.get("normalizedContent") or t.get("summary") or "",
                    "transcript": t.get("originalTranscript"),
                    "project_hint": None,  # Not included in synced-todos response
                    # git_remote is DERIVED from actions (DRY - not stored on todos)
                    # API returns gitRemote computed from action's action_config.gitRemote
                    # See: /docs/20260128_git_remote_derivation_from_actions_architecture.md
                    "git_remote": t.get("gitRemote") or git_remote,
                    "is_backlog": t.get("isBacklog", False),
                    "created_at": t.get("createdAt"),
                }
                for t in todos
            ]
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise ValueError("Invalid API key. Run '/push-todo connect' to configure.")
        if e.code == 404:
            # No action registered for this project
            return []
        raise
    except urllib.error.URLError as e:
        raise ValueError(f"Network error: {e.reason}")


def get_tasks(git_remote: Optional[str] = None, backlog_filter: Optional[str] = None) -> List:
    """
    Get tasks - always fetches fresh from API.

    Args:
        git_remote: If provided, fetch tasks for this project only.
                   If None, fetch ALL synced tasks across all projects.
        backlog_filter: Controls backlog item filtering (see fetch_tasks_from_api).

    Returns:
        List of tasks from the synced-todos endpoint.

    Version 4.0: Removed caching - always returns fresh data from Supabase.
    Version 6.0: Renamed to backlog_filter (was later_filter).
    """
    return fetch_tasks_from_api(git_remote, backlog_filter)


def fetch_task_by_number(display_number: int) -> Optional[dict]:
    """
    Fetch a specific task by its display number (direct lookup).

    This is the fast path - goes directly to the API with display_number
    query param, bypassing project filtering.

    Args:
        display_number: The global task number (e.g., 427)

    Returns:
        Task dict if found, None if not found.
    """
    api_key = get_api_key()
    url = f"{API_BASE_URL}/synced-todos?display_number={display_number}"

    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.loads(response.read().decode())
            todos = data.get("todos", [])
            if not todos:
                return None
            t = todos[0]
            return {
                "id": t.get("id"),
                "display_number": t.get("displayNumber"),
                "summary": t.get("summary") or t.get("title", "No summary"),
                "content": t.get("normalizedContent") or t.get("summary") or "",
                "transcript": t.get("originalTranscript"),
                "project_hint": None,
                # git_remote derived from actions (DRY - not stored on todos)
                "git_remote": t.get("gitRemote"),
                "is_backlog": t.get("isBacklog", False),
                "created_at": t.get("createdAt"),
            }
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise ValueError("Invalid API key. Run '/push-todo connect' to configure.")
        if e.code == 404:
            return None
        raise
    except urllib.error.URLError as e:
        raise ValueError(f"Network error: {e.reason}")


def mark_task_completed(task_id: str, comment: Optional[str] = None) -> bool:
    """
    Mark a task as completed using the todo-status endpoint.

    This syncs the completion back to the Push iOS app via the unified hub.
    Optionally includes a completion comment that appears in the task's timeline.

    Args:
        task_id: The UUID of the todo to mark as completed.
        comment: Optional completion comment (summary of work done).

    Returns:
        True if successful, False otherwise.
    """
    api_key = get_api_key()
    url = f"{API_BASE_URL}/todo-status"

    payload = {
        "todoId": task_id,
        "isCompleted": True,
        "completedAt": datetime.now(timezone.utc).isoformat()
    }

    # Add completion comment if provided (appears in Push app timeline)
    if comment:
        payload["completionComment"] = comment

    body = json.dumps(payload).encode()

    req = urllib.request.Request(url, data=body, method="PATCH")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status == 200
    except urllib.error.HTTPError:
        return False
    except urllib.error.URLError:
        return False


def format_task_for_display(task: dict) -> str:
    """Format a task for human-readable display."""
    lines = []

    # Build task header with display number and backlog indicator
    display_num = task.get("display_number")
    backlog_prefix = "📦 " if task.get("is_backlog") else ""
    num_prefix = f"#{display_num} " if display_num else ""
    lines.append(f"## Task: {num_prefix}{backlog_prefix}{task.get('summary', 'No summary')}")
    lines.append("")

    if task.get("project_hint"):
        lines.append(f"**Project:** {task['project_hint']}")
        lines.append("")

    lines.append("### Content")
    lines.append(task.get("content", "No content"))
    lines.append("")

    if task.get("transcript"):
        lines.append("### Original Voice Transcript")
        lines.append(f"> {task['transcript']}")
        lines.append("")

    lines.append(f"**Task ID:** `{task.get('id', 'unknown')}`")
    if display_num:
        lines.append(f"**Display Number:** #{display_num}")
    lines.append(f"**Created:** {task.get('created_at', 'unknown')}")

    return "\n".join(lines)


def parse_task_number(value: str) -> Optional[int]:
    """
    Parse task number from string, handling both '5' and '#5' formats.

    Returns:
        The integer task number, or None if not a valid format.
    """
    if not value:
        return None
    # Strip leading '#' if present
    cleaned = value.lstrip("#")
    try:
        num = int(cleaned)
        return num if num > 0 else None
    except ValueError:
        return None


def queue_task(display_number: int) -> bool:
    """
    Queue a task for background execution by the daemon.

    Sets execution_status to 'queued' via the update-task-execution endpoint.
    The daemon will pick it up on next poll.

    Args:
        display_number: The global task number (e.g., 427)

    Returns:
        True if successfully queued, False otherwise.
    """
    api_key = get_api_key()
    url = f"{API_BASE_URL}/update-task-execution"

    payload = {
        "displayNumber": display_number,
        "status": "queued"
    }

    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method="PATCH")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.loads(response.read().decode())
            return data.get("success", False)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise ValueError("Invalid API key. Run '/push-todo connect' to configure.")
        return False
    except urllib.error.URLError:
        return False


def main():
    parser = argparse.ArgumentParser(description="Fetch active Push tasks")
    parser.add_argument("task_number", nargs="?", default=None, help="Task number to fetch directly (e.g., 5 or #5)")
    parser.add_argument("--all-projects", action="store_true", help="Fetch tasks from ALL projects (not just current)")
    parser.add_argument("--backlog", action="store_true", help="Only show backlog items")
    parser.add_argument("--include-backlog", action="store_true", help="Include backlog items in the active list")
    parser.add_argument("--mark-completed", metavar="ID", help="Mark a task as completed")
    parser.add_argument("--completion-comment", metavar="TEXT", help="Comment to include when marking task completed (appears in Push app timeline)")
    parser.add_argument("--queue", metavar="NUM", help="Queue a task for background execution (e.g., --queue 427)")
    parser.add_argument("--queue-batch", metavar="NUMS", help="Queue multiple tasks (comma-separated: --queue-batch 427,351,289)")
    parser.add_argument("--set-batch-size", metavar="N", type=int, help="Set max tasks for batch queue (1-20, default 5)")
    parser.add_argument("--daemon-status", action="store_true", help="Show daemon status")
    parser.add_argument("--status", action="store_true", help="Show comprehensive status (daemon, connection, project)")
    parser.add_argument("--commands", action="store_true", help="Show available user commands")
    parser.add_argument("--watch", action="store_true", help="Live monitor daemon task execution")
    parser.add_argument("--follow", "-f", action="store_true", help="With --watch: exit when all tasks complete")
    parser.add_argument("--json", action="store_true", help="Output raw JSON")
    args = parser.parse_args()

    # Self-healing: ensure daemon is running on any /push-todo command
    ensure_daemon_running()

    try:
        # Handle --set-batch-size (pro user setting)
        if args.set_batch_size is not None:
            if args.set_batch_size < 1 or args.set_batch_size > 20:
                print("Batch size must be between 1 and 20", file=sys.stderr)
                sys.exit(1)
            if set_max_batch_size(args.set_batch_size):
                print(f"Max batch size set to {args.set_batch_size}")
            else:
                print("Failed to update config", file=sys.stderr)
                sys.exit(1)
            return

        # Handle --watch (live monitoring)
        if args.watch:
            import subprocess as sp
            import os
            watch_script = Path(__file__).parent / "watch.py"
            cmd = [sys.executable, str(watch_script)]

            # Auto-detect if running in non-interactive environment (Claude Code)
            # If not a TTY, use --status mode (single snapshot, no ANSI)
            is_tty = os.isatty(sys.stdout.fileno())

            if args.json:
                cmd.append("--json")
            elif not is_tty:
                # Running in Claude Code or piped - use plain text snapshot
                cmd.append("--status")
            elif args.follow:
                cmd.append("--follow")

            try:
                sp.run(cmd)
            except KeyboardInterrupt:
                pass
            return

        # Handle --commands (simple help for users)
        if args.commands:
            print()
            print("  Push Voice Tasks - Commands")
            print("  " + "=" * 40)
            print()
            print("  /push-todo              Show your active tasks")
            print("  /push-todo 427          Work on task #427")
            print("  /push-todo connect      Setup or fix problems")
            print("  /push-todo review       Check completed work")
            print("  /push-todo status       Show connection status")
            print("  /push-todo watch        Live monitor daemon tasks")
            print()
            print("  Options:")
            print("  --all-projects          See tasks from all projects")
            print("  --backlog               See deferred tasks only")
            print()
            return

        # Handle --status (comprehensive status view)
        if args.status:
            print()
            print("  Push Voice Tasks - Status")
            print("  " + "=" * 40)
            print()

            # Daemon status
            daemon = get_daemon_status()
            if daemon["running"]:
                print(f"  Daemon: RUNNING (PID {daemon['pid']}, {daemon['uptime']})")
                if daemon.get("version"):
                    print(f"          Version {daemon['version']}")
            else:
                print("  Daemon: NOT RUNNING")
                print("          (auto-starts on next command)")
            print()

            # Connection status
            config_file = Path.home() / ".config" / "push" / "config"
            if config_file.exists():
                email = None
                try:
                    for line in config_file.read_text().splitlines():
                        if line.startswith("export PUSH_EMAIL="):
                            email = line.split("=", 1)[1].strip().strip('"\'')
                            break
                except Exception:
                    pass
                if email:
                    print(f"  Account: {email}")
                else:
                    print("  Account: Configured (email unknown)")
            else:
                print("  Account: NOT CONNECTED")
                print("           Run '/push-todo connect' to set up")
            print()

            # Machine info
            try:
                machine_name = get_machine_name()
                machine_id = get_machine_id()
                print(f"  Machine: {machine_name}")
                print(f"           ID: {machine_id[-8:]}")  # Last 8 chars
            except Exception:
                print("  Machine: Unknown")
            print()

            # Project info
            try:
                git_result = subprocess.run(
                    ["git", "remote", "get-url", "origin"],
                    capture_output=True, text=True, timeout=5
                )
                if git_result.returncode == 0:
                    git_remote = git_result.stdout.strip()
                    # Normalize
                    for prefix in ["https://", "http://", "git@", "ssh://git@"]:
                        if git_remote.startswith(prefix):
                            git_remote = git_remote[len(prefix):]
                            break
                    if ":" in git_remote and "://" not in git_remote:
                        git_remote = git_remote.replace(":", "/", 1)
                    if git_remote.endswith(".git"):
                        git_remote = git_remote[:-4]
                    print(f"  Project: {git_remote}")

                    # Check registry
                    registry = get_registry()
                    registered_path = registry.get_path_without_update(git_remote)
                    if registered_path:
                        print(f"           Registered: YES")
                    else:
                        print(f"           Registered: NO")
                        print(f"           Run '/push-todo connect' to register")
                else:
                    print("  Project: Not a git repository")
            except Exception:
                print("  Project: Unknown")
            print()

            # Registered projects count
            try:
                registry = get_registry()
                count = registry.project_count()
                print(f"  Total registered projects: {count}")
            except Exception:
                pass

            # Batch settings
            batch_size = get_max_batch_size()
            print(f"  Batch size: {batch_size} tasks")

            print("  " + "=" * 40)
            print()
            return

        # Handle --daemon-status (legacy, kept for compatibility)
            status = get_daemon_status()
            if args.json:
                print(json.dumps(status, indent=2))
            else:
                if status["running"]:
                    print(f"Daemon RUNNING (PID: {status['pid']}, uptime: {status['uptime']})")
                    print(f"Log file: {status['log_file']}")
                else:
                    print("Daemon NOT RUNNING")
                    print("(Will auto-start on next /push-todo command)")
            return

        # Handle --queue
        if args.queue:
            display_num = parse_task_number(args.queue)
            if display_num is None:
                print(f"Invalid task number: {args.queue}", file=sys.stderr)
                sys.exit(1)

            success = queue_task(display_num)
            if success:
                print(f"Task #{display_num} queued for background execution")
                print("Daemon will pick it up shortly.")
            else:
                print(f"Failed to queue task #{display_num}", file=sys.stderr)
                sys.exit(1)
            return

        # Handle --queue-batch (queue multiple tasks at once)
        if args.queue_batch:
            # Parse comma-separated task numbers
            task_nums_str = args.queue_batch.split(",")
            task_nums = []
            for num_str in task_nums_str:
                num = parse_task_number(num_str.strip())
                if num is None:
                    print(f"Invalid task number: {num_str.strip()}", file=sys.stderr)
                    sys.exit(1)
                task_nums.append(num)

            if not task_nums:
                print("No valid task numbers provided", file=sys.stderr)
                sys.exit(1)

            # Queue each task
            print(f"Queueing {len(task_nums)} tasks for background execution...")
            print()
            success_count = 0
            for num in task_nums:
                success = queue_task(num)
                if success:
                    print(f"  #{num} queued")
                    success_count += 1
                else:
                    print(f"  #{num} FAILED", file=sys.stderr)

            print()
            if success_count == len(task_nums):
                print(f"All {success_count} tasks queued. Daemon will process them automatically.")
            else:
                print(f"{success_count}/{len(task_nums)} tasks queued.", file=sys.stderr)
                sys.exit(1)
            return

        # Handle mark-completed
        if args.mark_completed:
            success = mark_task_completed(args.mark_completed, args.completion_comment)
            if success:
                print(f"Task {args.mark_completed} marked as completed")
                if args.completion_comment:
                    print(f"Completion note: {args.completion_comment[:100]}{'...' if len(args.completion_comment) > 100 else ''}")
            else:
                print(f"Failed to mark task {args.mark_completed} as completed", file=sys.stderr)
                sys.exit(1)
            return

        # Handle direct task number lookup (fast path)
        if args.task_number:
            display_num = parse_task_number(args.task_number)
            if display_num is None:
                print(f"Invalid task number: {args.task_number}", file=sys.stderr)
                sys.exit(1)

            task = fetch_task_by_number(display_num)
            if not task:
                print(f"Task #{display_num} not found (may be completed or deleted).")
                sys.exit(0)

            if args.json:
                print(json.dumps({"tasks": [task]}, indent=2))
            else:
                print(f"# Task #{display_num} from Push\n")
                print(format_task_for_display(task))
            sys.exit(0)

        # Determine project filter
        # By default, scope to current project (git remote)
        # Use --all-projects to disable project filtering
        git_remote = None if args.all_projects else get_git_remote()

        # Determine backlog filter
        # Default: exclude backlog items (they're not for working on now)
        # --backlog: only show backlog items
        # --include-backlog: show all items (active + backlog)
        backlog_filter = None  # Default: exclude backlog items
        if args.backlog:
            backlog_filter = "only"
        elif args.include_backlog:
            backlog_filter = "include"

        # Fetch tasks (always fresh from API)
        tasks = get_tasks(git_remote=git_remote, backlog_filter=backlog_filter)

        # Filter out tasks without display_number (required for predictable identification)
        valid_tasks = [t for t in tasks if t.get("display_number")]
        invalid_count = len(tasks) - len(valid_tasks)
        if invalid_count > 0:
            print(f"Warning: {invalid_count} task(s) missing display_number (skipped)", file=sys.stderr)
        tasks = valid_tasks

        if not tasks:
            if args.backlog:
                print("No backlog tasks found.")
            elif git_remote:
                print(f"No active tasks for this project.")
            else:
                print("No active tasks from Push.")
            sys.exit(0)

        # Output - always use global display_number (#N format)
        if args.json:
            print(json.dumps({"tasks": tasks}, indent=2))
        else:
            # Show all tasks for current project (default behavior)
            scope = "this project" if git_remote else "all projects"
            backlog_suffix = ", backlog only" if args.backlog else ""
            include_suffix = ", including backlog" if args.include_backlog else ""
            print(f"# {len(tasks)} Active Tasks ({scope}{backlog_suffix}{include_suffix})\n")
            for task in tasks:
                display_num = task.get("display_number")
                print(f"---\n### #{display_num}\n")
                print(format_task_for_display(task))
                print()

            # Batch queue offer - only show for active tasks (not backlog view)
            if not args.backlog and len(tasks) > 0:
                max_batch = get_max_batch_size()
                batch_count = min(len(tasks), max_batch)
                batch_tasks = tasks[:batch_count]
                batch_numbers = [str(t.get("display_number")) for t in batch_tasks]

                print("=" * 50)
                print(f"BATCH_OFFER: {batch_count}")
                print(f"BATCH_TASKS: {','.join(batch_numbers)}")
                for t in batch_tasks:
                    print(f"  #{t.get('display_number')} - {t.get('summary', 'No summary')[:50]}")
                print("=" * 50)

        sys.exit(0)

    except ValueError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
