/**
 * CLI argument parsing and command routing for Push CLI.
 *
 * Handles all command-line options and dispatches to appropriate handlers.
 */

import { parseArgs } from 'util';
import { spawn } from 'child_process';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as fetch from './fetch.js';
import * as api from './api.js';
import { runConnect } from './connect.js';
import { startWatch } from './watch.js';
import { showSettings, toggleSetting, setMaxBatchSize } from './config.js';
import { ensureDaemonRunning, getDaemonStatus, startDaemon, stopDaemon } from './daemon-health.js';
import { install as installLaunchAgent, uninstall as uninstallLaunchAgent, getStatus as getLaunchAgentStatus } from './launchagent.js';
import { getScreenshotPath, screenshotExists, openScreenshot } from './utils/screenshots.js';
import { bold, red, cyan, dim, green, yellow } from './utils/colors.js';
import { getMachineId } from './machine-id.js';
import { parseReminder } from './reminder-parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Read version from package.json (DRY - single source of truth)
 */
function getVersion() {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version || '3.0.0';
  } catch {
    return '3.0.0';
  }
}

const VERSION = getVersion();

const HELP_TEXT = `
${bold('push-todo')} - Voice tasks from Push iOS app for Claude Code

${bold('USAGE:')}
  push-todo [options]              List active tasks
  push-todo <number>               Show specific task
  push-todo create <title>         Create a new todo
    --remind <text>                Set reminder ("tomorrow night", "in 2 hours")
    --remind-at <iso>              Set reminder at exact ISO8601 time
    --alarm                        Mark as urgent (bypasses Focus)
  push-todo connect                Run connection doctor
  push-todo search <query>         Search tasks
  push-todo review                 Review completed tasks
  push-todo update                 Update CLI, check agents, refresh projects
  push-todo schedule               Manage remote schedules (add/list/remove)

${bold('OPTIONS:')}
  --all-projects, -a               List tasks from all projects
  --backlog, -b                    Only show backlog items
  --include-backlog                Include backlog items in listing
  --completed, -c                  Only show completed items
  --include-completed              Include completed items in listing
  --queue <numbers>                Queue tasks for daemon (comma-separated)
  --queue-batch                    Auto-queue a batch of tasks
  --mark-completed <uuid>          Mark a task as completed
  --completion-comment <text>      Comment for completion
  --search <query>                 Search tasks
  --status                         Show connection and daemon status
  --watch, -w                      Live terminal UI
  --follow, -f                     With --watch: exit when all tasks complete
  --setting [name]                 Show or toggle settings
  --resume <number>                Resume Claude session for a completed task
  --view-screenshot <idx>          Open screenshot for viewing (index or filename)
  --learn-vocabulary <uuid>        Contribute vocabulary for a task
  --keywords <terms>               Comma-separated vocabulary terms (with --learn-vocabulary)
  --report-progress <uuid>         Report progress for a running task
  --phase <name>                   Phase name (with --report-progress)
  --detail <text>                  Detail text (with --report-progress)
  --update-status <uuid>           Update execution phase for a running task
  --check-messages <uuid>          Check for messages from the human
  --request-input <uuid>           Request input from the human (blocking)
  --question <text>                Question to ask (with --request-input)
  --set-batch-size <N>             Set max tasks for batch queue (1-20)
  --daemon-status                  Show daemon status
  --daemon-start                   Start daemon manually
  --daemon-stop                    Stop daemon
  --daemon-install                 Install LaunchAgent (auto-start on login)
  --daemon-uninstall               Remove LaunchAgent
  --commands                       Show available user commands
  --json                           Output as JSON
  --version, -v                    Show version
  --help, -h                       Show this help

${bold('EXAMPLES:')}
  push-todo                        List active tasks for current project
  push-todo 427                    Show task #427
  push-todo create "Fix auth bug"  Create a new todo
  push-todo create "Debug" --remind "tomorrow night"
  push-todo create "Call" --remind "at 3pm" --alarm
  push-todo create "Item" --backlog Create as backlog item
  push-todo -a                     List all tasks across projects
  push-todo --queue 1,2,3          Queue tasks 1, 2, 3 for daemon
  push-todo search "auth bug"      Search for tasks matching "auth bug"
  push-todo connect                Run connection diagnostics

${bold('CONNECT OPTIONS:')}
  --reauth                         Force re-authentication
  --client <type>                  Client type (claude-code, openai-codex, openclaw)
  --check-version                  Check for updates (JSON output)
  --update                         Update to latest version
  --validate-key                   Validate API key (JSON output)
  --validate-project               Validate project registration (JSON output)
  --store-e2ee-key <key>           Import E2EE encryption key
  --description <text>             Project description (with connect)
  --auto                           Auto-discover and register all projects

${bold('CONFIRM (for daemon skills):')}
  push-todo confirm --type "social_post" --title "Post tweet" --content "..."
  --type <type>                    Confirmation category (social_post, email, etc.)
  --title <text>                   Short description of the action
  --content <text>                 Content to be confirmed
  --metadata <json>                Optional JSON metadata for rich rendering
  --task <number>                  Display number (auto-detected in daemon)

${bold('SCHEDULE (remote scheduled jobs):')}
  push-todo schedule add             Create a schedule
    --name <name>                    Schedule name (required)
    --every <interval>               Repeat interval: 30m, 1h, 24h, 7d
    --at <iso-date>                  One-shot at specific time
    --cron <expression>              5-field cron expression
    --create-todo <title>            Create a new todo each fire
    --queue-todo <todoId>            Re-queue an existing todo each fire
    --git-remote <remote>            Route created todos to a project
    --agent-type <type>              Agent: claude-code, openclaw, openai-codex
    --content <body>                 Expanded content for created todos
  push-todo schedule list            List all schedules
  push-todo schedule remove <id>     Remove a schedule
  push-todo schedule enable <id>     Enable a schedule
  push-todo schedule disable <id>    Disable a schedule

${bold('JOURNAL (daily automated journal):')}
  push-todo journal setup            Install daily journal cron (default: 9pm)
    --time <HH:MM>                   Time to run daily (e.g., "21:00", "09:30")
  push-todo journal status           Show journal cron status
  push-todo journal remove           Uninstall journal cron

${bold('SETTINGS:')}
  push-todo setting                Show all settings
  push-todo setting auto-commit    Toggle auto-commit

${dim('Documentation:')} https://pushto.do/docs/cli
`;

const options = {
  'all-projects': { type: 'boolean', short: 'a' },
  'backlog': { type: 'boolean', short: 'b' },
  'include-backlog': { type: 'boolean' },
  'completed': { type: 'boolean', short: 'c' },
  'include-completed': { type: 'boolean' },
  'queue': { type: 'string' },
  'queue-batch': { type: 'boolean' },
  'mark-completed': { type: 'string' },
  'completion-comment': { type: 'string' },
  'search': { type: 'string' },
  'status': { type: 'boolean' },
  'watch': { type: 'boolean', short: 'w' },
  'follow': { type: 'boolean', short: 'f' },
  'setting': { type: 'string' },
  'resume': { type: 'string' },
  'view-screenshot': { type: 'string' },
  'learn-vocabulary': { type: 'string' },
  'keywords': { type: 'string' },
  'set-batch-size': { type: 'string' },
  'daemon-status': { type: 'boolean' },
  'daemon-start': { type: 'boolean' },
  'daemon-stop': { type: 'boolean' },
  'daemon-install': { type: 'boolean' },
  'daemon-uninstall': { type: 'boolean' },
  'commands': { type: 'boolean' },
  'json': { type: 'boolean' },
  'version': { type: 'boolean', short: 'v' },
  'help': { type: 'boolean', short: 'h' },
  // Connect options
  'reauth': { type: 'boolean' },
  'client': { type: 'string' },
  'check-version': { type: 'boolean' },
  'update': { type: 'boolean' },
  'validate-key': { type: 'boolean' },
  'validate-project': { type: 'boolean' },
  'store-e2ee-key': { type: 'string' },
  'description': { type: 'string' },
  'auto': { type: 'boolean' },
  // Create command options
  'remind': { type: 'string' },
  'remind-at': { type: 'string' },
  'alarm': { type: 'boolean' },
  // Confirm command options
  'type': { type: 'string' },
  'title': { type: 'string' },
  'content': { type: 'string' },
  'metadata': { type: 'string' },
  'task': { type: 'string' },
  // Schedule command options
  'name': { type: 'string' },
  'every': { type: 'string' },
  'at': { type: 'string' },
  'cron': { type: 'string' },
  'create-todo': { type: 'string' },
  'git-remote': { type: 'string' },
  'agent-type': { type: 'string' },
  'queue-todo': { type: 'string' },
  // Skill CLI options (Phase 3)
  'report-progress': { type: 'string' },
  'phase': { type: 'string' },
  'detail': { type: 'string' },
  'update-status': { type: 'string' },
  'check-messages': { type: 'string' },
  'request-input': { type: 'string' },
  'question': { type: 'string' },
  // Journal cron options
  'time': { type: 'string' },
};

/**
 * Parse command line arguments.
 *
 * @param {string[]} argv - Command line arguments
 * @returns {Object} Parsed arguments with values and positionals
 */
function parseArguments(argv) {
  try {
    return parseArgs({
      args: argv,
      options,
      allowPositionals: true
    });
  } catch (error) {
    console.error(red(`Error: ${error.message}`));
    console.log(`Run ${cyan('push-todo --help')} for usage.`);
    process.exit(1);
  }
}

/**
 * Main CLI entry point.
 *
 * @param {string[]} argv - Command line arguments (without node and script path)
 */
export async function run(argv) {
  const { values, positionals } = parseArguments(argv);

  // Help
  if (values.help) {
    console.log(HELP_TEXT);
    return;
  }

  // Version
  if (values.version) {
    console.log(`push-todo ${VERSION}`);
    return;
  }

  // Daemon management commands (don't auto-start daemon for these)
  if (values['daemon-status']) {
    const status = getDaemonStatus();
    if (status.running) {
      console.log(`${bold('Daemon:')} Running (PID: ${status.pid})`);
      if (status.uptime) console.log(`${dim('Uptime:')} ${status.uptime}`);
      if (status.version) console.log(`${dim('Version:')} ${status.version}`);
      if (status.runningTasks?.length > 0) {
        console.log(`\n${bold('Running Tasks:')}`);
        for (const t of status.runningTasks) {
          console.log(`  #${t.displayNumber} - ${t.summary}`);
        }
      }
      if (status.completedToday?.length > 0) {
        console.log(`\n${bold('Completed Today:')} ${status.completedToday.length} tasks`);
      }
    } else {
      console.log(`${bold('Daemon:')} Not running`);
    }
    // Show LaunchAgent status
    const laStatus = getLaunchAgentStatus();
    if (laStatus.installed) {
      console.log(`${bold('LaunchAgent:')} Installed${laStatus.loaded ? ' (loaded)' : ' (not loaded)'}`);
    } else {
      console.log(`${bold('LaunchAgent:')} Not installed`);
      console.log(dim('  Run: push-todo --daemon-install'));
    }
    return;
  }

  if (values['daemon-start']) {
    const status = getDaemonStatus();
    if (status.running) {
      console.log(`Daemon already running (PID: ${status.pid})`);
    } else {
      const success = startDaemon();
      if (success) {
        console.log('Daemon started');
      } else {
        console.error(red('Failed to start daemon'));
        process.exit(1);
      }
    }
    return;
  }

  if (values['daemon-stop']) {
    const status = getDaemonStatus();
    if (!status.running) {
      console.log('Daemon is not running');
    } else {
      const success = stopDaemon();
      if (success) {
        console.log('Daemon stopped');
        const laStatus = getLaunchAgentStatus();
        if (laStatus.installed && laStatus.loaded) {
          console.log(dim('Note: LaunchAgent will restart the daemon automatically.'));
          console.log(dim('To fully stop: push-todo --daemon-uninstall'));
        }
      } else {
        console.error(red('Failed to stop daemon'));
        process.exit(1);
      }
    }
    return;
  }

  if (values['daemon-install']) {
    const result = installLaunchAgent();
    if (result.success) {
      if (result.alreadyInstalled) {
        console.log('LaunchAgent already installed');
      } else {
        console.log('LaunchAgent installed — daemon will start automatically on login');
      }
      const laStatus = getLaunchAgentStatus();
      console.log(dim(`Plist: ${laStatus.plistPath}`));
    } else {
      console.error(red(result.message));
      process.exit(1);
    }
    return;
  }

  if (values['daemon-uninstall']) {
    const result = uninstallLaunchAgent();
    if (result.success) {
      console.log(result.message);
      console.log(dim('Daemon will still self-heal via push-todo commands.'));
    } else {
      console.error(red(result.message));
      process.exit(1);
    }
    return;
  }

  // Handle --commands (simple user help)
  if (values.commands) {
    console.log(`
  ${bold('Push Voice Tasks - Commands')}
  ${'='.repeat(40)}

  /push-todo              Show your active tasks
  /push-todo 427          Work on task #427
  /push-todo search X     Search tasks for 'X'
  /push-todo connect      Setup or fix problems
  /push-todo review       Check completed work
  /push-todo status       Show connection status
  /push-todo watch        Live monitor daemon tasks
  /push-todo setting      View/toggle settings

  ${dim('Options:')}
  --all-projects          See tasks from all projects
  --backlog               See deferred tasks only
  --search "query"        Search active & completed tasks
`);
    return;
  }

  // Handle --set-batch-size
  if (values['set-batch-size']) {
    const size = parseInt(values['set-batch-size'], 10);
    if (isNaN(size) || size < 1 || size > 20) {
      console.error(red('Batch size must be between 1 and 20'));
      process.exit(1);
    }
    if (setMaxBatchSize(size)) {
      console.log(`Max batch size set to ${size}`);
    } else {
      console.error(red('Failed to set batch size'));
      process.exit(1);
    }
    return;
  }

  // Handle --resume (resume Claude session for a completed task)
  if (values.resume) {
    const taskNum = values.resume.replace(/^#/, '');
    const displayNumber = parseInt(taskNum, 10);
    if (isNaN(displayNumber)) {
      console.error(red(`Invalid task number: ${values.resume}`));
      process.exit(1);
    }

    // Fetch task to get session_id
    const task = await fetch.getTaskByNumber(displayNumber);
    if (!task) {
      console.error(red(`Task #${displayNumber} not found`));
      process.exit(1);
    }

    const sessionId = task.execution_session_id || task.executionSessionId;
    if (!sessionId) {
      const executionStatus = task.execution_status || task.executionStatus;
      if (executionStatus) {
        console.log(`Task #${displayNumber} has execution status '${executionStatus}' but no session ID.`);
        console.log('Session ID is captured when daemon completes a task.');
        console.log();
        console.log('Possible reasons:');
        console.log('  - Task was completed before session capture was added');
        console.log('  - Task was completed manually (not by daemon)');
        console.log("  - Daemon couldn't extract session ID from Claude's output");
      } else {
        console.log(`Task #${displayNumber} was not executed by the daemon.`);
        console.log('Session resume is only available for tasks completed by the Push daemon.');
      }
      process.exit(1);
    }

    // Find the worktree directory where the daemon ran this task.
    // Sessions are directory-scoped in Claude Code, so we must launch
    // from the same directory (worktree) where the session was created.
    let resumeCwd = process.cwd();
    try {
      const machineId = getMachineId();
      const parts = machineId.split('-');
      const suffix = parts.length > 1 ? parts[parts.length - 1].slice(0, 8) : machineId.slice(0, 8);
      const worktreeName = `push-${displayNumber}-${suffix}`;

      // Check new location first (inside project at .claude/worktrees/)
      const newCandidate = join(process.cwd(), '.claude', 'worktrees', worktreeName);
      // Check legacy location (sibling directory, pre-migration daemon)
      const legacyCandidate = join(dirname(process.cwd()), worktreeName);

      if (existsSync(newCandidate)) {
        resumeCwd = newCandidate;
        console.log(`Found daemon worktree: ${newCandidate}`);
      } else if (existsSync(legacyCandidate)) {
        resumeCwd = legacyCandidate;
        console.log(`Found daemon worktree (legacy): ${legacyCandidate}`);
      } else {
        // Worktree was cleaned up after daemon finished, but the session file
        // still exists at ~/.claude/projects/. Re-create the directory so Claude
        // maps CWD to the correct session directory and finds the session.
        try {
          mkdirSync(newCandidate, { recursive: true });
          resumeCwd = newCandidate;
          console.log(`Re-created worktree directory for session lookup: ${newCandidate}`);
        } catch {
          // Fall back to legacy location
          try {
            mkdirSync(legacyCandidate, { recursive: true });
            resumeCwd = legacyCandidate;
            console.log(`Re-created worktree directory for session lookup: ${legacyCandidate}`);
          } catch {
            console.log(dim(`Could not create worktree dir, using current directory`));
          }
        }
      }
    } catch {
      // Fall back to current directory
    }

    // Launch claude --resume with the session ID
    console.log(`Resuming session for task #${displayNumber}...`);
    console.log(`Session ID: ${sessionId}`);
    console.log();

    // Use spawn with stdio: 'inherit' to give control to Claude
    const child = spawn('claude', ['--resume', sessionId], {
      cwd: resumeCwd,
      stdio: 'inherit',
      shell: true
    });

    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        console.error(red("Error: 'claude' command not found. Is Claude Code installed?"));
      } else {
        console.error(red(`Error launching Claude: ${error.message}`));
      }
      process.exit(1);
    });

    child.on('close', (code) => {
      process.exit(code || 0);
    });

    return;
  }

  // Handle --view-screenshot (open screenshot for viewing)
  if (values['view-screenshot']) {
    // Get the first positional as task number (if provided)
    const taskNum = positionals[0]?.replace(/^#/, '');

    if (taskNum && /^\d+$/.test(taskNum)) {
      // Task number provided - get task's screenshots
      const displayNumber = parseInt(taskNum, 10);
      const task = await fetch.getTaskByNumber(displayNumber);

      if (!task) {
        console.error(red(`Task #${displayNumber} not found`));
        process.exit(1);
      }

      const raw = task.screenshotAttachmentsJson || task.screenshotAttachments || task.screenshot_attachments;
      const screenshots = !raw ? [] : Array.isArray(raw) ? raw : (() => { try { return JSON.parse(raw); } catch { return []; } })();
      if (screenshots.length === 0) {
        console.error(red(`Task #${displayNumber} has no screenshot attachments`));
        process.exit(1);
      }

      // Try to parse as index
      let filename;
      const idx = parseInt(values['view-screenshot'], 10);
      if (!isNaN(idx)) {
        if (idx < 0 || idx >= screenshots.length) {
          console.error(red(`Screenshot index ${idx} out of range (0-${screenshots.length - 1})`));
          process.exit(1);
        }
        filename = screenshots[idx].imageFilename || screenshots[idx].image_filename;
      } else {
        // Not an index, treat as filename
        filename = values['view-screenshot'];
      }

      const filepath = getScreenshotPath(filename);
      try {
        await openScreenshot(filepath);
      } catch (error) {
        console.error(red(error.message));
        process.exit(1);
      }
    } else {
      // No task number, treat arg as filename
      const filepath = getScreenshotPath(values['view-screenshot']);
      try {
        await openScreenshot(filepath);
      } catch (error) {
        console.error(red(error.message));
        process.exit(1);
      }
    }
    return;
  }

  // Handle --learn-vocabulary (contribute vocabulary terms)
  if (values['learn-vocabulary']) {
    if (!values.keywords) {
      console.error(red('--keywords required with --learn-vocabulary'));
      console.error("Example: --learn-vocabulary TASK_ID --keywords 'realtime,sync,websocket'");
      process.exit(1);
    }

    // Parse comma-separated keywords
    const keywords = values.keywords.split(',').map(k => k.trim()).filter(Boolean);
    if (keywords.length === 0) {
      console.error(red('No valid keywords provided'));
      process.exit(1);
    }

    try {
      const result = await api.learnVocabulary(values['learn-vocabulary'], keywords);

      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const added = result.keywords_added || [];
        const dupes = result.keywords_duplicate || [];
        const total = result.total_keywords || 0;

        if (added.length > 0) {
          console.log(green(`Added ${added.length} new terms: ${added.join(', ')}`));
        }
        if (dupes.length > 0) {
          console.log(dim(`Already known: ${dupes.join(', ')}`));
        }
        console.log(`Total vocabulary: ${total} terms`);
      }
    } catch (error) {
      console.error(red(`Failed to learn vocabulary: ${error.message}`));
      process.exit(1);
    }
    return;
  }

  // Handle --report-progress (report structured progress for a running task)
  if (values['report-progress']) {
    try {
      const result = await api.reportProgress(values['report-progress'], {
        phase: values.phase || 'progress',
        detail: values.detail || undefined,
      });
      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(green('Progress reported.'));
      }
    } catch (error) {
      console.error(red(`Failed to report progress: ${error.message}`));
      process.exit(1);
    }
    return;
  }

  // Handle --update-status (update execution phase for a running task)
  if (values['update-status']) {
    const status = positionals[0] || values.phase;
    if (!status) {
      console.error(red('Status required. Usage: --update-status <uuid> <status>'));
      process.exit(1);
    }
    try {
      const result = await api.updateStatus(values['update-status'], status);
      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(green(`Status updated to: ${status}`));
      }
    } catch (error) {
      console.error(red(`Failed to update status: ${error.message}`));
      process.exit(1);
    }
    return;
  }

  // Handle --check-messages (check for messages from the human)
  if (values['check-messages']) {
    try {
      const messages = await api.checkMessages(values['check-messages']);
      if (values.json) {
        console.log(JSON.stringify(messages, null, 2));
      } else if (messages.length === 0) {
        console.log(dim('No pending messages.'));
      } else {
        for (const msg of messages) {
          console.log(`[${msg.created_at || 'unknown'}] ${msg.message}`);
        }
      }
    } catch (error) {
      console.error(red(`Failed to check messages: ${error.message}`));
      process.exit(1);
    }
    return;
  }

  // Handle --request-input (ask the human a question, poll for response)
  if (values['request-input']) {
    const question = values.question || positionals.slice(0).join(' ');
    if (!question) {
      console.error(red('--question required with --request-input'));
      console.error('Usage: --request-input <uuid> --question "What should I do?"');
      process.exit(1);
    }
    try {
      console.log(dim('Waiting for human response (timeout: 5 min)...'));
      const reply = await api.requestInput(values['request-input'], question);
      if (values.json) {
        console.log(JSON.stringify({ reply }, null, 2));
      } else if (reply) {
        console.log(green('Response:'), reply);
      } else {
        console.log(dim('No response received (timeout).'));
      }
    } catch (error) {
      console.error(red(`Failed to request input: ${error.message}`));
      process.exit(1);
    }
    return;
  }

  // Auto-start daemon on every command (self-healing behavior)
  ensureDaemonRunning();

  // Get the command (first positional)
  const command = positionals[0];

  // Confirm command - request user confirmation for irreversible actions
  if (command === 'confirm') {
    const { requestConfirmation } = await import('./confirm.js');
    return requestConfirmation(values, positionals);
  }

  // Create command - create a new todo
  if (command === 'create') {
    const title = positionals.slice(1).join(' ');
    if (!title) {
      console.error(red('Error: Title is required.'));
      console.error('');
      console.error('Usage:');
      console.error('  push-todo create "Fix the auth bug"');
      console.error('  push-todo create "Debug daemon" --remind "tomorrow night"');
      console.error('  push-todo create "Call dentist" --remind "at 3pm" --alarm');
      console.error('  push-todo create "Deploy" --remind-at "2026-03-03T14:00:00"');
      process.exit(1);
    }

    // Conflict check
    if (values.remind && values['remind-at']) {
      console.error(red('Error: Use --remind OR --remind-at, not both.'));
      process.exit(1);
    }

    // Parse reminder
    let reminderDate = null;
    let reminderTimeSource = null;
    const alarmEnabled = values.alarm || false;

    if (values['remind-at']) {
      const parsed = new Date(values['remind-at']);
      if (isNaN(parsed.getTime())) {
        console.error(red('Error: --remind-at must be a valid ISO8601 date.'));
        console.error(dim('  Example: 2026-03-03T14:00:00'));
        process.exit(1);
      }
      if (parsed <= new Date()) {
        console.error(red('Error: --remind-at must be in the future.'));
        process.exit(1);
      }
      reminderDate = parsed.toISOString();
      reminderTimeSource = 'userSpecified';
    } else if (values.remind) {
      const result = parseReminder(values.remind);
      if (!result.date) {
        console.error(red(`Error: Could not parse reminder: "${values.remind}"`));
        console.error('');
        console.error('Examples:');
        console.error('  --remind "tomorrow"');
        console.error('  --remind "tonight"');
        console.error('  --remind "in 2 hours"');
        console.error('  --remind "next monday at 3pm"');
        process.exit(1);
      }
      reminderDate = result.date.toISOString();
      reminderTimeSource = result.timeSource;
    }

    try {
      const todo = await api.createTodo({
        title,
        content: values.content || null,
        backlog: values.backlog || false,
        reminderDate,
        reminderTimeSource,
        alarmEnabled,
      });

      if (values.json) {
        console.log(JSON.stringify(todo, null, 2));
      } else {
        let msg = green(`Created todo #${todo.displayNumber}: ${todo.title}`);
        if (reminderDate) {
          const d = new Date(reminderDate);
          msg += `\n  ${dim('Reminder:')} ${d.toLocaleString()}`;
        }
        if (alarmEnabled) {
          msg += `  ${dim('(urgent)')}`;
        }
        console.log(msg);
      }
    } catch (error) {
      console.error(red(`Failed to create todo: ${error.message}`));
      process.exit(1);
    }
    return;
  }

  // Schedule command - Supabase-backed unified scheduling
  if (command === 'schedule') {
    const { computeNextRun } = await import('./cron.js');
    const subCommand = positionals[1];

    if (subCommand === 'add') {
      if (!values.name) {
        console.error(red('--name is required for schedule add'));
        process.exit(1);
      }

      // Determine schedule timing
      let scheduleType, scheduleValue;
      if (values.every) {
        scheduleType = 'every';
        scheduleValue = values.every;
      } else if (values.at) {
        scheduleType = 'at';
        scheduleValue = values.at;
      } else if (values.cron) {
        scheduleType = 'cron';
        scheduleValue = values.cron;
      } else {
        console.error(red('Schedule required: --every, --at, or --cron'));
        process.exit(1);
      }

      // Validate schedule and compute next run
      let nextRunAt;
      try {
        nextRunAt = computeNextRun({ type: scheduleType, value: scheduleValue });
        if (!nextRunAt) {
          console.error(red('Schedule has no future run time'));
          process.exit(1);
        }
      } catch (error) {
        console.error(red(`Invalid schedule: ${error.message}`));
        process.exit(1);
      }

      // Determine action
      let actionType, actionTitle, actionContent, gitRemote, todoId;
      if (values['create-todo']) {
        actionType = 'create-todo';
        actionTitle = values['create-todo'];
        actionContent = values.content || null;
        gitRemote = values['git-remote'] || null;
      } else if (values['queue-todo']) {
        actionType = 'queue-todo';
        todoId = values['queue-todo'];
      } else {
        console.error(red('Action required: --create-todo <title> or --queue-todo <todoId>'));
        process.exit(1);
      }

      // Resolve agent type: explicit flag > auto-detect from caller
      const agentType = values['agent-type'] || null;

      try {
        const response = await api.apiRequest('manage-schedules', {
          method: 'POST',
          body: JSON.stringify({
            name: values.name,
            scheduleType,
            scheduleValue,
            actionType,
            agentType,
            actionTitle,
            actionContent,
            gitRemote,
            todoId,
            nextRunAt,
          }),
        });

        if (!response.ok) {
          const data = await response.json();
          console.error(red(`Failed to create schedule: ${data.error || response.status}`));
          process.exit(1);
        }

        const data = await response.json();
        const s = data.schedule;
        console.log(green(`Created schedule: ${s.name} (ID: ${s.id.slice(0, 8)})`));
        console.log(dim(`Next run: ${s.next_run_at}`));
      } catch (error) {
        console.error(red(`Failed to create schedule: ${error.message}`));
        process.exit(1);
      }
      return;
    }

    if (subCommand === 'list') {
      try {
        const response = await api.apiRequest('manage-schedules', { method: 'GET' });
        if (!response.ok) {
          console.error(red(`Failed to list schedules: HTTP ${response.status}`));
          process.exit(1);
        }

        const data = await response.json();
        const schedules = data.schedules || [];

        if (schedules.length === 0) {
          console.log('No schedules configured.');
          console.log(dim('Add one with: push-todo schedule add --name "..." --every "4h" --create-todo "..."'));
          return;
        }

        console.log(bold('Schedules:'));
        for (const s of schedules) {
          const status = s.enabled ? green('ON') : dim('OFF');
          const schedStr = s.schedule_type === 'every' ? `every ${s.schedule_value}` :
                           s.schedule_type === 'at' ? `at ${s.schedule_value}` :
                           `cron: ${s.schedule_value}`;
          const actionStr = s.action_type === 'create-todo'
            ? `create-todo: ${s.action_title || ''}`
            : `queue-todo: ${s.todo_id || '?'}`;
          const agentStr = s.agent_type && s.agent_type !== 'claude-code' ? ` (${s.agent_type})` : '';
          console.log(`  ${status} ${s.name} [${schedStr}] → ${actionStr}${agentStr}`);
          console.log(dim(`     ID: ${s.id.slice(0, 8)} | Next: ${s.next_run_at || 'N/A'} | Last: ${s.last_run_at || 'never'}`));
        }
      } catch (error) {
        console.error(red(`Failed to list schedules: ${error.message}`));
        process.exit(1);
      }
      return;
    }

    if (subCommand === 'remove') {
      const scheduleId = positionals[2];
      if (!scheduleId) {
        console.error(red('Usage: push-todo schedule remove <id>'));
        process.exit(1);
      }

      try {
        const response = await api.apiRequest(`manage-schedules?id=${scheduleId}`, {
          method: 'DELETE',
        });
        if (response.ok) {
          console.log(green(`Removed schedule ${scheduleId}`));
        } else {
          const data = await response.json();
          console.error(red(`Failed to remove schedule: ${data.error || response.status}`));
          process.exit(1);
        }
      } catch (error) {
        console.error(red(`Failed to remove schedule: ${error.message}`));
        process.exit(1);
      }
      return;
    }

    if (subCommand === 'enable' || subCommand === 'disable') {
      const scheduleId = positionals[2];
      if (!scheduleId) {
        console.error(red(`Usage: push-todo schedule ${subCommand} <id>`));
        process.exit(1);
      }

      const enabled = subCommand === 'enable';
      try {
        const response = await api.apiRequest('manage-schedules', {
          method: 'PATCH',
          body: JSON.stringify({ id: scheduleId, enabled }),
        });
        if (response.ok) {
          console.log(green(`Schedule ${scheduleId} ${enabled ? 'enabled' : 'disabled'}`));
        } else {
          const data = await response.json();
          console.error(red(`Failed to ${subCommand} schedule: ${data.error || response.status}`));
          process.exit(1);
        }
      } catch (error) {
        console.error(red(`Failed to ${subCommand} schedule: ${error.message}`));
        process.exit(1);
      }
      return;
    }

    // Default: show help for schedule
    console.log(`${bold('Schedule Commands:')}
  push-todo schedule add      Create a new remote schedule
  push-todo schedule list     List all schedules
  push-todo schedule remove   Remove a schedule by ID
  push-todo schedule enable   Enable a schedule
  push-todo schedule disable  Disable a schedule

${bold('Examples:')}
  push-todo schedule add --name "Daily standup" --every 24h --create-todo "Write standup update"
  push-todo schedule add --name "Weekly review" --cron "0 9 * * 1" --create-todo "Weekly code review" --git-remote github.com/user/repo
  push-todo schedule add --name "Re-run task" --every 4h --queue-todo <todoId>
  push-todo schedule add --name "Codex review" --every 12h --create-todo "Review PRs" --git-remote github.com/user/repo --agent-type openai-codex
    `);
    return;
  }

  // Journal cron command
  if (command === 'journal') {
    const { install, uninstall, getStatus, parseTime, formatTime, DEFAULT_HOUR, DEFAULT_MINUTE } = await import('./journal-cron.js');
    const subCommand = positionals[1] || 'setup';

    if (subCommand === 'setup') {
      let hour = DEFAULT_HOUR;
      let minute = DEFAULT_MINUTE;
      if (values.time) {
        try {
          ({ hour, minute } = parseTime(values.time));
        } catch (error) {
          console.error(red(error.message));
          process.exit(1);
        }
      }
      const result = install({ hour, minute });
      if (result.success) {
        console.log(green(result.message));
        console.log(dim(`Journal entries will be written to ~/journal/`));
        console.log(dim(`Logs: ~/.push/journal.log`));
      } else {
        console.error(red(result.message));
        process.exit(1);
      }
      return;
    }

    if (subCommand === 'status') {
      const status = getStatus();
      if (!status.installed) {
        console.log(dim('Journal cron not installed. Run: push-todo journal setup'));
        return;
      }
      const timeStr = typeof status.hour === 'number' ? formatTime(status.hour, status.minute) : 'unknown';
      console.log(`Journal cron: ${status.loaded ? green('active') : yellow('installed (not loaded)')}`);
      console.log(`  Runs daily at: ${bold(timeStr)}`);
      console.log(`  Logs: ~/.push/journal.log`);
      return;
    }

    if (subCommand === 'remove') {
      const result = uninstall();
      if (result.success) {
        console.log(green(result.message));
      } else {
        console.error(red(result.message));
        process.exit(1);
      }
      return;
    }

    console.error(red(`Unknown journal subcommand: ${subCommand}`));
    console.log(dim('Usage: push-todo journal [setup|status|remove]'));
    process.exit(1);
  }

  // Connect command
  if (command === 'connect') {
    if (values.auto) {
      const { runAutoConnect } = await import('./auto-connect.js');
      return runAutoConnect(values);
    }
    return runConnect(values);
  }

  // Update command - manual update of CLI, agents, and project freshness
  if (command === 'update') {
    const { runManualUpdate } = await import('./update.js');
    return runManualUpdate(values);
  }

  // Review command
  if (command === 'review') {
    return fetch.runReview(values);
  }

  // Setting command (positional form: push-todo setting [name])
  if (command === 'setting') {
    const settingName = positionals[1];
    if (settingName) {
      return toggleSetting(settingName);
    }
    return showSettings();
  }

  // Search command (positional form)
  if (command === 'search' && positionals[1]) {
    return fetch.searchTasks(positionals.slice(1).join(' '), values);
  }

  // Search option
  if (values.search) {
    return fetch.searchTasks(values.search, values);
  }

  // Watch mode
  if (values.watch) {
    return startWatch(values);
  }

  // Status
  if (values.status) {
    return fetch.showStatus(values);
  }

  // Settings
  if ('setting' in values) {
    const settingName = values.setting;
    if (settingName && settingName !== 'true') {
      return toggleSetting(settingName);
    }
    return showSettings();
  }

  // Queue tasks
  if (values.queue) {
    return fetch.queueForExecution(values.queue);
  }

  // Queue batch
  if (values['queue-batch']) {
    return fetch.offerBatch(values);
  }

  // Mark completed
  if (values['mark-completed']) {
    const comment = values['completion-comment'] || '';
    return fetch.markComplete(values['mark-completed'], comment);
  }

  // Specific task by number
  if (command && /^\d+$/.test(command)) {
    const displayNumber = parseInt(command, 10);
    return fetch.showTask(displayNumber, values);
  }

  // Unknown command
  if (command && !/^\d+$/.test(command)) {
    console.error(red(`Unknown command: ${command}`));
    console.log(`Run ${cyan('push-todo --help')} for usage.`);
    process.exit(1);
  }

  // Default: list tasks
  return fetch.listTasks(values);
}
