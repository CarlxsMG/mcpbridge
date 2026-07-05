import { useStoredToggle } from "./useStoredToggle";

export type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "mcpbridge:theme";

function isTheme(value: string | null): value is Theme {
  return value === "dark";
}

function applyTheme(t: Theme): void {
  if (t === "dark") {
    document.documentElement.dataset.theme = "dark";
  } else {
    delete document.documentElement.dataset.theme;
  }
}

const { value: theme, setValue: setTheme } = useStoredToggle<Theme>(THEME_STORAGE_KEY, isTheme, "light", applyTheme);

export function useTheme() {
  return { theme, setTheme };
}
