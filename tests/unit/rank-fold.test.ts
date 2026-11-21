import { describe, expect, it } from 'vitest';
import { foldCaptureDuplicates, rankSources } from '../../src/core/rank';
import type { VideoSource } from '../../src/core/model';

const PAGE = 'https://www.youtube.com/watch?v=abc';
const dom = { visibleRatio: 1, rectWidth: 800, rectHeight: 450, playing: true };

const adapter = (over: Partial<VideoSource> = {}): VideoSource => ({
  id: 'youtube:abc',
  site: 'youtube',
  title: 'A talk',
  pageUrl: PAGE,
  duration: 634.6,
  variants: [
    {
      id: 'vos:itag:137',
      kind: 'progressive',
      url: 'https://rr1.googlevideo.com/v?itag=137',
      container: 'mp4',
      height: 1080,
      hasAudio: false,
    },
  ],
  audioTracks: [],
  protection: 'none',
  detectedBy: ['adapter'],
  ...over,
});

const element = (over: Partial<VideoSource> = {}): VideoSource => ({
  id: 'dom:1',
  site: 'generic',
  title: 'A talk - YouTube',
  pageUrl: PAGE,
  duration: 635,
  variants: [
    {
      id: 'rec:e1',
      kind: 'recorder',
      url: 'blob:https://www.youtube.com/x',
      container: 'webm',
      height: 480,
      hasAudio: true,
    },
  ],
  audioTracks: [],
  protection: 'none',
  detectedBy: ['dom'],
  dom,
  frameRef: { frameId: 0, elementKey: 'e1' },
  ...over,
});

describe('foldCaptureDuplicates', () => {
  it("gives the adapter find the element's DOM facts and drops the recorder-only entry", () => {
    const out = rankSources([element(), adapter()]);
    expect(out.map((s) => s.id)).toEqual(['youtube:abc']);
    expect(out[0]!.dom).toEqual(dom);
    expect(out[0]!.frameRef).toEqual({ frameId: 0, elementKey: 'e1' });
  });

  it('leaves both when the lengths differ, the page differs, or two adapter finds match', () => {
    expect(foldCaptureDuplicates([element({ duration: 30 }), adapter()])).toHaveLength(2);
    expect(
      foldCaptureDuplicates([
        element({ pageUrl: 'https://www.youtube.com/watch?v=other' }),
        adapter(),
      ]),
    ).toHaveLength(2);
    expect(
      foldCaptureDuplicates([element(), adapter(), adapter({ id: 'youtube:def' })]),
    ).toHaveLength(3);
  });

  it('leaves an adapter find that has no variants yet, and an element with a real URL', () => {
    expect(foldCaptureDuplicates([element(), adapter({ variants: [] })])).toHaveLength(2);
    const progressive = element({
      variants: [
        {
          id: 'u',
          kind: 'progressive',
          url: 'https://cdn/x.mp4',
          container: 'mp4',
          hasAudio: true,
        },
      ],
    });
    expect(foldCaptureDuplicates([progressive, adapter()])).toHaveLength(2);
  });

  it("lets the page's main video claim the largest element while an ad plays in it", () => {
    const main = adapter({ mainVideo: true });
    const ad = element({ duration: 15 });
    const out = rankSources([ad, main]);
    expect(out.map((s) => s.id)).toEqual(['youtube:abc']);
    expect(out[0]!.frameRef).toEqual({ frameId: 0, elementKey: 'e1' });
    // a smaller element (a hover preview) stays listed, below the main video
    const preview = element({
      id: 'dom:2',
      duration: 20,
      dom: { ...dom, rectWidth: 300, rectHeight: 170 },
      frameRef: { frameId: 0, elementKey: 'e2' },
    });
    const out2 = rankSources([preview, ad, main]);
    expect(out2.map((s) => s.id)).toEqual(['youtube:abc', 'dom:2']);
  });

  it('without the main-video mark, a length mismatch still leaves both', () => {
    expect(foldCaptureDuplicates([element({ duration: 15 }), adapter()])).toHaveLength(2);
  });

  it('folds a site-specific network find with a duration-matching capture-only element', () => {
    const redditPage = 'https://www.reddit.com/r/videos/comments/1abc23/cat/';
    const net = adapter({
      id: 'reddit:v-k9x2m3q4',
      site: 'reddit',
      pageUrl: redditPage,
      duration: 12.1,
      detectedBy: ['network'],
      variants: [
        {
          id: 'dash:k9x2m3q4',
          kind: 'dash',
          url: 'https://v.redd.it/k9x2m3q4/DASHPlaylist.mpd',
          container: 'fmp4',
          hasAudio: false,
        },
      ],
    });
    const rec = element({ pageUrl: redditPage, duration: 12 });
    const out = rankSources([rec, net]);
    expect(out.map((s) => s.id)).toEqual(['reddit:v-k9x2m3q4']);
    expect(out[0]!.dom).toEqual(dom);
    expect(out[0]!.frameRef).toEqual({ frameId: 0, elementKey: 'e1' });
  });

  it('does not fold a generic network find with a capture-only element', () => {
    const net = adapter({ id: 'net:1', site: 'generic', detectedBy: ['network'] });
    expect(foldCaptureDuplicates([element(), net])).toHaveLength(2);
  });
});
