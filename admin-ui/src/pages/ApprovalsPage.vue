<script setup lang="ts">
import { ref, onMounted, computed, reactive, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useLoadState } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { tk } from "@/i18n";
import { toErrorMessage } from "@/utils/errors";
import { formatDateTime } from "@/utils/format";
import { statusTone, toneColorVar } from "@/utils/status";
import type { ApprovalRecord, ApprovalStatus } from "@/types/api";
import DonutChart from "@/components/charts/DonutChart.vue";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import ChartCard from "@/components/charts/ChartCard.vue";
import TabStrip from "@/components/ui/TabStrip.vue";
import HoverPreview from "@/components/ui/HoverPreview.vue";
import { ClipboardCheck, Check, X, RefreshCw } from "lucide-vue-next";

const { t } = useI18n({ useScope: "global" });

type TabKey = ApprovalStatus | "all";
const TABS = computed(() => [
  { key: "pending" as TabKey, label: t("pages.approvals.tab.pending") },
  { key: "approved" as TabKey, label: t("pages.approvals.tab.approved") },
  { key: "rejected" as TabKey, label: t("pages.approvals.tab.rejected") },
  { key: "all" as TabKey, label: t("pages.approvals.tab.all") },
]);
const activeTab = ref<TabKey>("pending");
const activeTabLabel = computed(() => TABS.value.find((tb) => tb.key === activeTab.value)?.label ?? activeTab.value);

const summary = ref<ApprovalRecord[]>([]);
const tableItems = ref<ApprovalRecord[]>([]);
const loadFallback = tk("pages.approvals.errors.load_failed");
const { loading, errorMessage, run } = useLoadState(loadFallback);
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
    { label: t("pages.approvals.status.pending"), value: counts.pending, color: "var(--canary)" },
    { label: t("pages.approvals.status.approved"), value: counts.approved, color: "var(--ok)" },
    { label: t("pages.approvals.status.rejected"), value: counts.rejected, color: "var(--breach)" },
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
    errorMessage.value = toErrorMessage(err, t("pages.approvals.errors.action_failed", { action, id: a.id }));
  } finally {
    decidingId.value = null;
  }
}

const {
  pending: pendingApprove,
  request: requestApprove,
  cancel: cancelApprove,
  confirm: confirmActionApprove,
} = useConfirmAction<ApprovalRecord>();

async function confirmApprove() {
  await confirmActionApprove(async (a) => {
    await decide(a, "approved");
  });
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
    <PageHeader :title="t('pages.approvals.title')" :subtitle="t('pages.approvals.subtitle')">
      <button type="button" class="btn-secondary" :disabled="loading" @click="loadTable">
        <RefreshCw :size="14" stroke-width="2" aria-hidden="true" :class="{ spin: loading }" />
        {{ loading ? t("common.refreshing") : t("common.refresh") }}
      </button>
    </PageHeader>

    <ChartCard :title="t('pages.approvals.breakdown_title')" dotted>
      <DonutChart :segments="segments" :size="88" />
    </ChartCard>

    <TabStrip v-model="activeTab" :tabs="TABS" :aria-label="t('pages.approvals.tab_aria')" />

    <ListLayout :loading="loading && !tableItems.length" :error="errorMessage" :empty="tableItems.length === 0">
      <template #empty>
        <EmptyState :icon="ClipboardCheck" muted>
          <template v-if="activeTab === 'pending'">{{ t("pages.approvals.empty.nothing_pending") }}</template>
          <template v-else>
            {{ t("pages.approvals.empty.no_items_for_tab", { tab: activeTabLabel }) }}
          </template>
        </EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">{{ t("pages.approvals.table.client_tool") }}</th>
            <th scope="col">{{ t("pages.approvals.table.args") }}</th>
            <th scope="col">{{ t("pages.approvals.table.requested") }}</th>
            <th scope="col">{{ t("pages.approvals.table.decision") }}</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in tableItems" :key="a.id">
            <td class="mono">{{ a.id }}</td>
            <td class="mono">{{ a.clientName }}/{{ a.toolName }}</td>
            <td>
              <HoverPreview class="cell-truncate" :text="prettyArgs(a.argsJson)" mono>
                <code>{{ prettyArgs(a.argsJson) }}</code>
              </HoverPreview>
            </td>
            <td>{{ formatDateTime(a.createdAt) }}</td>
            <td>
              <span
                v-if="a.status === 'pending'"
                class="status-pending"
                :style="{ color: `var(${toneColorVar(statusTone(a.status))})` }"
              >
                {{ t("pages.approvals.status.pending") }}<br />
                <span v-if="a.requiredLevels > 1" class="levels-badge">{{
                  t("pages.approvals.levels_badge_short", { approved: approvedCount(a), total: a.requiredLevels })
                }}</span>
              </span>
              <span v-else :style="{ color: `var(${toneColorVar(statusTone(a.status))})` }">
                {{
                  a.status === "approved" ? t("pages.approvals.status.approved") : t("pages.approvals.status.rejected")
                }}
                <template v-if="a.requiredLevels > 1 && a.status === 'approved'"
                  >({{ approvedCount(a) }}/{{ a.requiredLevels }})</template
                >
                {{ t("pages.approvals.by") }} {{ a.decidedBy }}
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
                    :placeholder="t('pages.approvals.note_placeholder')"
                    class="note-input"
                    :aria-label="t('pages.approvals.aria.note_for_id', { id: a.id })"
                    :disabled="decidingId === a.id"
                  />
                  <button type="button" class="link-btn" :disabled="decidingId === a.id" @click="requestApprove(a)">
                    <Check :size="13" stroke-width="2" aria-hidden="true" /> {{ t("pages.approvals.table.approve") }}
                  </button>
                  <button
                    type="button"
                    class="link-btn danger"
                    :disabled="decidingId === a.id"
                    @click="requestReject(a)"
                  >
                    <X :size="13" stroke-width="2" aria-hidden="true" /> {{ t("pages.approvals.table.deny") }}
                  </button>
                </template>
              </div>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <ConfirmDialog
      :open="pendingApprove !== null"
      :title="t('pages.approvals.confirm.approve_title')"
      :message="
        pendingApprove
          ? t('pages.approvals.confirm.approve_message', {
              client: pendingApprove.clientName,
              tool: pendingApprove.toolName,
            })
          : ''
      "
      :confirm-label="t('pages.approvals.confirm.approve_cta')"
      danger
      @confirm="confirmApprove"
      @cancel="cancelApprove"
    />

    <ConfirmDialog
      :open="pendingReject !== null"
      :title="t('pages.approvals.confirm.reject_title')"
      :message="
        pendingReject
          ? t('pages.approvals.confirm.reject_message', {
              client: pendingReject.clientName,
              tool: pendingReject.toolName,
            })
          : ''
      "
      :confirm-label="t('pages.approvals.confirm.reject_cta')"
      danger
      @confirm="confirmReject"
      @cancel="cancelReject"
    />
  </section>
</template>

<style scoped>
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
  font-weight: 600;
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
</style>
