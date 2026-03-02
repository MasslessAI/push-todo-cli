/**
 * Tests for reminder-parser.js
 *
 * Validates conformance with iOS TodoItem+ReminderParsing.swift three-tier model.
 * Uses frozen `now` dates for deterministic results.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { parseReminder } from '../lib/reminder-parser.js';

// Frozen reference: Tuesday, 2026-03-03 at 10:00 AM local time
const TUESDAY_10AM = new Date(2026, 2, 3, 10, 0, 0); // Month is 0-indexed

// Helper: check date is within N minutes of target
function assertWithinMinutes(actual, target, minutes, msg) {
  const diffMs = Math.abs(actual.getTime() - target.getTime());
  assert.ok(diffMs <= minutes * 60_000, `${msg}: expected within ${minutes}min of ${target}, got ${actual} (diff: ${diffMs}ms)`);
}

// Helper: check hour and minute
function assertTime(date, hour, minute, msg) {
  assert.strictEqual(date.getHours(), hour, `${msg}: expected hour ${hour}, got ${date.getHours()}`);
  assert.strictEqual(date.getMinutes(), minute, `${msg}: expected minute ${minute}, got ${date.getMinutes()}`);
}

// Helper: check it's tomorrow relative to now
function assertTomorrow(date, now, msg) {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  assert.strictEqual(date.getDate(), tomorrow.getDate(), `${msg}: expected tomorrow's date`);
}

describe('parseReminder', () => {
  // ==================== Edge Cases ====================

  describe('edge cases', () => {
    test('null returns null', () => {
      const r = parseReminder(null);
      assert.strictEqual(r.date, null);
      assert.strictEqual(r.timeSource, null);
    });

    test('empty string returns null', () => {
      const r = parseReminder('');
      assert.strictEqual(r.date, null);
    });

    test('undefined returns null', () => {
      const r = parseReminder(undefined);
      assert.strictEqual(r.date, null);
    });

    test('unrecognized text returns null', () => {
      const r = parseReminder('banana', TUESDAY_10AM);
      assert.strictEqual(r.date, null);
    });
  });

  // ==================== Tier 1: ASAP ====================

  describe('ASAP (Tier 1)', () => {
    test('"now" → ~now+1min', () => {
      const r = parseReminder('now', TUESDAY_10AM);
      assertWithinMinutes(r.date, new Date(TUESDAY_10AM.getTime() + 60_000), 1, 'now');
      assert.strictEqual(r.timeSource, 'userSpecified');
    });

    test('"today" → ASAP', () => {
      const r = parseReminder('today', TUESDAY_10AM);
      assertWithinMinutes(r.date, new Date(TUESDAY_10AM.getTime() + 60_000), 1, 'today');
      assert.strictEqual(r.timeSource, 'userSpecified');
    });

    test('"asap" → ASAP', () => {
      const r = parseReminder('asap', TUESDAY_10AM);
      assert.ok(r.date, 'asap should return a date');
      assert.strictEqual(r.timeSource, 'userSpecified');
    });

    test('"soon" → ASAP', () => {
      const r = parseReminder('soon', TUESDAY_10AM);
      assert.ok(r.date);
      assert.strictEqual(r.timeSource, 'userSpecified');
    });

    test('"immediately" → ASAP', () => {
      const r = parseReminder('immediately', TUESDAY_10AM);
      assert.ok(r.date);
    });

    test('"later today" → ASAP', () => {
      const r = parseReminder('later today', TUESDAY_10AM);
      assert.ok(r.date);
      assert.strictEqual(r.timeSource, 'userSpecified');
    });

    test('"right now" → ASAP', () => {
      const r = parseReminder('right now', TUESDAY_10AM);
      assert.ok(r.date);
    });
  });

  // ==================== Tier 2: Deferred ====================

  describe('Deferred (Tier 2)', () => {
    test('"tomorrow" → +1d at 9AM', () => {
      const r = parseReminder('tomorrow', TUESDAY_10AM);
      assertTomorrow(r.date, TUESDAY_10AM, 'tomorrow');
      assertTime(r.date, 9, 0, 'tomorrow');
      assert.strictEqual(r.timeSource, 'defaultGeneral');
    });

    test('"tomorrow morning" → +1d at 9AM (morning default)', () => {
      const r = parseReminder('tomorrow morning', TUESDAY_10AM);
      assertTomorrow(r.date, TUESDAY_10AM, 'tomorrow morning');
      assertTime(r.date, 9, 0, 'tomorrow morning');
      assert.strictEqual(r.timeSource, 'defaultMorning');
    });

    test('"tomorrow night" → +1d at 21:00', () => {
      const r = parseReminder('tomorrow night', TUESDAY_10AM);
      assertTomorrow(r.date, TUESDAY_10AM, 'tomorrow night');
      assertTime(r.date, 21, 0, 'tomorrow night');
      assert.strictEqual(r.timeSource, 'userSpecified');
    });

    test('"tomorrow evening" → +1d at 18:00', () => {
      const r = parseReminder('tomorrow evening', TUESDAY_10AM);
      assertTomorrow(r.date, TUESDAY_10AM, 'tomorrow evening');
      assertTime(r.date, 18, 0, 'tomorrow evening');
      assert.strictEqual(r.timeSource, 'defaultEvening');
    });

    test('"next week" → +7d at 9AM', () => {
      const r = parseReminder('next week', TUESDAY_10AM);
      const expected = new Date(TUESDAY_10AM);
      expected.setDate(expected.getDate() + 7);
      assert.strictEqual(r.date.getDate(), expected.getDate(), 'next week date');
      assertTime(r.date, 9, 0, 'next week');
      assert.strictEqual(r.timeSource, 'defaultGeneral');
    });

    test('"this week" → this Friday at 9AM', () => {
      // TUESDAY_10AM is Tuesday, so Friday is 3 days away
      const r = parseReminder('this week', TUESDAY_10AM);
      assert.strictEqual(r.date.getDay(), 5, 'this week should be Friday');
      assertTime(r.date, 9, 0, 'this week');
      assert.strictEqual(r.timeSource, 'defaultGeneral');
    });

    test('"this week" on Saturday → ASAP', () => {
      const saturday = new Date(2026, 2, 7, 10, 0, 0); // Saturday
      const r = parseReminder('this week', saturday);
      // Should be ASAP since this Friday already passed
      assert.ok(r.date);
      assert.strictEqual(r.timeSource, 'defaultGeneral');
    });
  });

  // ==================== Tier 3: Precise ====================

  describe('Precise (Tier 3)', () => {
    test('"at 3pm" → 15:00 today (future)', () => {
      const r = parseReminder('at 3pm', TUESDAY_10AM);
      assertTime(r.date, 15, 0, 'at 3pm');
      assert.strictEqual(r.timeSource, 'userSpecified');
    });

    test('"at 3pm" → 15:00 tomorrow if past', () => {
      const tuesday4pm = new Date(2026, 2, 3, 16, 0, 0);
      const r = parseReminder('at 3pm', tuesday4pm);
      assertTime(r.date, 15, 0, 'at 3pm (past)');
      // Should be tomorrow since 3pm already passed
      assertTomorrow(r.date, tuesday4pm, 'at 3pm rolls to tomorrow');
    });

    test('"in 2 hours" → now+2h', () => {
      const r = parseReminder('in 2 hours', TUESDAY_10AM);
      assertTime(r.date, 12, 0, 'in 2 hours');
      assert.strictEqual(r.timeSource, 'userSpecified');
    });

    test('"in 30 minutes" → now+30m', () => {
      const r = parseReminder('in 30 minutes', TUESDAY_10AM);
      assertTime(r.date, 10, 30, 'in 30 minutes');
    });

    test('"half an hour" → now+30m', () => {
      const r = parseReminder('half an hour', TUESDAY_10AM);
      assertTime(r.date, 10, 30, 'half an hour');
    });

    test('"in an hour" → now+1h', () => {
      const r = parseReminder('in an hour', TUESDAY_10AM);
      assertTime(r.date, 11, 0, 'in an hour');
    });

    test('"tomorrow at 10am" → +1d at 10:00', () => {
      const r = parseReminder('tomorrow at 10am', TUESDAY_10AM);
      assertTomorrow(r.date, TUESDAY_10AM, 'tomorrow at 10am');
      assertTime(r.date, 10, 0, 'tomorrow at 10am');
      assert.strictEqual(r.timeSource, 'userSpecified');
    });

    test('"in 3 days" → +3d at 9AM', () => {
      const r = parseReminder('in 3 days', TUESDAY_10AM);
      const expected = new Date(TUESDAY_10AM);
      expected.setDate(expected.getDate() + 3);
      assert.strictEqual(r.date.getDate(), expected.getDate(), 'in 3 days date');
      assertTime(r.date, 9, 0, 'in 3 days');
      assert.strictEqual(r.timeSource, 'defaultGeneral');
    });

    test('"3:30pm" → 15:30', () => {
      const r = parseReminder('3:30pm', TUESDAY_10AM);
      assertTime(r.date, 15, 30, '3:30pm');
    });
  });

  // ==================== Day Anchoring ====================

  describe('Day anchoring', () => {
    test('"tonight" before evening → today at 18:00', () => {
      const r = parseReminder('tonight', TUESDAY_10AM);
      assertTime(r.date, 18, 0, 'tonight');
      assert.strictEqual(r.date.getDate(), TUESDAY_10AM.getDate(), 'tonight is today');
      assert.strictEqual(r.timeSource, 'defaultEvening');
    });

    test('"tonight" after evening → ASAP', () => {
      const tuesday11pm = new Date(2026, 2, 3, 23, 0, 0);
      const r = parseReminder('tonight', tuesday11pm);
      // Past evening hour → ASAP (day-anchored, won't roll to tomorrow)
      assertWithinMinutes(r.date, new Date(tuesday11pm.getTime() + 60_000), 1, 'tonight past');
      assert.strictEqual(r.timeSource, 'defaultEvening');
    });

    test('"this morning" before morning → today at 9AM', () => {
      const tuesday6am = new Date(2026, 2, 3, 6, 0, 0);
      const r = parseReminder('this morning', tuesday6am);
      assertTime(r.date, 9, 0, 'this morning');
      assert.strictEqual(r.timeSource, 'defaultMorning');
    });

    test('"this morning" after morning → ASAP', () => {
      // 10 AM is after 9 AM morning default
      const r = parseReminder('this morning', TUESDAY_10AM);
      assertWithinMinutes(r.date, new Date(TUESDAY_10AM.getTime() + 60_000), 1, 'this morning past');
      assert.strictEqual(r.timeSource, 'userSpecified');
    });

    test('"this afternoon" before 2PM → today at 14:00', () => {
      const r = parseReminder('this afternoon', TUESDAY_10AM);
      assertTime(r.date, 14, 0, 'this afternoon');
    });

    test('"this afternoon" after 2PM → ASAP', () => {
      const tuesday3pm = new Date(2026, 2, 3, 15, 0, 0);
      const r = parseReminder('this afternoon', tuesday3pm);
      assertWithinMinutes(r.date, new Date(tuesday3pm.getTime() + 60_000), 1, 'this afternoon past');
    });
  });

  // ==================== Weekday Handling ====================

  describe('Weekday handling', () => {
    test('"tuesday" on Tuesday → ASAP (same-day)', () => {
      const r = parseReminder('tuesday', TUESDAY_10AM);
      assertWithinMinutes(r.date, new Date(TUESDAY_10AM.getTime() + 60_000), 1, 'tuesday on tuesday');
      assert.strictEqual(r.timeSource, 'userSpecified');
    });

    test('"friday" on Tuesday → next Friday at 9AM', () => {
      const r = parseReminder('friday', TUESDAY_10AM);
      assert.strictEqual(r.date.getDay(), 5, 'friday weekday');
      assertTime(r.date, 9, 0, 'friday');
      assert.strictEqual(r.timeSource, 'defaultGeneral');
    });

    test('"monday" on Tuesday → next Monday at 9AM', () => {
      const r = parseReminder('monday', TUESDAY_10AM);
      assert.strictEqual(r.date.getDay(), 1, 'monday weekday');
      assertTime(r.date, 9, 0, 'monday');
      // Should be 6 days from Tuesday
      const diffDays = (r.date.getTime() - TUESDAY_10AM.getTime()) / 86_400_000;
      assert.ok(diffDays >= 5.5 && diffDays <= 6.5, `monday should be ~6 days away, got ${diffDays}`);
    });

    test('"friday at 3pm" on Tuesday → next Friday at 15:00', () => {
      const r = parseReminder('friday at 3pm', TUESDAY_10AM);
      assert.strictEqual(r.date.getDay(), 5, 'friday at 3pm weekday');
      assertTime(r.date, 15, 0, 'friday at 3pm');
      assert.strictEqual(r.timeSource, 'userSpecified');
    });
  });

  // ==================== End of Day ====================

  describe('End of day', () => {
    test('"eod" → 17:00 today (future)', () => {
      const r = parseReminder('eod', TUESDAY_10AM);
      assertTime(r.date, 17, 0, 'eod');
      assert.strictEqual(r.timeSource, 'userSpecified');
    });

    test('"end of day" → 17:00', () => {
      const r = parseReminder('end of day', TUESDAY_10AM);
      assertTime(r.date, 17, 0, 'end of day');
    });

    test('"cob" → 17:00', () => {
      const r = parseReminder('cob', TUESDAY_10AM);
      assertTime(r.date, 17, 0, 'cob');
    });

    test('"eod" after 5PM → tomorrow 17:00', () => {
      const tuesday6pm = new Date(2026, 2, 3, 18, 0, 0);
      const r = parseReminder('eod', tuesday6pm);
      assertTime(r.date, 17, 0, 'eod past');
      assertTomorrow(r.date, tuesday6pm, 'eod rolls to tomorrow');
    });
  });

  // ==================== Noon ====================

  describe('Noon', () => {
    test('"noon" → 12:00 today', () => {
      const r = parseReminder('noon', TUESDAY_10AM);
      assertTime(r.date, 12, 0, 'noon');
    });

    test('"midday" → 12:00', () => {
      const r = parseReminder('midday', TUESDAY_10AM);
      assertTime(r.date, 12, 0, 'midday');
    });
  });
});
