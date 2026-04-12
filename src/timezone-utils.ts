/** IANA time zone used for displaying dates/times and calendar windows (COROS APIs use YYYYMMDD). */

let cachedTimeZone: string | null = null;

function isValidIanaTimeZone(id: string): boolean {
  const t = id.trim();
  if (!t) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: t }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves display calendar zone: COROS_TIMEZONE → TZ (if valid IANA) → system default from Intl.
 */
export function getCorosTimeZone(): string {
  if (cachedTimeZone) return cachedTimeZone;

  const fromEnv = process.env.COROS_TIMEZONE?.trim();
  if (fromEnv && isValidIanaTimeZone(fromEnv)) {
    cachedTimeZone = fromEnv;
    return cachedTimeZone;
  }

  const fromTz = process.env.TZ?.trim();
  if (fromTz && isValidIanaTimeZone(fromTz)) {
    cachedTimeZone = fromTz;
    return cachedTimeZone;
  }

  cachedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return cachedTimeZone;
}

/** Test helper: clear memoized zone after mutating env. */
export function resetCorosTimeZoneCache(): void {
  cachedTimeZone = null;
}

export function formatDatePtBr(epochSeconds: number, timeZone: string): string {
  return new Date(epochSeconds * 1000).toLocaleDateString("pt-BR", { timeZone });
}

export function formatTimePtBr(epochSeconds: number, timeZone: string): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString("pt-BR", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Calendar YYYYMMDD for `instant` in `timeZone`. */
export function ymdInZone(instant: Date, timeZone: string): string {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
  return s.replace(/-/g, "");
}

/** Pure calendar arithmetic on YYYYMMDD (no DST; safe for API day ranges). */
export function shiftYmdCalendar(ymd: string, deltaDays: number): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/** Monday (UTC calendar) of the week containing this YYYYMMDD — stable for grouping COROS happenDay. */
export function weekMondayYmdFromYmd(ymd: string): string {
  const padded = ymd.length === 8 ? ymd : ymd.padStart(8, "0");
  const y = Number(padded.slice(0, 4));
  const m = Number(padded.slice(4, 6));
  const d = Number(padded.slice(6, 8));
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return shiftYmdCalendar(padded, -((wd + 6) % 7));
}
