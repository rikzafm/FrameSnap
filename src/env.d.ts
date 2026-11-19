/// <reference types="vite/client" />

/** crxjs: bundles the script and gives its output path (for registerContentScripts). */
declare module "*?script" {
  const path: string;
  export default path;
}
