import { useStoredToggle } from "./useStoredToggle";

export type Density = "comfortable" | "compact";

const DENSITY_STORAGE_KEY = "mcpbridge:density";

function isDensity(value: string | null): value is Density {
  return value === "compact";
}

function applyDensity(d: Density): void {
  document.body.classList.toggle("density-compact", d === "compact");
}

const { value: density, setValue: setDensity } = useStoredToggle<Density>(
  DENSITY_STORAGE_KEY,
  isDensity,
  "comfortable",
  applyDensity,
);

export function useDensity() {
  return { density, setDensity };
}
