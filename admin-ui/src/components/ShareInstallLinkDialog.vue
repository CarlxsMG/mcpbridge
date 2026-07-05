<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import type { BundleInstallLink, BundleInstallLinkWithToken } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import ModalShell from "@/components/ui/ModalShell.vue";
import CopyButton from "@/components/ui/CopyButton.vue";
import { formatDateTime, formatMaybeDate } from "@/utils/format";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";

const props = defineProps<{ open: boolean; bundleName: string }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n({ useScope: "global" });

const links = ref<BundleInstallLink[]>([]);
const loading = ref(false);
const listError = ref("");
const creating = ref(false);
const createError = ref("");

const minted = ref<BundleInstallLinkWithToken | null>(null);
const gatewayBaseUrl = ref("");

const pendingRevoke = ref<BundleInstallLink | null>(null);
const revokeError = ref("");

function installUrl(token: string): string {
  const base = (gatewayBaseUrl.value || window.location.origin).replace(/\/+$/, "");
  return `${base}/install/${token}`;
}

async function load() {
  listError.value = "";
  loading.value = true;
  try {
    const res = await api.get<{ items: BundleInstallLink[] }>(
      `/admin-api/bundles/${encodeURIComponent(props.bundleName)}/install-links`,
    );
    links.value = res.items;
  } catch (err) {
    listError.value = toErrorMessage(err, tk("components.share_install_link.errors.load_failed"));
  } finally {
    loading.value = false;
  }
}

async function loadGatewayUrl() {
  gatewayBaseUrl.value = window.location.origin;
  try {
    const res = await api.get<{ publicUrl: string | null }>("/admin-api/connect/gateway-url");
    if (res.publicUrl) gatewayBaseUrl.value = res.publicUrl;
  } catch {
    /* keep window.location.origin */
  }
}

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      minted.value = null;
      createError.value = "";
      listError.value = "";
      await Promise.all([load(), loadGatewayUrl()]);
    }
  },
);

async function createLink() {
  createError.value = "";
  creating.value = true;
  try {
    const created = await api.post<BundleInstallLinkWithToken>(
      `/admin-api/bundles/${encodeURIComponent(props.bundleName)}/install-links`,
      {},
    );
    minted.value = created;
    await load();
  } catch (err) {
    createError.value = toErrorMessage(err, tk("components.share_install_link.errors.create_failed"));
  } finally {
    creating.value = false;
  }
}

async function confirmRevoke() {
  if (!pendingRevoke.value) return;
  const link = pendingRevoke.value;
  pendingRevoke.value = null;
  revokeError.value = "";
  try {
    await api.delete(`/admin-api/bundles/${encodeURIComponent(props.bundleName)}/install-links/${link.id}`);
    if (minted.value?.id === link.id) minted.value = null;
    await load();
  } catch (err) {
    revokeError.value = toErrorMessage(err, tk("components.share_install_link.errors.revoke_failed"));
  }
}

function statusOf(link: BundleInstallLink): string {
  if (link.revokedAt !== null) return t("components.share_install_link.status.revoked");
  if (link.expiresAt !== null && link.expiresAt <= Date.now()) return t("components.share_install_link.status.expired");
  return t("components.share_install_link.status.active");
}
</script>

<template>
  <ModalShell :open="open" :ariaLabel="t('components.share_install_link.title')" :max-width="'40rem'" @close="emit('close')">
    <div class="dialog-head">
      <h2>{{ t('components.share_install_link.title') }}</h2>
      <button type="button" class="link-btn" @click="emit('close')">{{ t('common.close') }}</button>
    </div>
    <p class="hint">
      {{ t('components.share_install_link.hint_p1', { name: bundleName }) }}
      {{ t('components.share_install_link.hint_p2') }}
    </p>

    <div v-if="minted" class="minted" role="alert">
      <div class="minted-title">{{ t('components.share_install_link.minted_title') }}</div>
      <div class="minted-row">
        <code class="minted-secret">{{ installUrl(minted.token) }}</code>
        <CopyButton :key="minted.token" :text="installUrl(minted.token)" :label="t('common.copy')" />
        <button type="button" class="link-btn" @click="minted = null">{{ t('components.share_install_link.dismiss') }}</button>
      </div>
    </div>

    <button type="button" class="btn-primary create-btn" :disabled="creating" @click="createLink">
      {{ creating ? t('common.creating') : t('components.share_install_link.create_new') }}
    </button>
    <p v-if="createError" class="row-error">{{ createError }}</p>

    <h3>{{ t('components.share_install_link.existing_heading') }}</h3>
    <p v-if="listError" class="row-error">{{ listError }}</p>
    <p v-else-if="loading" class="hint">{{ t('common.loading') }}</p>
    <p v-else-if="links.length === 0" class="hint">{{ t('components.share_install_link.empty') }}</p>
    <div v-else class="table-wrap">
      <table class="links-table">
        <thead>
          <tr>
            <th>{{ t('components.share_install_link.table.token') }}</th>
            <th>{{ t('components.share_install_link.table.status') }}</th>
            <th>{{ t('components.share_install_link.table.created') }}</th>
            <th>{{ t('components.share_install_link.table.last_used') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="link in links" :key="link.id">
            <td>
              <code>{{ link.tokenPrefix }}…</code>
            </td>
            <td>
              <span class="status" :class="statusOf(link).toLowerCase()">{{ statusOf(link) }}</span>
            </td>
            <td>{{ formatDateTime(link.createdAt) }}</td>
            <td>{{ formatMaybeDate(link.lastUsedAt) }}</td>
            <td>
              <div class="actions">
                <button
                  v-if="link.revokedAt === null"
                  type="button"
                  class="link-btn danger"
                  @click="pendingRevoke = link"
                >
                  {{ t('components.share_install_link.revoke') }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="revokeError" class="row-error">{{ revokeError }}</p>

    <ConfirmDialog
      :open="pendingRevoke !== null"
      :title="t('components.share_install_link.confirm.revoke_title')"
      :message="t('components.share_install_link.confirm.revoke_message')"
      :confirm-label="pendingRevoke ? t('components.share_install_link.confirm.revoke_cta', { token: pendingRevoke.tokenPrefix }) : t('components.share_install_link.revoke')"
      danger
      @confirm="confirmRevoke"
      @cancel="pendingRevoke = null"
    />
  </ModalShell>
</template>

<style scoped>
.minted {
  background: var(--ok-soft);
  border: 1px solid var(--ok);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  margin-bottom: var(--space-4);
}
.minted-title {
  font-weight: 600;
  font-size: var(--text-sm);
  margin-bottom: var(--space-2);
}
.minted-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.minted-secret {
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 0.4rem 0.6rem;
  font-size: 0.82rem;
  font-family: var(--font-mono);
  word-break: break-all;
  flex: 1;
  min-width: 12.5rem;
}
.create-btn {
  margin-bottom: var(--space-5);
}
h3 {
  font-size: var(--text-base);
  margin: 0 0 var(--space-2);
}
.table-wrap {
  overflow-x: auto;
}
.links-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}
.links-table th {
  text-align: left;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.links-table td {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.links-table tbody tr:last-child td {
  border-bottom: none;
}
.actions {
  text-align: right;
}
.status {
  font-size: 0.74rem;
  padding: 0.1rem 0.5rem;
  border-radius: var(--radius-pill);
  font-weight: 600;
}
.status.active {
  background: var(--ok-soft);
  color: var(--ok);
}
.status.revoked,
.status.expired {
  background: var(--breach-soft);
  color: var(--breach);
}
.row-error {
  color: var(--breach);
  font-size: var(--text-sm);
  margin: var(--space-2) 0 0;
}
</style>