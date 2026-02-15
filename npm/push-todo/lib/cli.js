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
import { getScreenshotPath, screenshotExists, openScreenshot } from './utils/screenshots.js';
import { bold, red, cyan, dim, green } from './utils/colors.js';
import { getMachineId } from './machine-id.js';

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
  push-todo connect                Run connection doctor
  push-todo search <query>         Search tasks
  push-todo review                 Review completed tasks

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
  --set-batch-size <N>             Set max tasks for batch queue (1-20)
  --daemon-status                  Show daemon status
  --daemon-start                   Start daemon manually
  --daemon-stop                    Stop daemon
  --commands                       Show available user commands
  --json                           Output as JSON
  --version, -v                    Show version
  --help, -h                       Show this help

${bold('EXAMPLES:')}
  push-todo                        List active tasks for current project
  push-todo 427                    Show task #427
  push-todo create "Fix auth bug"  Create a new todo
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

${bold('CONFIRM (for daemon skills):')}
  push-todo confirm --type "social_post" --title "Post tweet" --content "..."
  --type <type>                    Confirmation category (social_post, email, etc.)
  --title <text>                   Short description of the action
  --content <text>                 Content to be confirmed
  --metadata <json>                Optional JSON metadata for rich rendering
  --task <number>                  Display number (auto-detected in daemon)

${bold('CRON (scheduled jobs):')}
  push-todo cron add               Add a cron job
    --name <name>                  Job name (required)
    --every <interval>             Repeat interval: 30m, 1h, 24h, 7d
    --at <iso-date>                One-shot at specific time
    --cron <expression>            5-field cron expression
    --notify <message>             Send Mac notification
    --create-todo <content>        Create todo reminder
  push-todo cron list              List all cron jobs
  push-todo cron remove <id>       Remove a cron job by ID

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
  // Confirm command options
  'type': { type: 'string' },
  'title': { type: 'string' },
  'content': { type: 'string' },
  'metadata': { type: 'string' },
  'task': { type: 'string' },
  // Cron command options
  'name': { type: 'string' },
  'every': { type: 'string' },
  'at': { type: 'string' },
  'cron': { type: 'string' },
  'create-todo': { type: 'string' },
  'notify': { type: 'string' },
  'queue-execution': { type: 'string' },
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
      } else {
        console.error(red('Failed to stop daemon'));
        process.exit(1);
      }
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

      // Try to find the worktree relative to CWD's parent (sibling directory)
      const candidate = join(dirname(process.cwd()), worktreeName);
      if (existsSync(candidate)) {
        resumeCwd = candidate;
        console.log(`Found daemon worktree: ${candidate}`);
      } else {
        // Worktree was cleaned up after daemon finished, but the session file
        // still exists at ~/.claude/projects/. Re-create the directory so Claude
        // maps CWD to the correct session directory and finds the session.
        try {
          mkdirSync(candidate, { recursive: true });
          resumeCwd = candidate;
          console.log(`Re-created worktree directory for session lookup: ${candidate}`);
        } catch {
          console.log(dim(`Could not create worktree dir at ${candidate}, using current directory`));
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
      console.error('  push-todo create "Fix the auth bug" --backlog');
      console.error('  push-todo create "Fix the auth bug" --content "Detailed description"');
      process.exit(1);
    }

    try {
      const todo = await api.createTodo({
        title,
        content: values.content || null,
        backlog: values.backlog || false,
      });

      if (values.json) {
        console.log(JSON.stringify(todo, null, 2));
      } else {
        console.log(green(`Created todo #${todo.displayNumber}: ${todo.title}`));
      }
    } catch (error) {
      console.error(red(`Failed to create todo: ${error.message}`));
      process.exit(1);
    }
    return;
  }

  // Cron command - scheduled jobs
  if (command === 'cron') {
    const { addJob, removeJob, listJobs } = await import('./cron.js');
    const subCommand = positionals[1];

    if (subCommand === 'add') {
      if (!values.name) {
        console.error(red('--name is required for cron add'));
        process.exit(1);
      }

      // Determine schedule
      let schedule;
      if (values.every) {
        schedule = { type: 'every', value: values.every };
      } else if (values.at) {
        schedule = { type: 'at', value: values.at };
      } else if (values.cron) {
        schedule = { type: 'cron', value: values.cron };
      } else {
        console.error(red('Schedule required: --every, --at, or --cron'));
        process.exit(1);
      }

      // Determine action
      let action;
      if (values['create-todo']) {
        action = { type: 'create-todo', content: values['create-todo'] };
      } else if (values.notify) {
        action = { type: 'notify', content: values.notify };
      } else if (values['queue-execution']) {
        action = { type: 'queue-execution', todoId: values['queue-execution'] };
      } else {
        console.error(red('Action required: --create-todo, --notify, or --queue-execution'));
        process.exit(1);
      }

      try {
        const job = addJob({ name: values.name, schedule, action });
        console.log(green(`Created cron job: ${job.name} (ID: ${job.id.slice(0, 8)})`));
        console.log(dim(`Next run: ${job.nextRunAt}`));
      } catch (error) {
        console.error(red(`Failed to create cron job: ${error.message}`));
        process.exit(1);
      }
      return;
    }

    if (subCommand === 'list') {
      const jobs = listJobs();
      if (jobs.length === 0) {
        console.log('No cron jobs configured.');
        console.log(dim('Add one with: push-todo cron add --name "..." --every "24h" --notify "..."'));
        return;
      }
      console.log(bold('Cron Jobs:'));
      for (const job of jobs) {
        const status = job.enabled ? green('ON') : dim('OFF');
        const schedStr = job.schedule.type === 'every' ? `every ${job.schedule.value}` :
                         job.schedule.type === 'at' ? `at ${job.schedule.value}` :
                         `cron: ${job.schedule.value}`;
        console.log(`  ${status} ${job.name} [${schedStr}] → ${job.action.type}: ${job.action.content || job.action.todoId || ''}`);
        console.log(dim(`     ID: ${job.id.slice(0, 8)} | Next: ${job.nextRunAt || 'N/A'} | Last: ${job.lastRunAt || 'never'}`));
      }
      return;
    }

    if (subCommand === 'remove') {
      const jobId = positionals[2];
      if (!jobId) {
        console.error(red('Usage: push-todo cron remove <id>'));
        process.exit(1);
      }
      if (removeJob(jobId)) {
        console.log(green(`Removed cron job ${jobId}`));
      } else {
        console.error(red(`Cron job not found: ${jobId}`));
        process.exit(1);
      }
      return;
    }

    // Default: show help for cron
    console.log(`${bold('Cron Commands:')}
  push-todo cron add     Add a new scheduled job
  push-todo cron list    List all jobs
  push-todo cron remove  Remove a job by ID
    `);
    return;
  }

  // Connect command
  if (command === 'connect') {
    return runConnect(values);
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
