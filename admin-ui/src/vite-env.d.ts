/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" only in the public demo build (VITE_DEMO=true) — see demo/demo.ts. */
  readonly VITE_DEMO?: string;
}
