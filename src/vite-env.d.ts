/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Shared secret for quest app attestation. Must match the APP_ATTEST_SECRET
   * Pages secret on the coldstar Pages project. Vite inlines this into the
   * bundle, so it is extractable from a shipped app by design — see
   * coldstar-website/functions/_lib/attest.js for the threat model.
   */
  readonly VITE_APP_ATTEST_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.png' {
  const value: string;
  export default value;
}

declare module '*.jpg' {
  const value: string;
  export default value;
}

declare module '*.jpeg' {
  const value: string;
  export default value;
}

declare module '*.gif' {
  const value: string;
  export default value;
}

declare module '*.svg' {
  const value: string;
  export default value;
}

declare module '*.webp' {
  const value: string;
  export default value;
}
