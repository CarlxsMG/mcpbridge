<script setup lang="ts">
import { ref, onMounted, computed, reactive, watch } from "vue";
import { api } from "@/composables/useApi";
import { useLoadState } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { toErrorMessage } from "@/utils/errors";
import { formatDateTime } from "@/utils/format";
import type { ApprovalRecord, ApprovalStatus } from "@/types/api";
import DonutChart from "@/components/charts/DonutChart.vue";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import ChartCard from "@/components/charts/ChartCard.vue";
import TabStrip from "@/components/ui/TabStrip.vue";
import { ClipboardCheck, Check, X, RefreshCw } from "lucide-vue-next";

type TabKey = ApprovalStatus | "all";
const TABS: { key: TabKey; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];
const activeTab = ref<TabKey>("pending");

const summary = ref<ApprovalRecord[]>([]);
const tableItems = ref<ApprovalRecord[]>([]);
const { loading, errorMessage, run } = useLoadState("Failed to load approvals. Check your connection and try again.");
const decidingId = ref<number | null>(null);
const noteDraft = reactive<Record<number, string>>({});

async function loadTable() {
  const tab = activeTab.value;
  await run(async () => {
    const summaryReq = api.get<{ items: ApprovalRecord[] }>("/admin-api/approvals").then((r) => r.items);
    if (tab === "all") {
      const all = await summaryReq;
      if (tab === activeTab.value) {
        summary.value = all;
        tableItems.value = all;
      }
    } else {
      const [items, all] = await Promise.all([
        api.get<{ items: ApprovalRecord[] }>(`/admin-api/approvals?status=${tab}`).then((r) => r.items),
        summaryReq,
      ]);
      if (tab === activeTab.value) {
        tableItems.value = items;
        summary.value = all;
      }
    }
  });
}
onMounted(loadTable);

watch(activeTab, () => {
  loadTable();
});

const segments = computed(() => {
  const counts: Record<ApprovalStatus, number> = { pending: 0, approved: 0, rejected: 0 };
  for (const a of summary.value) counts[a.status]++;
  return [
    { label: "Pending", value: counts.pending, color: "var(--canary)" },
    { label: "Approved", value: counts.approved, color: "var(--ok)" },
    { label: "Rejected", value: counts.rejected, color: "var(--breach)" },
  ].filter((s) => s.value > 0);
});

function approvedCount(a: ApprovalRecord): number {
  return a.decisions.filter((d) => d.decision === "approved").length;
}

function prettyArgs(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json));
  } catch {
    return json;
  }
}

async function decide(a: ApprovalRecord, status: "approved" | "rejected") {
  const action = status === "approved" ? "approve" : "reject";
  decidingId.value = a.id;
  errorMessage.value = "";
  try {
    const note = noteDraft[a.id]?.trim();
    await api.post(`/admin-api/approvals/${a.id}/${action}`, note ? { note } : undefined);
    delete noteDraft[a.id];
    await loadTable();
  } catch (err) {
    errorMessage.value = toErrorMessage(err, `Failed to ${action} approval #${a.id}.`);
  } finally {
    decidingId.value = null;
  }
}

const {
  pending: pendingReject,
  request: requestReject,
  cancel: cancelReject,
  confirm: confirmActionReject,
} = useConfirmAction<ApprovalRecord>();

async function confirmReject() {
  await confirmActionReject(async (a) => {
    await decide(a, "rejected");
  });
}
</script>

<template>
  <section>
    <PageHeader
      title="Approvals"
      subtitle="Human-in-the-loop queue for tools configured to require approval before their upstream call runs."
    >
      <button type="button" class="btn-secondary" :disabled="loading" @click="loadTable">
        <RefreshCw :size="14" stroke-width="2" aria-hidden="true" :class="{ spin: loading }" />
        {{ loading ? "Refreshing…" : "Refresh" }}
      </button>
    </PageHeader>

    <ChartCard title="Status breakdown" dotted>
      <DonutChart :segments="segments" :size="88" />
    </ChartCard>

    <TabStrip v-model="activeTab" :tabs="TABS" aria-label="Approval status" />

    <ListLayout :loading="loading && !tableItems.length" :error="errorMessage" :empty="tableItems.length === 0">
      <template #empty>
        <EmptyState :icon="ClipboardCheck">
          <template v-if="activeTab === 'pending'">Nothing waiting for review right now.</template>
          <template v-else>
            No {{ activeTab === "all" ? "" : activeTab + " " }}approvals yet. Requests show up here once a tool is
            configured to require approval before its upstream call runs.
          </template>
        </EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th>#</th>
            <th>Client / Tool</th>
            <th>Args</th>
            <th>Requested</th>
            <th>Decision</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in tableItems" :key="a.id">
            <td class="mono">{{ a.id }}</td>
            <td class="mono">{{ a.clientName }}/{{ a.toolName }}</td>
            <td class="cell-truncate" :title="prettyArgs(a.argsJson)">
              <code>{{ prettyArgs(a.argsJson) }}</code>
            </td>
            <td>{{ formatDateTime(a.createdAt) }}</td>
            <td>
              <span v-if="a.status === 'pending'" class="status-pending">
                Pending<br>
                <span v-if="a.requiredLevels > 1" class="levels-badge"
                  >{{ approvedCount(a) }}/{{ a.requiredLevels }} approved</span
                >
              </span>
              <span v-else :class="a.status === 'approved' ? 'status-approved' : 'status-rejected'">
                {{ a.status === "approved" ? "Approved" : "Rejected" }}
                <template v-if="a.requiredLevels > 1 && a.status === 'approved'"
                  >({{ approvedCount(a) }}/{{ a.requiredLevels }})</template
                >
                by {{ a.decidedBy }}
                <span v-if="a.note" class="note">— {{ a.note }}</span>
              </span>
              <ul v-if="a.decisions.length" class="decisions">
                <li v-for="d in a.decisions" :key="d.id">
                  {{ d.decidedBy }}: {{ d.decision }}<span v-if="d.note"> — {{ d.note }}</span>
                </li>
              </ul>
            </td>
            <td>
              <div class="actions">
                <template v-if="a.status === 'pending'">
                  <input
                    v-model="noteDraft[a.id]"
                    type="text"
                    placeholder="Note…"
                    class="note-input"
                    :aria-label="`Note for approval #${a.id}`"
                    :disabled="decidingId === a.id"
                  />
                  <button type="button" class="link-btn" :disabled="decidingId === a.id" @click="decide(a, 'approved')">
                    <Check :size="13" stroke-width="2" aria-hidden="true" /> Approve
                  </button>
                  <button
                    type="button"
                    class="link-btn danger"
                    :disabled="decidingId === a.id"
                    @click="requestReject(a)"
                  >
                    <X :size="13" stroke-width="2" aria-hidden="true" /> Reject
                  </button>
                </template>
              </div>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <ConfirmDialog
      :open="pendingReject !== null"
      title="Reject this call?"
      :message="
        pendingReject
          ? `This will deny ${pendingReject.clientName}'s pending call to ${pendingReject.toolName}. This cannot be undone.`
          : ''
      "
      confirm-label="Reject call"
      danger
      @confirm="confirmReject"
      @cancel="cancelReject"
    />
  </section>
</template>

<style scoped>
/* Page-specific tweak on top of PageHeader.vue's own recipe: a wider max-width for the subtitle
   paragraph than the component's default (unbounded). */
:deep(.subtitle) {
  max-width: 40rem;
}
.page-header .btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
}
.cell-truncate {
  max-width: 11.875rem;
}
.status-pending {
  color: var(--canary);
  font-weight: 600;
}
.status-approved {
  color: var(--ok);
}
.status-rejected {
  color: var(--breach);
}
.note {
  color: var(--text-muted);
}
.levels-badge {
  display: inline-block;
  font-size: 0.75em;
  font-weight: 600;
  color: var(--text-muted);
}
.decisions {
  list-style: none;
  margin: 0.3rem 0 0;
  padding: 0;
  font-size: 0.78rem;
  color: var(--text-muted);
}
.actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  white-space: nowrap;
}
.note-input {
  width: 6.875rem;
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  font-family: var(--font-body);
}
.link-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3em;
}
/* Page-specific tweak on top of EmptyState.vue's own recipe: this page wants the muted text tone
   here instead of the component's default (--text-secondary). */
:deep(.empty-state p) {
  color: var(--text-muted);
}
</style>
