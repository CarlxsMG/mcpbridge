<template>
  <div class="table-card table-scroll">
    <table class="data-table">
      <slot />
    </table>
  </div>
</template>

<style scoped>
.table-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}
</style>

<style>
/* .data-table styles the <table> rendered by this component but populated via
   the default slot, so scoped attribute selectors wouldn't reach its thead/tbody
   children — this block is intentionally global, scoped by the class name alone. */
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.data-table th {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.data-table td {
  padding: var(--table-pad-y) 0.85rem;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.data-table tbody tr:last-child td {
  border-bottom: none;
}
.data-table tbody tr:hover {
  background: var(--surface-sunken);
}
</style>
