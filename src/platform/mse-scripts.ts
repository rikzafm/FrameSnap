/**
 * MSE capture is opt-in per site: the MAIN-world hook is registered at
 * document_start only for origins the user granted at runtime (Q8), never for
 * the built-in sites. Chrome keeps the registration across restarts.
 */
export const MSE_SCRIPT_ID = "framesnap-mse-hook";

export interface MseScriptsApi {
  getRegistered(filter: { ids: string[] }): Promise<{ id: string; matches?: string[] }[]>;
  register(scripts: { id: string; matches: string[]; js: string[]; runAt: "document_start"; world: "MAIN"; allFrames: boolean; persistAcrossSessions: boolean }[]): Promise<void>;
  update(scripts: { id: string; matches: string[] }[]): Promise<void>;
  unregister(filter: { ids: string[] }): Promise<void>;
}

/** Match patterns that are granted at runtime, i.e. granted origins minus the manifest's own list. */
export function grantedOptionalOrigins(granted: readonly string[], builtIn: readonly string[]): string[] {
  const own = new Set(builtIn);
  return granted.filter((o) => !own.has(o) && o !== "<all_urls>" && /^(\*|https?):\/\//.test(o));
}

/** Make the registration match the granted origins. */
export async function syncMseScripts(api: MseScriptsApi, file: string, origins: readonly string[]): Promise<void> {
  const existing = (await api.getRegistered({ ids: [MSE_SCRIPT_ID] }))[0];
  if (origins.length === 0) {
    if (existing) await api.unregister({ ids: [MSE_SCRIPT_ID] });
    return;
  }
  const matches = [...origins];
  if (existing) await api.update([{ id: MSE_SCRIPT_ID, matches }]);
  else await api.register([{ id: MSE_SCRIPT_ID, matches, js: [file], runAt: "document_start", world: "MAIN", allFrames: true, persistAcrossSessions: true }]);
}
