/**
 * Context Engine + Prompt Engine for Push daemon.
 *
 * Scans project skills, collects git/GitHub state, builds context-rich prompts.
 * All functions are non-fatal — errors result in empty/partial context.
 *
 * Architecture: docs/20260214_push_daemon_evolution_complete_architecture.md §23
 * Pattern: Follow self-update.js — pure functions, execFileSync, no npm deps.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// ==================== Cache ====================

const contextCache = new Map(); // projectPath -> { data, timestamp }
const CACHE_TTL = 3600000; // 1 hour

/**
 * Invalidate cache for a specific project path.
 * Called before task execution to ensure fresh context.
 */
export function invalidateCache(projectPath) {
  contextCache.delete(projectPath);
}

// ==================== YAML Frontmatter Parser ====================

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Minimal parser: extracts key: value pairs between --- markers.
 * No npm yaml dependency — skills use simple single-line key: value format.
 *
 * @param {string} content - Full file content
 * @returns {{ frontmatter: Object, body: string }}
 */
export function parseFrontmatter(content) {
  const lines = content.split('\n');

  // Must start with ---
  if (lines[0].trim() !== '---') {
    return { frontmatter: {}, body: content };
  }

  // Find closing ---
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    return { frontmatter: {}, body: content };
  }

  // Parse key: value pairs
  const frontmatter = {};
  for (let i = 1; i < closingIndex; i++) {
    const line = lines[i];
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) {
      frontmatter[key] = value;
    }
  }

  const body = lines.slice(closingIndex + 1).join('\n');
  return { frontmatter, body };
}

// ==================== Skill Scanning ====================

/**
 * Scan .claude/skills/x/SKILL.md files in a project directory.
 *
 * @param {string} projectPath - Absolute path to project root
 * @returns {Array<{ name: string, description: string, requiresConfirmation: boolean }>}
 */
export function scanProjectSkills(projectPath) {
  const skillsDir = join(projectPath, '.claude', 'skills');

  if (!existsSync(skillsDir)) {
    return [];
  }

  try {
    const entries = readdirSync(skillsDir);
    const skills = [];

    for (const entry of entries) {
      const entryPath = join(skillsDir, entry);

      // Skip non-directories
      try {
        if (!statSync(entryPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const skillFile = join(entryPath, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      try {
        const content = readFileSync(skillFile, 'utf8');
        const { frontmatter, body } = parseFrontmatter(content);

        // Parse tools field: comma-separated list of tool names/patterns
        const tools = frontmatter.tools
          ? frontmatter.tools.split(',').map(t => t.trim()).filter(Boolean)
          : [];

        skills.push({
          name: frontmatter.name || entry,
          description: frontmatter.description || '',
          requiresConfirmation: body.includes('push-todo confirm'),
          tools,
        });
      } catch {
        // Skip unreadable skill files
      }
    }

    return skills;
  } catch {
    return [];
  }
}

// ==================== Project State ====================

/**
 * Collect git + GitHub state for a project.
 * All calls are non-fatal — returns partial data on failure.
 *
 * @param {string} projectPath - Absolute path to project root
 * @returns {{ recentCommits: string[], openPRs: Array|null, currentBranch: string|null }}
 */
export function collectProjectState(projectPath) {
  const result = {
    recentCommits: [],
    openPRs: null,
    currentBranch: null,
  };

  // Current branch
  try {
    result.currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectPath,
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch { /* non-fatal */ }

  // Recent commits
  try {
    const output = execFileSync('git', ['log', '--oneline', '-5'], {
      cwd: projectPath,
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    if (output) {
      result.recentCommits = output.split('\n');
    }
  } catch { /* non-fatal */ }

  // Open PRs (only if gh CLI is available)
  try {
    execFileSync('which', ['gh'], {
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const prOutput = execFileSync('gh', ['pr', 'list', '--json', 'number,title,updatedAt', '--limit', '5'], {
      cwd: projectPath,
      timeout: 10000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    if (prOutput) {
      result.openPRs = JSON.parse(prOutput);
    }
  } catch { /* non-fatal — gh not installed or not authenticated */ }

  return result;
}

// ==================== Cached Context ====================

/**
 * Get project context (skills + state), with hourly cache.
 * Call invalidateCache(projectPath) before task execution for fresh data.
 *
 * @param {string} projectPath - Absolute path to project root
 * @returns {{ skills: Array, state: Object }}
 */
export function getProjectContext(projectPath) {
  const cached = contextCache.get(projectPath);

  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.data;
  }

  const skills = scanProjectSkills(projectPath);
  const state = collectProjectState(projectPath);
  const data = { skills, state };

  contextCache.set(projectPath, { data, timestamp: Date.now() });

  return data;
}

// ==================== Prompt Engine ====================

/**
 * Build a context-rich prompt for Claude Code sessions.
 * Each section is only included when data exists.
 *
 * @param {Object} task
 * @param {number} task.displayNumber
 * @param {string} task.content - Normalized content or summary
 * @param {string} task.attachmentContext - Pre-built attachment string (links, screenshots)
 * @param {string|null} task.actionName - Action display name from registry
 * @param {string|null} task.contextApp - Source app (X, Safari, etc.)
 * @param {Object} context - From getProjectContext()
 * @param {Array} context.skills
 * @param {Object} context.state
 * @returns {string} Complete prompt
 */
export function buildSmartPrompt(task, context) {
  const sections = [];

  // 1. Task section (always present)
  // For follow-ups, frame as iteration on previous work
  if (task.followUpRequest) {
    sections.push(`## Task (Follow-Up Iteration #${task.followUpIteration || 2})\nContinue working on Push task #${task.displayNumber}.\n\nOriginal task:\n${task.content}\n\n**Follow-up request:**\n${task.followUpRequest}`);
    // Include previous execution summary as context
    if (task.previousSummary) {
      sections.push(`## Previous Iteration Summary\nHere's what was accomplished in the previous iteration:\n\n${task.previousSummary}`);
    }
  } else {
    sections.push(`## Task\nWork on Push task #${task.displayNumber}:\n\n${task.content}`);
  }

  // 2. Metadata section (conditional)
  const metaParts = [];
  if (task.actionName) metaParts.push(`Action: ${task.actionName}`);
  if (task.contextApp) metaParts.push(`Context app: ${task.contextApp}`);
  if (metaParts.length > 0) {
    sections.push(`## Metadata\n${metaParts.join('\n')}`);
  }

  // 3. Attachment section (conditional — pre-built by caller)
  if (task.attachmentContext) {
    sections.push(`## Attachments${task.attachmentContext}`);
  }

  // 4. Skill section (conditional)
  if (context.skills && context.skills.length > 0) {
    const skillLines = context.skills.map(s => {
      const flag = s.requiresConfirmation ? ' [requires push-todo confirm]' : '';
      return `- /${s.name}: ${s.description || 'No description'}${flag}`;
    });

    const confirmSkills = context.skills.filter(s => s.requiresConfirmation);
    let confirmNote = '';
    if (confirmSkills.length > 0) {
      confirmNote = '\n\nSkills marked [requires push-todo confirm] include a user approval step before performing irreversible actions. If your task matches one of these skills, you MUST invoke it to ensure the proper confirmation workflow.';
    }

    sections.push(`## Available Skills\nThe following skills are available in this project:\n${skillLines.join('\n')}${confirmNote}`);
  }

  // 5. Project state section (conditional)
  const stateParts = [];
  if (context.state?.currentBranch) {
    stateParts.push(`Current branch: ${context.state.currentBranch}`);
  }
  if (context.state?.recentCommits?.length > 0) {
    stateParts.push(`Recent commits:\n${context.state.recentCommits.map(c => `  ${c}`).join('\n')}`);
  }
  if (context.state?.openPRs?.length > 0) {
    stateParts.push(`Open PRs:\n${context.state.openPRs.map(pr => `  #${pr.number} ${pr.title}`).join('\n')}`);
  }
  if (stateParts.length > 0) {
    sections.push(`## Project State\n${stateParts.join('\n')}`);
  }

  // 6. Instructions section (always present)
  sections.push(`## Instructions
1. If you need to understand the codebase, start by reading the CLAUDE.md file if it exists.
2. ALWAYS commit your changes before finishing. Use a descriptive commit message summarizing what you did. This is critical — uncommitted changes will be lost when the worktree is cleaned up.
3. When you're done, the SessionEnd hook will automatically report completion to Supabase.`);

  return sections.join('\n\n');
}
