<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ConfigImportResult } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import ConfigExportSection from "@/components/config/ConfigExportSection.vue";
import ConfigImportSection from "@/components/config/ConfigImportSection.vue";
import ConfigSnapshotsSection from "@/components/config/ConfigSnapshotsSection.vue";
import ErrorNote from "@/components/ui/ErrorNote.vue";

const { t } = useI18n({ useScope: "global" });

const result = ref<ConfigImportResult | null>(null);
const resultKind = ref<"import" | "rollback">("import");
const errorMessage = ref("");

function onError(message: string) {
  errorMessage.value = message;
}

function onImportResult(r: ConfigImportResult | null) {
  result.value = r;
  resultKind.value = "import";
}

function onRollbackResult(r: ConfigImportResult) {
  result.value = r;
  resultKind.value = "rollback";
}
</script>

<template>
  <section>
    <PageHeader :title="t('pages.config.title')" :subtitle="t('pages.config.subtitle')" />

    <!-- Stated up front, and before the buttons, because the cost of getting it
         wrong is asymmetric: an operator who believes a rollback is complete
         stops looking for what it did not restore. -->
    <section class="scope">
      <h2>{{ t("pages.config.scope.title") }}</h2>
      <dl>
        <dt>{{ t("pages.config.scope.included_label") }}</dt>
        <dd>{{ t("pages.config.scope.included") }}</dd>
        <dt>{{ t("pages.config.scope.excluded_label") }}</dt>
        <dd>{{ t("pages.config.scope.excluded") }}</dd>
      </dl>
      <p class="hint">{{ t("pages.config.scope.backup_hint") }}</p>
    </section>

    <ConfigExportSection @error="onError" />
    <ConfigImportSection @result="onImportResult" @error="onError" />
    <ConfigSnapshotsSection @result="onRollbackResult" @error="onError" />

    <ErrorNote v-if="errorMessage" :message="errorMessage" />

    <div v-if="result" class="result" :class="{ dry: result.dryRun }">
      <h3>
        {{
          result.dryRun
            ? t("pages.config.result.dry_run")
            : resultKind === "rollback"
              ? t("pages.config.result.rollback_applied")
              : t("pages.config.result.import_applied")
        }}
      </h3>
      <ul>
        <li>{{ t("pages.config.result.bundles", { count: result.applied.bundles }) }}</li>
        <li>{{ t("pages.config.result.alert_rules", { count: result.applied.alertRules }) }}</li>
        <li>{{ t("pages.config.result.clients_configured", { count: result.applied.clientsConfigured }) }}</li>
        <li>{{ t("pages.config.result.tools_configured", { count: result.applied.toolsConfigured }) }}</li>
        <li>{{ t("pages.config.result.guardrails", { count: result.applied.guardrails }) }}</li>
        <li>{{ t("pages.config.result.consumers", { count: result.applied.consumers }) }}</li>
      </ul>
      <div v-if="result.skipped.length" class="skipped">
        <strong>{{ t("pages.config.result.skipped_heading", { count: result.skipped.length }) }}</strong>
        <ul>
          <li v-for="s in result.skipped" :key="`${s.type}:${s.id}`">
            {{ s.type }} <code>{{ s.id }}</code> — {{ s.reason }}
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
:deep(.subtitle) {
  max-width: 40rem;
}
/* Reads as a note, not as another action card: no surface/shadow, so it does
   not compete with the three .config-block sections below it. */
.scope {
  border-left: 3px solid var(--border-strong);
  padding: 0.25rem 0 0.25rem 1rem;
  margin: 1.25rem 0;
  max-width: 46rem;
}
.scope h2 {
  margin: 0 0 0.5rem;
  font-size: var(--text-sm);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}
.scope dl {
  margin: 0;
  display: grid;
  gap: 0.35rem 0.75rem;
  font-size: 0.85rem;
}
.scope dt {
  font-weight: 700;
}
.scope dd {
  margin: 0 0 0.4rem;
  color: var(--text-secondary);
}
.scope .hint {
  margin: 0.6rem 0 0;
  font-size: 0.85rem;
}
.result {
  border-radius: var(--radius-md);
  padding: 1rem 1.25rem;
  background: var(--ok-soft);
  border: 1px solid var(--ok);
}
.result.dry {
  background: var(--signal-soft);
  border-color: var(--signal);
}
.result h3 {
  margin-top: 0;
}
.skipped {
  margin-top: 0.75rem;
  font-size: 0.85rem;
}
</style>

<style>
/* Unscoped on purpose: these style the `.config-block` sections rendered by the
   child components (ConfigExportSection / ConfigImportSection /
   ConfigSnapshotsSection), each under its own scoped-style hash, so a `scoped`
   block here could not reach them (same pattern as ConfigSection.vue). Renamed
   from the generic `.block` to `.config-block` so the unscoped rules can't
   collide app-wide with any other component. */
.config-block {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: 1.25rem;
  margin: 1.25rem 0;
}
.config-block h2 {
  margin-top: 0;
  font-size: 1.05rem;
}
.config-block .hint {
  color: var(--text-secondary);
  font-size: 0.85rem;
  max-width: 40rem;
}
.config-block > label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin: 0.5rem 0 0.35rem;
}
.config-block textarea {
  width: 100%;
  box-sizing: border-box;
  font-family: var(--font-mono);
  font-size: 0.82rem;
  padding: 0.6rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
}
.config-block .actions {
  display: flex;
  gap: 0.75rem;
  margin-top: 0.75rem;
  align-items: center;
}
.config-block .actions label {
  font-size: 0.85rem;
  font-weight: 600;
}
.config-block .label-input {
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-family: var(--font-body);
  min-width: 16.25rem;
}
.config-block .format-field {
  max-width: 12rem;
}
.config-block .row-actions {
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.config-block .diff {
  margin-top: 1rem;
}
.config-block .diff tr.added td {
  background: var(--ok-soft);
}
.config-block .diff tr.removed td {
  background: var(--breach-soft);
}
.config-block .diff tr.changed td {
  background: var(--canary-soft);
}
</style>
