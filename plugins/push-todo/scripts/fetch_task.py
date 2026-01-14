#!/usr/bin/env python3
"""
Fetch and display pending Push tasks.

This script retrieves pending tasks from the Push iOS app and outputs them
in a format suitable for Claude Code to process.

Two-call system for fast response:
1. Session start hook prefetches and caches all tasks
2. This script reads from cache for instant display

Usage:
    python fetch_task.py [--all] [--mark-started TASK_ID] [--mark-completed TASK_ID]

Options:
    --all              Fetch all pending tasks (default: first task only)
    --mark-started ID  Mark a task as started (also removes from cache)
    --mark-completed ID Mark a task as completed (also removes from cache)
    --refresh          Force refresh from database (updates cache)
    --json             Output raw JSON

Environment:
    PUSH_API_KEY: API key for Push authentication (required)

Output format (JSON):
    {
        "tasks": [
            {
                "id": "uuid",
                "summary": "Task summary",
                "content": "Full task content",
                "transcript": "Optional voice transcript",
                "project_hint": "Optional project hint",
                "created_at": "ISO timestamp"
            }
        ]
    }
"""

import os
import sys
import json
import argparse
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime, timezone

# Configuration
API_BASE_URL = "https://jxuzqcbqhiaxmfitzxlo.supabase.co/functions/v1"
CACHE_DIR = Path.home() / ".config" / "push" / "cache"
CACHE_FILE = CACHE_DIR / "tasks.json"
CACHE_MAX_AGE_SECONDS = 300  # 5 minutes


def get_api_key() -> str:
    """Get API key from environment."""
    key = os.environ.get("PUSH_API_KEY")
    if not key:
        raise ValueError("PUSH_API_KEY environment variable not set")
    return key


def load_cache() -> tuple[list, bool]:
    """
    Load tasks from cache.
    Returns (tasks, is_stale) tuple.
    """
    if not CACHE_FILE.exists():
        return [], True

    try:
        cache_data = json.loads(CACHE_FILE.read_text())
        tasks = cache_data.get("tasks", [])
        cached_at_str = cache_data.get("cached_at", "")

        # Check staleness
        if cached_at_str:
            cached_at = datetime.fromisoformat(cached_at_str.replace("Z", "+00:00"))
            age = (datetime.now(timezone.utc) - cached_at).total_seconds()
            is_stale = age > CACHE_MAX_AGE_SECONDS
        else:
            is_stale = True

        return tasks, is_stale
    except (json.JSONDecodeError, ValueError):
        return [], True


def save_cache(tasks: list) -> None:
    """Save tasks to cache file."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_data = {
        "tasks": tasks,
        "cached_at": datetime.now(timezone.utc).isoformat()
    }
    CACHE_FILE.write_text(json.dumps(cache_data, indent=2))


def remove_from_cache(task_id: str) -> None:
    """Remove a task from the cache."""
    tasks, _ = load_cache()
    tasks = [t for t in tasks if t.get("id") != task_id]
    save_cache(tasks)


def fetch_tasks_from_api() -> list:
    """Fetch all pending tasks from API."""
    api_key = get_api_key()
    url = f"{API_BASE_URL}/claude-tasks"

    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.loads(response.read().decode())
            return data.get("tasks", [])
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise ValueError("Invalid API key. Run 'push setup' to configure.")
        raise
    except urllib.error.URLError as e:
        raise ValueError(f"Network error: {e.reason}")


def get_tasks(force_refresh: bool = False) -> list:
    """
    Get tasks, using cache when available.

    Priority:
    1. If force_refresh, fetch from API
    2. If cache exists and is fresh, use cache
    3. If cache is stale, fetch from API
    4. If API fails and cache exists, use stale cache
    """
    if force_refresh:
        tasks = fetch_tasks_from_api()
        save_cache(tasks)
        return tasks

    cached_tasks, is_stale = load_cache()

    if cached_tasks and not is_stale:
        # Cache is fresh, use it immediately
        return cached_tasks

    # Cache is stale or empty, try to refresh
    try:
        tasks = fetch_tasks_from_api()
        save_cache(tasks)
        return tasks
    except Exception:
        # API failed, fall back to stale cache if available
        if cached_tasks:
            return cached_tasks
        raise


def mark_task_started(task_id: str) -> bool:
    """Mark a task as started and remove from cache."""
    api_key = get_api_key()
    url = f"{API_BASE_URL}/claude-tasks/{task_id}/start"

    req = urllib.request.Request(url, method="POST")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            if response.status == 200:
                # Remove from cache since it's no longer pending
                remove_from_cache(task_id)
                return True
            return False
    except urllib.error.HTTPError:
        return False


def mark_task_completed(task_id: str) -> bool:
    """Mark a task as completed and remove from cache."""
    api_key = get_api_key()
    url = f"{API_BASE_URL}/claude-tasks/{task_id}/complete"

    req = urllib.request.Request(url, method="POST")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            if response.status == 200:
                # Remove from cache since it's no longer pending
                remove_from_cache(task_id)
                return True
            return False
    except urllib.error.HTTPError:
        return False


def format_task_for_display(task: dict) -> str:
    """Format a task for human-readable display."""
    lines = []
    lines.append(f"## Task: {task.get('summary', 'No summary')}")
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
    lines.append(f"**Created:** {task.get('created_at', 'unknown')}")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Fetch pending Push tasks")
    parser.add_argument("--all", action="store_true", help="Fetch all pending tasks")
    parser.add_argument("--mark-started", metavar="ID", help="Mark a task as started")
    parser.add_argument("--mark-completed", metavar="ID", help="Mark a task as completed")
    parser.add_argument("--refresh", action="store_true", help="Force refresh from database")
    parser.add_argument("--json", action="store_true", help="Output raw JSON")
    args = parser.parse_args()

    try:
        # Handle mark-started
        if args.mark_started:
            success = mark_task_started(args.mark_started)
            if success:
                print(f"Task {args.mark_started} marked as started")
            else:
                print(f"Failed to mark task {args.mark_started} as started", file=sys.stderr)
                sys.exit(1)
            return

        # Handle mark-completed
        if args.mark_completed:
            success = mark_task_completed(args.mark_completed)
            if success:
                print(f"Task {args.mark_completed} marked as completed")
            else:
                print(f"Failed to mark task {args.mark_completed} as completed", file=sys.stderr)
                sys.exit(1)
            return

        # Fetch tasks (from cache or API)
        tasks = get_tasks(force_refresh=args.refresh)

        if not tasks:
            print("No pending tasks from Push.")
            sys.exit(0)

        # Output
        if args.json:
            print(json.dumps({"tasks": tasks}, indent=2))
        elif args.all:
            print(f"# {len(tasks)} Pending Tasks from Push\n")
            for i, task in enumerate(tasks, 1):
                print(f"---\n### Task {i}\n")
                print(format_task_for_display(task))
                print()
        else:
            # Just the first task
            print("# Task from Push\n")
            print(format_task_for_display(tasks[0]))

        sys.exit(0)

    except ValueError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
