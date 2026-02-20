/**
 * Execution Parsing Tests
 *
 * Tests the full execution parsing pipeline:
 * - YAML frontmatter parsing (context-engine.js)
 * - Smart prompt building with transcript details (context-engine.js)
 * - Certainty analysis with transcript (certainty.js)
 * - Task display formatting with transcript (utils/format.js)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseFrontmatter, buildSmartPrompt } from '../lib/context-engine.js';
import {
  CertaintyAnalyzer,
  CertaintyLevel,
  analyzeCertainty,
  shouldExecute,
  getExecutionMode
} from '../lib/certainty.js';
import { formatTaskForDisplay } from '../lib/utils/format.js';

// ==================== parseFrontmatter ====================

describe('parseFrontmatter', () => {
  test('parses valid YAML frontmatter', () => {
    const content = `---
name: deploy-skill
description: Deploy the application
allowed-tools: Bash, Read
---
# Deploy Skill
This skill deploys the app.`;

    const { frontmatter, body } = parseFrontmatter(content);
    assert.strictEqual(frontmatter.name, 'deploy-skill');
    assert.strictEqual(frontmatter.description, 'Deploy the application');
    assert.strictEqual(frontmatter['allowed-tools'], 'Bash, Read');
    assert.ok(body.includes('# Deploy Skill'));
  });

  test('returns empty frontmatter when no markers', () => {
    const content = 'Just a plain file with no frontmatter.';
    const { frontmatter, body } = parseFrontmatter(content);
    assert.deepStrictEqual(frontmatter, {});
    assert.strictEqual(body, content);
  });

  test('returns empty frontmatter when only opening marker', () => {
    const content = '---\nname: test\nno closing marker here';
    const { frontmatter, body } = parseFrontmatter(content);
    assert.deepStrictEqual(frontmatter, {});
    assert.strictEqual(body, content);
  });

  test('handles empty frontmatter block', () => {
    const content = '---\n---\nBody content here.';
    const { frontmatter, body } = parseFrontmatter(content);
    assert.deepStrictEqual(frontmatter, {});
    assert.ok(body.includes('Body content here.'));
  });

  test('handles values with colons', () => {
    const content = `---
description: Deploy to server: production
---
Body`;

    const { frontmatter } = parseFrontmatter(content);
    assert.strictEqual(frontmatter.description, 'Deploy to server: production');
  });

  test('skips lines without colons', () => {
    const content = `---
name: test
this line has no colon
description: a skill
---
Body`;

    const { frontmatter } = parseFrontmatter(content);
    assert.strictEqual(frontmatter.name, 'test');
    assert.strictEqual(frontmatter.description, 'a skill');
    assert.strictEqual(Object.keys(frontmatter).length, 2);
  });
});

// ==================== buildSmartPrompt ====================

describe('buildSmartPrompt', () => {
  test('builds minimal prompt with just task content', () => {
    const task = {
      displayNumber: 42,
      content: 'Fix the login button',
      attachmentContext: '',
      actionName: null,
      contextApp: null,
    };
    const context = { skills: [], state: {} };

    const prompt = buildSmartPrompt(task, context);
    assert.ok(prompt.includes('## Task'));
    assert.ok(prompt.includes('Push task #42'));
    assert.ok(prompt.includes('Fix the login button'));
    assert.ok(prompt.includes('## Instructions'));
    // Should not have metadata or attachments
    assert.ok(!prompt.includes('## Metadata'));
    assert.ok(!prompt.includes('## Attachments'));
  });

  test('includes metadata when actionName and contextApp present', () => {
    const task = {
      displayNumber: 10,
      content: 'Review the PR',
      attachmentContext: '',
      actionName: 'Code Review',
      contextApp: 'Safari',
    };
    const context = { skills: [], state: {} };

    const prompt = buildSmartPrompt(task, context);
    assert.ok(prompt.includes('## Metadata'));
    assert.ok(prompt.includes('Action: Code Review'));
    assert.ok(prompt.includes('Context app: Safari'));
  });

  test('includes attachment context', () => {
    const attachmentContext = '\n\nAttachments:\nLinks:\n  - https://example.com (Example)\nScreenshots:\n  - screenshot1.png (from Safari)';
    const task = {
      displayNumber: 5,
      content: 'Check the design',
      attachmentContext,
      actionName: null,
      contextApp: null,
    };
    const context = { skills: [], state: {} };

    const prompt = buildSmartPrompt(task, context);
    assert.ok(prompt.includes('## Attachments'));
    assert.ok(prompt.includes('https://example.com'));
    assert.ok(prompt.includes('screenshot1.png'));
  });

  test('includes skills with confirmation flag', () => {
    const task = {
      displayNumber: 1,
      content: 'Deploy',
      attachmentContext: '',
      actionName: null,
      contextApp: null,
    };
    const context = {
      skills: [
        { name: 'deploy', description: 'Deploy to prod', requiresConfirmation: true },
        { name: 'test', description: 'Run tests', requiresConfirmation: false },
      ],
      state: {},
    };

    const prompt = buildSmartPrompt(task, context);
    assert.ok(prompt.includes('## Available Skills'));
    assert.ok(prompt.includes('/deploy: Deploy to prod [requires push-todo confirm]'));
    assert.ok(prompt.includes('/test: Run tests'));
    assert.ok(prompt.includes('confirmation workflow'));
  });

  test('includes project state', () => {
    const task = {
      displayNumber: 3,
      content: 'Add tests',
      attachmentContext: '',
      actionName: null,
      contextApp: null,
    };
    const context = {
      skills: [],
      state: {
        currentBranch: 'feature/auth',
        recentCommits: ['abc1234 Add login page', 'def5678 Fix typo'],
        openPRs: [{ number: 12, title: 'Auth feature' }],
      },
    };

    const prompt = buildSmartPrompt(task, context);
    assert.ok(prompt.includes('## Project State'));
    assert.ok(prompt.includes('Current branch: feature/auth'));
    assert.ok(prompt.includes('abc1234 Add login page'));
    assert.ok(prompt.includes('#12 Auth feature'));
  });

  test('instructions section always present with commit reminder', () => {
    const task = {
      displayNumber: 1,
      content: 'Do something',
      attachmentContext: '',
      actionName: null,
      contextApp: null,
    };
    const context = { skills: [], state: {} };

    const prompt = buildSmartPrompt(task, context);
    assert.ok(prompt.includes('## Instructions'));
    assert.ok(prompt.includes('ALWAYS commit your changes'));
    assert.ok(prompt.includes('CLAUDE.md'));
    assert.ok(prompt.includes('SessionEnd hook'));
  });
});

// ==================== CertaintyAnalyzer with transcript ====================

describe('CertaintyAnalyzer', () => {
  test('high certainty for specific imperative task', () => {
    const content = 'Add a logout button to the UserMenu component in src/components/UserMenu.tsx';
    const analysis = analyzeCertainty(content);
    assert.strictEqual(analysis.level, CertaintyLevel.HIGH);
    assert.ok(analysis.score >= 0.7);
    assert.strictEqual(analysis.recommendedAction, 'execute');
  });

  test('low certainty for vague task', () => {
    const content = 'maybe look into performance or something';
    const analysis = analyzeCertainty(content);
    assert.strictEqual(analysis.level, CertaintyLevel.LOW);
    assert.ok(analysis.score < 0.4);
  });

  test('transcript boosts certainty by adding specificity', () => {
    // Short content alone
    const content = 'Fix bug';
    const analysisWithout = analyzeCertainty(content);

    // Same content + transcript with specific details
    const transcript = 'Fix the null pointer bug in the UserService.getProfile() function in src/services/user.ts line 42';
    const analysisWith = analyzeCertainty(content, null, transcript);

    assert.ok(analysisWith.score > analysisWithout.score,
      `Score with transcript (${analysisWith.score}) should be higher than without (${analysisWithout.score})`);
  });

  test('transcript with questions lowers certainty', () => {
    const content = 'Update the API';
    const transcript = 'How should we update the API? Should we use REST or GraphQL?';
    const analysis = analyzeCertainty(content, null, transcript);

    // Should detect the question patterns
    const hasQuestionReason = analysis.reasons.some(r => r.factor === 'question_present');
    assert.ok(hasQuestionReason, 'Should detect question in transcript');
    assert.ok(analysis.clarificationQuestions.length > 0, 'Should suggest clarification');
  });

  test('summary and transcript combine for analysis', () => {
    const content = 'refactor auth';
    const summary = 'Refactor the authentication module';
    const transcript = 'Refactor the authentication module to use JWT tokens instead of session cookies in the auth middleware';

    const analysis = analyzeCertainty(content, summary, transcript);
    assert.ok(analysis.score > 0.4, 'Combined text should have medium+ certainty');
  });

  test('shouldExecute with transcript', () => {
    const content = 'Add error handling to the payment service in src/services/payment.ts';
    const transcript = 'Add try catch blocks and proper error handling to the payment processing service';

    assert.ok(shouldExecute(content, null, transcript),
      'Specific task with reinforcing transcript should execute');
  });

  test('shouldExecute rejects uncertain transcript', () => {
    const content = 'thing';
    const transcript = 'maybe explore something or whatever not sure';

    assert.ok(!shouldExecute(content, null, transcript, 0.4),
      'Vague content + uncertain transcript should not execute');
  });

  test('getExecutionMode returns correct modes', () => {
    assert.strictEqual(getExecutionMode({ score: 0.85 }), 'immediate');
    assert.strictEqual(getExecutionMode({ score: 0.55 }), 'planning');
    assert.strictEqual(getExecutionMode({ score: 0.2 }), 'clarify');
    assert.strictEqual(getExecutionMode(null), 'immediate');
  });

  test('reasons include all scoring factors', () => {
    const content = 'Fix the bug in src/app.ts function handleLogin()';
    const analysis = analyzeCertainty(content);

    // Should have action_verb and specificity reasons
    const factors = analysis.reasons.map(r => r.factor);
    assert.ok(factors.includes('action_verb'), 'Should detect action verb');
    assert.ok(
      factors.includes('specificity') || factors.includes('high_specificity'),
      'Should detect specificity'
    );

    // All reasons should have required fields
    for (const reason of analysis.reasons) {
      assert.ok(reason.factor, 'Each reason must have a factor');
      assert.ok(typeof reason.scoreDelta === 'number', 'Each reason must have a scoreDelta');
      assert.ok(reason.explanation, 'Each reason must have an explanation');
    }
  });

  test('score is clamped between 0 and 1', () => {
    // Very vague — lots of negative signals
    const vagueContent = 'maybe possibly somehow look into something or maybe not sure what to do? what should I do?';
    const vagueAnalysis = analyzeCertainty(vagueContent);
    assert.ok(vagueAnalysis.score >= 0.0, 'Score should not go below 0');
    assert.ok(vagueAnalysis.score <= 1.0, 'Score should not exceed 1');

    // Very specific — lots of positive signals
    const specificContent = 'Add a validateEmail() function in src/utils/validation.ts that checks for RFC 5322 compliance and returns a boolean for the UserRegistration component';
    const specificAnalysis = analyzeCertainty(specificContent);
    assert.ok(specificAnalysis.score >= 0.0, 'Score should not go below 0');
    assert.ok(specificAnalysis.score <= 1.0, 'Score should not exceed 1');
  });
});

// ==================== formatTaskForDisplay with transcript ====================

describe('formatTaskForDisplay', () => {
  test('formats task with all transcript details', () => {
    const task = {
      id: 'abc-123-def',
      displayNumber: 42,
      summary: 'Fix login bug',
      content: 'Fix the null pointer in login handler',
      transcript: 'Fix the login bug where it crashes when the user enters a wrong password',
      originalTranscript: 'fix the login bug where it crashes when the user enters a wrong password',
      executionStatus: 'running',
      createdAt: '2026-02-20T10:00:00Z',
    };

    const output = formatTaskForDisplay(task);
    assert.ok(output.includes('#42'), 'Should include display number');
    assert.ok(output.includes('Fix login bug'), 'Should include summary');
    assert.ok(output.includes('Fix the null pointer'), 'Should include content');
    assert.ok(output.includes('Original Voice Transcript'), 'Should include transcript section');
    assert.ok(output.includes('login bug where it crashes'), 'Should include transcript text');
    assert.ok(output.includes('Running'), 'Should show running status');
  });

  test('uses transcript field when originalTranscript is absent', () => {
    const task = {
      id: 'test-id',
      displayNumber: 5,
      summary: 'Test task',
      content: 'Test content',
      transcript: 'This is the voice transcript from the iOS app',
      createdAt: '2026-02-20T10:00:00Z',
    };

    const output = formatTaskForDisplay(task);
    assert.ok(output.includes('Original Voice Transcript'));
    assert.ok(output.includes('voice transcript from the iOS app'));
  });

  test('uses originalTranscript when transcript is absent', () => {
    const task = {
      id: 'test-id',
      displayNumber: 6,
      summary: 'Test task',
      content: 'Test content',
      originalTranscript: 'Original voice recording transcribed text',
      createdAt: '2026-02-20T10:00:00Z',
    };

    const output = formatTaskForDisplay(task);
    assert.ok(output.includes('Original Voice Transcript'));
    assert.ok(output.includes('Original voice recording transcribed text'));
  });

  test('omits transcript section when no transcript', () => {
    const task = {
      id: 'test-id',
      displayNumber: 7,
      summary: 'Test task',
      content: 'Test content',
      createdAt: '2026-02-20T10:00:00Z',
    };

    const output = formatTaskForDisplay(task);
    assert.ok(!output.includes('Original Voice Transcript'), 'Should not show transcript section');
  });

  test('formats task with attachments and transcript', () => {
    const task = {
      id: 'attach-test',
      displayNumber: 15,
      summary: 'Design review',
      content: 'Review the new design mockup',
      transcript: 'Review the new homepage design that Sarah shared in the screenshots',
      screenshotAttachmentsJson: JSON.stringify([
        { imageFilename: 'homepage-v2.png', width: 1920, height: 1080 }
      ]),
      linkAttachmentsJson: JSON.stringify([
        { url: 'https://figma.com/design/123', title: 'Homepage Design' }
      ]),
      createdAt: '2026-02-20T10:00:00Z',
    };

    const output = formatTaskForDisplay(task);
    assert.ok(output.includes('Screenshots (1)'), 'Should show screenshot count');
    assert.ok(output.includes('homepage-v2.png'), 'Should show screenshot filename');
    assert.ok(output.includes('1920x1080'), 'Should show dimensions');
    assert.ok(output.includes('Homepage Design'), 'Should show link title');
    assert.ok(output.includes('Original Voice Transcript'), 'Should show transcript');
  });

  test('formats all execution statuses correctly', () => {
    const statuses = [
      { executionStatus: 'running', expected: 'Running' },
      { executionStatus: 'queued', expected: 'Queued' },
      { executionStatus: 'session_finished', expected: 'Session finished' },
      { executionStatus: 'failed', executionError: 'Timeout', expected: 'Failed' },
    ];

    for (const { executionStatus, executionError, expected } of statuses) {
      const task = {
        id: 'status-test',
        displayNumber: 1,
        summary: 'Test',
        content: 'Test',
        executionStatus,
        executionError,
        createdAt: '2026-02-20T10:00:00Z',
      };

      const output = formatTaskForDisplay(task);
      assert.ok(output.includes(expected),
        `Status "${executionStatus}" should render as "${expected}", got: ${output.split('\n').find(l => l.includes('Status'))}`);
    }
  });

  test('includes session resume hint', () => {
    const task = {
      id: 'session-test',
      displayNumber: 99,
      summary: 'Resumable task',
      content: 'Some work',
      executionSessionId: 'session-uuid-12345',
      executionStatus: 'session_finished',
      createdAt: '2026-02-20T10:00:00Z',
    };

    const output = formatTaskForDisplay(task);
    assert.ok(output.includes('Resumable'), 'Should show resumable hint');
    assert.ok(output.includes('push-todo resume 99'), 'Should show resume command');
  });

  test('includes execution summary when present', () => {
    const task = {
      id: 'summary-test',
      displayNumber: 50,
      summary: 'Completed task',
      content: 'Fix the bug',
      executionStatus: 'session_finished',
      executionSummary: 'Fixed the null pointer exception in UserService.getProfile() by adding a null check.',
      createdAt: '2026-02-20T10:00:00Z',
    };

    const output = formatTaskForDisplay(task);
    assert.ok(output.includes('What was done'), 'Should show execution summary header');
    assert.ok(output.includes('null pointer exception'), 'Should include summary details');
  });

  test('includes context app when present', () => {
    const task = {
      id: 'ctx-test',
      displayNumber: 8,
      summary: 'Task from Safari',
      content: 'Check this page',
      contextApp: 'Safari',
      createdAt: '2026-02-20T10:00:00Z',
    };

    const output = formatTaskForDisplay(task);
    assert.ok(output.includes('**Context App:** Safari'));
  });
});

// ==================== End-to-end: full transcript pipeline ====================

describe('End-to-end transcript pipeline', () => {
  test('transcript flows through certainty analysis into prompt building', () => {
    // Simulate a voice task with transcript
    const taskData = {
      displayNumber: 100,
      summary: 'Add dark mode',
      content: 'Add dark mode toggle to the settings page',
      transcript: 'Add a dark mode toggle to the settings page using the existing theme context provider in src/contexts/ThemeContext.tsx',
      originalTranscript: 'add a dark mode toggle to the settings page using the existing theme context provider',
    };

    // Step 1: Analyze certainty with transcript
    const analysis = analyzeCertainty(
      taskData.content,
      taskData.summary,
      taskData.transcript
    );
    assert.ok(analysis.score >= 0.4, 'Task with detailed transcript should pass medium certainty');
    assert.ok(analysis.recommendedAction !== 'skip_or_clarify');

    // Step 2: Build the execution prompt
    const prompt = buildSmartPrompt(
      {
        displayNumber: taskData.displayNumber,
        content: taskData.content,
        attachmentContext: '',
        actionName: null,
        contextApp: null,
      },
      { skills: [], state: { currentBranch: 'main' } }
    );
    assert.ok(prompt.includes('Push task #100'));
    assert.ok(prompt.includes('dark mode toggle'));

    // Step 3: Format for display (includes transcript)
    const display = formatTaskForDisplay(taskData);
    assert.ok(display.includes('Original Voice Transcript'));
    assert.ok(display.includes('theme context provider'));
  });

  test('task with only originalTranscript works through full pipeline', () => {
    const content = 'Fix the crash on startup';
    const originalTranscript = 'Fix the app crash that happens on startup when the database connection times out in DatabaseService.connect()';

    // Certainty analysis accepts originalTranscript as transcript param
    const analysis = analyzeCertainty(content, null, originalTranscript);
    assert.ok(analysis.score >= 0.4);

    // Format display shows it
    const display = formatTaskForDisplay({
      id: 'pipe-test',
      displayNumber: 200,
      summary: 'Fix crash',
      content,
      originalTranscript,
      createdAt: '2026-02-20T10:00:00Z',
    });
    assert.ok(display.includes('DatabaseService.connect()'));
  });
});
