export const PAGE_URL = "https://videos.example.org/watch/42";

/** A page that plays an HLS stream (the player hands the URL to MSE, so the element src is a blob:). */
export const PAGE_HTML = `<!doctype html>
<html><head><title>Intro clip - Example Videos</title></head>
<body>
  <video id="player" src="blob:https://videos.example.org/9f1c" poster="/p.jpg" width="640" height="360"></video>
  <video id="teaser" width="320" height="180"><source src="https://cdn.example.org/clips/teaser.mp4" type="video/mp4"></video>
</body></html>`;

export const MASTER_URL = "https://cdn.example.org/hls/master.m3u8";

export const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"
360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"
720p.m3u8
`;

export const MEDIA_VOD = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10.0,
s0.ts
#EXTINF:10.0,
s1.ts
#EXTINF:10.0,
s2.ts
#EXT-X-ENDLIST`;

export const MEDIA_LIVE = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:900
#EXTINF:6.0,
s900.ts
#EXTINF:6.0,
s901.ts`;

export const MEDIA_DRM = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:6.0,
s0.ts
#EXT-X-ENDLIST`;

export const MPD_URL = "https://cdn.example.org/dash/manifest.mpd";
export const MPD = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT20S" xmlns="urn:mpeg:dash:schema:mpd:2011">
 <Period>
  <AdaptationSet contentType="video" mimeType="video/mp4">
   <SegmentTemplate media="v$RepresentationID$-$Number$.m4s" initialization="v$RepresentationID$-init.mp4" duration="4" startNumber="1"/>
   <Representation id="v1" bandwidth="1000000" width="854" height="480" codecs="avc1.4d401f"/>
   <Representation id="v2" bandwidth="3000000" width="1920" height="1080" codecs="avc1.640028"/>
  </AdaptationSet>
  <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
   <SegmentTemplate media="a$RepresentationID$-$Number$.m4s" initialization="a$RepresentationID$-init.mp4" duration="4" startNumber="1"/>
   <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"/>
  </AdaptationSet>
 </Period>
</MPD>`;
