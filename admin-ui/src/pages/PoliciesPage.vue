<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useLoadState } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
import type { GuardPolicy, BundleSummary } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import { ShieldCheck } from "lucide-vue-next";

const { t } = useI18n({ useScope: "global" });

const policies = ref<GuardPolicy[]>([]);
const bundles = ref<BundleSummary[]>([]);
const loadFallback = tk("pages.policies.errors.load_failed");
const applyFallback = tk("pages.policies.errors.apply_failed");
const deleteFallback = tk("pages.policies.errors.delete_failed");
const { loading, errorMessage, run } = useLoadState(loadFallback);
const notice = ref("");
const {
  pending: pendingDelete,
  request: requestDelete,
  cancel: cancelDelete,
  confirm: confirmActionDelete,
} = useConfirmAction<GuardPolicy>();
const {
  pending: pendingApply,
  request: requestApplyItem,
  cancel: cancelApply,
  confirm: confirmActionApply,
} = useConfirmAction<{ policy: GuardPolicy; bundle: string }>();

const applyBundle = ref<Record<number, string>>({});
const applyingId = ref<number | null>(null);
const bundleOptions = computed(() => [
  { value: "", label: t("pages.policies.select_bundle") },
  ...bundles.value.map((b) => ({ value: b.name, label: b.name })),
]);

async function load() {
  await run(async () => {
    const [p, b] = await Promise.all([
      api.get<{ items: GuardPolicy[] }>("/admin-api/policies"),
      api.get<{ items: BundleSummary[] }>("/admin-api/bundles"),
    ]);
    policies.value = p.items;
    bundles.value = b.items;
  });
}
onMounted(load);

function requestApply(policy: GuardPolicy) {
  const bundle = applyBundle.value[policy.id];
  if (!bundle) return;
  requestApplyItem({ policy, bundle });
}

async function confirmApply() {
  await confirmActionApply(async ({ policy, bundle }) => {
    notice.value = "";
    applyingId.value = policy.id;
    try {
      const res = await api.post<{ applied: number; skipped: { tool: string; reason: string }[] }>(
        `/admin-api/policies/${policy.id}/apply`,
        { bundle },
      );
      let message = t("pages.policies.notice.applied", { name: policy.name, applied: res.applied, bundle });
      if (res.skipped.length > 0) {
        message += " " + t("pages.policies.notice.skipped", { count: res.skipped.length });
      }
      notice.value = message;
    } catch (err) {
      errorMessage.value = toErrorMessage(err, applyFallback);
    } finally {
      applyingId.value = null;
    }
  });
}

async function confirmDelete() {
  await confirmActionDelete(async (p) => {
    try {
      await api.delete(`/admin-api/policies/${p.id}`);
      await load();
    } catch (err) {
      errorMessage.value = toErrorMessage(err, deleteFallback);
    }
  });
}
</script>

<template>
  <section>
    <PageHeader :title="t('pages.policies.title')" :subtitle="t('pages.policies.subtitle')">
      <RouterLink to="/policies/new" class="btn-primary">{{ t("pages.policies.create") }}</RouterLink>
    </PageHeader>

    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <ListLayout :loading="loading" :error="errorMessage" :empty="policies.length === 0">
      <template #empty>
        <EmptyState :icon="ShieldCheck">{{ t("pages.policies.empty.no_policies") }}</EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th>{{ t("pages.policies.table.name") }}</th>
            <th>{{ t("pages.policies.table.rate_limit") }}</th>
            <th>{{ t("pages.policies.table.timeout") }}</th>
            <th>{{ t("pages.policies.table.apply_to_bundle") }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in policies" :key="p.id">
            <td>{{ p.name }}</td>
            <td>{{ p.rateLimitPerMin ?? "—" }}</td>
            <td>{{ p.timeoutMs ? `${p.timeoutMs}ms` : "—" }}</td>
            <td class="apply-cell">
              <SelectMenu
                v-model="applyBundle[p.id]"
                :options="bundleOptions"
                create-path="/bundles/new"
                :create-label="t('pages.policies.create_bundle')"
                :reload="load"
              />
              <button
                type="button"
                class="btn-secondary"
                :disabled="!applyBundle[p.id] || applyingId === p.id"
                @click="requestApply(p)"
              >
                {{ applyingId === p.id ? t("pages.policies.applying") : t("pages.policies.apply") }}
              </button>
            </td>
            <td>
              <button type="button" class="link-btn danger" @click="requestDelete(p)">{{ t("common.delete") }}</button>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="t('pages.policies.confirm.delete_title')"
      :message="pendingDelete ? t('pages.policies.confirm.delete_message', { name: pendingDelete.name }) : ''"
      :confirm-label="
        pendingDelete ? t('pages.policies.confirm.delete_label', { name: pendingDelete.name }) : t('common.delete')
      "
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />

    <ConfirmDialog
      :open="pendingApply !== null"
      :title="t('pages.policies.confirm.apply_title')"
      :message="
        pendingApply
          ? t('pages.policies.confirm.apply_message', { name: pendingApply.policy.name, bundle: pendingApply.bundle })
          : ''
      "
      :confirm-label="t('pages.policies.confirm.apply_cta')"
      danger
      @confirm="confirmApply"
      @cancel="cancelApply"
    />
  </section>
</template>

<style scoped>
.apply-cell {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}
.notice {
  color: var(--ok);
  font-size: 0.9rem;
}
</style>
