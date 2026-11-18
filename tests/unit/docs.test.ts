import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildManifest } from '../../src/manifest';

const read = (p: string) => readFileSync(p, 'utf8');

describe('docs/store/permissions.md', () => {
  const doc = read('docs/store/permissions.md');
  const store = buildManifest({ youtube: false });

  it('explains every permission the store build requests, one bullet each', () => {
    for (const p of [
      ...store.permissions,
      'optional_host_permissions',
      'host_permissions',
      'content_scripts',
    ]) {
      expect(doc, p).toMatch(new RegExp(`^- \`${p}\``, 'm'));
    }
  });

  it('says that resumable partial media is kept on the device for 7 days under storage', () => {
    expect(doc).toMatch(/`storage`[^\n]*(resum|partial)[^\n]*7 days/i);
  });

  it('does not mention YouTube, which the store build does not contain', () => {
    expect(doc).not.toMatch(/youtube|googlevideo/i);
  });
});

describe('README.md', () => {
  const readme = read('README.md');

  it('documents loading unpacked, both builds and the privacy stance', () => {
    expect(readme).toMatch(/Load unpacked/);
    expect(readme).toMatch(/npm run build\b/);
    expect(readme).toMatch(/npm run build:personal/);
    expect(readme).toMatch(/## Privacy/);
  });

  it('only references npm scripts that exist', () => {
    const scripts = Object.keys((JSON.parse(read('package.json')) as { scripts: object }).scripts);
    for (const m of readme.matchAll(/npm run ([\w:-]+)/g)) expect(scripts, m[1]).toContain(m[1]);
  });
});

describe('manual test checklists and limitations', () => {
  it('exist for every supported site', () => {
    for (const f of ['reddit', 'x', 'discord', 'youtube', 'generic']) {
      expect(existsSync(`docs/testing/manual-${f}.md`), f).toBe(true);
    }
  });

  it('known-limitations covers each limit in spec section 10', () => {
    const doc = read('docs/known-limitations.md');
    for (const phrase of [
      /keyframe/i,
      /single-threaded/i,
      /1\.6 GB/,
      /MediaRecorder/,
      /captureVisibleTab/,
      /7 days/,
      /first period/i,
      /adapters break/i,
    ]) {
      expect(doc).toMatch(phrase);
    }
  });
});
