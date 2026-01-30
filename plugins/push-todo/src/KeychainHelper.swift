#!/usr/bin/env swift
//
//  KeychainHelper.swift
//  push-todo CLI
//
//  Created on 2026-01-29.
//
//  Reads the Push encryption key from iCloud Keychain.
//  This helper is called by the Python CLI to decrypt encrypted todos.
//
//  COMPILE:
//    swiftc -O KeychainHelper.swift -o push-keychain-helper
//
//  USAGE:
//    ./push-keychain-helper           # Outputs base64-encoded key
//    ./push-keychain-helper --check   # Exits 0 if key exists, 1 if not
//    ./push-keychain-helper --version # Print version
//
//  EXIT CODES:
//    0 = Success
//    1 = Key not found
//    2 = iCloud Keychain not available
//    3 = Other error
//
//  CRITICAL: These values MUST match the iOS EncryptionService exactly:
//    - Service: "ai.massless.push.encryption"
//    - Account: "data-encryption-key"
//    - Synchronizable: true (iCloud Keychain)
//    - NO access group (allows CLI to read)
//
//  See: /docs/20260126_e2ee_cli_implementation_analysis.md
//

import Foundation
import Security

// MARK: - Constants

/// Version of this helper (for update checks)
let VERSION = "1.0.1"

/// Keychain service - MUST match iOS EncryptionService
let KEYCHAIN_SERVICE = "ai.massless.push.encryption"

/// Keychain account - MUST match iOS EncryptionService
let KEYCHAIN_ACCOUNT = "data-encryption-key"

// MARK: - Debug

var debugMode = false

func debug(_ message: String) {
    // Always write to file for debugging hangs
    let logPath = "/tmp/push-keychain-helper.log"
    let entry = "[DEBUG] \(message)\n"
    if let data = entry.data(using: .utf8) {
        if FileManager.default.fileExists(atPath: logPath) {
            if let handle = FileHandle(forWritingAtPath: logPath) {
                handle.seekToEndOfFile()
                handle.write(data)
                handle.closeFile()
            }
        } else {
            FileManager.default.createFile(atPath: logPath, contents: data)
        }
    }
    if debugMode {
        fputs("[DEBUG] \(message)\n", stderr)
    }
}

// MARK: - Exit Codes

enum ExitCode: Int32 {
    case success = 0
    case keyNotFound = 1
    case iCloudNotAvailable = 2
    case otherError = 3
}

// MARK: - Keychain Functions

/// Read the encryption key from iCloud Keychain.
///
/// - Returns: The key data, or nil if not found.
func readEncryptionKey() -> Data? {
    debug("Building keychain query...")
    debug("  Service: \(KEYCHAIN_SERVICE)")
    debug("  Account: \(KEYCHAIN_ACCOUNT)")
    debug("  Synchronizable: any (prefer synced)")

    // First try iCloud-synced key
    let syncQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: KEYCHAIN_SERVICE,
        kSecAttrAccount as String: KEYCHAIN_ACCOUNT,
        kSecAttrSynchronizable as String: true,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne
    ]

    debug("Trying iCloud-synced key first...")
    var result: AnyObject?
    var status = SecItemCopyMatching(syncQuery as CFDictionary, &result)
    debug("Synced query returned: \(status)")

    // If not found, try local key (fallback for testing or manual import)
    if status == errSecItemNotFound {
        debug("Synced key not found, trying local key...")
        let localQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: KEYCHAIN_SERVICE,
            kSecAttrAccount as String: KEYCHAIN_ACCOUNT,
            kSecAttrSynchronizable as String: false,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        result = nil
        status = SecItemCopyMatching(localQuery as CFDictionary, &result)
        debug("Local query returned: \(status)")
    }

    switch status {
    case errSecSuccess:
        debug("Success! Got key data.")
        return result as? Data

    case errSecItemNotFound:
        debug("Key not found in keychain.")
        return nil

    case errSecNotAvailable:
        // iCloud Keychain not available
        debug("iCloud Keychain not available (errSecNotAvailable)")
        fputs("Error: iCloud Keychain is not available on this Mac.\n", stderr)
        fputs("Make sure you're signed into iCloud and have Keychain enabled.\n", stderr)
        exit(ExitCode.iCloudNotAvailable.rawValue)

    case -34018: // errSecMissingEntitlement
        debug("Missing entitlement (errSecMissingEntitlement)")
        fputs("Error: Missing keychain entitlement. The helper may need to be properly signed.\n", stderr)
        exit(ExitCode.otherError.rawValue)

    default:
        debug("Query failed with status: \(status)")
        fputs("Error: Keychain query failed with status \(status)\n", stderr)
        exit(ExitCode.otherError.rawValue)
    }
}

/// Check if the encryption key exists (either synced or local).
///
/// - Returns: true if the key exists, false otherwise.
func keyExists() -> Bool {
    debug("Checking if key exists...")

    // First check iCloud-synced key
    let syncQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: KEYCHAIN_SERVICE,
        kSecAttrAccount as String: KEYCHAIN_ACCOUNT,
        kSecAttrSynchronizable as String: true,
        kSecReturnData as String: false
    ]

    debug("Checking synced key...")
    var result: AnyObject?
    var status = SecItemCopyMatching(syncQuery as CFDictionary, &result)
    debug("Synced check returned: \(status)")

    if status == errSecSuccess {
        return true
    }

    // Fallback to local key
    let localQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: KEYCHAIN_SERVICE,
        kSecAttrAccount as String: KEYCHAIN_ACCOUNT,
        kSecAttrSynchronizable as String: false,
        kSecReturnData as String: false
    ]

    debug("Checking local key...")
    result = nil
    status = SecItemCopyMatching(localQuery as CFDictionary, &result)
    debug("Local check returned: \(status)")

    return status == errSecSuccess
}

/// Store an encryption key in the LOCAL (file-based) keychain.
///
/// This is used for manual key import when iCloud Keychain sync doesn't work for CLI.
/// The key is stored with kSecAttrSynchronizable: false so it stays in login.keychain.
///
/// - Parameter keyData: The 32-byte AES-256 encryption key
/// - Returns: true if stored successfully, false otherwise.
func storeLocalKey(_ keyData: Data) -> Bool {
    debug("Storing key in local keychain...")
    debug("  Key size: \(keyData.count) bytes")

    // Validate key size (AES-256 = 32 bytes)
    guard keyData.count == 32 else {
        debug("Invalid key size: expected 32 bytes, got \(keyData.count)")
        return false
    }

    // Delete any existing local key first
    let deleteQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: KEYCHAIN_SERVICE,
        kSecAttrAccount as String: KEYCHAIN_ACCOUNT,
        kSecAttrSynchronizable as String: false
    ]

    let deleteStatus = SecItemDelete(deleteQuery as CFDictionary)
    debug("Delete existing returned: \(deleteStatus)")

    // Store new key
    let addQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: KEYCHAIN_SERVICE,
        kSecAttrAccount as String: KEYCHAIN_ACCOUNT,
        kSecAttrSynchronizable as String: false,  // CRITICAL: file-based keychain
        kSecValueData as String: keyData,
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
    ]

    let status = SecItemAdd(addQuery as CFDictionary, nil)
    debug("Add key returned: \(status)")

    return status == errSecSuccess
}

// MARK: - Main

func main() {
    // First thing - write to log to prove we started
    debug("=== Starting push-keychain-helper ===")

    let args = CommandLine.arguments

    // Check for debug mode
    if args.contains("--debug") || args.contains("-d") {
        debugMode = true
        debug("Debug mode enabled (stderr output)")
    }

    debug("push-keychain-helper v\(VERSION)")
    debug("Arguments: \(args)")

    // Handle --version
    if args.contains("--version") || args.contains("-v") {
        print(VERSION)
        exit(ExitCode.success.rawValue)
    }

    // Handle --help
    if args.contains("--help") || args.contains("-h") {
        print("""
        push-keychain-helper - Read/write Push encryption key

        USAGE:
            push-keychain-helper           Output base64-encoded encryption key
            push-keychain-helper --check   Check if key exists (exit 0) or not (exit 1)
            push-keychain-helper --store   Import key from stdin (base64)
            push-keychain-helper --debug   Enable debug output
            push-keychain-helper --version Print version
            push-keychain-helper --help    Show this help

        EXIT CODES:
            0  Success
            1  Key not found / invalid key
            2  iCloud Keychain not available
            3  Other error

        NOTES:
            - Key is stored by the Push iOS app in iCloud Keychain
            - For CLI, use --store to import key to local (file-based) keychain
            - First run may prompt for Keychain access permission
        """)
        exit(ExitCode.success.rawValue)
    }

    // Handle --store (import key from stdin)
    if args.contains("--store") {
        debug("Store mode: reading key from stdin...")

        // Read base64 key from stdin
        guard let inputLine = readLine() else {
            fputs("Error: No input provided. Paste the base64 key from your iOS app.\n", stderr)
            exit(ExitCode.keyNotFound.rawValue)
        }

        let base64Key = inputLine.trimmingCharacters(in: .whitespacesAndNewlines)
        debug("Read base64 key: \(base64Key.prefix(20))...")

        // Decode base64
        guard let keyData = Data(base64Encoded: base64Key) else {
            fputs("Error: Invalid base64 encoding.\n", stderr)
            exit(ExitCode.keyNotFound.rawValue)
        }

        debug("Decoded key: \(keyData.count) bytes")

        // Validate key size
        guard keyData.count == 32 else {
            fputs("Error: Invalid key size. Expected 32 bytes, got \(keyData.count).\n", stderr)
            exit(ExitCode.keyNotFound.rawValue)
        }

        // Store in local keychain
        if storeLocalKey(keyData) {
            print("Key stored successfully in macOS Keychain")
            exit(ExitCode.success.rawValue)
        } else {
            fputs("Error: Failed to store key in Keychain.\n", stderr)
            exit(ExitCode.otherError.rawValue)
        }
    }

    // Handle --check (just check if key exists)
    if args.contains("--check") {
        if keyExists() {
            print("Key exists")
            exit(ExitCode.success.rawValue)
        } else {
            print("Key not found")
            exit(ExitCode.keyNotFound.rawValue)
        }
    }

    // Default: read and output the key
    debug("Reading encryption key...")
    guard let keyData = readEncryptionKey() else {
        fputs("Error: Encryption key not found in iCloud Keychain.\n", stderr)
        fputs("Make sure:\n", stderr)
        fputs("  1. You have enabled E2EE in the Push iOS app\n", stderr)
        fputs("  2. iCloud Keychain is syncing to this Mac\n", stderr)
        fputs("  3. You're signed into the same Apple ID\n", stderr)
        exit(ExitCode.keyNotFound.rawValue)
    }

    debug("Key found, outputting base64...")
    // Output base64-encoded key to stdout
    print(keyData.base64EncodedString())
    exit(ExitCode.success.rawValue)
}

main()
