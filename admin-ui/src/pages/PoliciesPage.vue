<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api } from "../composables/useApi";
import { useLoadState } from "../composables/useResource";
import { useConfirmAction } from "../composables/useConfirmAction";
import { useEntityForm } from "@/composables/useEntityForm";
import { parseOptionalNumber } from "@/utils/fieldParsing";
import { toErrorMessage } from "@/utils/errors";
import type { GuardPolicy, BundleSummary } from "../types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import FormField from "@/components/ui/FormField.vue";
import ToggleFormButton from "@/components/ui/ToggleFormButton.vue";
import { ShieldCheck } from "lucide-vue-next";

const policies = ref<GuardPolicy[]>([]);
const bundles = ref<BundleSummary[]>([]);
const { loading, errorMessage, run } = useLoadState("Failed to load policies.");
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

const newName = ref("");
const newRate = ref("");
const newTimeout = ref("");

function resetForm() {
  newName.value = "";
  newRate.value = "";
  newTimeout.value = "";
}

const { open: showCreate, busy: creating, error: createError, submit } = useEntityForm<void>({ reset: resetForm });

// per-policy selected bundle to apply to
const applyBundle = ref<Record<number, string>>({});
const applyingId = ref<number | null>(null);

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

async function createPolicy() {
  createError.value = "";
  if (!newName.value.trim()) {
    createError.value = "Name is required.";
    return;
  }
  const rate = parseOptionalNumber(newRate.value, "Rate limit must be a plain number (no units), or blank.");
  if (rate.error) {
    createError.value = rate.error;
    return;
  }
  const timeout = parseOptionalNumber(newTimeout.value, "Timeout must be a plain number (no units), or blank.");
  if (timeout.error) {
    createError.value = timeout.error;
    return;
  }
  const ok = await submit(async () => {
    await api.post("/admin-api/policies", {
      name: newName.value.trim(),
      rateLimitPerMin: rate.value,
      timeoutMs: timeout.value,
    });
  }, "Failed to create policy.");
  if (ok) await load();
}

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
      let message = `Applied "${policy.name}" to ${res.applied} tool(s) in bundle "${bundle}".`;
      if (res.skipped.length > 0) {
        message += ` ${res.skipped.length} tool(s) were skipped because they no longer exist in the registry.`;
      }
      notice.value = message;
    } catch (err) {
      errorMessage.value = toErrorMessage(err, "Apply failed.");
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
      errorMessage.value = toErrorMessage(err, "Failed to delete policy.");
    }
  });
}
</script>

<template>
  <section>
    <PageHeader
      title="Guard policies"
      subtitle="Reusable rate-limit / timeout templates. Apply one to every tool in a bundle at once — each tool's existing API-key allow-list is left untouched."
    >
      <ToggleFormButton v-model="showCreate" show-label="New policy" />
    </PageHeader>

    <form v-if="showCreate" class="create-form" @submit.prevent="createPolicy">
      <FormField label="Name" for="p-name">
        <input id="p-name" v-model="newName" type="text" placeholder="strict" />
      </FormField>
      <FormField label="Rate limit (calls/min, blank = none)" for="p-rate">
        <input id="p-rate" v-model="newRate" type="text" inputmode="numeric" />
      </FormField>
      <FormField label="Timeout (ms, blank = none)" for="p-timeout">
        <input id="p-timeout" v-model="newTimeout" type="text" inputmode="numeric" />
      </FormField>
      <p v-if="createError" class="error">{{ createError }}</p>
      <button type="submit" class="btn-primary" :disabled="creating">
        {{ creating ? "Creating…" : "Create policy" }}
      </button>
    </form>

    <p v-if="notice" class="notice">{{ notice }}</p>

    <ListLayout :loading="loading" :error="errorMessage" :empty="policies.length === 0">
      <template #empty>
        <EmptyState :icon="ShieldCheck">
          No policies yet. A policy applies a rate limit and timeout across every tool at once, instead of setting each
          one individually.
        </EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th>Name</th>
            <th>Rate/min</th>
            <th>Timeout</th>
            <th>Apply to bundle</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in policies" :key="p.id">
            <td>{{ p.name }}</td>
            <td>{{ p.rateLimitPerMin ?? "—" }}</td>
            <td>{{ p.timeoutMs ? `${p.timeoutMs}ms` : "—" }}</td>
            <td class="apply-cell">
              <select v-model="applyBundle[p.id]">
                <option value="">Select bundle…</option>
                <option v-for="b in bundles" :key="b.name" :value="b.name">{{ b.name }}</option>
              </select>
              <button
                type="button"
                class="btn-secondary"
                :disabled="!applyBundle[p.id] || applyingId === p.id"
                @click="requestApply(p)"
              >
                {{ applyingId === p.id ? "Applying…" : "Apply" }}
              </button>
            </td>
            <td><button type="button" class="link-btn danger" @click="requestDelete(p)">Delete</button></td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this policy?"
      :message="
        pendingDelete
          ? `'${pendingDelete.name}' will be removed. Already-applied guards on tools are not reverted.`
          : ''
      "
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.name}` : 'Delete'"
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />

    <ConfirmDialog
      :open="pendingApply !== null"
      title="Apply this policy?"
      :message="
        pendingApply
          ? `Applying '${pendingApply.policy.name}' will overwrite the existing rate-limit and timeout guards on every tool in the '${pendingApply.bundle}' bundle.`
          : ''
      "
      confirm-label="Apply policy"
      danger
      @confirm="confirmApply"
      @cancel="cancelApply"
    />
  </section>
</template>

<style scoped>
.create-form {
  max-width: 26.25rem;
}
.apply-cell {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}
.apply-cell select {
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-family: var(--font-body);
}
.notice {
  color: var(--ok);
  font-size: 0.9rem;
}
</style>
