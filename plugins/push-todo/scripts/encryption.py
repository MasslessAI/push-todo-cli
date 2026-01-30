#!/usr/bin/env python3
"""
encryption.py - End-to-end encryption support for Push CLI

Decrypts todo content encrypted by the Push iOS app.
Uses a Swift helper to read the encryption key from iCloud Keychain.

Encryption Format (version 0):
    [version: 1 byte] [nonce: 12 bytes] [ciphertext: N bytes] [tag: 16 bytes]

CRITICAL: This must match the iOS EncryptionService exactly.

See: /docs/20260126_e2ee_cli_implementation_analysis.md
"""

import base64
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional, Tuple

# AES-GCM constants (must match iOS CryptoKit)
VERSION_SIZE = 1
NONCE_SIZE = 12
TAG_SIZE = 16
MIN_CIPHERTEXT_SIZE = VERSION_SIZE + NONCE_SIZE + TAG_SIZE  # 29 bytes

# Supported encryption version
CURRENT_VERSION = 0


class EncryptionError(Exception):
    """Base exception for encryption errors."""
    pass


class KeyNotFoundError(EncryptionError):
    """Encryption key not found in Keychain."""
    pass


class KeychainUnavailableError(EncryptionError):
    """iCloud Keychain is not available."""
    pass


class DecryptionError(EncryptionError):
    """Failed to decrypt data."""
    pass


class UnsupportedVersionError(EncryptionError):
    """Encryption format version not supported."""
    pass


def get_helper_path() -> Path:
    """Get the path to the push-keychain-helper binary."""
    # Check if running from plugin directory
    plugin_root = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if plugin_root:
        helper = Path(plugin_root) / "bin" / "push-keychain-helper"
        if helper.exists():
            return helper

    # Fall back to default location
    default_path = Path.home() / ".claude" / "skills" / "push-todo" / "bin" / "push-keychain-helper"
    if default_path.exists():
        return default_path

    # Check if we need to compile it
    src_path = Path.home() / ".claude" / "skills" / "push-todo" / "src" / "KeychainHelper.swift"
    if src_path.exists():
        raise EncryptionError(
            f"Swift helper not compiled. Run:\n"
            f"  swiftc -O {src_path} -o {default_path}"
        )

    raise EncryptionError(
        "Encryption helper not found. Run '/push-todo connect' to set up E2EE."
    )


def get_encryption_key() -> bytes:
    """
    Read the encryption key from macOS Keychain via Swift helper.

    Returns:
        The 32-byte AES-256 key.

    Raises:
        KeyNotFoundError: Key not found in Keychain.
        KeychainUnavailableError: iCloud Keychain not available.
        EncryptionError: Other errors.
    """
    helper_path = get_helper_path()

    try:
        result = subprocess.run(
            [str(helper_path)],
            capture_output=True,
            text=True,
            timeout=10
        )
    except subprocess.TimeoutExpired:
        raise EncryptionError("Keychain helper timed out")
    except FileNotFoundError:
        raise EncryptionError(f"Keychain helper not found at {helper_path}")

    # Check exit code
    if result.returncode == 0:
        # Success - decode base64 key
        key_base64 = result.stdout.strip()
        try:
            key = base64.b64decode(key_base64)
            if len(key) != 32:
                raise EncryptionError(f"Invalid key length: {len(key)} (expected 32)")
            return key
        except Exception as e:
            raise EncryptionError(f"Failed to decode key: {e}")

    elif result.returncode == 1:
        raise KeyNotFoundError(
            "Encryption key not found. Make sure E2EE is enabled in the Push iOS app "
            "and iCloud Keychain is syncing."
        )

    elif result.returncode == 2:
        raise KeychainUnavailableError(
            "iCloud Keychain is not available. "
            "Make sure you're signed into iCloud with Keychain enabled."
        )

    else:
        stderr = result.stderr.strip() if result.stderr else "Unknown error"
        raise EncryptionError(f"Keychain helper failed: {stderr}")


def has_encryption_key() -> bool:
    """Check if an encryption key exists in Keychain."""
    try:
        helper_path = get_helper_path()
        result = subprocess.run(
            [str(helper_path), "--check"],
            capture_output=True,
            text=True,
            timeout=5
        )
        return result.returncode == 0
    except Exception:
        return False


def decrypt(ciphertext: bytes) -> bytes:
    """
    Decrypt data using AES-256-GCM.

    Args:
        ciphertext: Encrypted data in format [version][nonce][ciphertext][tag]

    Returns:
        Decrypted plaintext bytes.

    Raises:
        DecryptionError: Decryption failed.
        UnsupportedVersionError: Unknown encryption version.
        KeyNotFoundError: No encryption key available.
    """
    # Validate minimum size
    if len(ciphertext) < MIN_CIPHERTEXT_SIZE:
        raise DecryptionError(
            f"Ciphertext too short: {len(ciphertext)} bytes (minimum {MIN_CIPHERTEXT_SIZE})"
        )

    # Check version
    version = ciphertext[0]
    if version != CURRENT_VERSION:
        raise UnsupportedVersionError(
            f"Unsupported encryption version: {version} (expected {CURRENT_VERSION})"
        )

    # Get encryption key
    key = get_encryption_key()

    # Parse ciphertext components (skip version byte)
    data = ciphertext[1:]
    nonce = data[:NONCE_SIZE]
    encrypted_with_tag = data[NONCE_SIZE:]

    # Decrypt using cryptography library
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        raise EncryptionError(
            "cryptography package not installed. Run: pip install cryptography"
        )

    try:
        aesgcm = AESGCM(key)
        plaintext = aesgcm.decrypt(nonce, encrypted_with_tag, None)
        return plaintext
    except Exception as e:
        raise DecryptionError(f"Decryption failed: {e}")


def decrypt_string(ciphertext: bytes) -> str:
    """
    Decrypt data and return as UTF-8 string.

    Args:
        ciphertext: Encrypted data.

    Returns:
        Decrypted plaintext string.
    """
    plaintext = decrypt(ciphertext)
    try:
        return plaintext.decode("utf-8")
    except UnicodeDecodeError as e:
        raise DecryptionError(f"Decrypted data is not valid UTF-8: {e}")


def decrypt_base64(base64_ciphertext: str) -> bytes:
    """
    Decrypt base64-encoded ciphertext.

    Args:
        base64_ciphertext: Base64-encoded encrypted data.

    Returns:
        Decrypted plaintext bytes.
    """
    try:
        ciphertext = base64.b64decode(base64_ciphertext)
    except Exception as e:
        raise DecryptionError(f"Invalid base64 encoding: {e}")

    return decrypt(ciphertext)


def decrypt_base64_string(base64_ciphertext: str) -> str:
    """
    Decrypt base64-encoded ciphertext to string.

    Args:
        base64_ciphertext: Base64-encoded encrypted data.

    Returns:
        Decrypted plaintext string.
    """
    plaintext = decrypt_base64(base64_ciphertext)
    try:
        return plaintext.decode("utf-8")
    except UnicodeDecodeError as e:
        raise DecryptionError(f"Decrypted data is not valid UTF-8: {e}")


def decrypt_todo_field(encrypted_value: Optional[str]) -> Optional[str]:
    """
    Decrypt a todo field if it's encrypted, otherwise return as-is.

    This is a convenience function for handling todo fields that may or may
    not be encrypted. If the value is None or doesn't look like base64-encoded
    encrypted data, it's returned unchanged.

    Args:
        encrypted_value: Possibly encrypted field value (base64 or plaintext).

    Returns:
        Decrypted value, or original value if not encrypted.
    """
    if not encrypted_value:
        return encrypted_value

    # Quick check: encrypted data is base64 and has minimum length
    # Base64 of 29 bytes = 40 characters minimum
    if len(encrypted_value) < 40:
        return encrypted_value

    # Try to decode and check version byte
    try:
        decoded = base64.b64decode(encrypted_value)
        if len(decoded) < MIN_CIPHERTEXT_SIZE:
            return encrypted_value

        # Check version byte
        if decoded[0] != CURRENT_VERSION:
            return encrypted_value

        # Looks like encrypted data, try to decrypt
        return decrypt_string(decoded)

    except Exception:
        # Not encrypted or decryption failed - return original
        return encrypted_value


# Convenience function for checking E2EE status
def is_e2ee_available() -> Tuple[bool, str]:
    """
    Check if E2EE is available (helper exists and key is accessible).

    Returns:
        Tuple of (available: bool, message: str)
    """
    try:
        helper_path = get_helper_path()
    except EncryptionError as e:
        return False, str(e)

    if not has_encryption_key():
        return False, "Encryption key not found in iCloud Keychain"

    return True, "E2EE available"


if __name__ == "__main__":
    # Test mode
    import argparse

    parser = argparse.ArgumentParser(description="Push E2EE encryption utilities")
    parser.add_argument("--check", action="store_true", help="Check if E2EE is available")
    parser.add_argument("--decrypt", type=str, help="Decrypt base64-encoded data")
    args = parser.parse_args()

    if args.check:
        available, message = is_e2ee_available()
        print(f"E2EE available: {available}")
        print(f"Message: {message}")
        sys.exit(0 if available else 1)

    if args.decrypt:
        try:
            result = decrypt_base64_string(args.decrypt)
            print(result)
        except EncryptionError as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        parser.print_help()
