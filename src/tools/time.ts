const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Local wall-clock parts of an instant in a time zone. */
export function partsInZone(ts: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
  const p: Record<string, string> = {};
  for (const { type, value } of f.formatToParts(new Date(ts))) p[type] = value;
  return {
    weekday: p.weekday,
    dow: WEEKDAYS.indexOf(p.weekday),
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute)
  };
}

/** UTC epoch (ms) for a local wall-clock time in `tz`. */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = partsInZone(guess, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = asUtc - target;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

/** Next occurrence (ms) of specs like ["Wed 18:00", "Fri 12:00"] in `tz`, strictly after `now`. */
export function nextDelivery(specs: string[], tz: string, now = Date.now()): number | null {
  let best: number | null = null;
  for (const spec of specs) {
    const m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(\d{1,2}):(\d{2})$/i.exec(spec.trim());
    if (!m) continue;
    const wantDow = WEEKDAYS.findIndex((w) => w.toLowerCase() === m[1].toLowerCase());
    const hh = Number(m[2]);
    const mm = Number(m[3]);
    for (let offset = 0; offset <= 7; offset++) {
      const p = partsInZone(now + offset * 86_400_000, tz);
      if (p.dow !== wantDow) continue;
      const t = zonedToUtc(p.year, p.month, p.day, hh, mm, tz);
      if (t > now && (best === null || t < best)) best = t;
    }
  }
  return best;
}

export function fmtInZone(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(ts));
}

/** ISO date (YYYY-MM-DD) of the coming Saturday and Sunday in `tz`, plus the following weekend. */
export function upcomingWeekends(tz: string, now = Date.now()): { thisSat: string; thisSun: string; nextSat: string; nextSun: string } {
  const p = partsInZone(now, tz);
  const daysToSat = (6 - p.dow + 7) % 7;
  const iso = (offsetDays: number) => {
    const q = partsInZone(now + offsetDays * 86_400_000, tz);
    return `${q.year}-${String(q.month).padStart(2, "0")}-${String(q.day).padStart(2, "0")}`;
  };
  return { thisSat: iso(daysToSat), thisSun: iso(daysToSat + 1), nextSat: iso(daysToSat + 7), nextSun: iso(daysToSat + 8) };
}
