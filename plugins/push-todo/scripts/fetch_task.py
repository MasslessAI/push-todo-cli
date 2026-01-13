#!/usr/bin/env python3
"""
Fetch and display pending Push tasks.

This script retrieves pending tasks from the Push iOS app and outputs them
in a format suitable for Claude Code to process.

Usage:
    python fetch_task.py [--all] [--mark-started TASK_ID]

Options:
    --all             Fetch all pending tasks (default: first task only)
    --mark-started ID Mark a task as started

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

# Configuration
API_BASE_URL = "https://jxuzqcbqhiaxmfitzxlo.supabase.co/functions/v1"


def get_api_key() -> str:
    """Get API key from environment."""
    key = os.environ.get("PUSH_API_KEY")
    if not key:
        raise ValueError("PUSH_API_KEY environment variable not set")
    return key


def fetch_tasks() -> list:
    """Fetch all pending tasks."""
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


def mark_task_started(task_id: str) -> bool:
    """Mark a task as started."""
    api_key = get_api_key()
    url = f"{API_BASE_URL}/claude-tasks/{task_id}/start"

    req = urllib.request.Request(url, method="POST")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status == 200
    except urllib.error.HTTPError:
        return False


def mark_task_completed(task_id: str) -> bool:
    """Mark a task as completed."""
    api_key = get_api_key()
    url = f"{API_BASE_URL}/claude-tasks/{task_id}/complete"

    req = urllib.request.Request(url, method="POST")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status == 200
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

        # Fetch tasks
        tasks = fetch_tasks()

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
