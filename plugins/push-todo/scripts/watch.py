#!/usr/bin/env python3
"""
Push Task Monitoring - Live Terminal UI

Displays real-time status of daemon task execution.
Reads from ~/.push/daemon_status.json (written by daemon.py).

Usage:
    python watch.py [--follow] [--status] [--json]

Options:
    --follow    Exit when all tasks complete (default: run until Ctrl+C)
    --status    Show current status once and exit (no ANSI, works in Claude Code)
    --json      Output status as JSON and exit

Keyboard controls (in live mode):
    q           Quit
    r           Force refresh

See: /docs/20260128_mac_terminal_daemon_ux_improvements.md
"""

import argparse
import json
import select
import sys
import termios
import time
import tty
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any

# Status file location (same as daemon.py)
STATUS_FILE = Path.home() / ".push" / "daemon_status.json"

# ANSI escape codes for terminal styling
class Colors:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"

    # Colors
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    BLUE = "\033[34m"
    RED = "\033[31m"
    CYAN = "\033[36m"
    MAGENTA = "\033[35m"

    # Cursor control
    CLEAR_SCREEN = "\033[2J"
    CURSOR_HOME = "\033[H"
    HIDE_CURSOR = "\033[?25l"
    SHOW_CURSOR = "\033[?25h"
    CLEAR_LINE = "\033[2K"


def format_duration(seconds: int) -> str:
    """Format seconds as human-readable duration."""
    if seconds < 60:
        return f"{seconds}s"
    elif seconds < 3600:
        mins = seconds // 60
        secs = seconds % 60
        return f"{mins}m {secs}s" if secs else f"{mins}m"
    else:
        hours = seconds // 3600
        mins = (seconds % 3600) // 60
        return f"{hours}h {mins}m" if mins else f"{hours}h"


def render_progress_bar(elapsed: int, estimated: int = 600, width: int = 20) -> str:
    """
    Render a text-based progress bar.

    Args:
        elapsed: Elapsed time in seconds
        estimated: Estimated total time (default 10 min)
        width: Bar width in characters

    Returns:
        Progress bar string like "████████░░░░░░░░░░░░"
    """
    if estimated <= 0:
        estimated = 600  # Default 10 min estimate

    progress = min(elapsed / estimated, 1.0)
    filled = int(width * progress)
    empty = width - filled

    # Use block characters for filled, light shade for empty
    bar = "█" * filled + "░" * empty

    return bar


def get_key_nonblocking() -> Optional[str]:
    """
    Non-blocking keyboard read.

    Returns single character if key pressed, None otherwise.
    Only works on Unix-like systems with a real terminal.
    """
    if not sys.stdin.isatty():
        return None

    try:
        # Check if input is available
        readable, _, _ = select.select([sys.stdin], [], [], 0)
        if readable:
            return sys.stdin.read(1)
    except Exception:
        pass

    return None


class TerminalMode:
    """Context manager for raw terminal mode (for keyboard input)."""

    def __init__(self):
        self.fd = None
        self.old_settings = None

    def __enter__(self):
        if sys.stdin.isatty():
            try:
                self.fd = sys.stdin.fileno()
                self.old_settings = termios.tcgetattr(self.fd)
                tty.setcbreak(self.fd)  # Use cbreak instead of raw (allows Ctrl+C)
            except Exception:
                pass
        return self

    def __exit__(self, *args):
        if self.fd is not None and self.old_settings is not None:
            try:
                termios.tcsetattr(self.fd, termios.TCSADRAIN, self.old_settings)
            except Exception:
                pass


def read_status() -> Optional[Dict[str, Any]]:
    """Read daemon status from file."""
    try:
        if not STATUS_FILE.exists():
            return None

        with open(STATUS_FILE, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return None


def render_header(status: Dict[str, Any]) -> str:
    """Render the header section."""
    daemon = status.get("daemon", {})
    stats = status.get("stats", {})

    lines = []
    lines.append(f"{Colors.BOLD}┌{'─' * 50}┐{Colors.RESET}")

    # Title with live indicator
    title = "Push Daemon - Live Monitor"
    live_indicator = f"{Colors.GREEN}[●]{Colors.RESET}" if daemon.get("pid") else f"{Colors.RED}[○]{Colors.RESET}"
    lines.append(f"{Colors.BOLD}│{Colors.RESET}  {title:<38} {live_indicator}  {Colors.BOLD}│{Colors.RESET}")

    lines.append(f"{Colors.BOLD}├{'─' * 50}┤{Colors.RESET}")

    return "\n".join(lines)


def render_task(task: Dict[str, Any], is_last: bool = False, show_details: bool = True) -> str:
    """
    Render a single task row with optional progress bar and branch.

    Enhanced P3 features:
    - Progress bar for running tasks
    - Branch name display
    - Phase indicator
    """
    display_num = task.get("display_number", "?")
    summary = task.get("summary", "Unknown task")[:32]
    status = task.get("status", "unknown")
    phase = task.get("phase", "")

    # Status indicator and color
    if status == "running":
        indicator = f"{Colors.GREEN}●{Colors.RESET}"
        status_text = f"{Colors.GREEN}RUNNING{Colors.RESET}"
        elapsed = task.get("elapsed_seconds", 0)
        time_text = format_duration(elapsed)
    elif status == "queued":
        indicator = f"{Colors.YELLOW}○{Colors.RESET}"
        status_text = f"{Colors.YELLOW}QUEUED{Colors.RESET}"
        time_text = ""
    elif status == "completed":
        indicator = f"{Colors.GREEN}✓{Colors.RESET}"
        status_text = f"{Colors.DIM}DONE{Colors.RESET}"
        duration = task.get("duration_seconds", 0)
        time_text = format_duration(duration)
    elif status == "failed":
        indicator = f"{Colors.RED}✗{Colors.RESET}"
        status_text = f"{Colors.RED}FAILED{Colors.RESET}"
        duration = task.get("duration_seconds", 0)
        time_text = format_duration(duration)
    elif status == "timeout":
        indicator = f"{Colors.RED}⏱{Colors.RESET}"
        status_text = f"{Colors.RED}TIMEOUT{Colors.RESET}"
        duration = task.get("duration_seconds", 0)
        time_text = format_duration(duration)
    else:
        indicator = "?"
        status_text = status[:7]
        time_text = ""

    lines = []

    # Main task line
    task_line = f"{Colors.BOLD}│{Colors.RESET}  {indicator} #{display_num:<4} {summary:<25} {status_text:>10} {time_text:>6}  {Colors.BOLD}│{Colors.RESET}"
    lines.append(task_line)

    # Show progress bar for running tasks
    if status == "running" and show_details:
        elapsed = task.get("elapsed_seconds", 0)
        # Estimate based on phase or default 10 min
        estimated = 600  # 10 min default
        if phase == "analyzing":
            estimated = 30
        elif phase == "planning":
            estimated = 300
        elif phase == "executing":
            estimated = 600

        progress_bar = render_progress_bar(elapsed, estimated, width=20)
        est_text = f"~{format_duration(estimated)}"
        progress_line = f"{Colors.BOLD}│{Colors.RESET}    {Colors.CYAN}{progress_bar}{Colors.RESET} {format_duration(elapsed):>6} / {est_text:<6}  {Colors.BOLD}│{Colors.RESET}"
        lines.append(progress_line)

        # Show branch if available
        branch = task.get("branch") or f"push-{display_num}-*"
        branch_line = f"{Colors.BOLD}│{Colors.RESET}    {Colors.DIM}Branch: {branch:<40}{Colors.RESET}  {Colors.BOLD}│{Colors.RESET}"
        lines.append(branch_line)

    # Show detail/phase for running tasks
    if status == "running" and task.get("detail") and show_details:
        detail = task.get("detail", "")[:44]
        phase_indicator = ""
        if phase == "analyzing":
            phase_indicator = f"{Colors.CYAN}◐{Colors.RESET} "
        elif phase == "planning":
            phase_indicator = f"{Colors.YELLOW}◑{Colors.RESET} "
        elif phase == "executing":
            phase_indicator = f"{Colors.GREEN}◒{Colors.RESET} "
        elif phase == "stuck" or phase == "idle":
            phase_indicator = f"{Colors.RED}◓{Colors.RESET} "

        detail_line = f"{Colors.BOLD}│{Colors.RESET}    {phase_indicator}{Colors.DIM}{detail:<42}{Colors.RESET}  {Colors.BOLD}│{Colors.RESET}"
        lines.append(detail_line)

    # Show PR URL for completed tasks
    if status == "completed" and task.get("pr_url"):
        pr_url = task.get("pr_url", "")[:44]
        pr_line = f"{Colors.BOLD}│{Colors.RESET}    {Colors.DIM}PR: {pr_url:<44}{Colors.RESET}  {Colors.BOLD}│{Colors.RESET}"
        lines.append(pr_line)

    return "\n".join(lines)


def render_completed_section(completed: list) -> str:
    """Render the completed tasks section."""
    if not completed:
        return ""

    lines = []
    lines.append(f"{Colors.BOLD}├{'─' * 50}┤{Colors.RESET}")

    # Show last 3 completed tasks
    for task in completed[-3:]:
        lines.append(render_task(task))

    return "\n".join(lines)


def render_footer(status: Dict[str, Any]) -> str:
    """Render the footer section."""
    stats = status.get("stats", {})
    daemon = status.get("daemon", {})

    running = stats.get("running", 0)
    max_concurrent = stats.get("max_concurrent", 5)
    completed_today = stats.get("completed_today", 0)
    pid = daemon.get("pid", "?")
    machine = daemon.get("machine_name", "")

    lines = []
    lines.append(f"{Colors.BOLD}├{'─' * 50}┤{Colors.RESET}")

    footer_text = f"Today: {completed_today} │ PID {pid} │ {running}/{max_concurrent} slots"
    if machine:
        footer_text = f"{machine[:12]} │ " + footer_text
    lines.append(f"{Colors.BOLD}│{Colors.RESET}  {Colors.DIM}{footer_text:<48}{Colors.RESET}  {Colors.BOLD}│{Colors.RESET}")

    lines.append(f"{Colors.BOLD}└{'─' * 50}┘{Colors.RESET}")
    lines.append(f"{Colors.DIM}q=quit  r=refresh  │  Updates every 500ms{Colors.RESET}")

    return "\n".join(lines)


def render_no_daemon() -> str:
    """Render message when daemon is not running."""
    lines = []
    lines.append(f"{Colors.BOLD}┌{'─' * 50}┐{Colors.RESET}")
    lines.append(f"{Colors.BOLD}│{Colors.RESET}  Push Daemon - Live Monitor       {Colors.RED}[○] Offline{Colors.RESET}  {Colors.BOLD}│{Colors.RESET}")
    lines.append(f"{Colors.BOLD}├{'─' * 50}┤{Colors.RESET}")
    lines.append(f"{Colors.BOLD}│{Colors.RESET}                                                    {Colors.BOLD}│{Colors.RESET}")
    lines.append(f"{Colors.BOLD}│{Colors.RESET}  {Colors.YELLOW}Daemon not running{Colors.RESET}                               {Colors.BOLD}│{Colors.RESET}")
    lines.append(f"{Colors.BOLD}│{Colors.RESET}  {Colors.DIM}Run any /push-todo command to auto-start{Colors.RESET}         {Colors.BOLD}│{Colors.RESET}")
    lines.append(f"{Colors.BOLD}│{Colors.RESET}                                                    {Colors.BOLD}│{Colors.RESET}")
    lines.append(f"{Colors.BOLD}└{'─' * 50}┘{Colors.RESET}")
    lines.append(f"{Colors.DIM}q=quit  r=refresh  │  Checking every 2s{Colors.RESET}")
    return "\n".join(lines)


def render_no_tasks(status: Dict[str, Any]) -> str:
    """Render message when no active tasks."""
    daemon = status.get("daemon", {})
    stats = status.get("stats", {})
    completed_today = stats.get("completed_today", 0)

    lines = []
    lines.append(f"{Colors.BOLD}┌{'─' * 50}┐{Colors.RESET}")
    lines.append(f"{Colors.BOLD}│{Colors.RESET}  Push Daemon - Live Monitor          {Colors.GREEN}[●] Live{Colors.RESET}  {Colors.BOLD}│{Colors.RESET}")
    lines.append(f"{Colors.BOLD}├{'─' * 50}┤{Colors.RESET}")
    lines.append(f"{Colors.BOLD}│{Colors.RESET}                                                    {Colors.BOLD}│{Colors.RESET}")
    lines.append(f"{Colors.BOLD}│{Colors.RESET}  {Colors.DIM}No active tasks{Colors.RESET}                                   {Colors.BOLD}│{Colors.RESET}")
    lines.append(f"{Colors.BOLD}│{Colors.RESET}  {Colors.DIM}Queue tasks with /push-todo{Colors.RESET}                       {Colors.BOLD}│{Colors.RESET}")
    lines.append(f"{Colors.BOLD}│{Colors.RESET}                                                    {Colors.BOLD}│{Colors.RESET}")

    # Show completed today if any
    if completed_today > 0:
        lines.append(f"{Colors.BOLD}├{'─' * 50}┤{Colors.RESET}")
        lines.append(f"{Colors.BOLD}│{Colors.RESET}  {Colors.GREEN}✓{Colors.RESET} {completed_today} task(s) completed today                      {Colors.BOLD}│{Colors.RESET}")

    lines.append(f"{Colors.BOLD}└{'─' * 50}┘{Colors.RESET}")
    lines.append(f"{Colors.DIM}q=quit  r=refresh  │  Updates every 500ms{Colors.RESET}")
    return "\n".join(lines)


def render(status: Optional[Dict[str, Any]]) -> str:
    """Render the full terminal UI."""
    if not status:
        return render_no_daemon()

    active_tasks = status.get("active_tasks", [])
    completed = status.get("completed_today", [])

    if not active_tasks:
        return render_no_tasks(status)

    lines = []
    lines.append(render_header(status))

    # Active tasks
    for i, task in enumerate(active_tasks):
        is_last = i == len(active_tasks) - 1
        lines.append(render_task(task, is_last))

    # Completed section (if any)
    completed_output = render_completed_section(completed)
    if completed_output:
        lines.append(completed_output)

    lines.append(render_footer(status))

    return "\n".join(lines)


def render_plain_status(status: Optional[Dict[str, Any]]) -> str:
    """Render status as plain text (no ANSI codes) for Claude Code."""
    if not status:
        return "Daemon: OFFLINE\n\nRun any /push-todo command to start the daemon."

    daemon = status.get("daemon", {})
    stats = status.get("stats", {})
    active_tasks = status.get("active_tasks", [])
    completed = status.get("completed_today", [])

    lines = []
    lines.append(f"Daemon: ONLINE (v{daemon.get('version', '?')}, PID {daemon.get('pid', '?')})")
    lines.append(f"Machine: {daemon.get('machine_name', 'unknown')}")
    lines.append("")

    running = [t for t in active_tasks if t.get("status") == "running"]
    queued = [t for t in active_tasks if t.get("status") == "queued"]

    if running:
        lines.append(f"Running ({len(running)}):")
        for task in running:
            elapsed = format_duration(task.get("elapsed_seconds", 0))
            detail = task.get("detail", "")
            lines.append(f"  ● #{task.get('display_number', '?')} {task.get('summary', 'Unknown')[:40]} ({elapsed})")
            if detail:
                lines.append(f"    └─ {detail[:50]}")

    if queued:
        lines.append(f"\nQueued ({len(queued)}):")
        for task in queued:
            lines.append(f"  ○ #{task.get('display_number', '?')} {task.get('summary', 'Unknown')[:40]}")

    if not running and not queued:
        lines.append("No active tasks")

    lines.append("")
    lines.append(f"Completed today: {stats.get('completed_today', 0)} | Slots: {stats.get('running', 0)}/{stats.get('max_concurrent', 5)}")

    if completed:
        lines.append(f"\nRecent completions:")
        for task in completed[-3:]:
            duration = format_duration(task.get("duration_seconds", 0))
            lines.append(f"  ✓ #{task.get('display_number', '?')} ({duration})")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Monitor Push daemon task execution")
    parser.add_argument("--follow", "-f", action="store_true",
                       help="Exit when all tasks complete")
    parser.add_argument("--status", "-s", action="store_true",
                       help="Show current status once and exit (no ANSI, works in Claude Code)")
    parser.add_argument("--json", action="store_true",
                       help="Output status as JSON and exit")
    args = parser.parse_args()

    # Single-shot modes (no loop, no ANSI)
    if args.json:
        status = read_status()
        print(json.dumps(status, indent=2, default=str) if status else "{}")
        return

    if args.status:
        status = read_status()
        print(render_plain_status(status))
        return

    print(Colors.HIDE_CURSOR, end="")

    try:
        last_render = ""
        no_task_count = 0
        force_refresh = False

        with TerminalMode():
            while True:
                # Check for keyboard input
                key = get_key_nonblocking()
                if key:
                    if key.lower() == 'q':
                        break  # Quit
                    elif key.lower() == 'r':
                        force_refresh = True  # Force refresh

                # Read status
                status = read_status()

                # Check if we should exit (--follow mode)
                if args.follow:
                    if status:
                        active_tasks = status.get("active_tasks", [])
                        if not active_tasks:
                            no_task_count += 1
                            if no_task_count >= 4:  # 2 seconds of no tasks
                                print(Colors.SHOW_CURSOR, end="")
                                print(f"\n{Colors.GREEN}All tasks completed.{Colors.RESET}")
                                return
                        else:
                            no_task_count = 0

                # Render UI
                output = render(status)

                # Only redraw if changed or forced (reduces flicker)
                if output != last_render or force_refresh:
                    print(Colors.CLEAR_SCREEN + Colors.CURSOR_HOME, end="")
                    print(output)
                    last_render = output
                    force_refresh = False

                # Sleep interval (faster when daemon running, slower when not)
                # Use smaller sleep to be more responsive to keyboard
                interval = 0.1 if status else 0.5
                time.sleep(interval)

    except KeyboardInterrupt:
        pass
    finally:
        print(Colors.SHOW_CURSOR, end="")
        print()


if __name__ == "__main__":
    main()
