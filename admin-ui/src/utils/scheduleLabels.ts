/**
 * Label lookups for Schedule enum fields — the "client"/"tool" target type
 * and "enable"/"disable" action values stored on `Schedule` (see
 * `types/api.ts`). Shared between NewSchedulePage.vue's SelectMenu options
 * and SchedulesPage.vue's list table so both views render the same
 * localized text for the same raw backend value instead of the list view
 * falling back to the raw enum string (see `pages.schedules.new.target_types.*`
 * / `.actions.*` in locales/en.json + es.json).
 *
 * Uses `tk()` (see `@/i18n`) rather than the component-scoped `t()` so it can
 * be called directly from a table-row template expression, same precedent as
 * `utils/cron.ts`'s `describeCron`.
 */

import { tk } from "@/i18n";
import type { Schedule } from "@/types/api";

export function targetTypeLabel(value: Schedule["targetType"]): string {
  return tk(`pages.schedules.new.target_types.${value}`);
}

export function scheduleActionLabel(value: Schedule["action"]): string {
  return tk(`pages.schedules.new.actions.${value}`);
}
