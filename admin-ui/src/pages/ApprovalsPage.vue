<script setup lang="ts">
import { ref, onMounted, computed, reactive } from "vue";
import { api, ApiError } from "../composables/useApi";
import { useLoadState } from "../composables/useResource";
import type { ApprovalRecord, ApprovalStatus } from "../types/api";
import DonutChart from "../components/DonutChart.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import SignalLoader from "../components/SignalLoader.vue";
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

function switchTab(key: TabKey) {
  activeTab.value = key;
  loadTable();
}

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
    errorMessage.value = err instanceof ApiError ? err.message : `Failed to ${action} approval #${a.id}.`;
  } finally {
    decidingId.value = null;
  }
}

const pendingReject = ref<ApprovalRecord | null>(null);

function requestReject(a: ApprovalRecord) {
  pendingReject.value = a;
}

async function confirmReject() {
  if (!pendingReject.value) return;
  await decide(pendingReject.value, "rejected");
  pendingReject.value = null;
}
</script>

<template>
  <section>
    <header class="page-header">
      <div>
        <h1>Approvals</h1>
        <p class="subtitle">
          Human-in-the-loop queue for tools configured to require approval before their upstream call runs.
        </p>
      </div>
      <button type="button" class="btn-secondary" :disabled="loading" @click="loadTable">
        <RefreshCw :size="14" stroke-width="2" aria-hidden="true" :class="{ spin: loading }" />
        {{ loading ? "Refreshing…" : "Refresh" }}
      </button>
    </header>

    <div class="chart-card">
      <h2>Status breakdown</h2>
      <DonutChart :segments="segments" :size="88" />
    </div>

    <div class="tab-strip" role="tablist">
      <button
        v-for="t in TABS"
        :key="t.key"
        type="button"
        role="tab"
        :aria-selected="activeTab === t.key"
        class="tab-btn"
        :class="{ 'tab-active': activeTab === t.key }"
        @click="switchTab(t.key)"
      >
        {{ t.label }}
      </button>
    </div>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <SignalLoader v-if="loading && !tableItems.length" />
    <div v-else-if="tableItems.length === 0" class="empty-state">
      <ClipboardCheck :size="26" stroke-width="1.5" aria-hidden="true" class="empty-icon" />
      <p v-if="activeTab === 'pending'">Nothing waiting for review right now.</p>
      <p v-else>
        No {{ activeTab === "all" ? "" : activeTab + " " }}approvals yet. Requests show up here once a tool is
        configured to require approval before its upstream call runs.
      </p>
    </div>

    <div v-else class="table-card table-scroll">
      <table class="appr-table">
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
            <td class="args" :title="prettyArgs(a.argsJson)">
              <code>{{ prettyArgs(a.argsJson) }}</code>
            </td>
            <td>{{ new Date(a.createdAt).toLocaleString() }}</td>
            <td>
              <span v-if="a.status === 'pending'" class="status-pending">
                Pending
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
            <td class="actions">
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
                <button type="button" class="link-btn danger" :disabled="decidingId === a.id" @click="requestReject(a)">
                  <X :size="13" stroke-width="2" aria-hidden="true" /> Reject
                </button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

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
      @cancel="pendingReject = null"
    />
  </section>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1.25rem;
}
.page-header h1 {
  margin: 0 0 0.2rem;
}
.subtitle {
  color: var(--text-secondary);
  margin: 0;
  max-width: 640px;
}
.page-header .btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
}
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.chart-card {
  background: var(--surface);
  background-image: radial-gradient(circle, var(--border) 1px, transparent 1px);
  background-size: 16px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: var(--space-4) var(--space-5);
  margin-bottom: var(--space-6);
}
.chart-card h2 {
  font-size: var(--text-sm);
  margin: 0 0 var(--space-3);
  color: var(--text-secondary);
  font-family: var(--font-body);
  font-weight: 600;
}
.tab-strip {
  display: flex;
  gap: 0.25rem;
  margin-bottom: 1.25rem;
  border-bottom: 1px solid var(--border);
}
.tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 0.88rem;
  padding: 0.55rem 0.35rem;
  margin-bottom: -1px;
  cursor: pointer;
  transition:
    color 0.12s ease,
    border-color 0.12s ease;
}
.tab-btn:hover {
  color: var(--text-primary);
}
.tab-btn.tab-active {
  color: var(--signal-strong);
  border-bottom-color: var(--signal);
}
.table-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}
.appr-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.appr-table th {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.appr-table td {
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.appr-table tbody tr:last-child td {
  border-bottom: none;
}
.appr-table tbody tr:hover {
  background: var(--surface-sunken);
}
.mono {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  white-space: nowrap;
}
.args {
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  margin-left: 0.4em;
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
  width: 110px;
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
.error {
  color: var(--breach);
}
.empty-state p {
  color: var(--text-muted);
}
.empty-state {
  padding: 3rem 2rem;
  text-align: center;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.empty-icon {
  color: var(--text-muted);
  margin-bottom: 0.75rem;
}
</style>
