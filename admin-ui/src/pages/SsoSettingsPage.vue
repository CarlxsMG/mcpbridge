<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { toErrorMessage } from "@/utils/errors";
import { usePatchResource } from "@/composables/usePatchResource";
import type { OidcSettings } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";
import SignalLoader from "@/components/ui/SignalLoader.vue";
import { tk } from "@/i18n";

const { t } = useI18n({ useScope: "global" });

const settings = ref<OidcSettings | null>(null);
const loading = ref(true);
const loadError = ref("");

const issuer = ref("");
const clientId = ref("");
const clientSecret = ref(""); // write-only — never repopulated from a previous save
const redirectUri = ref("");
const scopes = ref("openid profile email");
const enabled = ref(false);

const saved = ref(false);
const { saving, error: saveError, run } = usePatchResource(() => "/admin-api/auth/oidc/settings");

function applySettings(s: OidcSettings | null) {
  settings.value = s;
  issuer.value = s?.issuer ?? "";
  clientId.value = s?.clientId ?? "";
  clientSecret.value = ""; // never repopulated from a previous save
  redirectUri.value = s?.redirectUri ?? "";
  scopes.value = s?.scopes ?? "openid profile email";
  enabled.value = s?.enabled ?? false;
}

async function load() {
  loading.value = true;
  loadError.value = "";
  try {
    const res = await api.get<{ settings: OidcSettings | null }>("/admin-api/auth/oidc/settings");
    applySettings(res.settings);
  } catch (err) {
    loadError.value = toErrorMessage(err, tk("pages.sso_settings.errors.load_failed"));
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function save() {
  saveError.value = "";
  saved.value = false;
  if (!issuer.value.trim() || !clientId.value.trim() || !redirectUri.value.trim()) {
    saveError.value = t("pages.sso_settings.errors.required_fields");
    return;
  }
  // The backend never keeps the previous secret on a partial update (same
  // write-only-secret convention as the per-tool context-budget LLM key) —
  // every save, including one that only flips "enabled" or edits scopes,
  // must resupply the raw client secret.
  if (!clientSecret.value.trim()) {
    saveError.value = settings.value
      ? t("pages.sso_settings.errors.secret_required_for_update")
      : t("pages.sso_settings.errors.secret_required");
    return;
  }
  const ok = await run(
    (path) =>
      api.put(path, {
        issuer: issuer.value.trim(),
        clientId: clientId.value.trim(),
        clientSecret: clientSecret.value,
        redirectUri: redirectUri.value.trim(),
        scopes: scopes.value.trim() || "openid profile email",
        enabled: enabled.value,
      }),
    tk("pages.sso_settings.errors.save_failed"),
  );
  if (ok) {
    saved.value = true;
    await load();
  }
}
</script>

<template>
  <section>
    <FormPage max-width="34rem">
      <PageHeader :title="t('pages.sso_settings.title')" :subtitle="t('pages.sso_settings.subtitle')" />

      <p v-if="loadError" class="error" role="alert">{{ loadError }}</p>

      <SignalLoader v-if="loading" />
      <form v-else class="settings-form" @submit.prevent="save">
        <FormField :label="t('pages.sso_settings.fields.issuer')" for="sso-issuer">
          <input
            id="sso-issuer"
            v-model="issuer"
            type="url"
            placeholder="https://your-tenant.okta.com"
            autocomplete="off"
            required
          />
          <p class="hint">
            {{ t("pages.sso_settings.hints.issuer_p1") }}
            <code>{{ issuer }}/.well-known/openid-configuration</code>
            {{ t("pages.sso_settings.hints.issuer_p2") }}
          </p>
        </FormField>

        <FormField :label="t('pages.sso_settings.fields.client_id')" for="sso-client-id">
          <input id="sso-client-id" v-model="clientId" type="text" autocomplete="off" required />
        </FormField>

        <FormField :label="t('pages.sso_settings.fields.client_secret')" for="sso-client-secret">
          <input
            id="sso-client-secret"
            v-model="clientSecret"
            type="password"
            autocomplete="off"
            :placeholder="settings ? t('pages.sso_settings.placeholders.secret_configured') : ''"
          />
          <p class="hint">
            {{ t("pages.sso_settings.hints.client_secret") }}
          </p>
        </FormField>

        <FormField :label="t('pages.sso_settings.fields.redirect_uri')" for="sso-redirect-uri">
          <input
            id="sso-redirect-uri"
            v-model="redirectUri"
            type="url"
            placeholder="https://bridge.example.com/admin-api/auth/oidc/callback"
            autocomplete="off"
            required
          />
          <p class="hint">{{ t("pages.sso_settings.hints.redirect_uri") }}</p>
        </FormField>

        <FormField :label="t('pages.sso_settings.fields.scopes')" for="sso-scopes">
          <input id="sso-scopes" v-model="scopes" type="text" placeholder="openid profile email" autocomplete="off" />
          <p class="hint">
            {{ t("pages.sso_settings.hints.scopes_p1") }} <code>openid</code
            >{{ t("pages.sso_settings.hints.scopes_p2") }}
          </p>
        </FormField>

        <div class="field">
          <span class="field-label">{{ t("pages.sso_settings.provisioning.label") }}</span>
          <p class="hint">
            <strong>{{ t("pages.sso_settings.provisioning.role") }}</strong>
            {{ t("pages.sso_settings.provisioning.p1") }}
            <RouterLink to="/users">{{ t("nav.users.label") }}</RouterLink>
            {{ t("pages.sso_settings.provisioning.p2") }}
          </p>
        </div>

        <label class="inline-check">
          <input v-model="enabled" type="checkbox" />
          {{ t("pages.sso_settings.enable_label") }}
        </label>

        <p v-if="saveError" class="error" role="alert">{{ saveError }}</p>
        <p v-if="saved" class="success" role="status">{{ t("pages.sso_settings.saved") }}</p>

        <button type="submit" class="btn-primary" :disabled="saving">
          {{ saving ? t("common.saving") : t("pages.sso_settings.save") }}
        </button>
      </form>
    </FormPage>
  </section>
</template>

<style scoped>
.settings-form {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}
.field-label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
}
:deep(.settings-form .field) {
  margin-bottom: 0;
}
.hint {
  color: var(--text-secondary);
  font-size: 0.8rem;
  margin: 0.35rem 0 0;
}
.inline-check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  font-weight: 500;
}
.error {
  color: var(--breach);
  font-size: 0.85rem;
  margin: 0;
}
.success {
  color: var(--ok);
  font-size: 0.85rem;
  margin: 0;
}
</style>
