import { readonly, ref } from "vue";

export type Density = "comfortable" | "compact";

const DENSITY_STORAGE_KEY = "mcpbridge:density";

function readStoredDensity(): Density {
  return localStorage.getItem(DENSITY_STORAGE_KEY) === "compact" ? "compact" : "comfortable";
}

function applyDensity(d: Density): void {
  document.body.classList.toggle("density-compact", d === "compact");
}

const density = ref<Density>(readStoredDensity());

applyDensity(density.value);

export function useDensity() {
  function setDensity(d: Density): void {
    density.value = d;
    localStorage.setItem(DENSITY_STORAGE_KEY, d);
    applyDensity(d);
  }

  return { density: readonly(density), setDensity };
}
