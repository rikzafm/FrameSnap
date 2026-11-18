/// <reference types="vite/client" />

/** Set by Vite `define`: true only for the personal (YouTube) build. */
declare const __YOUTUBE__: boolean;

/** crxjs: bundles the script and gives its output path (for registerContentScripts). */
declare module "*?script" {
  const path: string;
  export default path;
}
