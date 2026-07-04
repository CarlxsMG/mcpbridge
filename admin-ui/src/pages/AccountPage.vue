<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, ApiError } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import { useAuth } from "../composables/useAuth";
import { useTheme } from "../composables/useTheme";
import { useDensity } from "../composables/useDensity";
import type { AdminSession } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import SignalLoader from "../components/SignalLoader.vue";
import PageHeader from "../components/PageHeader.vue";
import TableCard from "../components/TableCard.vue";
import EmptyState from "../components/EmptyState.vue";
import FormField from "../components/FormField.vue";
import { Lock, Monitor, LogOut, SlidersHorizontal } from "lucide-vue-next";

const { state: authState } = useAuth();
const { theme, setTheme } = useTheme();
const { density, setDensity } = useDensity();

// --- Change password -------------------------------------------------------

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
    passwordError.value = "All fields are required.";
    return;
  }
  if (newPassword.value.length < 12) {
    passwordError.value = "New password must be at least 12 characters.";
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    passwordError.value = "New password and confirmation do not match.";
    return;
  }

  changingPassword.value = true;
  try {
    await api.patch("/admin-api/auth/me/password", {
      current_password: currentPassword.value,
      new_password: newPassword.value,
    });
    resetPasswordForm();
    passwordSuccess.value = "Password changed. You're still signed in on this device.";
    // Changing the password revokes every session and issues a fresh one for
    // this device — refresh the list below so it reflects that immediately.
    await loadSessions();
  } catch (err) {
    passwordError.value = err instanceof ApiError ? err.message : "Failed to change password.";
  } finally {
    changingPassword.value = false;
  }
}

// --- Active sessions ---------------------------------------------------

const {
  data: sessions,
  loading: sessionsLoading,
  errorMessage: sessionsError,
  load: loadSessions,
} = useResource<AdminSession[]>(
  async () => (await api.get<{ sessions: AdminSession[] }>("/admin-api/auth/sessions")).sessions,
  [],
  "Failed to load active sessions.",
);

const pendingRevoke = ref<AdminSession | null>(null);
const revokeError = ref("");

function requestRevoke(session: AdminSession) {
  revokeError.value = "";
  pendingRevoke.value = session;
}

async function confirmRevoke() {
  if (!pendingRevoke.value) return;
  const session = pendingRevoke.value;
  pendingRevoke.value = null;
  try {
    await api.delete(`/admin-api/auth/sessions/${session.id}`);
    await loadSessions();
  } catch (err) {
    revokeError.value = err instanceof ApiError ? err.message : "Failed to revoke session.";
  }
}

// The session list has no field identifying "this is the session you're using
// right now" (the API never hands the browser its own session id), so there's
// no reliable way to badge or block revoking the current device from this
// list. Revoking it is allowed like any other row; the confirm dialog warns
// about the consequence instead of guessing which row is "safe."
function describeUserAgent(ua: string | null): string {
  if (!ua) return "Unknown device";

  let browser = "Unknown browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\//.test(ua)) browser = "Opera";
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = "Safari";
  else if (/curl\//.test(ua)) browser = "curl";

  let os = "";
  if (/Windows/.test(ua)) os = "Windows";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/iPhone|iPad/.test(ua)) os = "iOS";
  else if (/Linux/.test(ua)) os = "Linux";

  return os ? `${browser} on ${os}` : browser;
}

onMounted(loadSessions);
</script>

<template>
  <section>
    <PageHeader
      title="Account"
      :subtitle="`Manage your password and active sessions for ${authState.user?.username ?? ''}.`"
    />

    <div class="account-section">
      <h2><Lock :size="16" stroke-width="2" aria-hidden="true" /> Change password</h2>
      <p class="hint warn">Changing your password immediately signs out every other active session.</p>
      <form class="password-form" @submit.prevent="changePassword">
        <FormField label="Current password" for="acc-current-password">
          <input
            id="acc-current-password"
            v-model="currentPassword"
            type="password"
            autocomplete="current-password"
            required
          />
        </FormField>
        <FormField label="New password" for="acc-new-password">
          <input id="acc-new-password" v-model="newPassword" type="password" autocomplete="new-password" required />
          <p class="hint">At least 12 characters.</p>
        </FormField>
        <FormField label="Confirm new password" for="acc-confirm-password">
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
          {{ changingPassword ? "Changing…" : "Change password" }}
        </button>
      </form>
    </div>

    <div class="account-section">
      <h2><Monitor :size="16" stroke-width="2" aria-hidden="true" /> Active sessions</h2>
      <p class="subtitle">Devices and browsers currently signed in as you. Sign out any you don't recognize.</p>
      <p class="hint warn">
        This list doesn't indicate which session is the device you're using right now. Revoking a session may sign that
        device out immediately.
      </p>

      <p v-if="revokeError" class="error" role="alert">{{ revokeError }}</p>
      <SignalLoader v-if="sessionsLoading" />
      <p v-else-if="sessionsError" class="error" role="alert">{{ sessionsError }}</p>
      <EmptyState v-else-if="sessions.length === 0" :icon="Monitor">No active sessions.</EmptyState>

      <TableCard v-else>
        <thead>
          <tr>
            <th>Device</th>
            <th>IP address</th>
            <th>Last active</th>
            <th>Signed in</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="session in sessions" :key="session.id">
            <td>{{ describeUserAgent(session.userAgent) }}</td>
            <td class="mono-cell">{{ session.ipAddress ?? "—" }}</td>
            <td>{{ new Date(session.lastSeenAt).toLocaleString() }}</td>
            <td>{{ new Date(session.createdAt).toLocaleString() }}</td>
            <td>
              <div class="actions">
                <button type="button" class="link-btn danger" @click="requestRevoke(session)">
                  <LogOut :size="13" stroke-width="2" aria-hidden="true" /> Sign out
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </div>

    <div class="account-section">
      <h2><SlidersHorizontal :size="16" stroke-width="2" aria-hidden="true" /> Preferences</h2>

      <div class="pref-row pref-row-first">
        <div>
          <p class="pref-label">Theme</p>
          <p class="hint">Applies to this browser only.</p>
        </div>
        <div class="segmented" role="radiogroup" aria-label="Theme">
          <label>
            <input
              type="radio"
              name="theme-pref"
              value="light"
              :checked="theme === 'light'"
              @change="setTheme('light')"
            />
            Light
          </label>
          <label>
            <input type="radio" name="theme-pref" value="dark" :checked="theme === 'dark'" @change="setTheme('dark')" />
            Dark
          </label>
        </div>
      </div>

      <div class="pref-row">
        <div>
          <p class="pref-label">Table density</p>
          <p class="hint">Affects Traffic, Audit log, Traces, and API keys.</p>
        </div>
        <div class="segmented" role="radiogroup" aria-label="Table density">
          <label>
            <input
              type="radio"
              name="density-pref"
              value="comfortable"
              :checked="density === 'comfortable'"
              @change="setDensity('comfortable')"
            />
            Comfortable
          </label>
          <label>
            <input
              type="radio"
              name="density-pref"
              value="compact"
              :checked="density === 'compact'"
              @change="setDensity('compact')"
            />
            Compact
          </label>
        </div>
      </div>
    </div>

    <ConfirmDialog
      :open="pendingRevoke !== null"
      title="Sign out this device?"
      message="This immediately revokes the session. If it's the device you're using right now, you'll be signed out right away and returned to the login page."
      confirm-label="Sign out device"
      danger
      @confirm="confirmRevoke"
      @cancel="pendingRevoke = null"
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
  color: var(--breach);
}
.error {
  color: var(--breach);
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
