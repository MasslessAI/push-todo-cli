/**
 * Simple ANSI spinner for Push CLI.
 *
 * Braille-frame spinner that overwrites a single terminal line.
 * Uses the same ANSI patterns as watch.js (no external dependencies).
 */

import { codes } from './colors.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

/**
 * Create a spinner that updates in-place on a single line.
 *
 * @returns {{ start(text: string): void, update(text: string): void, succeed(text: string): void, fail(text: string): void, stop(): void }}
 */
export function createSpinner() {
  let frameIndex = 0;
  let intervalId = null;
  let currentText = '';

  function render() {
    const frame = `${codes.cyan}${FRAMES[frameIndex]}${codes.reset}`;
    process.stdout.write(`\r${codes.clearLine}  ${frame} ${currentText}`);
    frameIndex = (frameIndex + 1) % FRAMES.length;
  }

  return {
    start(text) {
      currentText = text;
      frameIndex = 0;
      render();
      intervalId = setInterval(render, INTERVAL_MS);
    },

    update(text) {
      currentText = text;
    },

    succeed(text) {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      process.stdout.write(`\r${codes.clearLine}  ${codes.green}✓${codes.reset} ${text}\n`);
    },

    fail(text) {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      process.stdout.write(`\r${codes.clearLine}  ${codes.red}✗${codes.reset} ${text}\n`);
    },

    info(text) {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      process.stdout.write(`\r${codes.clearLine}  ${codes.dim}○${codes.reset} ${text}\n`);
    },

    stop() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      process.stdout.write(`\r${codes.clearLine}`);
    }
  };
}
