<script setup lang="ts" generic="T extends string | number | boolean | null">
import { ref, computed, nextTick, onBeforeUnmount, useId } from "vue";
import { useRouter } from "vue-router";
import { ChevronDown, Plus } from "lucide-vue-next";
import { useFloatingPanel } from "@/composables/useFloatingPanel";

interface Option<V> {
  value: V;
  label: string;
  disabled?: boolean;
}

const props = defineProps<{
  id?: string;
  options: Option<T>[];
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  // aria-required / aria-describedby are declared as explicit props (not left to
  // fall through as attrs) so they land on the role="combobox" BUTTON below —
  // inheritAttrs would otherwise drop them on the wrapper <div>, where a screen
  // reader never sees them relative to the combobox.
  ariaRequired?: boolean;
  ariaDescribedby?: string;
  /** Route path of the page that creates this entity, e.g. "/teams". Renders a trailing "+ create" row in the list. */
  createPath?: string;
  /** e.g. "Create team" — rendered with a trailing "↗" to signal the new tab. */
  createLabel?: string;
  /** Re-fetches `options`; called once when the user comes back to this tab after using createPath. */
  reload?: () => unknown;
}>();

const model = defineModel<T>({ required: true });
// Only components that actually render a create-row need router context —
// calling useRouter() unconditionally would require every place that mounts
// a plain SelectMenu (most of them, with no createPath) to also provide a
// router, purely to satisfy an injection this instance never uses.
const router = props.createPath ? useRouter() : undefined;

const activeIndex = ref(0);
const triggerEl = ref<HTMLButtonElement | null>(null);
const listboxEl = ref<HTMLUListElement | null>(null);
// Vue's own collision-free id generator (3.5+). Replaces a Math.random() slice,
// which CodeQL flagged as insecure randomness: harmless here since this only
// links the trigger to its listbox for ARIA, but useId() is both the idiomatic
// answer and genuinely collision-free.
const listboxId = `select-menu-${useId()}`;

const floatingPanel = useFloatingPanel(triggerEl, listboxEl, {
  matchTriggerWidth: true,
  placement: (rect) => {
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUpward = spaceBelow < 220 && rect.top > spaceBelow;
    return openUpward ? { bottom: window.innerHeight - rect.top } : { top: rect.bottom };
  },
});
const { isOpen, style: listboxStyle } = floatingPanel;

const selectableCount = computed(() => props.options.length + (props.createPath ? 1 : 0));
const selectedLabel = computed(() => {
  const match = props.options.find((o) => o.value === model.value);
  if (match) return match.label;
  // Mirror a native <select>'s "display the first option" behavior ONLY when the
  // bound value is genuinely unset (a per-row v-model like `record[id]` that's
  // `undefined`/`null` until first touched). When the model holds a concrete
  // value that matches no option — a stale team id whose team list hasn't loaded
  // yet, a target left selected after a scope switch — falling back to
  // options[0] would advertise a selection the model does not hold, so surface
  // the raw value instead.
  if (model.value === null || model.value === undefined) return props.options[0]?.label ?? "";
  return String(model.value);
});

function optionId(i: number) {
  return `${listboxId}-opt-${i}`;
}
const createIndex = computed(() => props.options.length);
const activeOptionId = computed(() => (isOpen.value ? optionId(activeIndex.value) : undefined));

function onDocMousedown(e: MouseEvent) {
  const target = e.target as Node;
  if (triggerEl.value?.contains(target) || listboxEl.value?.contains(target)) return;
  close();
}

async function openMenu() {
  if (props.disabled || isOpen.value) return;
  const current = props.options.findIndex((o) => o.value === model.value);
  activeIndex.value = current >= 0 ? current : 0;
  await floatingPanel.open();
  document.addEventListener("mousedown", onDocMousedown);
}

function close() {
  if (!isOpen.value) return;
  floatingPanel.close();
  document.removeEventListener("mousedown", onDocMousedown);
}

function toggle() {
  if (isOpen.value) close();
  else void openMenu();
}

function choose(i: number) {
  const opt = props.options[i];
  if (!opt || opt.disabled) return;
  model.value = opt.value;
  close();
  triggerEl.value?.focus();
}

// Opening the create page in its own tab (rather than navigating away, or a
// modal) leaves whatever the user was filling in around this select intact.
// Re-fetching only once, on the next time this tab regains focus, avoids
// refetching on every unrelated alt-tab.
let armed = false;
function chooseCreate() {
  if (!props.createPath || !router) return;
  close();
  triggerEl.value?.focus();
  const href = router.resolve(props.createPath).href;
  window.open(href, "_blank", "noopener");
  if (armed || !props.reload) return;
  armed = true;
  const onFocus = () => {
    armed = false;
    window.removeEventListener("focus", onFocus);
    props.reload?.();
  };
  window.addEventListener("focus", onFocus);
}

function scrollActiveIntoView() {
  nextTick(() => {
    listboxEl.value?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  });
}

let typeaheadBuffer = "";
let typeaheadTimer: ReturnType<typeof setTimeout> | undefined;

function typeahead(key: string) {
  typeaheadBuffer += key.toLowerCase();
  clearTimeout(typeaheadTimer);
  typeaheadTimer = setTimeout(() => (typeaheadBuffer = ""), 500);
  const match = props.options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typeaheadBuffer));
  if (match >= 0) {
    activeIndex.value = match;
    scrollActiveIntoView();
  }
}

function onTriggerKeydown(e: KeyboardEvent) {
  if (props.disabled) return;
  if (!isOpen.value) {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      void openMenu();
    }
    return;
  }
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      activeIndex.value = Math.min(activeIndex.value + 1, selectableCount.value - 1);
      scrollActiveIntoView();
      break;
    case "ArrowUp":
      e.preventDefault();
      activeIndex.value = Math.max(activeIndex.value - 1, 0);
      scrollActiveIntoView();
      break;
    case "Home":
      e.preventDefault();
      activeIndex.value = 0;
      scrollActiveIntoView();
      break;
    case "End":
      e.preventDefault();
      activeIndex.value = selectableCount.value - 1;
      scrollActiveIntoView();
      break;
    case "Enter":
    case " ":
      e.preventDefault();
      if (activeIndex.value === createIndex.value && props.createPath) chooseCreate();
      else choose(activeIndex.value);
      break;
    case "Escape":
      e.preventDefault();
      close();
      break;
    case "Tab":
      close();
      break;
    default:
      if (e.key.length === 1) typeahead(e.key);
  }
}

onBeforeUnmount(close);
</script>

<template>
  <div class="select-menu">
    <button
      :id="id"
      ref="triggerEl"
      type="button"
      class="select-menu-trigger"
      :class="{ 'is-open': isOpen }"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="isOpen"
      :aria-controls="listboxId"
      :aria-activedescendant="activeOptionId"
      :aria-label="ariaLabel"
      :aria-required="ariaRequired"
      :aria-describedby="ariaDescribedby"
      :title="title"
      :disabled="disabled"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <span class="select-menu-value">{{ selectedLabel }}</span>
      <ChevronDown :size="14" stroke-width="2" aria-hidden="true" class="select-menu-chevron" />
    </button>

    <Teleport to="body">
      <ul
        v-if="isOpen"
        :id="listboxId"
        ref="listboxEl"
        role="listbox"
        class="select-menu-listbox"
        :aria-label="ariaLabel"
        :style="listboxStyle"
      >
        <li
          v-for="(opt, i) in options"
          :id="optionId(i)"
          :key="String(opt.value)"
          role="option"
          class="select-menu-option"
          :class="{ 'is-active': i === activeIndex, 'is-selected': opt.value === model, 'is-disabled': opt.disabled }"
          :aria-selected="opt.value === model"
          :aria-disabled="opt.disabled"
          @mousedown.prevent
          @click="choose(i)"
          @mouseenter="!opt.disabled && (activeIndex = i)"
        >
          {{ opt.label }}
        </li>
        <li
          v-if="createPath"
          :id="optionId(createIndex)"
          role="option"
          class="select-menu-option select-menu-create"
          :class="{ 'is-active': activeIndex === createIndex }"
          @mousedown.prevent
          @click="chooseCreate"
          @mouseenter="activeIndex = createIndex"
        >
          <Plus :size="14" stroke-width="2" aria-hidden="true" />
          {{ createLabel }} ↗
        </li>
      </ul>
    </Teleport>
  </div>
</template>

<style scoped>
.select-menu {
  display: inline-block;
  max-width: 100%;
}
.select-menu-trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  min-width: 6rem;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: 0.9rem;
  text-align: left;
  cursor: pointer;
}
.select-menu-trigger:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.select-menu-trigger.is-open,
.select-menu-trigger:focus-visible {
  outline: 2px solid var(--signal);
  outline-offset: 1px;
}
.select-menu-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.select-menu-chevron {
  flex-shrink: 0;
  color: var(--text-muted);
}
</style>

<style>
/* Unscoped: the listbox is teleported to <body>, outside this component's
   scoped-attribute tree, so a `scoped` block here would never match it. */
.select-menu-listbox {
  z-index: var(--z-popover);
  margin: 0;
  padding: 0.25rem;
  list-style: none;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
}
.select-menu-option {
  padding: 0.4rem 0.6rem;
  border-radius: calc(var(--radius-sm) - 2px);
  font-size: 0.9rem;
  color: var(--text-primary);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.select-menu-option.is-active {
  background: var(--signal-soft);
}
.select-menu-option.is-selected {
  font-weight: 600;
}
.select-menu-option.is-disabled {
  color: var(--text-muted);
  cursor: not-allowed;
}
.select-menu-create {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.25rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border);
  color: var(--signal-strong);
  font-weight: 600;
}
</style>
