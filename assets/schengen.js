// Schengen 90/180 calculator logic. Pure functions, no DOM, no network, no clock.
//
// Port of packages/residency_core/lib/src/rules/schengen.dart (the Sojournal app engine),
// spec and vectors in research/rules.md §3 and research/test-vectors.json (SCH-01..SCH-14).
// Tests: node --test 'tools/site/test/*.test.mjs'
//
// The rule: a short stay may not exceed 90 days in any 180-day period, looking at the
// 180 days that end on each day of stay. The day of entry is the first day of stay and the
// day of exit is the last (Regulation (EU) 2016/399, Schengen Borders Code, Art. 6(1)-(2),
// https://eur-lex.europa.eu/eli/reg/2016/399/oj). Planning follows the European Commission
// short-stay calculator user manual, section 6:
// https://ec.europa.eu/assets/home/visa-calculator/docs/short_stay_schengen_calculator_user_manual_en.pdf
//
// Dates are civil dates ("YYYY-MM-DD"), handled as integer day numbers since 1970-01-01 on the
// proleptic Gregorian calendar. No time zones are involved, so DST can never shift a day.

export const MAX_DAYS = 90;
export const WINDOW_DAYS = 180;

/** Pseudo-country for "somewhere in the Schengen area" (always counts). */
export const AREA = 'SCHENGEN';

// First day each state's days count, from the date it applied the Schengen acquis in full.
// Sources as in schengen.dart: Schengen Convention 1995; HR Council Decision (EU) 2022/2451;
// BG and RO Council Decision (EU) 2024/210 (31 March 2024; the land-border step on
// 1 January 2025, Decision (EU) 2024/3212, does not change counting). CY and IE never count.
const since = (iso, codes) => Object.fromEntries(codes.map((c) => [c, iso]));
export const MEMBERS_SINCE = Object.freeze({
  ...since('1995-03-26', ['BE', 'DE', 'ES', 'FR', 'LU', 'NL', 'PT']),
  IT: '1997-10-26',
  AT: '1997-12-01',
  GR: '2000-03-26',
  ...since('2001-03-25', ['DK', 'FI', 'IS', 'NO', 'SE']),
  ...since('2007-12-21', ['CZ', 'EE', 'HU', 'LT', 'LV', 'MT', 'PL', 'SI', 'SK']),
  CH: '2008-12-12',
  LI: '2011-12-19',
  HR: '2023-01-01',
  BG: '2024-03-31',
  RO: '2024-03-31',
});

/** Microstates with an open border and no checks: counted as their neighbour by default. */
export const OPEN_MICROSTATES = Object.freeze({ MC: 'FR', SM: 'IT', VA: 'IT' });

/** States that joined recently enough for "before they joined" to matter in practice. */
export const LATE_JOINERS = Object.freeze(['HR', 'BG', 'RO']);

// ---------------------------------------------------------------------------------------------
// Civil dates

const DAY_MS = 86400000;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" → day number, or null when the text is not a real calendar date. */
export function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = ISO.exec(s.trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const ms = Date.UTC(y, mo - 1, d);
  const t = new Date(ms);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return Math.round(ms / DAY_MS);
}

/** Day number → "YYYY-MM-DD". */
export function formatDate(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** The 180-day window that ends on `day`, both ends included. */
export function windowOf(day) {
  return { start: day - (WINDOW_DAYS - 1), end: day };
}

// ---------------------------------------------------------------------------------------------
// Which days count

/**
 * True when a day in `country` on `day` is inside the Schengen area.
 * `country` is an ISO 3166-1 alpha-2 code or AREA. Unknown codes (IE, CY, AD, GB, TR…) are
 * outside.
 */
export function isSchengen(country, day, { microstatesCount = true } = {}) {
  let c = String(country || AREA).toUpperCase();
  if (c === AREA) return true;
  if (microstatesCount && OPEN_MICROSTATES[c]) c = OPEN_MICROSTATES[c];
  const from = MEMBERS_SINCE[c];
  return from !== undefined && day >= parseDate(from);
}

/**
 * Validates and normalises stays.
 * Input stay: { entry: "YYYY-MM-DD", exit?: "YYYY-MM-DD" | "" | null, country?: code }.
 * A stay with no exit is ongoing: it runs to `asOf` (when given and not before entry), else
 * it is a one-day stay on the entry date.
 * Returns { stays: [{ index, entry, exit, country, ongoing }], errors: [{ index, code }] }.
 * Error codes: "entryMissing", "entryInvalid", "exitInvalid", "exitBeforeEntry".
 */
export function normaliseStays(input, { asOf = null } = {}) {
  const stays = [];
  const errors = [];
  (input || []).forEach((s, index) => {
    const rawEntry = s && s.entry;
    const rawExit = s && s.exit;
    if (!rawEntry) {
      if (rawExit) errors.push({ index, code: 'entryMissing' });
      return; // An empty row is ignored, not an error.
    }
    const entry = parseDate(rawEntry);
    if (entry === null) return void errors.push({ index, code: 'entryInvalid' });
    let exit;
    let ongoing = false;
    if (rawExit) {
      exit = parseDate(rawExit);
      if (exit === null) return void errors.push({ index, code: 'exitInvalid' });
      if (exit < entry) return void errors.push({ index, code: 'exitBeforeEntry' });
    } else {
      ongoing = true;
      exit = asOf !== null && asOf >= entry ? asOf : entry;
    }
    stays.push({ index, entry, exit, country: String((s && s.country) || AREA).toUpperCase(), ongoing });
  });
  return { stays, errors };
}

/**
 * Builds the day ledger: every counted day once (a day in two places counts once), plus the
 * days that were left out and why.
 */
export function ledger(stays, opts = {}) {
  const counted = new Map(); // day → Set(country codes)
  const preAccession = new Set();
  const outside = new Map(); // day → Set(codes) for days in non-Schengen places
  for (const s of stays) {
    for (let d = s.entry; d <= s.exit; d++) {
      if (isSchengen(s.country, d, opts)) {
        if (!counted.has(d)) counted.set(d, new Set());
        counted.get(d).add(s.country);
      } else {
        const base = (opts.microstatesCount ?? true) && OPEN_MICROSTATES[s.country] ? OPEN_MICROSTATES[s.country] : s.country;
        if (MEMBERS_SINCE[base]) preAccession.add(d);
        else {
          if (!outside.has(d)) outside.set(d, new Set());
          outside.get(d).add(s.country);
        }
      }
    }
  }
  for (const d of counted.keys()) preAccession.delete(d); // counted anyway via another stay
  const days = [...counted.keys()].sort((a, b) => a - b);
  return { days, set: counted, preAccession, outside };
}

/** Number of counted days in [from, to]. `days` is sorted. */
function countBetween(days, from, to) {
  if (to < from) return 0;
  return upperBound(days, to) - lowerBound(days, from);
}
function lowerBound(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
function upperBound(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; }
  return lo;
}

/** Groups sorted day numbers into runs of consecutive days: [{ from, to, days }]. */
export function runs(days) {
  const out = [];
  for (const d of days) {
    const last = out[out.length - 1];
    if (last && d === last.to + 1) { last.to = d; last.days++; }
    else out.push({ from: d, to: d, days: 1 });
  }
  return out;
}

/** Every counted day whose own 180-day window holds more than 90 days. */
export function overstayDays(days) {
  const out = [];
  let lo = 0;
  for (let i = 0; i < days.length; i++) {
    while (days[lo] < days[i] - (WINDOW_DAYS - 1)) lo++;
    if (i - lo + 1 > MAX_DAYS) out.push(days[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Check: the window that ends on a date

/**
 * Counts the 180-day window that ends on `asOf` (day number) and finds every overstay up to
 * that date (a past overstay stays an overstay), plus overstays in stays after it.
 */
export function check(stays, asOf, opts = {}) {
  const L = ledger(stays, opts);
  const w = windowOf(asOf);
  const used = countBetween(L.days, w.start, w.end);
  const allOver = overstayDays(L.days);
  const past = allOver.filter((d) => d <= asOf);
  const future = allOver.filter((d) => d > asOf);

  // The next date on which a counted day leaves the window: the first counted day in the
  // window, plus 180.
  const firstIn = L.days[lowerBound(L.days, w.start)];
  const nextDayFreed = firstIn !== undefined && firstIn <= w.end ? firstIn + WINDOW_DAYS : null;

  // When the person is in the area on asOf and within the limit: the last day they may stay
  // if they do not leave (days up to asOf as recorded, every day after asOf present).
  let lastAuthorisedDay = null;
  if (L.set.has(asOf) && past.length === 0) {
    lastAuthorisedDay = asOf;
    for (let n = 1; n <= MAX_DAYS; n++) {
      const day = asOf + n;
      // Recorded days up to asOf that are still in this day's window, plus n days after asOf.
      if (countBetween(L.days, windowOf(day).start, asOf) + n > MAX_DAYS) break;
      lastAuthorisedDay = day;
    }
  }

  const countries = new Set();
  for (const d of L.days) {
    if (d < w.start || d > w.end) continue;
    for (const c of L.set.get(d)) countries.add(c);
  }
  const inWindow = (d) => d >= w.start && d <= w.end;
  const preAccessionInWindow = [...L.preAccession].filter(inWindow).length;
  const outsideCodes = new Set();
  let andorra = false;
  for (const [d, codes] of L.outside) {
    if (!inWindow(d)) continue;
    for (const c of codes) { outsideCodes.add(c); if (c === 'AD') andorra = true; }
  }
  const warnings = [];
  if (preAccessionInWindow) warnings.push('preAccessionDaysIgnored');
  if (andorra) warnings.push('eesAndorraExitMayBeMissing');
  if ([...outsideCodes].some((c) => c !== 'AD')) warnings.push('nonSchengenDaysIgnored');

  return {
    asOf,
    windowStart: w.start,
    windowEnd: w.end,
    used,
    remaining: Math.max(0, MAX_DAYS - used),
    overstay: past.length > 0,
    overstayDays: past,
    overstayRuns: runs(past),
    firstOverstayDay: past.length ? past[0] : null,
    futureOverstayRuns: runs(future),
    presentOnAsOf: L.set.has(asOf),
    lastAuthorisedDay,
    nextDayFreed,
    countedJurisdictions: [...countries].sort(),
    ignoredPreAccessionDays: preAccessionInWindow,
    ignoredOutsideCodes: [...outsideCodes].sort(),
    warnings,
    perStay: stays.map((s) => ({
      index: s.index,
      entry: s.entry,
      exit: s.exit,
      country: s.country,
      ongoing: s.ongoing,
      inWindow: countStayInWindow(s, w, opts),
    })),
  };
}

function countStayInWindow(s, w, opts) {
  let n = 0;
  for (let d = Math.max(s.entry, w.start); d <= Math.min(s.exit, w.end); d++) {
    if (isSchengen(s.country, d, opts)) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// Plan: the longest stay from a planned entry date (Commission method)

/**
 * The longest continuous stay that starts on `entry` and keeps every day's window at 90 days
 * or fewer. As in the Commission calculator, recorded days before `entry` stay, and recorded
 * days from `entry` on are replaced by the planned stay.
 * Returns { entry, maxStayDays, latestExit, replacedStays }.
 */
export function plan(stays, entry, opts = {}) {
  const n = maxStayFrom(ledger(stays, opts).days, entry);
  return {
    entry,
    maxStayDays: n,
    latestExit: n === 0 ? null : entry + n - 1,
    replacedStays: stays.filter((s) => s.exit >= entry).map((s) => s.index),
  };
}

// `days` may hold days on or after `entry`; only those before it are read.
function maxStayFrom(days, entry) {
  // A continuous stay can never exceed 90 days, so 90 steps suffice.
  for (let n = 0; n < MAX_DAYS; n++) {
    const before = countBetween(days, windowOf(entry + n).start, entry - 1);
    if (before + n + 1 > MAX_DAYS) return n;
  }
  return MAX_DAYS;
}

/**
 * The first date on or after `from` on which an entry allows at least `minDays` days
 * (default 1), planned the same way as plan(). Searches `horizon` days ahead (default 366).
 * Returns { date, maxStayDays }, or null when no such date exists in the horizon (possible
 * only when the list itself holds later stays that fill the windows).
 */
export function earliestEntry(stays, from, minDays = 1, opts = {}, horizon = 366) {
  const days = ledger(stays, opts).days;
  for (let d = from; d <= from + horizon; d++) {
    const n = maxStayFrom(days, d);
    if (n >= minDays) return { date: d, maxStayDays: n };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Visa (type C) limits, on top of 90/180 (Visa Code, Regulation (EC) No 810/2009, Art. 24)

/**
 * Normalises a visa: { validFrom, validUntil, durationDays, entries: "1" | "2" | "MULT" }.
 * Returns { visa } or { error } ("visaDatesMissing", "visaUntilBeforeFrom",
 * "visaDurationInvalid"). Returns { visa: null } when nothing was entered.
 */
export function normaliseVisa(v) {
  if (!v || (!v.validFrom && !v.validUntil && !v.durationDays)) return { visa: null };
  const from = parseDate(v.validFrom || '');
  const until = parseDate(v.validUntil || '');
  if (from === null || until === null) return { error: 'visaDatesMissing' };
  if (until < from) return { error: 'visaUntilBeforeFrom' };
  const duration = Number(v.durationDays);
  if (!Number.isInteger(duration) || duration < 1 || duration > MAX_DAYS) return { error: 'visaDurationInvalid' };
  const entries = v.entries === '1' ? 1 : v.entries === '2' ? 2 : Infinity;
  return { visa: { validFrom: from, validUntil: until, durationDays: duration, maxEntries: entries } };
}

// The sticker's "duration of stay" is a separate cap only when it is below 90. A sticker
// showing 90 on a multiple-entry visa means the 90/180 rule governs (research/rules.md §3.4);
// the Commission manual's visa-holder examples (SCH-04..07) allow 170 days inside one
// 90-day multiple-entry visa because of this.
const durationCaps = (visa) => visa.durationDays < MAX_DAYS;

/** Continuous stays (runs of counted days up to asOf) that began inside the visa validity. */
function staysUnderVisa(days, visa, asOf) {
  return runs(days.filter((d) => d <= asOf)).filter((r) => r.from >= visa.validFrom && r.from <= visa.validUntil);
}

/**
 * Checks recorded stays against a visa up to `asOf`.
 * Returns { daysWithinValidity, usedUnderVisa, breaches: [{ kind, from, to, days }] } where
 * kind is "validityExpired" (days after the visa ended), "durationExceeded" (more days than
 * the sticker allows), or "tooManyEntries".
 */
export function checkVisa(stays, visa, asOf, opts = {}) {
  const L = ledger(stays, opts);
  const flagged = { validityExpired: [], durationExceeded: [], tooManyEntries: [] };
  let used = 0;
  staysUnderVisa(L.days, visa, asOf).forEach((r, i) => {
    for (let d = r.from; d <= r.to; d++) {
      if (d > visa.validUntil) { flagged.validityExpired.push(d); continue; }
      used++;
      if (durationCaps(visa) && used > visa.durationDays) flagged.durationExceeded.push(d);
      if (i >= visa.maxEntries) flagged.tooManyEntries.push(d);
    }
  });
  const breaches = [];
  for (const [kind, ds] of Object.entries(flagged)) {
    for (const r of runs(ds)) breaches.push({ kind, ...r });
  }
  breaches.sort((a, b) => a.from - b.from);
  return {
    daysWithinValidity: countBetween(L.days, visa.validFrom, visa.validUntil),
    usedUnderVisa: used,
    breaches,
  };
}

/**
 * The visa's own cap on a planned stay from `entry`: the stay must start inside the validity,
 * use an entry the visa still has, end by the "until" date and, for stickers under 90 days,
 * fit the days left on the sticker. Returns { maxStayDays, reason } where reason is null,
 * "notValidOnEntry", "noEntriesLeft", "validityEnds" or "durationLeft".
 */
export function visaPlanCap(stays, visa, entry, opts = {}) {
  if (entry < visa.validFrom || entry > visa.validUntil) return { maxStayDays: 0, reason: 'notValidOnEntry' };
  const days = ledger(stays, opts).days;
  const prior = staysUnderVisa(days, visa, entry - 1);
  // A planned entry the day after a recorded stay continues that stay, so it uses no entry.
  const continues = prior.length > 0 && prior[prior.length - 1].to === entry - 1;
  if (!continues && prior.length >= visa.maxEntries) return { maxStayDays: 0, reason: 'noEntriesLeft' };
  let cap = visa.validUntil - entry + 1;
  let reason = 'validityEnds';
  if (durationCaps(visa)) {
    const left = Math.max(0, visa.durationDays - daysUsedUnderVisa(prior, visa));
    if (left < cap) { cap = left; reason = 'durationLeft'; }
  }
  return { maxStayDays: cap, reason };
}

function daysUsedUnderVisa(stays, visa) {
  return stays.reduce((n, r) => n + Math.max(0, Math.min(r.to, visa.validUntil) - r.from + 1), 0);
}
