/**
 * Signature cipher for the TV client fallback (personal build only), ported
 * from YoutubeExplode (Bridge/PlayerSource.cs, Bridge/Cipher/*).
 *
 * A TV player response carries formats whose URL sits in `signatureCipher`
 * next to a scrambled signature `s`. The player script (base.js) scrambles
 * it with a short list of reverse / splice / swap steps; reading those steps
 * out of base.js and applying them gives the signature googlevideo accepts.
 * The player request must also name the script's `signatureTimestamp`.
 *
 * These are regexes over obfuscated code and break when YouTube reshapes
 * base.js. When they stop matching, compare with YoutubeExplode's
 * PlayerSource.cs.
 */

export const IFRAME_API_URL = 'https://www.youtube.com/iframe_api';

export const baseJsUrl = (version: string): string =>
  `https://www.youtube.com/s/player/${version}/player_ias.vflset/en_US/base.js`;

/** The 8-hex player version in iframe_api (slashes may be escaped as `\/`). */
export function parsePlayerVersion(iframeApi: string): string | undefined {
  return /player\\?\/([0-9a-fA-F]{8})\\?\//.exec(iframeApi)?.[1];
}

export type CipherOp =
  | { op: 'reverse' }
  | { op: 'splice'; index: number }
  | { op: 'swap'; index: number };

export interface CipherManifest {
  signatureTimestamp: string;
  operations: readonly CipherOp[];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Read the signature timestamp and the scramble steps out of base.js. */
export function parseCipherManifest(baseJs: string): CipherManifest | undefined {
  const signatureTimestamp = /(?:signatureTimestamp|sts):(\d{5})/.exec(baseJs)?.[1];
  if (!signatureTimestamp) return undefined;

  // e.g. Xy=function(a){a=a.split("");Ab.cd(a,3);Ab.ef(a,47);return a.join("")}
  const callsite = /[$_\w]+=function\([$_\w]+\){([$_\w]+)=\1\.split\(['"]{2}\);.*?return \1\.join\(['"]{2}\)}/s.exec(
    baseJs,
  )?.[0];
  if (!callsite) return undefined;

  const container = /([$_\w]+)\.[$_\w]+\([$_\w]+,\d+\);/.exec(callsite)?.[1];
  if (!container) return undefined;
  const definition = new RegExp(`var ${escapeRe(container)}={.*?};`, 's').exec(baseJs)?.[0];
  if (!definition) return undefined;

  const swapName = /([$_\w]+):function\([$_\w]+,[$_\w]+\){+[^}]*?%[^}]*?}/s.exec(definition)?.[1];
  const spliceName = /([$_\w]+):function\([$_\w]+,[$_\w]+\){+[^}]*?splice[^}]*?}/s.exec(definition)?.[1];
  const reverseName = /([$_\w]+):function\([$_\w]+\){+[^}]*?reverse[^}]*?}/s.exec(definition)?.[1];

  const operations: CipherOp[] = [];
  for (const statement of callsite.split(';')) {
    // the index argument is optional here: a reverse helper may be called without one
    const m = /[$_\w]+\.([$_\w]+)\([$_\w]+(?:,(\d+))?\)/.exec(statement);
    if (!m) continue;
    const [, name, arg] = m;
    const index = Number(arg);
    if (name === swapName && arg) operations.push({ op: 'swap', index });
    else if (name === spliceName && arg) operations.push({ op: 'splice', index });
    else if (name === reverseName) operations.push({ op: 'reverse' });
  }
  return operations.length ? { signatureTimestamp, operations } : undefined;
}

export function decipher(manifest: CipherManifest, signature: string): string {
  let s = signature;
  for (const o of manifest.operations) {
    if (o.op === 'reverse') s = [...s].reverse().join('');
    else if (o.op === 'splice') s = s.slice(o.index);
    else {
      const chars = [...s];
      const first = chars[0];
      const at = chars[o.index % chars.length];
      if (first === undefined || at === undefined) continue;
      chars[0] = at;
      chars[o.index % chars.length] = first;
      s = chars.join('');
    }
  }
  return s;
}

/**
 * The download URL of one format: its plain `url`, or the one in
 * `signatureCipher` (also `cipher`) with the deciphered signature set as
 * `sp` (default `sig`). Without a manifest, ciphered formats yield nothing.
 */
export function formatUrl(format: Record<string, unknown>, manifest?: CipherManifest): string | undefined {
  if (typeof format.url === 'string' && format.url) return format.url;
  const raw = typeof format.signatureCipher === 'string' ? format.signatureCipher : format.cipher;
  if (!manifest || typeof raw !== 'string' || !raw) return undefined;
  const q = new URLSearchParams(raw);
  const url = q.get('url');
  const s = q.get('s');
  if (!url || !s) return undefined;
  try {
    const u = new URL(url);
    u.searchParams.set(q.get('sp') || 'sig', decipher(manifest, s));
    return u.toString();
  } catch {
    return undefined;
  }
}
