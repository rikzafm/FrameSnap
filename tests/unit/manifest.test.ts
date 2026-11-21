import { describe, expect, it } from 'vitest';
import { buildManifest } from '../../src/manifest';

describe('manifest', () => {
  const store = buildManifest();

  it('is Manifest V3', () => {
    expect(store.manifest_version).toBe(3);
  });

  it('requests exactly the agreed permissions', () => {
    expect([...store.permissions].sort()).toEqual(
      [
        'activeTab',
        'scripting',
        'downloads',
        'storage',
        'webRequest',
        'offscreen',
        'clipboardWrite',
        'alarms',
        'declarativeNetRequestWithHostAccess',
        'contextMenus',
      ].sort(),
    );
  });

  it('does not list "commands" as a permission (it is a manifest key, and Chrome warns on the permission)', () => {
    expect(store.permissions).not.toContain('commands');
    expect(Object.keys(store.commands)).toContain('_execute_action');
  });

  it('asks for unlisted sites only at runtime', () => {
    expect(store.optional_host_permissions).toEqual(['<all_urls>']);
    expect(store.permissions).not.toContain('<all_urls>');
  });

  it('declares host permissions for the supported sites', () => {
    const hosts = store.host_permissions.join(' ');
    expect(hosts).toContain('reddit.com');
    expect(hosts).toContain('x.com');
    expect(hosts).toContain('discord.com');
  });

  it('declares the YouTube and googlevideo hosts', () => {
    const hosts = store.host_permissions.join(' ');
    expect(hosts).toMatch(/youtube\.com/);
    expect(hosts).toMatch(/googlevideo\.com/);
  });

  it('defines the three commands with Alt+Shift+S for snap-frame', () => {
    const c = store.commands;
    expect(Object.keys(c).sort()).toEqual(['_execute_action', 'snap-frame', 'start-picker']);
    expect(c['snap-frame']?.suggested_key?.default).toBe('Alt+Shift+S');
  });

  it('uses the strict extension-page CSP with wasm', () => {
    expect(store.content_security_policy.extension_pages).toBe(
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    );
  });

  it('ships icons at 16, 32, 48 and 128', () => {
    expect(Object.keys(store.icons).sort()).toEqual(['128', '16', '32', '48']);
    expect(store.action.default_icon).toEqual({
      '16': 'icons/icon-16.png',
      '32': 'icons/icon-32.png',
    });
  });
});

describe('manifest (firefox)', () => {
  const ff = buildManifest('firefox');

  it('uses background.scripts and options_ui in a tab, without offscreen permission', () => {
    expect(ff.manifest_version).toBe(3);
    expect(ff.background).toEqual({ scripts: ['src/background/index.ts'] });
    expect('options_page' in ff).toBe(false);
    expect(ff).toMatchObject({
      options_ui: { page: 'src/options/index.html', open_in_tab: true },
    });
    expect(ff.permissions).not.toContain('offscreen');
    expect([...ff.permissions].sort()).toEqual(
      [
        'activeTab',
        'scripting',
        'downloads',
        'storage',
        'webRequest',
        'clipboardWrite',
        'alarms',
        'declarativeNetRequestWithHostAccess',
        'contextMenus',
      ].sort(),
    );
  });

  it('declares browser_specific_settings.gecko with data_collection_permissions', () => {
    expect(ff).toMatchObject({
      browser_specific_settings: {
        gecko: {
          id: 'frame-snap@framesnap.app',
          strict_min_version: '128.0',
          data_collection_permissions: { required: ['none'] },
        },
      },
    });
  });

  it('keeps the same host permissions, commands and CSP as Chrome', () => {
    const chrome = buildManifest('chrome');
    expect(ff.host_permissions).toEqual(chrome.host_permissions);
    expect(ff.optional_host_permissions).toEqual(chrome.optional_host_permissions);
    expect(ff.commands).toEqual(chrome.commands);
    expect(ff.content_security_policy).toEqual(chrome.content_security_policy);
  });
});
