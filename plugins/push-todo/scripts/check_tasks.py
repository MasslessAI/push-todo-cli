#!/usr/bin/env python3
"""
Prefetch and cache pending Push tasks.

This script is called by the session-start hook to prefetch all pending tasks
from the Push iOS app. It caches the full task list and outputs the count.

The cache is used by fetch_task.py to show results immediately.

Usage:
    python check_tasks.py

Environment:
    PUSH_API_KEY: API key for Push authentication (required)

Exit codes:
    0: Success (count printed to stdout)
    1: Error (error message printed to stderr)
"""

import os
import sys
import json
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime

# Configuration
API_BASE_URL = "https://jxuzqcbqhiaxmfitzxlo.supabase.co/functions/v1"
CACHE_DIR = Path.home() / ".config" / "push" / "cache"
CACHE_FILE = CACHE_DIR / "tasks.json"


def get_api_key() -> str:
    """Get API key from environment."""
    key = os.environ.get("PUSH_API_KEY")
    if not key:
        raise ValueError("PUSH_API_KEY environment variable not set")
    return key


def fetch_tasks() -> list:
    """Fetch all pending tasks from the API."""
    api_key = get_api_key()
    url = f"{API_BASE_URL}/claude-tasks"

    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            data = json.loads(response.read().decode())
            return data.get("tasks", [])
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise ValueError("Invalid API key. Run 'push setup' to configure.")
        raise
    except urllib.error.URLError as e:
        raise ValueError(f"Network error: {e.reason}")


def save_cache(tasks: list) -> None:
    """Save tasks to cache file."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_data = {
        "tasks": tasks,
        "cached_at": datetime.utcnow().isoformat() + "Z"
    }
    CACHE_FILE.write_text(json.dumps(cache_data, indent=2))


def main():
    try:
        # Fetch full task list
        tasks = fetch_tasks()

        # Cache the tasks for fetch_task.py to use
        save_cache(tasks)

        # Output count (for session-start hook)
        print(len(tasks))
        sys.exit(0)

    except ValueError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
