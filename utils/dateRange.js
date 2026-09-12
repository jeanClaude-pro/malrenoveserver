// utils/dateRange.js
//
// Single source of truth for "which UTC instants correspond to the requested
// GMT+2 business day/month/year/range" — every reporting endpoint should use
// this instead of ad-hoc `new Date(); date.setHours(0,0,0,0)` logic, which
// silently uses the Node process's local timezone (UTC on most hosts like
// Render) instead of the GMT+2 operational timezone. Africa/GMT+2 has no DST,
// so a fixed +2h offset is always correct — no timezone library needed.
const GMT2_OFFSET_HOURS = 2;

function assertValidYear(year) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`Invalid year: ${year}. Must be between 2000-2100.`);
  }
}

function assertValidMonth(month) {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid month: ${month}. Must be between 01-12.`);
  }
}

function parseYMD(dateStr, label = "date") {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || "").trim());
  if (!match) {
    throw new Error(`Invalid ${label} format: ${dateStr}. Use YYYY-MM-DD format.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  assertValidYear(year);
  assertValidMonth(month);
  if (day < 1 || day > 31) {
    throw new Error(`Invalid ${label}: ${dateStr}.`);
  }
  return { year, month, day };
}

// Returns the UTC instant of GMT+2 local midnight for the given Y/M/D.
// Date.UTC normalizes out-of-range fields, so passing hour = -2 correctly
// rolls back to 22:00 UTC the previous day.
function gmt2MidnightUTC(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day, -GMT2_OFFSET_HOURS, 0, 0, 0));
}

function dayRangeUTC(year, month, day) {
  const start = gmt2MidnightUTC(year, month - 1, day);
  const end = gmt2MidnightUTC(year, month - 1, day + 1); // exclusive
  return { start, end };
}

function monthRangeUTC(year, month) {
  const start = gmt2MidnightUTC(year, month - 1, 1);
  const end = gmt2MidnightUTC(year, month, 1); // exclusive, rolls into next year if month=12
  return { start, end };
}

function yearRangeUTC(year) {
  const start = gmt2MidnightUTC(year, 0, 1);
  const end = gmt2MidnightUTC(year + 1, 0, 1); // exclusive
  return { start, end };
}

// Current Y/M/D as seen from GMT+2, independent of the server's own timezone.
function gmt2TodayParts() {
  const shifted = new Date(Date.now() + GMT2_OFFSET_HOURS * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Build a { start, end, exclusiveEnd: true, description } range from the same
 * query-parameter shape used across the app: from/to (custom range), date
 * (specific day), year+month (specific month), year (full year), or nothing
 * (today). All boundaries are GMT+2 business-day boundaries expressed as UTC
 * instants. `end` is EXCLUSIVE — callers should filter `createdAt < end`.
 */
function getGmt2ReportRange(query = {}) {
  const { from, to, date, year, month } = query;

  if (from || to) {
    const start = from ? dayRangeUTC(...Object.values(parseYMD(from, "from"))).start : new Date(0);
    const end = to ? dayRangeUTC(...Object.values(parseYMD(to, "to"))).end : new Date();
    if (from && to && start > end) {
      throw new Error("Start date (from) must be before or equal to end date (to)");
    }
    return {
      start,
      end,
      exclusiveEnd: true,
      description: `Custom range: ${from || "Beginning"} to ${to || "Now"}`,
    };
  }

  if (date) {
    const { year: y, month: m, day: d } = parseYMD(date, "date");
    const { start, end } = dayRangeUTC(y, m, d);
    return { start, end, exclusiveEnd: true, description: `Day: ${date}` };
  }

  if (year && month) {
    const yearNum = parseInt(year, 10);
    const monthNum = parseInt(month, 10);
    assertValidYear(yearNum);
    assertValidMonth(monthNum);
    const { start, end } = monthRangeUTC(yearNum, monthNum);
    return {
      start,
      end,
      exclusiveEnd: true,
      description: `Month: ${yearNum}-${String(monthNum).padStart(2, "0")}`,
    };
  }

  if (year) {
    const yearNum = parseInt(year, 10);
    assertValidYear(yearNum);
    const { start, end } = yearRangeUTC(yearNum);
    return { start, end, exclusiveEnd: true, description: `Year: ${yearNum}` };
  }

  const today = gmt2TodayParts();
  const { start, end } = dayRangeUTC(today.year, today.month, today.day);
  return { start, end, exclusiveEnd: true, description: "Today (default, GMT+2)" };
}

module.exports = {
  GMT2_OFFSET_HOURS,
  parseYMD,
  dayRangeUTC,
  monthRangeUTC,
  yearRangeUTC,
  gmt2TodayParts,
  getGmt2ReportRange,
};
