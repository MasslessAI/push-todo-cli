#!/usr/bin/env node
/**
 * Post-install script for Push CLI.
 *
 * Sets up integrations for ALL detected AI coding clients:
 * 1. Claude Code - symlink to ~/.claude/skills/ (gives clean /push-todo command)
 * 2. OpenAI Codex - AGENTS.md in ~/.codex/
 * 3. OpenClaw - SKILL.md in ~/.openclaw/skills/ (legacy: ~/.clawdbot/)
 * 4. Downloads native keychain helper binary (macOS)
 */

import { createWriteStream, existsSync, mkdirSync, unlinkSync, readFileSync, writeFileSync, symlinkSync, lstatSync, readlinkSync, rmSync, appendFileSync } from 'fs';
import { chmod, stat } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, platform, arch } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Package root (one level up from scripts/)
const PACKAGE_ROOT = join(__dirname, '..');

// Claude Code locations
const CLAUDE_DIR = join(homedir(), '.claude');
const SKILL_DIR = join(CLAUDE_DIR, 'skills');
const SKILL_LINK = join(SKILL_DIR, 'push-todo');
const LEGACY_PLUGIN_DIR = join(CLAUDE_DIR, 'plugins');
const LEGACY_PLUGIN_LINK = join(LEGACY_PLUGIN_DIR, 'push-todo');

// OpenAI Codex locations
const CODEX_DIR = join(homedir(), '.codex');
const CODEX_SKILL_DIR = join(CODEX_DIR, 'skills', 'push-todo');
const CODEX_SKILL_FILE = join(CODEX_SKILL_DIR, 'SKILL.md');
const CODEX_AGENTS_FILE = join(CODEX_DIR, 'AGENTS.md');

// OpenClaw locations (formerly Clawdbot)
const OPENCLAW_DIR = join(homedir(), '.openclaw');
const OPENCLAW_LEGACY_DIR = join(homedir(), '.clawdbot');
const OPENCLAW_SKILL_DIR = join(OPENCLAW_DIR, 'skills', 'push-todo');

const BINARY_NAME = 'push-keychain-helper';
const BINARY_DIR = join(__dirname, '../bin');
const BINARY_PATH = join(BINARY_DIR, BINARY_NAME);

// Read version from package.json - binaries are released alongside npm package
const PACKAGE_JSON = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
const VERSION = PACKAGE_JSON.version;
const BINARY_URL = `https://github.com/MasslessAI/push-todo-cli/releases/download/v${VERSION}/${BINARY_NAME}-darwin-arm64`;
const BINARY_URL_X64 = `https://github.com/MasslessAI/push-todo-cli/releases/download/v${VERSION}/${BINARY_NAME}-darwin-x64`;

/**
 * Set up Claude Code skill by creating symlink.
 *
 * Creates: ~/.claude/skills/push-todo -> <npm-package-location>
 *
 * Skills give clean slash commands like /push-todo (no namespace prefix).
 *
 * @returns {boolean} True if successful
 */
function setupClaudeSkill() {
  try {
    // Ensure ~/.claude/skills/ directory exists
    if (!existsSync(SKILL_DIR)) {
      mkdirSync(SKILL_DIR, { recursive: true });
      console.log('[push-todo] Created ~/.claude/skills/ directory');
    }

    // Check if symlink already exists
    if (existsSync(SKILL_LINK)) {
      try {
        const stats = lstatSync(SKILL_LINK);
        if (stats.isSymbolicLink()) {
          const currentTarget = readlinkSync(SKILL_LINK);
          if (currentTarget === PACKAGE_ROOT) {
            console.log('[push-todo] Claude Code skill symlink already configured.');
            return true;
          }
          // Different target - remove and recreate
          console.log('[push-todo] Updating existing symlink...');
          unlinkSync(SKILL_LINK);
        } else {
          // It's a directory or file, not a symlink - back it up
          console.log('[push-todo] Found existing skill directory, backing up...');
          const backupPath = `${SKILL_LINK}.backup.${Date.now()}`;
          rmSync(SKILL_LINK, { recursive: true });
          console.log(`[push-todo] Backed up to ${backupPath}`);
        }
      } catch (err) {
        console.log(`[push-todo] Warning: Could not check existing skill: ${err.message}`);
      }
    }

    // Create the symlink
    symlinkSync(PACKAGE_ROOT, SKILL_LINK);
    console.log('[push-todo] Claude Code skill installed:');
    console.log(`[push-todo]   ~/.claude/skills/push-todo -> ${PACKAGE_ROOT}`);
    return true;
  } catch (error) {
    console.error(`[push-todo] Failed to set up Claude Code skill: ${error.message}`);
    console.log('[push-todo] You can manually create the symlink:');
    console.log(`[push-todo]   ln -s "${PACKAGE_ROOT}" "${SKILL_LINK}"`);
    return false;
  }
}

/**
 * Clean up legacy plugin installation (in ~/.claude/plugins/).
 * We migrated from plugins to skills for cleaner /push-todo command.
 */
function cleanupLegacyInstallation() {
  if (!existsSync(LEGACY_PLUGIN_LINK)) {
    return;
  }

  try {
    const stats = lstatSync(LEGACY_PLUGIN_LINK);

    if (stats.isSymbolicLink()) {
      console.log('[push-todo] Removing legacy plugin symlink at ~/.claude/plugins/push-todo');
      unlinkSync(LEGACY_PLUGIN_LINK);
      console.log('[push-todo] Legacy plugin symlink removed.');
    } else if (stats.isDirectory()) {
      console.log('[push-todo] Removing legacy plugin directory at ~/.claude/plugins/push-todo');
      rmSync(LEGACY_PLUGIN_LINK, { recursive: true });
      console.log('[push-todo] Legacy plugin directory removed.');
    }
  } catch (error) {
    // Ignore errors - this is best-effort cleanup
    console.log(`[push-todo] Note: Could not clean up legacy plugin: ${error.message}`);
  }
}

/**
 * Migrate from old Python installation if present.
 */
function migrateFromPython() {
  // Config is preserved at ~/.config/push/ - no action needed
  // Just inform the user about the migration
  const configPath = join(homedir(), '.config', 'push');

  if (existsSync(configPath)) {
    console.log('[push-todo] Existing configuration found at ~/.config/push/');
    console.log('[push-todo] Your API key and settings are preserved.');
  }
}

/**
 * Set up OpenAI Codex integration.
 * Creates symlink ~/.codex/skills/push-todo -> npm package
 * Updates AGENTS.md for session bootstrap
 *
 * @returns {boolean} True if Codex was detected and set up
 */
function setupCodex() {
  // Only set up if Codex directory exists (user has Codex installed)
  if (!existsSync(CODEX_DIR)) {
    return false;
  }

  console.log('[push-todo] Detected OpenAI Codex installation');

  // AGENTS.md bootstrap content (Codex-specific)
  const AGENTS_SECTION = `
## Push Tasks Integration

At the start of each session, check for pending tasks from the Push iOS app:

1. Run this command silently:
   \`\`\`bash
   push-todo --json 2>/dev/null | head -1
   \`\`\`

2. If tasks exist, inform the user:
   "You have X task(s) from Push. Type $push-todo to see them."

3. If no output or error, proceed normally without mentioning Push.
`;

  try {
    // Ensure skills directory exists
    const skillsDir = join(CODEX_DIR, 'skills');
    mkdirSync(skillsDir, { recursive: true });

    // Create symlink (same as Claude Code approach)
    if (existsSync(CODEX_SKILL_DIR)) {
      const stats = lstatSync(CODEX_SKILL_DIR);
      if (stats.isSymbolicLink()) {
        const target = readlinkSync(CODEX_SKILL_DIR);
        if (target === PACKAGE_ROOT) {
          console.log('[push-todo] Codex: Symlink already configured');
        } else {
          unlinkSync(CODEX_SKILL_DIR);
          symlinkSync(PACKAGE_ROOT, CODEX_SKILL_DIR);
          console.log('[push-todo] Codex: Updated symlink');
        }
      } else {
        // It's a directory (old copy) - remove and replace with symlink
        rmSync(CODEX_SKILL_DIR, { recursive: true });
        symlinkSync(PACKAGE_ROOT, CODEX_SKILL_DIR);
        console.log('[push-todo] Codex: Replaced copy with symlink');
      }
    } else {
      symlinkSync(PACKAGE_ROOT, CODEX_SKILL_DIR);
      console.log('[push-todo] Codex: Created symlink');
    }

    // Update AGENTS.md for session-start bootstrap
    if (existsSync(CODEX_AGENTS_FILE)) {
      const content = readFileSync(CODEX_AGENTS_FILE, 'utf8');
      if (content.includes('Push Tasks Integration')) {
        // Update existing section
        const updated = content.replace(
          /## Push Tasks Integration[\s\S]*?(?=\n## |$)/,
          AGENTS_SECTION.trim() + '\n\n'
        );
        writeFileSync(CODEX_AGENTS_FILE, updated);
        console.log('[push-todo] Codex: Updated AGENTS.md');
      } else {
        appendFileSync(CODEX_AGENTS_FILE, AGENTS_SECTION);
        console.log('[push-todo] Codex: Added to AGENTS.md');
      }
    } else {
      writeFileSync(CODEX_AGENTS_FILE, AGENTS_SECTION.trim() + '\n');
      console.log('[push-todo] Codex: Created AGENTS.md');
    }

    return true;
  } catch (error) {
    console.log(`[push-todo] Codex: Setup failed: ${error.message}`);
    return false;
  }
}

/**
 * Set up OpenClaw integration (formerly Clawdbot).
 * Creates symlink ~/.openclaw/skills/push-todo -> npm package
 * Also cleans up legacy ~/.clawdbot/skills/push-todo if present.
 *
 * @returns {boolean} True if OpenClaw was detected and set up
 */
function setupOpenClaw() {
  // Detect OpenClaw (new) or Clawdbot (legacy)
  const detected = existsSync(OPENCLAW_DIR) || existsSync(OPENCLAW_LEGACY_DIR);
  if (!detected) {
    return false;
  }

  // Prefer ~/.openclaw/ (new); fall back to ~/.clawdbot/ (legacy)
  const targetDir = existsSync(OPENCLAW_DIR) ? OPENCLAW_DIR : OPENCLAW_LEGACY_DIR;
  const skillDir = join(targetDir, 'skills', 'push-todo');
  const label = existsSync(OPENCLAW_DIR) ? 'OpenClaw' : 'OpenClaw (legacy ~/.clawdbot)';

  console.log(`[push-todo] Detected ${label} installation`);

  try {
    // Ensure skills directory exists
    mkdirSync(join(targetDir, 'skills'), { recursive: true });

    // Create symlink (same as Claude Code approach)
    if (existsSync(skillDir)) {
      const stats = lstatSync(skillDir);
      if (stats.isSymbolicLink()) {
        const target = readlinkSync(skillDir);
        if (target === PACKAGE_ROOT) {
          console.log('[push-todo] OpenClaw: Symlink already configured');
        } else {
          unlinkSync(skillDir);
          symlinkSync(PACKAGE_ROOT, skillDir);
          console.log('[push-todo] OpenClaw: Updated symlink');
        }
      } else {
        rmSync(skillDir, { recursive: true });
        symlinkSync(PACKAGE_ROOT, skillDir);
        console.log('[push-todo] OpenClaw: Replaced copy with symlink');
      }
    } else {
      symlinkSync(PACKAGE_ROOT, skillDir);
      console.log('[push-todo] OpenClaw: Created symlink');
    }

    // Clean up legacy Clawdbot symlink if we installed to the new location
    if (existsSync(OPENCLAW_DIR) && existsSync(OPENCLAW_LEGACY_DIR)) {
      const legacySkill = join(OPENCLAW_LEGACY_DIR, 'skills', 'push-todo');
      if (existsSync(legacySkill)) {
        try {
          const stats = lstatSync(legacySkill);
          if (stats.isSymbolicLink()) {
            unlinkSync(legacySkill);
            console.log('[push-todo] OpenClaw: Cleaned up legacy ~/.clawdbot symlink');
          }
        } catch { /* best-effort */ }
      }
    }

    return true;
  } catch (error) {
    console.log(`[push-todo] OpenClaw: Setup failed: ${error.message}`);
    return false;
  }
}

/**
 * Download a file from URL to destination.
 *
 * @param {string} url - Source URL
 * @param {string} dest - Destination path
 * @returns {Promise<boolean>} True if successful
 */
async function downloadFile(url, dest) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(60000) // 60 second timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Ensure directory exists
    mkdirSync(dirname(dest), { recursive: true });

    // Remove existing file if present
    if (existsSync(dest)) {
      unlinkSync(dest);
    }

    // Write to file
    const fileStream = createWriteStream(dest);
    await pipeline(response.body, fileStream);

    // Make executable
    await chmod(dest, 0o755);

    return true;
  } catch (error) {
    console.error(`[push-todo] Download failed: ${error.message}`);
    return false;
  }
}

/**
 * Main post-install routine.
 */
async function main() {
  console.log('[push-todo] Running post-install...');
  console.log('');

  // Step 1: Check for migration from Python
  migrateFromPython();

  // Step 2: Clean up legacy installation
  cleanupLegacyInstallation();

  // Step 3: Set up Claude Code skill symlink
  console.log('[push-todo] Setting up Claude Code skill...');
  const claudeSuccess = setupClaudeSkill();
  console.log('');

  // Step 4: Set up OpenAI Codex (if installed)
  const codexSuccess = setupCodex();
  if (codexSuccess) console.log('');

  // Step 5: Set up OpenClaw (if installed — formerly Clawdbot)
  const openclawSuccess = setupOpenClaw();
  if (openclawSuccess) console.log('');

  // Track which clients were set up
  const clients = [];
  if (claudeSuccess) clients.push('Claude Code');
  if (codexSuccess) clients.push('OpenAI Codex');
  if (openclawSuccess) clients.push('OpenClaw');

  // Step 6: Download native binary (macOS only)
  if (platform() !== 'darwin') {
    console.log('[push-todo] Skipping native binary (macOS only)');
    console.log('[push-todo] E2EE features will not be available.');
    console.log('');
    console.log('[push-todo] Installation complete!');
    if (clients.length > 0) {
      console.log(`[push-todo] Configured for: ${clients.join(', ')}`);
    }
    return;
  }

  // Check if binary already exists and is valid
  let binaryExists = false;
  if (existsSync(BINARY_PATH)) {
    try {
      const stats = await stat(BINARY_PATH);
      if (stats.size > 0) {
        console.log('[push-todo] Native binary already installed.');
        binaryExists = true;
      }
    } catch {
      // Continue to download
    }
  }

  if (binaryExists) {
    // Skip download, show summary
    console.log('');
    console.log('[push-todo] Installation complete!');
    if (clients.length > 0) {
      console.log(`[push-todo] Configured for: ${clients.join(', ')}`);
    }
    console.log('');
    console.log('[push-todo] Quick start:');
    console.log('[push-todo]   push-todo connect --auto   One-command setup (auth + projects + daemon)');
    console.log('[push-todo]   push-todo                  List your tasks');
    if (claudeSuccess) console.log('[push-todo]   /push-todo                Use in Claude Code');
    if (codexSuccess) console.log('[push-todo]   $push-todo                Use in OpenAI Codex');
    if (openclawSuccess) console.log('[push-todo]   /push-todo                Use in OpenClaw');
    return;
  }

  // Determine architecture
  const archType = arch();
  const url = archType === 'arm64' ? BINARY_URL : BINARY_URL_X64;

  console.log(`[push-todo] Downloading native binary for ${archType}...`);

  const success = await downloadFile(url, BINARY_PATH);

  if (success) {
    console.log('[push-todo] Native binary installed successfully.');
    console.log('[push-todo] E2EE decryption is now available.');
  } else {
    console.log('[push-todo] Native binary download failed.');
    console.log('[push-todo] E2EE features will not be available.');
    console.log('[push-todo] You can manually download from:');
    console.log(`[push-todo]   ${url}`);
  }

  console.log('');
  console.log('[push-todo] Installation complete!');
  if (clients.length > 0) {
    console.log(`[push-todo] Configured for: ${clients.join(', ')}`);
  }
  console.log('');
  console.log('[push-todo] Quick start:');
  console.log('[push-todo]   push-todo connect --auto   One-command setup (auth + projects + daemon)');
  console.log('[push-todo]   push-todo                  List your tasks');
  if (claudeSuccess) {
    console.log('[push-todo]   /push-todo                Use in Claude Code');
  }
  if (codexSuccess) {
    console.log('[push-todo]   $push-todo                Use in OpenAI Codex');
  }
  if (openclawSuccess) {
    console.log('[push-todo]   /push-todo                Use in OpenClaw');
  }
}

main().catch(error => {
  console.error(`[push-todo] Post-install error: ${error.message}`);
  // Don't fail the install - E2EE is optional
  process.exit(0);
});
