import { describe, expect, it } from "vitest";
import { parseMaster, parseMedia, isMasterPlaylist, audioRenditionFor, sequenceIv } from "../../src/core/media/hls";
import { parseMpd, parseIsoDuration, fillTemplate } from "../../src/core/media/dash";
import { parseXml } from "../../src/core/media/xml";
import { selectWindow } from "../../src/core/media/window";

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"
360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,AVERAGE-BANDWIDTH=2200000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"
https://cdn.test/720p.m3u8?token=a,b
`;

describe("HLS", () => {
  it("parses a master playlist, highest first, with audio groups", () => {
    expect(isMasterPlaylist(MASTER)).toBe(true);
    const m = parseMaster(MASTER, "https://site.test/v/master.m3u8");
    expect(m.variants.map((v) => v.height)).toEqual([720, 360]);
    expect(m.variants[0]).toMatchObject({ bandwidth: 2_200_000, width: 1280, codecs: "avc1.64001f,mp4a.40.2", uri: "https://cdn.test/720p.m3u8?token=a,b" });
    expect(m.variants[1]!.uri).toBe("https://site.test/v/360p.m3u8");
    expect(audioRenditionFor(m, m.variants[0]!)?.uri).toBe("https://site.test/v/audio/en.m3u8");
  });

  it("parses VOD media playlists with byte ranges and an init map", () => {
    const media = parseMedia(
      `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXTINF:6.0,
#EXT-X-BYTERANGE:1000@720
all.mp4
#EXTINF:4.5,
#EXT-X-BYTERANGE:900
all.mp4
#EXT-X-ENDLIST`,
      "https://cdn.test/p/index.m3u8",
    );
    expect(media.live).toBe(false);
    expect(media.container).toBe("fmp4");
    expect(media.totalDuration).toBeCloseTo(10.5);
    expect(media.segments.map((s) => [s.sequence, s.start, s.byteRange])).toEqual([
      [100, 0, { offset: 720, length: 1000 }],
      [101, 6, { offset: 1720, length: 900 }],
    ]);
    expect(media.segments[0]!.map).toEqual({ uri: "https://cdn.test/p/init.mp4", byteRange: { offset: 0, length: 720 } });
  });

  it("flags live playlists and DRM key systems, but not plain AES-128", () => {
    const live = parseMedia("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.ts", "https://x.test/");
    expect(live.live).toBe(true);
    const aes = parseMedia('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST', "https://x.test/");
    expect(aes.protection).toBe("none");
    const fairplay = parseMedia('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST', "https://x.test/");
    expect(fairplay.protection).toBe("drm");
  });

  it("derives the default IV from the sequence number", () => {
    expect(Array.from(sequenceIv(258).slice(14))).toEqual([1, 2]);
  });
});

const REDDIT_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT42.5S" type="static">
  <Period duration="PT42.5S">
    <AdaptationSet contentType="video" segmentAlignment="true">
      <Representation id="720" bandwidth="2400000" codecs="avc1.4d401f" mimeType="video/mp4" width="1280" height="720" frameRate="30000/1001">
        <BaseURL>CMAF_720.mp4</BaseURL>
        <SegmentBase indexRange="800-1000"><Initialization range="0-799"/></SegmentBase>
      </Representation>
      <Representation id="480" bandwidth="1200000" codecs="avc1.4d401e" mimeType="video/mp4" width="854" height="480">
        <BaseURL>CMAF_480.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" lang="en">
      <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2" mimeType="audio/mp4"><BaseURL>CMAF_AUDIO_128.mp4</BaseURL></Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

describe("DASH", () => {
  it("parses SegmentBase representations as whole files (Reddit)", () => {
    const m = parseMpd(REDDIT_MPD, "https://v.redd.it/abc/DASHPlaylist.mpd?a=1");
    expect(m.duration).toBe(42.5);
    expect(m.video.map((r) => [r.height, r.addressing, r.segments[0]!.key, r.segments[0]!.url])).toEqual([
      [720, "whole", "whole", "https://v.redd.it/abc/CMAF_720.mp4"],
      [480, "whole", "whole", "https://v.redd.it/abc/CMAF_480.mp4"],
    ]);
    expect(m.video[0]!.frameRate).toBeCloseTo(29.97, 2);
    expect(m.audio[0]).toMatchObject({ id: "a128", language: "en", codecs: "mp4a.40.2" });
  });

  it("expands SegmentTemplate with $Number$ and a fixed duration", () => {
    const m = parseMpd(
      `<MPD mediaPresentationDuration="PT10S"><Period><AdaptationSet mimeType="video/mp4">
        <SegmentTemplate timescale="1000" duration="4000" startNumber="5" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number%03d$.m4s"/>
        <Representation id="hd" bandwidth="1" height="1080"/>
      </AdaptationSet></Period></MPD>`,
      "https://cdn.test/m/manifest.mpd",
    );
    const r = m.video[0]!;
    expect(r.init?.url).toBe("https://cdn.test/m/hd/init.mp4");
    expect(r.segments.map((s) => [s.key, s.url.split("/").pop(), s.start, s.duration])).toEqual([
      ["n5", "seg-005.m4s", 0, 4],
      ["n6", "seg-006.m4s", 4, 4],
      ["n7", "seg-007.m4s", 8, 2],
    ]);
  });

  it("expands SegmentTimeline with repeats and $Time$ keys", () => {
    const m = parseMpd(
      `<MPD><Period duration="PT9S"><AdaptationSet contentType="audio">
        <Representation id="a" bandwidth="2" codecs="opus">
          <SegmentTemplate timescale="10" media="a/$Time$.webm" initialization="a/init.webm">
            <SegmentTimeline><S t="0" d="30" r="1"/><S d="30"/></SegmentTimeline>
          </SegmentTemplate>
        </Representation>
      </AdaptationSet></Period></MPD>`,
      "https://cdn.test/x.mpd",
    );
    expect(m.audio[0]!.segments.map((s) => [s.key, s.start])).toEqual([
      ["t0", 0],
      ["t30", 3],
      ["t60", 6],
    ]);
  });

  it("marks ContentProtection as DRM", () => {
    const m = parseMpd(
      `<MPD><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"><cenc:pssh>AAAA</cenc:pssh></ContentProtection><Representation id="1" bandwidth="1"/></AdaptationSet></Period></MPD>`,
      "https://x.test/a.mpd",
    );
    expect(m.protection).toBe("drm");
  });

  it("helpers", () => {
    expect(parseIsoDuration("PT1H2M3.5S")).toBe(3723.5);
    expect(parseIsoDuration("P1DT1S")).toBe(86401);
    expect(fillTemplate("$RepresentationID$_$Bandwidth$_$$_$Number%05d$", { RepresentationID: "v", Bandwidth: 9, Number: 42 })).toBe("v_9_$_00042");
    expect(parseXml(`<a x='1 &amp; 2'><!-- c --><b><![CDATA[<raw>]]></b></a>`)).toMatchObject({ attrs: { x: "1 & 2" }, children: [{ name: "b", text: "<raw>" }] });
  });
});

describe("selectWindow", () => {
  const segs = [0, 4, 8, 12].map((start) => ({ start, duration: 4 }));
  it("keeps only overlapping segments and reports the seek offset", () => {
    const w = selectWindow(segs, { start: 5, end: 9 });
    expect(w.segments.map((s) => s.start)).toEqual([4, 8]);
    expect(w.offset).toBe(1);
    expect(w.length).toBe(4);
  });
  it("clamps past the end", () => {
    expect(selectWindow(segs, { start: 14, end: 99 })).toMatchObject({ length: 2, offset: 2 });
  });
});
