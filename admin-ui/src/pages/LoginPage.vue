<script setup lang="ts">
import { ref } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useAuth } from "../composables/useAuth";
import { ApiError } from "../composables/useApi";

const username = ref("");
const password = ref("");
const submitting = ref(false);
const errorMessage = ref("");

const { login } = useAuth();
const router = useRouter();
const route = useRoute();

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
    <form class="login-card" @submit.prevent="onSubmit">
      <h1>MCP REST Bridge</h1>
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
  </div>
</template>

<style scoped>
.login-shell {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f4f5f7;
}
.login-card {
  background: #fff;
  padding: 2.5rem;
  border-radius: 12px;
  box-shadow: 0 8px 28px rgba(20, 24, 30, 0.1);
  width: 100%;
  max-width: 360px;
}
.login-card h1 {
  font-size: 1.3rem;
  margin: 0 0 0.25rem;
}
.subtitle {
  color: #63676e;
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
  border: 1px solid #cfd4da;
  border-radius: 6px;
  font-size: 0.95rem;
  box-sizing: border-box;
}
.btn-primary {
  width: 100%;
}
.error {
  color: #a11212;
  font-size: 0.85rem;
  margin: 0 0 1rem;
}
</style>
