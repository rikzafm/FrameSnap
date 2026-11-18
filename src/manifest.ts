export interface ManifestOptions {
  /** Personal build only: adds the YouTube host permissions. */
  youtube: boolean;
}

const SITE_HOSTS = [
  '*://*.reddit.com/*',
  '*://*.redd.it/*',
  '*://*.redditmedia.com/*',
  '*://*.x.com/*',
  '*://*.twitter.com/*',
  '*://*.twimg.com/*',
  '*://*.discord.com/*',
  '*://cdn.discordapp.com/*',
  '*://media.discordapp.net/*',
];

const YOUTUBE_HOSTS = ['*://*.youtube.com/*', '*://*.googlevideo.com/*'];

export function buildManifest({ youtube }: ManifestOptions) {
  return {
    manifest_version: 3 as const,
    name: 'Frame Snap',
    version: '0.1.0',
    description: 'Download video, make GIFs and snap frames. Everything runs locally.',
    icons: {
      '16': 'icons/icon-16.png',
      '32': 'icons/icon-32.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    },
    action: {
      default_title: 'Frame Snap',
      default_popup: 'src/popup/index.html',
      default_icon: {
        '16': 'icons/icon-16.png',
        '32': 'icons/icon-32.png',
      },
    },
    options_page: 'src/options/index.html',
    background: {
      service_worker: 'src/background/index.ts',
      type: 'module' as const,
    },
    content_scripts: [
      {
        matches: ['<all_urls>'],
        js: ['src/content/index.ts'],
        run_at: 'document_idle' as const,
        all_frames: true,
        match_origin_as_fallback: true,
      },
    ],
    permissions: [
      'activeTab',
      'scripting',
      'downloads',
      'storage',
      'webRequest',
      'offscreen',
      'clipboardWrite',
      'commands',
      'alarms',
      'declarativeNetRequestWithHostAccess',
    ],
    host_permissions: youtube ? [...SITE_HOSTS, ...YOUTUBE_HOSTS] : [...SITE_HOSTS],
    optional_host_permissions: ['<all_urls>'],
    commands: {
      _execute_action: {
        description: 'Open Frame Snap',
      } as {
        suggested_key?: { default: string };
        description?: string;
      },
      'start-picker': {
        description: 'Pick a video on the page',
      } as {
        suggested_key?: { default: string };
        description?: string;
      },
      'snap-frame': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Snap the current frame',
      } as {
        suggested_key?: { default: string };
        description?: string;
      },
    },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  };
}
