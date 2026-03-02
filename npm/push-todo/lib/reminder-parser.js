/**
 * Reminder parser for Push CLI.
 *
 * Ports the iOS three-tier agent scheduling model to JavaScript.
 * Source of truth: App/Data/TodoItem+ReminderParsing.swift
 *
 * Three tiers:
 *   Tier 1 — ASAP: "today", "now", "asap" → now + 1 minute
 *   Tier 2 — Deferred: "tomorrow", "next week", "morning" → target day at default hour
 *   Tier 3 — Precise: "at 3pm", "in 2 hours" → exact requested time
 *
 * Key difference from iOS: CLI cannot access user-configurable ReminderSettings.
 * Uses factory defaults from ReminderSettings.swift instead.
 */

// Fixed defaults matching iOS ReminderSettings factory values
const DEFAULTS = {
  general: 9,     // ReminderSettings.swift:32 — defaultReminderHour
  morning: 9,     // ReminderSettings.swift:45 — defaultMorningHour
  evening: 18,    // ReminderSettings.swift:53 — defaultEveningHour
  night: 21,      // ReminderParsing.swift:223 — hardcoded
  afternoon: 14,  // ReminderParsing.swift:200 — hardcoded
  endOfDay: 17,   // ReminderParsing.swift:171 — hardcoded
  noon: 12,       // ReminderParsing.swift:233 — hardcoded
};

/**
 * Parse a natural language reminder description into a concrete Date.
 *
 * @param {string|null} description - Natural language like "tomorrow night", "at 3pm"
 * @param {Date} [now] - Current time (for testing). Defaults to new Date().
 * @returns {{ date: Date|null, timeSource: string|null }}
 */
export function parseReminder(description, now = new Date()) {
  if (!description || typeof description !== 'string') {
    return { date: null, timeSource: null };
  }

  const text = description.toLowerCase().trim();
  if (!text) {
    return { date: null, timeSource: null };
  }

  // Tier 1 anchor: 1-minute buffer so reminderDate is always > now after sync latency.
  const asapDate = new Date(now.getTime() + 60_000);

  // ============================================================
  // PHASE 1: Precise relative patterns (Tier 3)
  // "in X minutes/hours" — inherently future, no rollover needed.
  // "in X days" — day-level, uses defaultReminderHour on target day.
  // ============================================================

  if (text.startsWith('in ') || text.includes('half an hour') || text.includes('half hour')) {
    if (text.includes('half an hour') || text.includes('half hour')) {
      return { date: addMinutes(now, 30), timeSource: 'userSpecified' };
    }
    if (text.includes('an hour') && !text.includes('half')) {
      return { date: addHours(now, 1), timeSource: 'userSpecified' };
    }
    if (text.includes('minute')) {
      const n = extractNumber(text);
      if (n) return { date: addMinutes(now, n), timeSource: 'userSpecified' };
    }
    if (text.includes('hour')) {
      const n = extractNumber(text);
      if (n) return { date: addHours(now, n), timeSource: 'userSpecified' };
    }
    if (text.includes('day')) {
      const n = extractNumber(text);
      if (n) {
        const future = addDays(now, n);
        return { date: setTime(future, DEFAULTS.general, 0), timeSource: 'defaultGeneral' };
      }
    }
  }

  // ============================================================
  // PHASE 2: ASAP (Tier 1) — execute on next daemon poll
  // ============================================================

  if (text.includes('right now') || text === 'now' ||
      text.includes('asap') || text === 'soon' ||
      text.includes('immediately')) {
    return { date: asapDate, timeSource: 'userSpecified' };
  }

  if (text === 'today') {
    return { date: asapDate, timeSource: 'userSpecified' };
  }

  if (text.includes('later today') || text.includes('later on')) {
    return { date: asapDate, timeSource: 'userSpecified' };
  }

  // ============================================================
  // PHASE 3: End-of-day expressions (Tier 2)
  // ============================================================

  if (text.includes('end of day') || text.includes('eod') ||
      text.includes('close of business') || text.includes('cob') ||
      text.includes('by end of')) {
    const baseDate = extractBaseDate(text, now);
    const eodDate = setTime(baseDate, DEFAULTS.endOfDay, 0);
    return { date: ensureFutureTime(eodDate, now), timeSource: 'userSpecified' };
  }

  // ============================================================
  // PHASE 4: Time-of-day patterns (Tier 2, with day-anchor awareness)
  // ============================================================

  if (text.includes('morning')) {
    const baseDate = extractBaseDate(text, now);
    const morningDate = setTime(baseDate, DEFAULTS.morning, 0);
    if (isDayAnchored(text) && morningDate <= now) {
      return { date: asapDate, timeSource: 'userSpecified' };
    }
    return { date: ensureFutureTime(morningDate, now), timeSource: 'defaultMorning' };
  }

  if (text.includes('afternoon')) {
    const baseDate = extractBaseDate(text, now);
    const afternoonDate = setTime(baseDate, DEFAULTS.afternoon, 0);
    if (isDayAnchored(text) && afternoonDate <= now) {
      return { date: asapDate, timeSource: 'userSpecified' };
    }
    return { date: ensureFutureTime(afternoonDate, now), timeSource: 'userSpecified' };
  }

  if (text.includes('evening') || text.includes('tonight')) {
    const baseDate = extractBaseDate(text, now);
    const eveningDate = setTime(baseDate, DEFAULTS.evening, 0);
    if (isDayAnchored(text) && eveningDate <= now) {
      return { date: asapDate, timeSource: 'defaultEvening' };
    }
    return { date: ensureFutureTime(eveningDate, now), timeSource: 'defaultEvening' };
  }

  // "night" without "tonight" (checked after evening/tonight to avoid double-match)
  if (text.includes('night') && !text.includes('tonight')) {
    const baseDate = extractBaseDate(text, now);
    const nightDate = setTime(baseDate, DEFAULTS.night, 0);
    if (isDayAnchored(text) && nightDate <= now) {
      return { date: asapDate, timeSource: 'userSpecified' };
    }
    return { date: ensureFutureTime(nightDate, now), timeSource: 'userSpecified' };
  }

  if (text.includes('noon') || text.includes('midday')) {
    const baseDate = extractBaseDate(text, now);
    const noonDate = setTime(baseDate, DEFAULTS.noon, 0);
    if (isDayAnchored(text) && noonDate <= now) {
      return { date: asapDate, timeSource: 'userSpecified' };
    }
    return { date: ensureFutureTime(noonDate, now), timeSource: 'userSpecified' };
  }

  // ============================================================
  // PHASE 5: Specific time patterns (Tier 3 — Precise)
  // ============================================================

  const time = extractTime(text, now);
  if (time) {
    const baseDate = extractBaseDate(text, now);
    const specificDate = setTime(baseDate, time.hour, time.minute);
    return { date: ensureFutureTime(specificDate, now), timeSource: 'userSpecified' };
  }

  // ============================================================
  // PHASE 6: Deferred day references (Tier 2)
  // Note: compound forms like "tomorrow morning" are caught in Phase 4.
  // ============================================================

  if (text.includes('tomorrow')) {
    const tomorrow = addDays(now, 1);
    return { date: setTime(tomorrow, DEFAULTS.general, 0), timeSource: 'defaultGeneral' };
  }

  if (text.includes('next week')) {
    const nextWeek = addDays(now, 7);
    return { date: setTime(nextWeek, DEFAULTS.general, 0), timeSource: 'defaultGeneral' };
  }

  if (text.includes('this week')) {
    const friday = thisFriday(now, DEFAULTS.general);
    if (friday === null) {
      // It's Saturday — this week's Friday is yesterday
      return { date: asapDate, timeSource: 'defaultGeneral' };
    }
    if (friday <= now) {
      return { date: asapDate, timeSource: 'defaultGeneral' };
    }
    return { date: friday, timeSource: 'defaultGeneral' };
  }

  // Weekday names
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < weekdays.length; i++) {
    if (text.includes(weekdays[i])) {
      const currentWeekday = now.getDay(); // 0=Sunday

      if (currentWeekday === i) {
        // Today IS the named weekday
        const weekdayTime = extractTime(text, now);
        if (weekdayTime) {
          const specificDate = setTime(now, weekdayTime.hour, weekdayTime.minute);
          return { date: ensureFutureTime(specificDate, now), timeSource: 'userSpecified' };
        }
        // No time specified → ASAP (user means "this [weekday]" = today)
        return { date: asapDate, timeSource: 'userSpecified' };
      }

      // Different weekday → next occurrence
      const nextDate = nextWeekday(i, now);
      if (nextDate) {
        const weekdayTime = extractTime(text, now);
        if (weekdayTime) {
          return { date: setTime(nextDate, weekdayTime.hour, weekdayTime.minute), timeSource: 'userSpecified' };
        }
        return { date: setTime(nextDate, DEFAULTS.general, 0), timeSource: 'defaultGeneral' };
      }
    }
  }

  // No pattern matched
  return { date: null, timeSource: null };
}

// ==================== Helper Functions ====================

/**
 * Extract a positive integer from text. Handles digits and word numbers.
 * Port of iOS extractNumber(from:)
 */
function extractNumber(text) {
  // Try numeric digits
  const digits = text.replace(/[^\d]/g, '');
  if (digits) {
    const n = parseInt(digits, 10);
    if (n > 0) return n;
  }

  // Word numbers
  const wordNumbers = {
    'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
    'fifteen': 15, 'twenty': 20, 'thirty': 30, 'forty five': 45,
  };

  for (const [word, number] of Object.entries(wordNumbers)) {
    if (text.includes(word)) return number;
  }

  return null;
}

/**
 * Extract hour:minute from time expressions.
 * Port of iOS extractTime(from:now:)
 */
function extractTime(text, now = new Date()) {
  // Pattern 1: X:XX am/pm or X:XX p.m.
  const colonAmPm = text.match(/(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)/i);
  if (colonAmPm) {
    let hour = parseInt(colonAmPm[1], 10);
    const minute = parseInt(colonAmPm[2], 10);
    const period = colonAmPm[3].toLowerCase();
    if (period.startsWith('p') && hour < 12) hour += 12;
    if (period.startsWith('a') && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
  }

  // Pattern 2: X am/pm or X p.m.
  const bareAmPm = text.match(/(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)/i);
  if (bareAmPm) {
    let hour = parseInt(bareAmPm[1], 10);
    const period = bareAmPm[2].toLowerCase();
    if (period.startsWith('p') && hour < 12) hour += 12;
    if (period.startsWith('a') && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23) {
      return { hour, minute: 0 };
    }
  }

  // Pattern 3: 24-hour format X:XX (no am/pm)
  const twentyFour = text.match(/(\d{1,2}):(\d{2})(?!\s*(a|p))/i);
  if (twentyFour) {
    const hour = parseInt(twentyFour[1], 10);
    const minute = parseInt(twentyFour[2], 10);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
  }

  // Pattern 4: Bare number with "at" prefix — infer AM/PM from current time
  const bareNumber = text.match(/(?:at\s+)?(\d{1,2})(?:\s*o'?clock)?/i);
  if (bareNumber) {
    const num = parseInt(bareNumber[1], 10);
    if (num >= 1 && num <= 12) {
      const currentHour = now.getHours();
      const amHour = num === 12 ? 0 : num;
      const pmHour = num === 12 ? 12 : num + 12;

      let inferredHour;
      if (currentHour < amHour) {
        inferredHour = amHour;
      } else if (currentHour < pmHour) {
        inferredHour = pmHour;
      } else {
        inferredHour = amHour; // Both passed → AM tomorrow (ensureFutureTime will roll)
      }
      return { hour: inferredHour, minute: 0 };
    }
  }

  return null;
}

/**
 * Extract the base date from compound expressions.
 * Port of iOS extractBaseDate(from:calendar:now:)
 */
function extractBaseDate(text, now) {
  if (text.includes('tomorrow')) {
    return addDays(now, 1);
  }
  if (text.includes('today') || text.includes('tonight') || text.includes('this')) {
    return now;
  }

  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < weekdays.length; i++) {
    if (text.includes(weekdays[i])) {
      return nextWeekday(i, now) || now;
    }
  }

  return now;
}

/**
 * Check if the description is explicitly pinned to this calendar day.
 * Port of iOS isDayAnchored(_:)
 */
function isDayAnchored(text) {
  if (text.includes('tonight')) return true;

  const phrases = [
    'this morning', 'this afternoon', 'this evening', 'this night', 'this noon',
    'today morning', 'today afternoon', 'today evening', 'today night', 'today noon',
  ];
  return phrases.some(p => text.includes(p));
}

/**
 * Returns this week's Friday at the given hour, or null if it's Saturday.
 * Port of iOS thisFriday(from:calendar:defaultHour:)
 */
function thisFriday(now, defaultHour) {
  const fridayWeekday = 5; // JS: 0=Sun, 5=Fri
  const currentWeekday = now.getDay();
  const daysToFriday = fridayWeekday - currentWeekday;

  if (daysToFriday < 0) {
    // It's Saturday — this week's Friday is yesterday
    return null;
  }

  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDay = addDays(startOfDay, daysToFriday);
  return setTime(targetDay, defaultHour, 0);
}

/**
 * Returns the next occurrence of the given weekday.
 * Port of iOS nextWeekday(_:from:)
 */
function nextWeekday(weekday, now) {
  const currentWeekday = now.getDay();
  let daysToAdd = weekday - currentWeekday;
  if (daysToAdd <= 0) {
    daysToAdd += 7;
  }
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return addDays(startOfDay, daysToAdd);
}

/**
 * Rolls a past time to the next day at the same time.
 * Port of iOS ensureFutureTime(_:now:calendar:)
 */
function ensureFutureTime(date, now) {
  if (date > now) return date;
  return addDays(date, 1);
}

// ==================== Date Utilities ====================

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 3_600_000);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function setTime(date, hour, minute) {
  const result = new Date(date);
  result.setHours(hour, minute, 0, 0);
  return result;
}
