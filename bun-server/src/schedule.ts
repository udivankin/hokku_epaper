// Refresh schedule, matching python/hokku/webserver/time_utils.py.

// A slot less than this far ahead counts as the current one, so a screen that
// wakes slightly early is sent to the following slot rather than back to sleep for seconds.
const EARLY_WAKE_GRACE_S = 60;

/** Parse "0600,1200,1800" into sorted [hour, minute] pairs. */
export function parseTimes(spec: string): [number, number][] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const t = s.padStart(4, "0");
      const h = Number(t.slice(0, 2));
      const m = Number(t.slice(2, 4));
      if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) throw new Error(`bad refresh time ${s}`);
      return [h, m] as [number, number];
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** The next refresh slot (local time zone, TZ env respected). */
export function nextSlot(times: [number, number][], now = new Date()): Date {
  if (!times.length) return new Date(now.getTime() + 6 * 3600_000);
  const earliest = now.getTime() + EARLY_WAKE_GRACE_S * 1000;
  for (let day = 0; day < 3; day++) {
    for (const [h, m] of times) {
      const c = new Date(now);
      c.setDate(now.getDate() + day);
      c.setHours(h, m, 0, 0);
      if (c.getTime() > earliest) return c;
    }
  }
  throw new Error("unreachable: a configured slot always recurs within 2 days");
}

export function secondsUntil(d: Date, now = new Date()): number {
  return Math.max(1, Math.floor((d.getTime() - now.getTime()) / 1000));
}
