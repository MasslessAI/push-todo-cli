/**
 * Project Discovery Engine for Push CLI.
 *
 * Scans the user's home folder for projects used with Claude Code, Codex,
 * and OpenClaw. Returns deduplicated list of (gitRemote, agentType) pairs.
 *
 * Discovery sources:
 * - Claude Code: ~/.claude/projects/ (sessions-index.json or path decode)
 * - Codex: ~/.codex/sessions/ (JSONL first-line cwd extraction)
 * - OpenClaw: ~/.openclaw/agents/main/sessions/ (JSONL first-line cwd)
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getGitRemoteForPath, normalizeGitRemote } from './utils/git.js';

/**
 * @typedef {Object} DiscoveredProject
 * @property {string} projectPath - Absolute path to the project directory
 * @property {string} gitRemote - Normalized git remote URL
 * @property {string} agentType - 'claude-code' | 'openai-codex' | 'openclaw'
 * @property {string} source - Human-readable description of discovery source
 * @property {string|null} projectContext - First 50 lines of CLAUDE.md or README.md (for keyword generation)
 */

// ============================================================================
// CLAUDE CODE DISCOVERY
// ============================================================================

/**
 * Discover projects from Claude Code's ~/.claude/projects/ directory.
 *
 * Strategy:
 * 1. List all dirs, skip worktree dirs (contain '--claude-worktrees')
 * 2. For dirs WITH sessions-index.json: extract unique projectPaths
 * 3. For dirs WITHOUT: decode path naively (replace - with /)
 * 4. Verify each path exists and has a git remote
 *
 * @returns {DiscoveredProject[]}
 */
export function discoverClaudeCodeProjects() {
  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return [];

  const results = [];
  const seenPaths = new Set();

  let dirs;
  try {
    dirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }

  for (const dirName of dirs) {
    // Skip worktree dirs
    if (dirName.includes('--claude-worktrees')) continue;

    const dirPath = join(projectsDir, dirName);

    // Try sessions-index.json first (most reliable — contains real projectPath)
    const indexPath = join(dirPath, 'sessions-index.json');
    if (existsSync(indexPath)) {
      try {
        const data = JSON.parse(readFileSync(indexPath, 'utf8'));
        if (data.entries && Array.isArray(data.entries)) {
          for (const entry of data.entries) {
            if (entry.projectPath && !seenPaths.has(entry.projectPath)) {
              seenPaths.add(entry.projectPath);
              addIfValid(results, entry.projectPath, 'claude-code', 'Claude Code session');
            }
          }
        }
        continue; // sessions-index.json handled this dir
      } catch {
        // Fall through to naive decode
      }
    }

    // Fallback: naive path decode
    // -Users-yuxianggu-projects-AppleWhisper → /Users/yuxianggu/projects/AppleWhisper
    // This is lossy for paths containing hyphens, but we verify existence
    if (dirName.startsWith('-')) {
      const decoded = '/' + dirName.slice(1).replace(/-/g, '/');
      if (!seenPaths.has(decoded) && existsSync(decoded)) {
        seenPaths.add(decoded);
        addIfValid(results, decoded, 'claude-code', 'Claude Code project');
      }
    }
  }

  return results;
}

// ============================================================================
// CODEX DISCOVERY
// ============================================================================

/**
 * Discover projects from Codex's ~/.codex/sessions/ directory.
 *
 * Strategy:
 * 1. Recursively find *.jsonl files under ~/.codex/sessions/
 * 2. Read first line, parse JSON, extract payload.cwd
 * 3. Verify each path exists and has a git remote
 *
 * @returns {DiscoveredProject[]}
 */
export function discoverCodexProjects() {
  const sessionsDir = join(homedir(), '.codex', 'sessions');
  if (!existsSync(sessionsDir)) return [];

  const results = [];
  const seenPaths = new Set();

  const jsonlFiles = findJsonlFiles(sessionsDir);

  for (const filePath of jsonlFiles) {
    const cwd = extractCwdFromJsonl(filePath, 'codex');
    if (cwd && !seenPaths.has(cwd)) {
      seenPaths.add(cwd);
      addIfValid(results, cwd, 'openai-codex', 'Codex session');
    }
  }

  return results;
}

// ============================================================================
// OPENCLAW DISCOVERY
// ============================================================================

/**
 * Discover projects from OpenClaw's session files.
 *
 * Strategy:
 * 1. Read *.jsonl files from ~/.openclaw/agents/main/sessions/
 * 2. Extract cwd from first line
 * 3. Skip generic workspace (~/.openclaw/workspace) — not a real project
 * 4. Verify each path exists and has a git remote
 *
 * @returns {DiscoveredProject[]}
 */
export function discoverOpenClawProjects() {
  const sessionsDir = join(homedir(), '.openclaw', 'agents', 'main', 'sessions');
  if (!existsSync(sessionsDir)) return [];

  const results = [];
  const seenPaths = new Set();
  const workspacePath = join(homedir(), '.openclaw', 'workspace');

  let files;
  try {
    files = readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl') && !f.includes('.deleted.'));
  } catch {
    return [];
  }

  for (const fileName of files) {
    const filePath = join(sessionsDir, fileName);
    const cwd = extractCwdFromJsonl(filePath, 'openclaw');
    if (cwd && cwd !== workspacePath && !seenPaths.has(cwd)) {
      seenPaths.add(cwd);
      addIfValid(results, cwd, 'openclaw', 'OpenClaw session');
    }
  }

  return results;
}

// ============================================================================
// UNIFIED DISCOVERY
// ============================================================================

/**
 * Discover all projects from all supported agents.
 *
 * Runs each agent's scanner and deduplicates results by (gitRemote, agentType).
 *
 * @returns {{ projects: DiscoveredProject[], counts: { claudeCode: number, codex: number, openclaw: number } }}
 */
export function discoverAllProjects() {
  const claudeCode = discoverClaudeCodeProjects();
  const codex = discoverCodexProjects();
  const openclaw = discoverOpenClawProjects();

  const all = [...claudeCode, ...codex, ...openclaw];
  const deduplicated = deduplicateProjects(all);

  return {
    projects: deduplicated,
    counts: {
      claudeCode: claudeCode.length,
      codex: codex.length,
      openclaw: openclaw.length,
    }
  };
}

/**
 * Deduplicate discovered projects by (gitRemote, agentType) pair.
 *
 * @param {DiscoveredProject[]} projects
 * @returns {DiscoveredProject[]}
 */
export function deduplicateProjects(projects) {
  const seen = new Map();

  for (const project of projects) {
    const key = `${project.gitRemote}::${project.agentType}`;
    if (!seen.has(key)) {
      seen.set(key, project);
    }
  }

  return Array.from(seen.values());
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Check if a path is a valid project with a git remote, and add to results if so.
 *
 * @param {DiscoveredProject[]} results - Array to push to
 * @param {string} projectPath - Absolute path to check
 * @param {string} agentType - Agent type identifier
 * @param {string} source - Human-readable source description
 */
function addIfValid(results, projectPath, agentType, source) {
  if (!existsSync(projectPath)) return;

  // Check it's a directory
  try {
    if (!statSync(projectPath).isDirectory()) return;
  } catch {
    return;
  }

  const gitRemote = getGitRemoteForPath(projectPath);
  if (!gitRemote) return;

  const projectContext = readProjectContext(projectPath);
  results.push({ projectPath, gitRemote, agentType, source, projectContext });
}

/**
 * Read project context for keyword generation.
 *
 * Tries CLAUDE.md first (richer, written for AI), then README.md.
 * Returns first 50 lines or null if neither exists.
 *
 * @param {string} projectPath - Absolute path to the project
 * @returns {string|null} First 50 lines of project documentation
 */
function readProjectContext(projectPath) {
  for (const filename of ['CLAUDE.md', 'README.md']) {
    const filePath = join(projectPath, filename);
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n').slice(0, 50);
      const text = lines.join('\n').trim();
      if (text.length > 0) return text;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Extract cwd from the first line of a JSONL session file.
 *
 * Handles two formats:
 * - Codex: {"type":"session_meta","payload":{"cwd":"/path",...}}
 * - OpenClaw: {"type":"session","cwd":"/path",...}
 *
 * @param {string} filePath - Absolute path to the JSONL file
 * @param {'codex'|'openclaw'} format - Which format to expect
 * @returns {string|null} The cwd value or null
 */
function extractCwdFromJsonl(filePath, format) {
  try {
    const content = readFileSync(filePath, 'utf8');
    const firstLine = content.split('\n')[0];
    if (!firstLine) return null;

    const data = JSON.parse(firstLine);

    if (format === 'codex') {
      return data?.payload?.cwd || null;
    }
    // openclaw
    return data?.cwd || null;
  } catch {
    return null;
  }
}

/**
 * Recursively find all .jsonl files in a directory.
 *
 * @param {string} dir - Directory to search
 * @param {number} maxDepth - Maximum recursion depth
 * @returns {string[]}
 */
function findJsonlFiles(dir, maxDepth = 5) {
  if (maxDepth <= 0) return [];

  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(fullPath, maxDepth - 1));
    } else if (entry.name.endsWith('.jsonl') && !entry.name.includes('.deleted.')) {
      results.push(fullPath);
    }
  }

  return results;
}
