#!/usr/bin/env python3
"""
Check for pending Push tasks.

This script is called by the session-start hook to check if there are
pending tasks from the Push iOS app. It outputs a count to stdout.

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

# Configuration
API_BASE_URL = "https://jxuzqcbqhiaxmfitzxlo.supabase.co/functions/v1"
ENDPOINT = "/claude-tasks/count"


def get_api_key() -> str:
    """Get API key from environment."""
    key = os.environ.get("PUSH_API_KEY")
    if not key:
        raise ValueError("PUSH_API_KEY environment variable not set")
    return key


def check_tasks() -> int:
    """Check for pending tasks and return the count."""
    api_key = get_api_key()
    url = f"{API_BASE_URL}{ENDPOINT}"

    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode())
            return data.get("count", 0)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise ValueError("Invalid API key. Run 'push setup' to configure.")
        raise
    except urllib.error.URLError as e:
        raise ValueError(f"Network error: {e.reason}")


def main():
    try:
        count = check_tasks()
        print(count)
        sys.exit(0)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
