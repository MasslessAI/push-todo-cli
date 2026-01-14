#!/usr/bin/env python3
"""
Smart setup for Push integration.

This script handles both initial authentication AND project registration:
- First time: Opens browser for Sign in with Apple, saves credentials
- Subsequent: Uses existing credentials for instant project registration

Usage:
    python setup.py                      # Default: Claude Code
    python setup.py --client claude-code # Explicit: Claude Code
    python setup.py --client openai-codex # For OpenAI Codex
    python setup.py --reauth             # Force re-authentication

See: /docs/20260114_cli_action_auto_creation_implementation_plan.md
"""

import argparse
import json
import os
import platform
import subprocess
import sys
import time
import webbrowser
import urllib.request
import urllib.error
from typing import Optional

# Configuration
API_BASE = "https://jxuzqcbqhiaxmfitzxlo.supabase.co/functions/v1"
ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4dXpxY2JxaGlheG1maXR6eGxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzU2OTY5MzQsImV4cCI6MjA1MTI3MjkzNH0.4Nm5_ABkgJCrrFc-bVzbx8qAp-SQo92HKziH7TBgspo"
CONFIG_DIR = os.path.expanduser("~/.config/push")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config")


class SlowDownError(Exception):
    """Raised when polling too frequently."""
    def __init__(self, new_interval: int):
        self.new_interval = new_interval


# ============================================================================
# CONFIG FILE HELPERS
# ============================================================================

def get_existing_key() -> Optional[str]:
    """Get existing API key from config."""
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE) as f:
                for line in f:
                    if line.startswith("export PUSH_API_KEY="):
                        key = line.split("=", 1)[1].strip().strip('"\'')
                        return key if key else None
        except Exception:
            pass
    return None


def get_existing_email() -> Optional[str]:
    """Get existing email from config."""
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE) as f:
                for line in f:
                    if line.startswith("export PUSH_EMAIL="):
                        email = line.split("=", 1)[1].strip().strip('"\'')
                        return email if email else None
        except Exception:
            pass
    return None


def save_config(api_key: str, email: str):
    """Save API key and email to config file."""
    os.makedirs(CONFIG_DIR, exist_ok=True)

    with open(CONFIG_FILE, 'w') as f:
        f.write(f'export PUSH_API_KEY="{api_key}"\n')
        f.write(f'export PUSH_EMAIL="{email}"\n')

    # Set restrictive permissions
    os.chmod(CONFIG_FILE, 0o600)


def clear_config():
    """Clear the config file (for re-auth)."""
    if os.path.exists(CONFIG_FILE):
        try:
            os.remove(CONFIG_FILE)
        except Exception:
            pass


# ============================================================================
# CONTEXT COLLECTION
# ============================================================================

def get_device_name() -> str:
    """Get the computer's hostname for device identification."""
    try:
        return platform.node() or "Unknown Device"
    except Exception:
        return "Unknown Device"


def get_project_path() -> str:
    """Get the current working directory."""
    try:
        return os.getcwd()
    except Exception:
        return ""


def get_git_remote() -> Optional[str]:
    """Get the git remote URL (origin) if in a git repo.

    Returns the origin remote URL, or None if not a git repo or no origin.
    This is used for git-first project identification.
    """
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=5
        )
        if result.returncode == 0:
            return result.stdout.strip() or None
        return None
    except Exception:
        return None


# ============================================================================
# LIGHTWEIGHT PROJECT REGISTRATION (FAST PATH)
# ============================================================================

def register_project(api_key: str, client_type: str = "claude-code") -> dict:
    """
    Register current project using existing API key.

    This is the "fast path" - no browser needed, instant registration.

    Returns dict with:
        - status: "success", "unauthorized", or "error"
        - action_name: Name of the action (if success)
        - created: True if new, False if existing (if success)
        - message: Human-readable message
    """
    client_names = {
        "claude-code": "Claude Code",
        "openai-codex": "OpenAI Codex"
    }

    req = urllib.request.Request(
        f"{API_BASE}/register-project",
        data=json.dumps({
            "client_type": client_type,
            "client_name": client_names.get(client_type, "Claude Code"),
            "device_name": get_device_name(),
            "project_path": get_project_path(),
            "git_remote": get_git_remote(),
        }).encode(),
        headers={
            "Content-Type": "application/json",
            "apikey": ANON_KEY,
            "Authorization": f"Bearer {api_key}",
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode())
            if data.get("success"):
                return {
                    "status": "success",
                    "action_name": data.get("action_name", "Unknown"),
                    "created": data.get("created", True),
                    "message": data.get("message", ""),
                }
            return {"status": "error", "message": "Unknown error"}
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return {"status": "unauthorized", "message": "API key invalid or revoked"}
        try:
            body = json.loads(e.read().decode())
            return {"status": "error", "message": body.get("error_description", str(e))}
        except Exception:
            return {"status": "error", "message": str(e)}
    except Exception as e:
        return {"status": "error", "message": str(e)}


# ============================================================================
# FULL DEVICE AUTH FLOW (SLOW PATH)
# ============================================================================

def initiate_device_flow(client_type: str = "claude-code") -> dict:
    """Request a new device code from the server.

    Sends git_remote (if available) for git-first project identification.
    Falls back to project_path when not in a git repo.
    """
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
            "project_path": get_project_path(),
            "git_remote": get_git_remote(),
        }).encode(),
        headers={
            "Content-Type": "application/json",
            "apikey": ANON_KEY,
        },
        method="POST"
    )

    with urllib.request.urlopen(req, timeout=10) as response:
        return json.loads(response.read().decode())


def poll_status(device_code: str) -> dict:
    """Poll for authorization status."""
    req = urllib.request.Request(
        f"{API_BASE}/device-auth/poll",
        data=json.dumps({"device_code": device_code}).encode(),
        headers={
            "Content-Type": "application/json",
            "apikey": ANON_KEY,
        },
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


def do_full_device_auth(client_type: str = "claude-code") -> dict:
    """
    Full device auth flow with browser sign-in.

    Returns dict with:
        - api_key: The new API key
        - email: User's email from Apple Sign-In
        - action_name: Name of the created action
    """
    client_names = {
        "claude-code": "Claude Code",
        "openai-codex": "OpenAI Codex"
    }
    client_name = client_names.get(client_type, "Claude Code")

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

    # Get the web OAuth URL
    auth_url = device_data.get("verification_uri_complete",
                               f"https://pushto.do/auth/cli?code={device_code}")

    # Open browser for OAuth
    print()
    print("  Opening browser for Sign in with Apple...")
    print()

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
                email = result.get("email", "Unknown")
                action_name = result.get("action_name", client_name)

                if api_key:
                    return {
                        "api_key": api_key,
                        "email": email,
                        "action_name": action_name,
                    }
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
        except urllib.error.URLError:
            sys.stdout.write(f"\r  Network error, retrying...              ")
            sys.stdout.flush()
        except Exception as e:
            sys.stdout.write(f"\r  Error: {e}. Retrying...                 ")
            sys.stdout.flush()

        time.sleep(poll_interval)


# ============================================================================
# MAIN
# ============================================================================

def main():
    # Parse command line arguments
    parser = argparse.ArgumentParser(description="Setup Push integration")
    parser.add_argument(
        "--client",
        choices=["claude-code", "openai-codex"],
        default="claude-code",
        help="Client type (default: claude-code)"
    )
    parser.add_argument(
        "--reauth",
        action="store_true",
        help="Force re-authentication (get new API key)"
    )
    args = parser.parse_args()

    client_type = args.client
    client_names = {
        "claude-code": "Claude Code",
        "openai-codex": "OpenAI Codex"
    }
    client_name = client_names.get(client_type, "Claude Code")

    print()
    print(f"  Push Voice Tasks Setup")
    print("  " + "=" * 40)
    print()

    # Check for --reauth flag
    if args.reauth:
        print("  Forcing re-authentication...")
        clear_config()

    existing_key = get_existing_key()
    existing_email = get_existing_email()

    if existing_key and existing_email and not args.reauth:
        # ─────────────────────────────────────────────────────────────────
        # FAST PATH: Already authenticated, just register project
        # ─────────────────────────────────────────────────────────────────
        print(f"  Connected as {existing_email}")
        print("  Registering project...")

        result = register_project(existing_key, client_type)

        if result["status"] == "success":
            print()
            print("  " + "=" * 40)
            if result["created"]:
                print(f'  Created action: "{result["action_name"]}"')
            else:
                print(f'  Found existing action: "{result["action_name"]}"')
            print("  " + "=" * 40)
            print()
            if result["created"]:
                print("  Your iOS app will sync this automatically.")
            else:
                print("  This project is already configured.")
            print()
            return

        elif result["status"] == "unauthorized":
            print()
            print("  Session expired, re-authenticating...")
            print()
            clear_config()
            # Fall through to full auth

        else:
            print()
            print(f"  Registration failed: {result.get('message', 'Unknown error')}")
            print("  Trying full setup...")
            print()
            # Fall through to full auth

    # ─────────────────────────────────────────────────────────────────────
    # SLOW PATH: First time or re-auth needed
    # ─────────────────────────────────────────────────────────────────────
    is_reauth = existing_key is not None

    result = do_full_device_auth(client_type)

    # Save credentials
    save_config(result["api_key"], result["email"])

    # Show success
    print()
    print("  " + "=" * 40)
    if is_reauth:
        print(f'  Re-connected as {result["email"]}')
    else:
        print(f'  Connected as {result["email"]}')
    print(f'  Created action: "{result["action_name"]}"')
    print("  " + "=" * 40)
    print()
    print("  Your iOS app will sync this automatically.")
    print()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n")
        print("  Setup cancelled.")
        print()
        sys.exit(1)
