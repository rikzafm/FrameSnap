/**
 * YouTube player API lookup (personal build only), the way YoutubeExplode
 * (and so YoutubeDownloader) does it.
 *
 * The page's own WEB player response is SABR-only: its formats carry no URL,
 * or only a `signatureCipher`. The VISIONOS client gets plain googlevideo URLs
 * that need no signature or `n` solving and no PO token. When VISIONOS says
 * the video is unplayable, YoutubeExplode asks again as the ANDROID client,
 * and last as the TV embedded client, whose formats need the signature
 * cipher (see youtube-cipher.ts). `PLAYER_CLIENTS` keeps that order.
 *
 * These values are what YouTube expects today and will go stale: when the
 * lookup starts failing, compare them with yt-dlp's `INNERTUBE_CLIENTS`
 * (yt_dlp/extractor/youtube/_base.py).
 */

export const PLAYER_ENDPOINT = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
export const VISITOR_DATA_URL = 'https://www.youtube.com/sw.js_data';

export const VISIONOS_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

const VISIONOS_CLIENT = {
  clientName: 'VISIONOS',
  clientVersion: '1.02',
  deviceMake: 'Apple',
  deviceModel: 'RealityDevice17,1',
  osName: 'visionOS',
  osVersion: '26.5.23O471',
  hl: 'en',
  gl: 'US',
  utcOffsetMinutes: 0,
} as const;

/** Headers the player request needs. The caller applies them with a header rule: fetch drops User-Agent. */
export const PLAYER_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': VISIONOS_USER_AGENT,
  Origin: 'https://www.youtube.com',
  'X-Youtube-Client-Name': '101',
  'X-Youtube-Client-Version': VISIONOS_CLIENT.clientVersion,
};

/** Headers googlevideo should see when downloading a VISIONOS URL. */
export const MEDIA_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': VISIONOS_USER_AGENT,
};

export const ANDROID_USER_AGENT = 'com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip';

const ANDROID_CLIENT = {
  clientName: 'ANDROID',
  clientVersion: '21.26.364',
  androidSdkVersion: 30,
  osName: 'Android',
  osVersion: '11',
  hl: 'en',
  gl: 'US',
  utcOffsetMinutes: 0,
} as const;

/** One innertube client the lookup can pose as. */
export interface PlayerClient {
  /** Id prefix of the variants and audio tracks this client's reply yields. */
  prefix: string;
  /** Set when the client needs base.js: its formats are ciphered and the request names the signature timestamp. */
  ciphered?: true;
  requestBody(videoId: string, visitorData?: string, signatureTimestamp?: string): Record<string, unknown>;
  /** Headers for the player request (applied with a header rule). */
  requestHeaders: Readonly<Record<string, string>>;
  /** Headers googlevideo should see when downloading this client's URLs. */
  mediaHeaders: Readonly<Record<string, string>>;
}

function body(client: Record<string, unknown>, videoId: string, visitorData?: string): Record<string, unknown> {
  return {
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    context: { client: { ...client, ...(visitorData ? { visitorData } : {}) } },
  };
}

export const VISIONOS: PlayerClient = {
  prefix: 'vos:',
  requestBody: (videoId, visitorData) => body(VISIONOS_CLIENT, videoId, visitorData),
  requestHeaders: PLAYER_REQUEST_HEADERS,
  mediaHeaders: MEDIA_REQUEST_HEADERS,
};

export const ANDROID: PlayerClient = {
  prefix: 'and:',
  requestBody: (videoId, visitorData) => body(ANDROID_CLIENT, videoId, visitorData),
  requestHeaders: {
    'User-Agent': ANDROID_USER_AGENT,
    Origin: 'https://www.youtube.com',
    'X-Youtube-Client-Name': '3',
    'X-Youtube-Client-Version': ANDROID_CLIENT.clientVersion,
  },
  mediaHeaders: { 'User-Agent': ANDROID_USER_AGENT },
};

export const TV_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.114 Safari/537.36';

const TV_CLIENT = {
  clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
  clientVersion: '2.0',
  hl: 'en',
  gl: 'US',
  utcOffsetMinutes: 0,
} as const;

export const TV: PlayerClient = {
  prefix: 'tv:',
  ciphered: true,
  requestBody: (videoId, visitorData, signatureTimestamp) => ({
    videoId,
    context: {
      client: { ...TV_CLIENT, ...(visitorData ? { visitorData } : {}) },
      thirdParty: { embedUrl: 'https://www.youtube.com' },
    },
    ...(signatureTimestamp
      ? { playbackContext: { contentPlaybackContext: { signatureTimestamp: Number(signatureTimestamp) } } }
      : {}),
  }),
  requestHeaders: {
    'User-Agent': TV_USER_AGENT,
    Origin: 'https://www.youtube.com',
    'X-Youtube-Client-Name': '85',
    'X-Youtube-Client-Version': TV_CLIENT.clientVersion,
  },
  mediaHeaders: { 'User-Agent': TV_USER_AGENT },
};

/** Tried in order; the first reply with playable formats wins. */
export const PLAYER_CLIENTS: readonly PlayerClient[] = [VISIONOS, ANDROID, TV];

export function playerRequestBody(videoId: string, visitorData?: string): Record<string, unknown> {
  return VISIONOS.requestBody(videoId, visitorData);
}

/**
 * `sw.js_data` is `)]}'` followed by an unlabelled nested array; the visitor
 * data sits at [0][2][0][0][13] (same path YoutubeExplode reads).
 */
export function parseVisitorData(text: string): string | undefined {
  try {
    const json: unknown = JSON.parse(text.startsWith(")]}'") ? text.slice(4) : text);
    let at: unknown = json;
    for (const i of [0, 2, 0, 0, 13]) {
      if (!Array.isArray(at)) return undefined;
      at = at[i];
    }
    return typeof at === 'string' && at ? at : undefined;
  } catch {
    return undefined;
  }
}
