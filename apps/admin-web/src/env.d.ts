/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute API origin in production; empty means "same origin". */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
