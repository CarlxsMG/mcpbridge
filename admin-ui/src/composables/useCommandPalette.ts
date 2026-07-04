import { ref } from "vue";

const paletteOpen = ref(false);

export function useCommandPalette() {
  return { paletteOpen };
}
