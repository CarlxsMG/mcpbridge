/**
 * Cron helpers for schedules — plain functions, no "use" prefix (same
 * precedent as utils/connectTemplates.ts and utils/fieldParsing.ts).
 *
 * `describeCron` translates the 5-field expressions NewSchedulePage.vue's
 * builder can produce (plus the handful of hand-authored patterns already
 * saved before that builder existed) into a plain-English sentence, for
 * people who don't read cron. Anything more exotic than that falls back to
 * the raw expression — still correct, just not translated.
 */

export const WEEKDAY_OPTIONS = [
  { value: 0, label: "Sun", full: "Sunday" },
  { value: 1, label: "Mon", full: "Monday" },
  { value: 2, label: "Tue", full: "Tuesday" },
  { value: 3, label: "Wed", full: "Wednesday" },
  { value: 4, label: "Thu", full: "Thursday" },
  { value: 5, label: "Fri", full: "Friday" },
  { value: 6, label: "Sat", full: "Saturday" },
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "3:05 PM" style, matching the <input type="time"> the builder uses. */
export function formatTimeOfDay(hour: number, minute: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${pad(minute)} ${period} UTC`;
}

function asInt(v: string): number | null {
  return /^\d+$/.test(v) ? Number(v) : null;
}

export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const isWild = (v: string) => v === "*";

  if ([minute, hour, dayOfMonth, month, dayOfWeek].every(isWild)) {
    return "Every minute";
  }

  const everyNMinutes = minute.match(/^\*\/(\d+)$/);
  if (everyNMinutes && isWild(hour) && isWild(dayOfMonth) && isWild(month) && isWild(dayOfWeek)) {
    const n = Number(everyNMinutes[1]);
    return `Every ${n} minute${n === 1 ? "" : "s"}`;
  }

  const min = asInt(minute);
  const hr = asInt(hour);

  const everyNHours = hour.match(/^\*\/(\d+)$/);
  if (min !== null && everyNHours && isWild(dayOfMonth) && isWild(month) && isWild(dayOfWeek)) {
    const n = Number(everyNHours[1]);
    return `Every ${n} hour${n === 1 ? "" : "s"}, at minute ${min}`;
  }

  if (min !== null && hr !== null && isWild(dayOfMonth) && isWild(month)) {
    const time = formatTimeOfDay(hr, min);
    if (isWild(dayOfWeek)) {
      return `Every day at ${time}`;
    }
    if (dayOfWeek === "1-5") {
      return `Every weekday at ${time}`;
    }
    const rangeMatch = dayOfWeek.match(/^(\d)-(\d)$/);
    if (rangeMatch) {
      const from = WEEKDAY_OPTIONS.find((w) => w.value === Number(rangeMatch[1]) % 7)?.full;
      const to = WEEKDAY_OPTIONS.find((w) => w.value === Number(rangeMatch[2]) % 7)?.full;
      if (from && to) {
        return `Every day from ${from} to ${to} at ${time}`;
      }
    }
    const days = dayOfWeek
      .split(",")
      .map((d) => WEEKDAY_OPTIONS.find((w) => w.value === Number(d) % 7)?.full)
      .filter((d): d is string => Boolean(d));
    if (days.length) {
      return `Every ${days.join(", ")} at ${time}`;
    }
  }

  if (min !== null && hr !== null && !isWild(dayOfMonth) && isWild(month) && isWild(dayOfWeek)) {
    const dom = asInt(dayOfMonth);
    if (dom !== null) {
      return `On day ${dom} of the month at ${formatTimeOfDay(hr, min)}`;
    }
  }

  return cron;
}
