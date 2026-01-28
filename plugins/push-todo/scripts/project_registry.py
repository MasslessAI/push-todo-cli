"""
Project Registry - Maps git_remote to local paths.

This module enables the global daemon to route tasks to the correct project
by maintaining a local registry of git_remote -> local_path mappings.

Usage:
    from project_registry import ProjectRegistry, get_registry

    registry = get_registry()
    registry.register("github.com/user/Push", "/Users/you/projects/Push")
    path = registry.get_path("github.com/user/Push")

File location: ~/.config/push/projects.json
"""

import json
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List

REGISTRY_FILE = Path.home() / ".config" / "push" / "projects.json"
REGISTRY_VERSION = 1


class ProjectRegistry:
    """Manages the local project registry for global daemon routing."""

    def __init__(self):
        self._ensure_config_dir()
        self._data = self._load()

    def _ensure_config_dir(self):
        """Ensure config directory exists."""
        REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)

    def _load(self) -> Dict[str, Any]:
        """Load registry from disk."""
        if not REGISTRY_FILE.exists():
            return {
                "version": REGISTRY_VERSION,
                "projects": {},
                "default_project": None
            }

        try:
            with open(REGISTRY_FILE, "r") as f:
                data = json.load(f)
                # Migration: handle older versions if needed
                if data.get("version", 0) < REGISTRY_VERSION:
                    data = self._migrate(data)
                return data
        except (json.JSONDecodeError, IOError):
            return {
                "version": REGISTRY_VERSION,
                "projects": {},
                "default_project": None
            }

    def _save(self):
        """Save registry to disk."""
        with open(REGISTRY_FILE, "w") as f:
            json.dump(self._data, f, indent=2)

    def _migrate(self, data: Dict) -> Dict:
        """Migrate older registry versions."""
        # Future: handle migrations as needed
        data["version"] = REGISTRY_VERSION
        return data

    def register(self, git_remote: str, local_path: str) -> bool:
        """
        Register a project.

        Args:
            git_remote: Normalized git remote (e.g., "github.com/user/repo")
            local_path: Absolute local path

        Returns:
            True if newly registered, False if updated existing
        """
        is_new = git_remote not in self._data["projects"]

        now = datetime.now(timezone.utc).isoformat()

        if is_new:
            self._data["projects"][git_remote] = {
                "local_path": local_path,
                "registered_at": now,
                "last_used": now
            }
        else:
            self._data["projects"][git_remote]["local_path"] = local_path
            self._data["projects"][git_remote]["last_used"] = now

        # Set as default if first project
        if self._data["default_project"] is None:
            self._data["default_project"] = git_remote

        self._save()
        return is_new

    def get_path(self, git_remote: str) -> Optional[str]:
        """
        Get local path for a git remote.

        Args:
            git_remote: Normalized git remote

        Returns:
            Local path or None if not registered
        """
        project = self._data["projects"].get(git_remote)
        if project:
            # Update last_used
            project["last_used"] = datetime.now(timezone.utc).isoformat()
            self._save()
            return project["local_path"]
        return None

    def get_path_without_update(self, git_remote: str) -> Optional[str]:
        """
        Get local path for a git remote without updating last_used.

        Useful for status checks and listing operations.

        Args:
            git_remote: Normalized git remote

        Returns:
            Local path or None if not registered
        """
        project = self._data["projects"].get(git_remote)
        if project:
            return project["local_path"]
        return None

    def list_projects(self) -> Dict[str, str]:
        """
        List all registered projects.

        Returns:
            Dict of git_remote -> local_path
        """
        return {
            remote: info["local_path"]
            for remote, info in self._data["projects"].items()
        }

    def list_projects_with_metadata(self) -> Dict[str, Dict[str, Any]]:
        """
        List all registered projects with full metadata.

        Returns:
            Dict of git_remote -> {local_path, registered_at, last_used}
        """
        return dict(self._data["projects"])

    def unregister(self, git_remote: str) -> bool:
        """
        Unregister a project.

        Args:
            git_remote: Normalized git remote

        Returns:
            True if was registered, False if not found
        """
        if git_remote in self._data["projects"]:
            del self._data["projects"][git_remote]
            if self._data["default_project"] == git_remote:
                # Set new default
                remaining = list(self._data["projects"].keys())
                self._data["default_project"] = remaining[0] if remaining else None
            self._save()
            return True
        return False

    def get_default_project(self) -> Optional[str]:
        """Get the default project's git remote."""
        return self._data["default_project"]

    def set_default_project(self, git_remote: str) -> bool:
        """Set a project as the default."""
        if git_remote in self._data["projects"]:
            self._data["default_project"] = git_remote
            self._save()
            return True
        return False

    def project_count(self) -> int:
        """Return the number of registered projects."""
        return len(self._data["projects"])

    def is_registered(self, git_remote: str) -> bool:
        """Check if a project is registered."""
        return git_remote in self._data["projects"]

    def validate_paths(self) -> List[Dict[str, str]]:
        """
        Validate that all registered paths still exist.

        Returns:
            List of invalid entries: [{"git_remote": "...", "local_path": "...", "reason": "..."}]
        """
        invalid = []
        for git_remote, info in self._data["projects"].items():
            path = Path(info["local_path"])
            if not path.exists():
                invalid.append({
                    "git_remote": git_remote,
                    "local_path": info["local_path"],
                    "reason": "path_not_found"
                })
            elif not path.is_dir():
                invalid.append({
                    "git_remote": git_remote,
                    "local_path": info["local_path"],
                    "reason": "not_a_directory"
                })
            elif not (path / ".git").exists():
                invalid.append({
                    "git_remote": git_remote,
                    "local_path": info["local_path"],
                    "reason": "not_a_git_repo"
                })
        return invalid


# Singleton instance
_registry: Optional[ProjectRegistry] = None


def get_registry() -> ProjectRegistry:
    """Get the singleton registry instance."""
    global _registry
    if _registry is None:
        _registry = ProjectRegistry()
    return _registry


def reset_registry():
    """Reset the singleton (for testing)."""
    global _registry
    _registry = None


if __name__ == "__main__":
    # Simple self-test
    import sys

    registry = get_registry()
    print(f"Registry file: {REGISTRY_FILE}")
    print(f"Projects registered: {registry.project_count()}")

    projects = registry.list_projects()
    if projects:
        print("\nRegistered projects:")
        for remote, path in projects.items():
            print(f"  {remote}")
            print(f"    -> {path}")
    else:
        print("\nNo projects registered yet.")
        print("Run '/push-todo connect' in your project directories.")

    # Validate paths
    invalid = registry.validate_paths()
    if invalid:
        print("\nInvalid entries:")
        for entry in invalid:
            print(f"  {entry['git_remote']}: {entry['reason']}")
