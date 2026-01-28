#!/usr/bin/env python3
"""
Daemon health check - ensures daemon is running.
Call ensure_daemon_running() at the top of EVERY push-todo script.

This is THE self-healing function. It makes the daemon auto-heal on any
/push-todo command, so users never need to explicitly manage the daemon.

See: /docs/20260127_parallel_task_execution_research.md
See: /docs/20260127_parallel_task_execution_implementation_plan.md
"""

import os
import subprocess
import sys
from pathlib import Path

# Daemon configuration
DAEMON_SCRIPT = Path(__file__).parent / "daemon.py"
DAEMON_PID = Path.home() / ".push" / "daemon.pid"
DAEMON_LOG = Path.home() / ".push" / "daemon.log"

# Check if global mode is available
_script_dir = str(Path(__file__).parent)
if _script_dir not in sys.path:
    sys.path.insert(0, _script_dir)

try:
    from project_registry import get_registry
    GLOBAL_MODE_AVAILABLE = True
except ImportError:
    GLOBAL_MODE_AVAILABLE = False
    get_registry = None


def is_daemon_running() -> bool:
    """Check if daemon is running via PID file and process check."""
    if not DAEMON_PID.exists():
        return False

    try:
        pid = int(DAEMON_PID.read_text().strip())
        # Check if process exists (signal 0 = just check, don't kill)
        os.kill(pid, 0)
        return True
    except (ValueError, OSError, ProcessLookupError):
        # PID file corrupted, process dead, or no permission
        return False


def start_daemon() -> int:
    """
    Start daemon in background.
    Returns PID of started daemon.

    Global Mode (GLOBAL_MODE_AVAILABLE=True):
        Starts from home directory. Daemon uses project registry to
        route tasks to correct projects.

    Legacy Mode (GLOBAL_MODE_AVAILABLE=False):
        Starts from current directory. Daemon only handles tasks for
        the current project.
    """
    # Ensure log directory exists
    DAEMON_LOG.parent.mkdir(parents=True, exist_ok=True)

    # Determine working directory for daemon
    if GLOBAL_MODE_AVAILABLE:
        # Global mode: start from home directory
        # Daemon will use project registry to find project paths
        cwd = str(Path.home())
    else:
        # Legacy mode: start from current directory
        # Daemon will only handle tasks for current project
        cwd = os.getcwd()

    # Open log file for appending
    with open(DAEMON_LOG, "a") as log_file:
        proc = subprocess.Popen(
            [sys.executable, str(DAEMON_SCRIPT)],
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,  # Detach from parent process group
            cwd=cwd,
        )

    # Write PID file
    DAEMON_PID.parent.mkdir(parents=True, exist_ok=True)
    DAEMON_PID.write_text(str(proc.pid))

    return proc.pid


def stop_daemon() -> bool:
    """
    Stop daemon if running.
    Returns True if daemon was stopped, False if not running.
    """
    if not DAEMON_PID.exists():
        return False

    try:
        pid = int(DAEMON_PID.read_text().strip())
        os.kill(pid, 15)  # SIGTERM
        DAEMON_PID.unlink(missing_ok=True)
        return True
    except (ValueError, OSError, ProcessLookupError):
        DAEMON_PID.unlink(missing_ok=True)
        return False


def ensure_daemon_running() -> bool:
    """
    Ensure daemon is running. Start if needed.
    Returns True if daemon is now running.

    This is THE self-healing function. Call it at the top of every script.

    Usage:
        from daemon_health import ensure_daemon_running
        ensure_daemon_running()
    """
    if is_daemon_running():
        return True

    # Check if daemon script exists
    if not DAEMON_SCRIPT.exists():
        # Daemon script not yet created - silently skip
        # This allows the plugin to work before daemon is implemented
        return False

    # Start daemon
    try:
        pid = start_daemon()
        # Print to stderr so it doesn't interfere with JSON output
        print(f"[Push] Daemon started (PID: {pid})", file=sys.stderr)
        return True
    except Exception as e:
        print(f"[Push] Failed to start daemon: {e}", file=sys.stderr)
        return False


def get_daemon_status() -> dict:
    """
    Get detailed daemon status for /push-todo status command.

    Returns dict with:
        - running: bool
        - pid: int or None
        - uptime: str (e.g., "2h 30m") or None
        - log_file: str
        - mode: "global" or "legacy"
        - registered_projects: int (count, global mode only)
    """
    mode = "global" if GLOBAL_MODE_AVAILABLE else "legacy"
    registered_projects = 0

    if GLOBAL_MODE_AVAILABLE and get_registry:
        try:
            registry = get_registry()
            registered_projects = registry.project_count()
        except Exception:
            pass

    if not is_daemon_running():
        return {
            "running": False,
            "pid": None,
            "uptime": None,
            "log_file": str(DAEMON_LOG),
            "mode": mode,
            "registered_projects": registered_projects,
        }

    pid = int(DAEMON_PID.read_text().strip())

    # Calculate uptime from PID file mtime
    uptime = None
    try:
        import time
        mtime = DAEMON_PID.stat().st_mtime
        uptime_seconds = int(time.time() - mtime)
        hours = uptime_seconds // 3600
        minutes = (uptime_seconds % 3600) // 60
        if hours > 0:
            uptime = f"{hours}h {minutes}m"
        else:
            uptime = f"{minutes}m"
    except Exception:
        uptime = "unknown"

    return {
        "running": True,
        "pid": pid,
        "uptime": uptime,
        "log_file": str(DAEMON_LOG),
        "mode": mode,
        "registered_projects": registered_projects,
    }


if __name__ == "__main__":
    # When run directly, check/start daemon and report status
    import argparse

    parser = argparse.ArgumentParser(description="Push daemon health check")
    parser.add_argument("--status", action="store_true", help="Show daemon status")
    parser.add_argument("--stop", action="store_true", help="Stop daemon if running")
    parser.add_argument("--start", action="store_true", help="Start daemon if not running")
    args = parser.parse_args()

    if args.stop:
        if stop_daemon():
            print("Daemon stopped")
        else:
            print("Daemon was not running")
    elif args.status:
        status = get_daemon_status()
        if status["running"]:
            print(f"Daemon RUNNING (PID: {status['pid']}, uptime: {status['uptime']})")
            print(f"Log file: {status['log_file']}")
        else:
            print("Daemon NOT RUNNING")
            print("(Will auto-start on next /push-todo command)")
    else:
        # Default: ensure running
        ensure_daemon_running()
        status = get_daemon_status()
        if status["running"]:
            print(f"Daemon running (PID: {status['pid']}, uptime: {status['uptime']})")
        else:
            print("Daemon not running")
