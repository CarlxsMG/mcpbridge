<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useAuth } from "../composables/useAuth";
import { api, ApiError } from "../composables/useApi";
import type { OidcPublicConfig } from "../types/api";
import { GitBranch } from "lucide-vue-next";

const username = ref("");
const password = ref("");
const submitting = ref(false);
const errorMessage = ref("");

const { login } = useAuth();
const router = useRouter();
const route = useRoute();

// Does the login page need to offer an SSO button? Fetched before any
// session exists, so this call is deliberately public (no adminAuth) —
// see GET /admin-api/auth/oidc/config. Never alters the password-login
// flow above; if the check itself fails, the button just doesn't appear.
const ssoConfig = ref<OidcPublicConfig>({ enabled: false });
onMounted(async () => {
  try {
    ssoConfig.value = await api.get<OidcPublicConfig>("/admin-api/auth/oidc/config");
  } catch {
    ssoConfig.value = { enabled: false };
  }
});

async function onSubmit() {
  errorMessage.value = "";
  submitting.value = true;
  try {
    await login(username.value.trim(), password.value);
    const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "/servers";
    await router.push(redirect);
  } catch (err) {
    // Never state which field was wrong — avoids helping a credential-stuffing attempt.
    if (err instanceof ApiError && (err.status === 401 || err.status === 400)) {
      errorMessage.value = "Couldn't sign in — check your username and password.";
    } else if (err instanceof ApiError && err.status === 429) {
      errorMessage.value = "Too many attempts — please wait a moment and try again.";
    } else {
      errorMessage.value = "Something went wrong. Please try again.";
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login-shell">
    <div class="signal-trace-wrap" aria-hidden="true">
      <svg class="signal-trace-svg" viewBox="0 0 400 40" preserveAspectRatio="none">
        <polyline
          points="0,20 40,20 55,8 70,32 90,20 130,20 145,8 160,32 180,20 200,20 240,20 255,8 270,32 290,20 330,20 345,8 360,32 380,20 400,20"
        />
      </svg>
    </div>
    <div class="login-card">
      <form @submit.prevent="onSubmit">
        <h1><GitBranch :size="20" stroke-width="2.25" aria-hidden="true" /> MCP REST Bridge</h1>
        <p class="subtitle">Sign in to manage servers and tools</p>

        <div class="field">
          <label for="username">Username</label>
          <input id="username" v-model="username" type="text" autocomplete="username" required autofocus />
        </div>

        <div class="field">
          <label for="password">Password</label>
          <input id="password" v-model="password" type="password" autocomplete="current-password" required />
        </div>

        <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

        <button type="submit" class="btn-primary" :disabled="submitting">
          {{ submitting ? "Signing in…" : "Sign in" }}
        </button>
      </form>

      <div v-if="ssoConfig.enabled" class="sso-section">
        <div class="divider" role="separator"><span>or</span></div>
        <a class="btn-secondary sso-link" href="/admin-api/auth/oidc/start">Sign in with SSO</a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-shell {
  position: relative;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--paper);
}
.signal-trace-wrap {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  display: flex;
  align-items: center;
  z-index: 0;
}
.signal-trace-svg {
  width: 200%;
  height: 4rem;
  flex-shrink: 0;
  animation: signal-trace-drift 9s linear infinite;
}
.signal-trace-svg polyline {
  stroke: var(--signal);
  stroke-width: 1.5;
  fill: none;
  opacity: 0.3;
}
@keyframes signal-trace-drift {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-50%);
  }
}
.login-card {
  position: relative;
  z-index: 1;
  background: var(--surface);
  padding: 2.5rem;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  width: 100%;
  max-width: 22.5rem;
}
.login-card h1 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1.3rem;
  margin: 0 0 0.25rem;
}
.login-card h1 svg {
  color: var(--signal);
  flex-shrink: 0;
}
.subtitle {
  color: var(--text-secondary);
  margin: 0 0 1.5rem;
  font-size: 0.9rem;
}
.field {
  margin-bottom: 1rem;
}
.field label {
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
  font-size: 0.95rem;
  box-sizing: border-box;
}
.btn-primary {
  width: 100%;
}
.error {
  color: var(--breach);
  font-size: 0.85rem;
  margin: 0 0 1rem;
}
.sso-section {
  margin-top: 1.25rem;
}
.divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: var(--text-muted);
  font-size: 0.78rem;
  margin: 0 0 1rem;
}
.divider::before,
.divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--border);
}
.sso-link {
  display: block;
  width: 100%;
  text-align: center;
  box-sizing: border-box;
  text-decoration: none;
}
</style>
