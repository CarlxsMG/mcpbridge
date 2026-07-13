/**
 * Cron helpers for schedules — plain functions, no "use" prefix (same
 * precedent as utils/connectTemplates.ts and utils/fieldParsing.ts).
 *
 * `describeCron` translates the 5-field expressions NewSchedulePage.vue's
 * builder can produce (plus the handful of hand-authored patterns already
 * saved before that builder existed) into a localized sentence (via `tk()`
 * from `@/i18n` — see `utils.cron.*` in locales/en.json + es.json), for
 * people who don't read cron. Anything more exotic than that falls back to
 * the raw expression — still correct, just not translated.
 */

import { tk } from "@/i18n";

const WEEKDAY_FULL_KEYS: Record<number, string> = {
  0: "utils.cron.weekdays.sunday",
  1: "utils.cron.weekdays.monday",
  2: "utils.cron.weekdays.tuesday",
  3: "utils.cron.weekdays.wednesday",
  4: "utils.cron.weekdays.thursday",
  5: "utils.cron.weekdays.friday",
  6: "utils.cron.weekdays.saturday",
};

function weekdayName(value: number): string | undefined {
  const key = WEEKDAY_FULL_KEYS[value];
  return key ? tk(key) : undefined;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "3:05 PM" style, matching the <input type="time"> the builder uses. */
export function formatTimeOfDay(hour: number, minute: number): string {
  const period = hour < 12 ? tk("utils.cron.am") : tk("utils.cron.pm");
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return tk("utils.cron.time_of_day", { hour: h12, minute: pad(minute), period });
}

function asInt(v: string): number | null {
  return /^\d+$/.test(v) ? Number(v) : null;
}

/** Selects the `one`/`other` sub-key for a simple two-form plural message. */
function pluralForm(n: number): "one" | "other" {
  return n === 1 ? "one" : "other";
}

export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const isWild = (v: string) => v === "*";

  if ([minute, hour, dayOfMonth, month, dayOfWeek].every(isWild)) {
    return tk("utils.cron.every_minute");
  }

  const everyNMinutes = minute.match(/^\*\/(\d+)$/);
  if (everyNMinutes && isWild(hour) && isWild(dayOfMonth) && isWild(month) && isWild(dayOfWeek)) {
    const n = Number(everyNMinutes[1]);
    return tk(`utils.cron.every_n_minutes.${pluralForm(n)}`, { n });
  }

  const min = asInt(minute);
  const hr = asInt(hour);

  const everyNHours = hour.match(/^\*\/(\d+)$/);
  if (min !== null && everyNHours && isWild(dayOfMonth) && isWild(month) && isWild(dayOfWeek)) {
    const n = Number(everyNHours[1]);
    return tk(`utils.cron.every_n_hours_at_minute.${pluralForm(n)}`, { n, min });
  }

  if (min !== null && hr !== null && isWild(dayOfMonth) && isWild(month)) {
    const time = formatTimeOfDay(hr, min);
    if (isWild(dayOfWeek)) {
      return tk("utils.cron.every_day_at", { time });
    }
    if (dayOfWeek === "1-5") {
      return tk("utils.cron.every_weekday_at", { time });
    }
    const rangeMatch = dayOfWeek.match(/^(\d)-(\d)$/);
    if (rangeMatch) {
      const from = weekdayName(Number(rangeMatch[1]) % 7);
      const to = weekdayName(Number(rangeMatch[2]) % 7);
      if (from && to) {
        return tk("utils.cron.every_day_range_at", { from, to, time });
      }
    }
    const days = dayOfWeek
      .split(",")
      .map((d) => weekdayName(Number(d) % 7))
      .filter((d): d is string => Boolean(d));
    if (days.length) {
      return tk("utils.cron.every_days_at", { days: days.join(", "), time });
    }
  }

  if (min !== null && hr !== null && !isWild(dayOfMonth) && isWild(month) && isWild(dayOfWeek)) {
    const dom = asInt(dayOfMonth);
    if (dom !== null) {
      return tk("utils.cron.on_day_of_month_at", { dom, time: formatTimeOfDay(hr, min) });
    }
  }

  return cron;
}
