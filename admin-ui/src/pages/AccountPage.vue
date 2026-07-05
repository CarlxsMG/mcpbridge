<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useAuth } from "@/composables/useAuth";
import { useTheme } from "@/composables/useTheme";
import { useDensity } from "@/composables/useDensity";
import { i18n } from "../i18n";
import { toErrorMessage } from "@/utils/errors";
import { formatDateTime } from "@/utils/format";
import type { AdminSession } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import FormField from "@/components/ui/FormField.vue";
import { Lock, Monitor, LogOut, SlidersHorizontal, Languages } from "lucide-vue-next";
import { useLocale } from "@/composables/useLocale";

const { t } = useI18n({ useScope: "global" });
const tk = (k: string) => (i18n.global.t as (key: string) => string)(k);

const { state: authState } = useAuth();
const { theme, setTheme } = useTheme();
const { density, setDensity } = useDensity();
const { locale, locales, setLocale } = useLocale();

const currentPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const passwordError = ref("");
const passwordSuccess = ref("");
const changingPassword = ref(false);

function resetPasswordForm() {
  currentPassword.value = "";
  newPassword.value = "";
  confirmPassword.value = "";
}

async function changePassword() {
  passwordError.value = "";
  passwordSuccess.value = "";

  if (!currentPassword.value || !newPassword.value || !confirmPassword.value) {
    passwordError.value = t("pages.account.errors.all_required");
    return;
  }
  if (newPassword.value.length < 12) {
    passwordError.value = t("pages.account.errors.password_too_short");
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    passwordError.value = t("pages.account.errors.password_mismatch");
    return;
  }

  changingPassword.value = true;
  try {
    await api.patch("/admin-api/auth/me/password", {
      current_password: currentPassword.value,
      new_password: newPassword.value,
    });
    resetPasswordForm();
    passwordSuccess.value = t("pages.account.success.password_changed");
    await loadSessions();
  } catch (err) {
    passwordError.value = toErrorMessage(err, tk("pages.account.errors.password_change_failed"));
  } finally {
    changingPassword.value = false;
  }
}

const sessionsLoadError = tk("pages.account.errors.sessions_load_failed");
const revokeErrorFallback = tk("pages.account.errors.session_revoke_failed");

const {
  data: sessions,
  loading: sessionsLoading,
  errorMessage: sessionsError,
  load: loadSessions,
} = useResource<AdminSession[]>(
  async () => (await api.get<{ sessions: AdminSession[] }>("/admin-api/auth/sessions")).sessions,
  [],
  sessionsLoadError,
);

const {
  pending: pendingRevoke,
  request: requestRevokeAction,
  cancel: cancelRevoke,
  confirm: confirmRevokeAction,
} = useConfirmAction<AdminSession>();
const revokeError = ref("");

function requestRevoke(session: AdminSession) {
  revokeError.value = "";
  requestRevokeAction(session);
}

async function confirmRevoke() {
  await confirmRevokeAction(async (session) => {
    try {
      await api.delete(`/admin-api/auth/sessions/${session.id}`);
      await loadSessions();
    } catch (err) {
      revokeError.value = toErrorMessage(err, revokeErrorFallback);
    }
  });
}

function describeUserAgent(ua: string | null): string {
  if (!ua) return t("pages.account.device.unknown_browser");

  let browser = t("pages.account.device.unknown_browser");
  if (/Edg\//.test(ua)) browser = t("pages.account.device.edge");
  else if (/OPR\//.test(ua)) browser = t("pages.account.device.opera");
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = t("pages.account.device.chrome");
  else if (/Firefox\//.test(ua)) browser = t("pages.account.device.firefox");
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = t("pages.account.device.safari");
  else if (/curl\//.test(ua)) browser = t("pages.account.device.curl");

  let os = "";
  if (/Windows/.test(ua)) os = t("pages.account.device.os.windows");
  else if (/Mac OS X/.test(ua)) os = t("pages.account.device.os.macos");
  else if (/Android/.test(ua)) os = t("pages.account.device.os.android");
  else if (/iPhone|iPad/.test(ua)) os = t("pages.account.device.os.ios");
  else if (/Linux/.test(ua)) os = t("pages.account.device.os.linux");

  const onFmt = os ? t("pages.account.device.on", { browser, os }) : browser;
  return onFmt;
}

onMounted(loadSessions);
</script>

<template>
  <section>
    <PageHeader
      :title="t('pages.account.title')"
      :subtitle="t('pages.account.subtitle', { username: authState.user?.username ?? '' })"
    />

    <div class="account-section">
      <h2><Lock :size="16" stroke-width="2" aria-hidden="true" /> {{ t('pages.account.change_password') }}</h2>
      <p class="hint warn">{{ t('pages.account.change_password_warning') }}</p>
      <form class="password-form" @submit.prevent="changePassword">
        <FormField :label="t('pages.account.password_current')" for="acc-current-password">
          <input
            id="acc-current-password"
            v-model="currentPassword"
            type="password"
            autocomplete="current-password"
            required
          />
        </FormField>
        <FormField :label="t('pages.account.password_new')" for="acc-new-password">
          <input id="acc-new-password" v-model="newPassword" type="password" autocomplete="new-password" required />
          <p class="hint">{{ t('pages.account.password_min_hint') }}</p>
        </FormField>
        <FormField :label="t('pages.account.password_confirm')" for="acc-confirm-password">
          <input
            id="acc-confirm-password"
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            required
          />
        </FormField>
        <p v-if="passwordError" class="error" role="alert">{{ passwordError }}</p>
        <p v-if="passwordSuccess" class="success" role="status">{{ passwordSuccess }}</p>
        <button type="submit" class="btn-primary" :disabled="changingPassword">
          {{ changingPassword ? t('pages.account.changing') : t('pages.account.change_password_cta') }}
        </button>
      </form>
    </div>

    <div class="account-section">
      <h2><Monitor :size="16" stroke-width="2" aria-hidden="true" /> {{ t('pages.account.active_sessions') }}</h2>
      <p class="subtitle">{{ t('pages.account.active_sessions_subtitle') }}</p>
      <p class="hint warn">{{ t('pages.account.active_sessions_hint') }}</p>

      <p v-if="revokeError" class="error" role="alert">{{ revokeError }}</p>
      <ListLayout :loading="sessionsLoading" :error="sessionsError" :empty="sessions.length === 0">
        <template #empty>
          <EmptyState :icon="Monitor">{{ t('pages.account.empty.no_sessions') }}</EmptyState>
        </template>

        <TableCard>
          <thead>
            <tr>
              <th>{{ t('pages.account.table.device') }}</th>
              <th>{{ t('pages.account.table.ip') }}</th>
              <th>{{ t('pages.account.table.last_active') }}</th>
              <th>{{ t('pages.account.table.signed_in') }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="session in sessions" :key="session.id">
              <td>{{ describeUserAgent(session.userAgent) }}</td>
              <td class="mono-cell">{{ session.ipAddress ?? "—" }}</td>
              <td>{{ formatDateTime(session.lastSeenAt) }}</td>
              <td>{{ formatDateTime(session.createdAt) }}</td>
              <td>
                <div class="actions">
                  <button type="button" class="link-btn danger" @click="requestRevoke(session)">
                    <LogOut :size="13" stroke-width="2" aria-hidden="true" /> {{ t('pages.account.sign_out_device') }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </TableCard>
      </ListLayout>
    </div>

    <div class="account-section">
      <h2><SlidersHorizontal :size="16" stroke-width="2" aria-hidden="true" /> {{ t('pages.account.preferences') }}</h2>

      <div class="pref-row pref-row-first">
        <div>
          <p class="pref-label">{{ t('pages.account.theme_label') }}</p>
          <p class="hint">{{ t('pages.account.theme_hint') }}</p>
        </div>
        <div class="segmented" role="radiogroup" :aria-label="t('pages.account.theme_aria')">
          <label>
            <input
              type="radio"
              name="theme-pref"
              value="light"
              :checked="theme === 'light'"
              @change="setTheme('light')"
            />
            {{ t('pages.account.theme_light') }}
          </label>
          <label>
            <input type="radio" name="theme-pref" value="dark" :checked="theme === 'dark'" @change="setTheme('dark')" />
            {{ t('pages.account.theme_dark') }}
          </label>
        </div>
      </div>

      <div class="pref-row">
        <div>
          <p class="pref-label">{{ t('pages.account.density_label') }}</p>
          <p class="hint">{{ t('pages.account.density_hint') }}</p>
        </div>
        <div class="segmented" role="radiogroup" :aria-label="t('pages.account.density_aria')">
          <label>
            <input
              type="radio"
              name="density-pref"
              value="comfortable"
              :checked="density === 'comfortable'"
              @change="setDensity('comfortable')"
            />
            {{ t('pages.account.density_comfortable') }}
          </label>
          <label>
            <input
              type="radio"
              name="density-pref"
              value="compact"
              :checked="density === 'compact'"
              @change="setDensity('compact')"
            />
            {{ t('pages.account.density_compact') }}
          </label>
        </div>
      </div>

      <div class="pref-row">
        <div>
          <p class="pref-label"><Languages :size="14" stroke-width="2" aria-hidden="true" style="display:inline-block; vertical-align:-2px; margin-right:4px;" />{{ t('pages.account.locale_label') }}</p>
          <p class="hint">{{ t('pages.account.locale_hint') }}</p>
        </div>
        <div class="segmented" role="radiogroup" :aria-label="t('common.current_locale')">
          <label v-for="code in locales" :key="code">
            <input
              type="radio"
              name="locale-pref"
              :value="code"
              :checked="locale === code"
              @change="setLocale(code)"
            />
            {{ t(`pages.account.locale_${code}`) }}
          </label>
        </div>
      </div>
    </div>

    <ConfirmDialog
      :open="pendingRevoke !== null"
      :title="t('pages.account.revoke_confirm.title')"
      :message="t('pages.account.revoke_confirm.message')"
      :confirm-label="t('pages.account.revoke_confirm.confirm')"
      danger
      @confirm="confirmRevoke"
      @cancel="cancelRevoke"
    />
  </section>
</template>

<style scoped>
.subtitle {
  color: var(--text-secondary);
  margin: 0;
}
.account-section {
  margin-bottom: var(--space-8);
}
.account-section h2 {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  font-size: var(--text-lg);
  font-family: var(--font-display);
  margin: 0 0 var(--space-1);
}
.account-section h2 svg {
  color: var(--signal);
}
.account-section > .subtitle {
  margin-bottom: var(--space-4);
}
.password-form {
  background: var(--surface-sunken);
  padding: var(--space-5);
  border-radius: var(--radius-md);
  margin-top: var(--space-4);
  max-width: 23.75rem;
}
.field input {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: var(--text-md);
  font-family: var(--font-body);
  box-sizing: border-box;
}
.hint {
  margin: 0.3rem 0 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
}
.hint.warn {
  color: var(--canary);
}
.mono-cell {
  font-family: var(--font-mono);
  font-size: 0.83rem;
  color: var(--text-secondary);
}
.actions {
  text-align: right;
}
.link-btn.danger {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.success {
  color: var(--ok);
}
.pref-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) 0;
  border-top: 1px solid var(--border);
}
.pref-row-first {
  border-top: none;
}
.pref-label {
  font-weight: 600;
  margin: 0 0 0.2rem;
  font-size: var(--text-md);
}
</style>
