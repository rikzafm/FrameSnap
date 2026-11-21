import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/platform/chrome', () => ({
  downloads: {},
  storage: {},
  tabs: {},
}));

import { downloadFrameUrl } from '../../src/background/snap-wire';

describe('downloadFrameUrl', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('converts data: URLs to blob: URLs when createObjectURL is available and revokes on completion', async () => {
    const listeners = new Set<(d: { id: number; state?: { current?: string } }) => void>();
    const download = vi.fn(async () => 42);
    const revoke = vi.fn();
    const create = vi.fn(() => 'blob:moz-extension://123/frame');
    const fetchFn = vi.fn(async () => new Response(new Blob(['png'], { type: 'image/png' })));

    const id = await downloadFrameUrl('data:image/png;base64,AAA', 'snap.png', {
      downloads: {
        download,
        onChanged: {
          addListener: (fn) => listeners.add(fn),
          removeListener: (fn) => listeners.delete(fn),
        },
      },
      fetch: fetchFn as unknown as typeof fetch,
      urls: { create, revoke },
    });

    expect(id).toBe(42);
    expect(download).toHaveBeenCalledWith({
      url: 'blob:moz-extension://123/frame',
      filename: 'snap.png',
      conflictAction: 'uniquify',
      saveAs: false,
    });
    expect(revoke).not.toHaveBeenCalled();

    for (const fn of [...listeners]) fn({ id: 99, state: { current: 'complete' } });
    expect(revoke).not.toHaveBeenCalled();

    for (const fn of [...listeners]) fn({ id: 42, state: { current: 'complete' } });
    expect(revoke).toHaveBeenCalledWith('blob:moz-extension://123/frame');
    expect(listeners.size).toBe(0);
  });

  it('revokes the blob URL immediately if downloads.download rejects', async () => {
    const listeners = new Set<(d: { id: number; state?: { current?: string } }) => void>();
    const revoke = vi.fn();
    const fetchFn = vi.fn(async () => new Response(new Blob(['png'], { type: 'image/png' })));

    await expect(
      downloadFrameUrl('data:image/png;base64,AAA', 'snap.png', {
        downloads: {
          download: async () => Promise.reject(new Error('denied')),
          onChanged: {
            addListener: (fn) => listeners.add(fn),
            removeListener: (fn) => listeners.delete(fn),
          },
        },
        fetch: fetchFn as unknown as typeof fetch,
        urls: { create: () => 'blob:tmp', revoke },
      }),
    ).rejects.toThrow('denied');

    expect(revoke).toHaveBeenCalledWith('blob:tmp');
    expect(listeners.size).toBe(0);
  });

  it('passes non-data URLs directly to downloads.download', async () => {
    const download = vi.fn(async () => 7);
    const id = await downloadFrameUrl('https://example.com/frame.png', 'frame.png', {
      downloads: {
        download,
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });
    expect(id).toBe(7);
    expect(download).toHaveBeenCalledWith({
      url: 'https://example.com/frame.png',
      filename: 'frame.png',
      conflictAction: 'uniquify',
      saveAs: false,
    });
  });
});
