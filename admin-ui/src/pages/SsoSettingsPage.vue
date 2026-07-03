<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { OidcSettings } from "../types/api";
import { Fingerprint } from "lucide-vue-next";

const settings = ref<OidcSettings | null>(null);
const loading = ref(true);
const loadError = ref("");

const issuer = ref("");
const clientId = ref("");
const clientSecret = ref(""); // write-only — never repopulated from a previous save
const redirectUri = ref("");
const scopes = ref("openid profile email");
const enabled = ref(false);

const saving = ref(false);
const saveError = ref("");
const saved = ref(false);

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
    loadError.value = err instanceof ApiError ? err.message : "Failed to load SSO settings.";
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function save() {
  saveError.value = "";
  saved.value = false;
  if (!issuer.value.trim() || !clientId.value.trim() || !redirectUri.value.trim()) {
    saveError.value = "Issuer, client ID, and redirect URI are required.";
    return;
  }
  // The backend never keeps the previous secret on a partial update (same
  // write-only-secret convention as the per-tool context-budget LLM key) —
  // every save, including one that only flips "enabled" or edits scopes,
  // must resupply the raw client secret.
  if (!clientSecret.value.trim()) {
    saveError.value = settings.value
      ? "Re-enter the client secret to save changes — it's never stored in a way this page can read back."
      : "Client secret is required.";
    return;
  }
  saving.value = true;
  try {
    await api.put("/admin-api/auth/oidc/settings", {
      issuer: issuer.value.trim(),
      clientId: clientId.value.trim(),
      clientSecret: clientSecret.value,
      redirectUri: redirectUri.value.trim(),
      scopes: scopes.value.trim() || "openid profile email",
      enabled: enabled.value,
    });
    saved.value = true;
    await load();
  } catch (err) {
    saveError.value = err instanceof ApiError ? err.message : "Failed to save SSO settings.";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="page">
    <header class="page-header">
      <div>
        <h1><Fingerprint :size="20" stroke-width="2" aria-hidden="true" /> Single sign-on (OIDC)</h1>
        <p class="subtitle">
          Let admins sign in through an external identity provider (Okta, Azure AD, Google Workspace, Auth0, or any
          OIDC-compliant IdP) via Authorization Code + PKCE, instead of — or alongside — the built-in username/password
          login. SAML is not supported.
        </p>
      </div>
    </header>

    <p v-if="loadError" class="error" role="alert">{{ loadError }}</p>

    <form v-if="!loading" class="settings-form" @submit.prevent="save">
      <div class="field">
        <label for="sso-issuer">Issuer URL</label>
        <input
          id="sso-issuer"
          v-model="issuer"
          type="url"
          placeholder="https://your-tenant.okta.com"
          autocomplete="off"
          required
        />
        <p class="hint">
          The bridge fetches <code>{issuer}/.well-known/openid-configuration</code> — no need to enter individual
          endpoints.
        </p>
      </div>

      <div class="field">
        <label for="sso-client-id">Client ID</label>
        <input id="sso-client-id" v-model="clientId" type="text" autocomplete="off" required />
      </div>

      <div class="field">
        <label for="sso-client-secret">Client secret</label>
        <input
          id="sso-client-secret"
          v-model="clientSecret"
          type="password"
          autocomplete="off"
          :placeholder="settings ? 'Configured — required again every time you save' : ''"
        />
        <p class="hint">
          Write-only: stored encrypted at rest and never shown again once saved — re-enter it on every save, even one
          that only changes another field below.
        </p>
      </div>

      <div class="field">
        <label for="sso-redirect-uri">Redirect URI</label>
        <input
          id="sso-redirect-uri"
          v-model="redirectUri"
          type="url"
          placeholder="https://bridge.example.com/admin-api/auth/oidc/callback"
          autocomplete="off"
          required
        />
        <p class="hint">Must exactly match a redirect URI registered with the identity provider.</p>
      </div>

      <div class="field">
        <label for="sso-scopes">Scopes</label>
        <input id="sso-scopes" v-model="scopes" type="text" placeholder="openid profile email" autocomplete="off" />
        <p class="hint">Must include <code>openid</code>.</p>
      </div>

      <div class="field">
        <span class="field-label">New SSO users are provisioned as</span>
        <p class="hint">
          <strong>viewer</strong> — always, regardless of any other setting. An existing admin must manually promote a
          new SSO user from the <RouterLink to="/users">Users</RouterLink> page after reviewing them.
        </p>
      </div>

      <label class="inline-check">
        <input v-model="enabled" type="checkbox" />
        Enable SSO login (shows a "Sign in with SSO" button on the login page)
      </label>

      <p v-if="saveError" class="error" role="alert">{{ saveError }}</p>
      <p v-if="saved" class="success" role="status">SSO settings saved.</p>

      <button type="submit" class="btn-primary" :disabled="saving">
        {{ saving ? "Saving…" : "Save SSO settings" }}
      </button>
    </form>
  </section>
</template>

<style scoped>
.page {
  max-width: 40rem;
}
.page-header {
  margin-bottom: 1.25rem;
}
.page-header h1 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 0.2rem;
}
.subtitle {
  color: var(--text-secondary);
  margin: 0;
  font-size: 0.9rem;
}
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
.field label,
.field-label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
}
.field input {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-family: var(--font-body);
  box-sizing: border-box;
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
