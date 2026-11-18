import { describe, expect, it } from 'vitest';
import { storeImageSvg, STORE_IMAGES } from '../../scripts/store-assets';

describe('store image sizes', () => {
  it('match the Chrome Web Store requirements', () => {
    expect(STORE_IMAGES.map((i) => [i.file, i.width, i.height])).toEqual([
      ['promo-small-440x280.png', 440, 280],
      ['promo-marquee-1400x560.png', 1400, 560],
    ]);
  });
});

describe('storeImageSvg', () => {
  it('is an svg of exactly the requested size containing the logo mark', () => {
    const svg = storeImageSvg({ width: 440, height: 280 });
    expect(svg).toMatch(/<svg[^>]* width="440" height="280"/);
    expect(svg).toContain('#C23A08');
  });

  it('places a screenshot when one is given', () => {
    const svg = storeImageSvg({
      width: 1280,
      height: 800,
      shot: { base64: 'AAAA', width: 380, height: 500 },
    });
    expect(svg).toContain('data:image/png;base64,AAAA');
  });
});
