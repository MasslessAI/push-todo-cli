#!/usr/bin/env python3
"""
OAuth web flow setup for Push integration.

This script opens a browser for Sign in with Apple authentication,
linking Claude Code or OpenAI Codex with your Push account automatically.

Usage:
    python setup.py                      # Default: Claude Code
    python setup.py --client claude-code # Explicit: Claude Code
    python setup.py --client openai-codex # For OpenAI Codex

The flow:
    1. Request a device code from Push
    2. Open browser to pushto.do/auth/cli
    3. User clicks "Sign in with Apple"
    4. Poll for authorization
    5. Save API key automatically

No manual code entry or iPhone interaction needed!

See: /docs/20260113_oauth_web_flow_implementation_plan.md
"""

import argparse
import json
import os
import platform
import sys
import time
import webbrowser
import urllib.request
import urllib.error
from typing import Optional

# Configuration
API_BASE = "https://jxuzqcbqhiaxmfitzxlo.supabase.co/functions/v1"
CONFIG_DIR = os.path.expanduser("~/.config/push")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config")


class SlowDownError(Exception):
    """Raised when polling too frequently."""
    def __init__(self, new_interval: int):
        self.new_interval = new_interval


def get_existing_key() -> Optional[str]:
    """Get existing API key from config."""
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE) as f:
                for line in f:
                    if line.startswith("export PUSH_API_KEY="):
                        # Extract key from: export PUSH_API_KEY="push_xxx"
                        key = line.split("=", 1)[1].strip().strip('"\'')
                        return key if key else None
        except Exception:
            pass
    return None


def save_config(api_key: str):
    """Save API key to config file."""
    os.makedirs(CONFIG_DIR, exist_ok=True)

    with open(CONFIG_FILE, 'w') as f:
        f.write(f'export PUSH_API_KEY="{api_key}"\n')

    # Set restrictive permissions
    os.chmod(CONFIG_FILE, 0o600)


def get_device_name() -> str:
    """Get the computer's hostname for device identification."""
    try:
        # platform.node() returns the computer's network name
        return platform.node() or "Unknown Device"
    except Exception:
        return "Unknown Device"


def get_project_path() -> str:
    """Get the current working directory."""
    try:
        return os.getcwd()
    except Exception:
        return ""


def initiate_device_flow(client_type: str = "claude-code") -> dict:
    """Request a new device code from the server."""
    # Map client_type to display name
    client_names = {
        "claude-code": "Claude Code",
        "openai-codex": "OpenAI Codex"
    }
    client_name = client_names.get(client_type, "Claude Code")

    req = urllib.request.Request(
        f"{API_BASE}/device-auth/init",
        data=json.dumps({
            "client_name": client_name,
            "client_type": client_type,
            "client_version": "1.0.0",
            "device_name": get_device_name(),
            "project_path": get_project_path()
        }).encode(),
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    with urllib.request.urlopen(req, timeout=10) as response:
        return json.loads(response.read().decode())


def poll_status(device_code: str) -> dict:
    """Poll for authorization status."""
    req = urllib.request.Request(
        f"{API_BASE}/device-auth/poll",
        data=json.dumps({"device_code": device_code}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as e:
        body = json.loads(e.read().decode())
        if body.get("error") == "slow_down":
            raise SlowDownError(body.get("interval", 10))
        raise


def main():
    # Parse command line arguments
    parser = argparse.ArgumentParser(description="Setup Push integration")
    parser.add_argument(
        "--client",
        choices=["claude-code", "openai-codex"],
        default="claude-code",
        help="Client type (default: claude-code)"
    )
    args = parser.parse_args()

    client_type = args.client
    client_display_names = {
        "claude-code": "Claude Code",
        "openai-codex": "OpenAI Codex"
    }
    client_name = client_display_names.get(client_type, "Claude Code")

    print()
    print(f"  Push Voice Tasks Setup ({client_name})")
    print("  " + "=" * 40)
    print()

    # Check if already configured - just inform, don't block
    # Running setup again is safe and will simply refresh the API key
    existing_key = get_existing_key()
    if existing_key:
        print(f"  Note: Already configured with key: {existing_key[:12]}...")
        print("  Continuing will generate a new key (old key will be revoked).")
        print()

    # Initiate device code flow
    print("  Initializing...")
    try:
        device_data = initiate_device_flow(client_type)
    except Exception as e:
        print(f"  Error: Failed to initiate setup: {e}")
        sys.exit(1)

    device_code = device_data["device_code"]
    expires_in = device_data["expires_in"]
    interval = device_data.get("interval", 5)

    # Get the web OAuth URL (uses device_code, not user_code)
    auth_url = device_data.get("verification_uri_complete",
                               f"https://pushto.do/auth/cli?code={device_code}")

    # Open browser for OAuth
    print()
    print("  Opening browser for Sign in with Apple...")
    print()

    # Try to open browser
    browser_opened = webbrowser.open(auth_url)

    if browser_opened:
        print("  If the browser didn't open, visit:")
    else:
        print("  Open this URL in your browser:")
    print(f"  {auth_url}")
    print()
    print(f"  Waiting for authorization ({expires_in // 60} min timeout)...")
    print("  Press Ctrl+C to cancel")
    print()

    # Poll for authorization
    start_time = time.time()
    poll_interval = interval

    while True:
        elapsed = time.time() - start_time
        if elapsed > expires_in:
            print()
            print("  Error: Authorization timed out. Please run setup again.")
            print()
            sys.exit(1)

        try:
            result = poll_status(device_code)

            if result["status"] == "authorized":
                api_key = result.get("api_key")
                if api_key:
                    save_config(api_key)
                    print()
                    print("  " + "=" * 40)
                    print("  ✓ Connected!")
                    print("  " + "=" * 40)
                    print()
                    print(f"  API key saved to {CONFIG_FILE}")
                    print()
                    print("  You can now use 'push-todo' to view your tasks.")
                    print()
                    return
                else:
                    print()
                    print("  Error: Authorization succeeded but no API key received.")
                    print()
                    sys.exit(1)

            elif result["status"] == "denied":
                print()
                print("  Authorization denied.")
                print()
                sys.exit(1)

            elif result["status"] == "expired":
                print()
                print("  Error: Authorization expired. Please run setup again.")
                print()
                sys.exit(1)

            # Still pending, continue polling
            remaining = expires_in - int(elapsed)
            mins, secs = divmod(remaining, 60)
            sys.stdout.write(f"\r  Waiting... ({mins}:{secs:02d} remaining)   ")
            sys.stdout.flush()

        except SlowDownError as e:
            poll_interval = e.new_interval
        except urllib.error.URLError as e:
            # Network error, continue polling
            sys.stdout.write(f"\r  Network error, retrying...              ")
            sys.stdout.flush()
        except Exception as e:
            sys.stdout.write(f"\r  Error: {e}. Retrying...                 ")
            sys.stdout.flush()

        time.sleep(poll_interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n")
        print("  Setup cancelled.")
        print()
        sys.exit(1)
