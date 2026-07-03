import { ref } from "vue";

export type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "mcpbridge:theme";

function readStoredTheme(): Theme {
  return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
}

function applyTheme(t: Theme): void {
  if (t === "dark") {
    document.documentElement.dataset.theme = "dark";
  } else {
    delete document.documentElement.dataset.theme;
  }
}

const theme = ref<Theme>(readStoredTheme());

applyTheme(theme.value);

export function useTheme() {
  function setTheme(t: Theme): void {
    theme.value = t;
    localStorage.setItem(THEME_STORAGE_KEY, t);
    applyTheme(t);
  }

  return { theme, setTheme };
}
