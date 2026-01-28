"""
Machine Identification - Unique identifier for multi-Mac coordination.

This module generates and persists a unique machine identifier used for:
- Atomic task claiming (prevents multi-Mac race conditions)
- Task attribution (which Mac executed a task)
- Lease timeout recovery (identify stale claims)

Usage:
    from machine_id import get_machine_id, get_machine_name

    machine_id = get_machine_id()      # e.g., "Yuxiang-MacBook-Pro-a1b2c3d4"
    machine_name = get_machine_name()  # e.g., "Yuxiang-MacBook-Pro"

File location: ~/.config/push/machine_id
"""

import uuid
import platform
from pathlib import Path
from typing import Optional

MACHINE_ID_FILE = Path.home() / ".config" / "push" / "machine_id"


def _ensure_config_dir():
    """Ensure config directory exists."""
    MACHINE_ID_FILE.parent.mkdir(parents=True, exist_ok=True)


def get_machine_id() -> str:
    """
    Get or create a unique machine identifier.

    Format: "{hostname}-{random_hex}"
    Example: "Yuxiang-MacBook-Pro-a1b2c3d4"

    The ID is persisted to disk and reused across sessions.
    This ensures consistent identification even after restarts.

    Returns:
        Unique machine identifier string
    """
    if MACHINE_ID_FILE.exists():
        try:
            stored_id = MACHINE_ID_FILE.read_text().strip()
            if stored_id:
                return stored_id
        except IOError:
            pass

    # Generate new ID: hostname + random suffix
    hostname = platform.node()  # e.g., "Yuxiang-MacBook-Pro"
    random_suffix = uuid.uuid4().hex[:8]  # e.g., "a1b2c3d4"
    machine_id = f"{hostname}-{random_suffix}"

    # Persist to disk
    _ensure_config_dir()
    try:
        MACHINE_ID_FILE.write_text(machine_id)
    except IOError:
        # If we can't persist, still return the ID for this session
        pass

    return machine_id


def get_machine_name() -> str:
    """
    Get human-readable machine name.

    Returns the hostname without the random suffix.
    Example: "Yuxiang-MacBook-Pro"

    Returns:
        Human-readable machine name
    """
    return platform.node()


def get_machine_info() -> dict:
    """
    Get full machine information for debugging.

    Returns:
        Dict with machine_id, machine_name, platform info
    """
    return {
        "machine_id": get_machine_id(),
        "machine_name": get_machine_name(),
        "platform": platform.system(),  # "Darwin" for macOS
        "platform_release": platform.release(),
        "platform_version": platform.version(),
        "processor": platform.processor(),
    }


def reset_machine_id():
    """
    Delete the stored machine ID (for testing/debugging).

    The next call to get_machine_id() will generate a new ID.
    """
    if MACHINE_ID_FILE.exists():
        try:
            MACHINE_ID_FILE.unlink()
        except IOError:
            pass


if __name__ == "__main__":
    # Self-test
    print("Machine Information:")
    print("-" * 40)
    info = get_machine_info()
    for key, value in info.items():
        print(f"  {key}: {value}")
    print()
    print(f"ID file: {MACHINE_ID_FILE}")
    print(f"ID file exists: {MACHINE_ID_FILE.exists()}")
