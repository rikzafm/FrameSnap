/** Reddit fixtures: serialized page fragments (shadow content inlined) and MPDs. */

export const NEW_POST_URL = "https://www.reddit.com/r/videos/comments/1abc23/cat_jumps/";
export const NEW_POST_HTML = `
<shreddit-post id="t3_1abc23" post-title="Cat jumps" post-type="video" content-href="https://v.redd.it/k9x2m3q4">
  <shreddit-player-2 src="https://v.redd.it/k9x2m3q4/HLSPlaylist.m3u8?f=hd" poster="https://preview.redd.it/k9x2m3q4.png">
    <video src="blob:https://www.reddit.com/aa11"></video>
  </shreddit-player-2>
</shreddit-post>`;

export const OLD_POST_URL = "https://old.reddit.com/r/videos/comments/2def45/dog_swims/";
export const OLD_POST_HTML = `
<div class="thing link" data-fullname="t3_2def45">
  <p class="title"><a class="title may-blank" href="/r/videos/comments/2def45/dog_swims/">Dog swims</a></p>
  <div class="reddit-video-player-root" data-seek-preview-url="" data-hls-url="https://v.redd.it/p7q8r9s0/HLSPlaylist.m3u8" data-mpd-url="https://v.redd.it/p7q8r9s0/DASHPlaylist.mpd?a=1&amp;v=1"></div>
</div>`;

export const FEED_URL = "https://www.reddit.com/r/videos/";
export const FEED_HTML = `
<shreddit-post id="t3_aaa111" post-title="First clip" post-type="video">
  <shreddit-player src="https://v.redd.it/vid111/HLSPlaylist.m3u8"></shreddit-player>
</shreddit-post>
<shreddit-post id="t3_bbb222" post-title="Second clip" post-type="video">
  <shreddit-player src="https://v.redd.it/vid222/HLSPlaylist.m3u8"></shreddit-player>
</shreddit-post>
<shreddit-post id="t3_ccc333" post-title="Just an image" post-type="image"></shreddit-post>`;

export const COMMENT_URL = "https://www.reddit.com/r/videos/comments/3ghi67/text_post/";
export const COMMENT_HTML = `
<shreddit-post id="t3_3ghi67" post-title="Text post" post-type="text"></shreddit-post>
<shreddit-comment thingid="t1_kz9y8x" author="someone">
  <shreddit-player src="https://v.redd.it/cmt999/HLSPlaylist.m3u8"></shreddit-player>
</shreddit-comment>`;

export const VIDEO_PLAYER_SRC_URL = "https://www.reddit.com/r/videos/comments/4jkl89/new_player/";
export const VIDEO_PLAYER_SRC_HTML = `
<shreddit-post id="t3_4jkl89" post-title="New player" post-type="video">
  <shreddit-video-player src="https://v.redd.it/nvp111/HLSPlaylist.m3u8" poster="https://preview.redd.it/nvp111.png"></shreddit-video-player>
</shreddit-post>`;

export const VIDEO_PLAYER_URL_ATTR_URL = "https://www.reddit.com/r/videos/comments/5mno01/video_url_attr/";
export const VIDEO_PLAYER_URL_ATTR_HTML = `
<shreddit-post id="t3_5mno01" post-title="Video URL attr" post-type="video">
  <shreddit-video-player video-url="https://v.redd.it/nvp222/HLSPlaylist.m3u8"></shreddit-video-player>
</shreddit-post>`;

export const CONTENT_HREF_ONLY_URL = "https://www.reddit.com/r/videos/comments/6pqr23/lazy_post/";
export const CONTENT_HREF_ONLY_HTML = `
<shreddit-post id="t3_6pqr23" post-title="Lazy post" post-type="video" content-href="https://v.redd.it/lazy333"></shreddit-post>`;

const base = (id: string) => `https://v.redd.it/${id}/`;

/** New CMAF names, with audio. */
export const MPD_CMAF_URL = `${base("k9x2m3q4")}DASHPlaylist.mpd`;
export const MPD_CMAF = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT12S" xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="1" bandwidth="2400000" width="1280" height="720" codecs="avc1.64001f"><BaseURL>CMAF_720.mp4</BaseURL><SegmentBase indexRange="800-1000"><Initialization range="0-799"/></SegmentBase></Representation>
      <Representation id="2" bandwidth="1200000" width="854" height="480" codecs="avc1.4d401e"><BaseURL>CMAF_480.mp4</BaseURL><SegmentBase indexRange="800-1000"><Initialization range="0-799"/></SegmentBase></Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <Representation id="3" bandwidth="128000" codecs="mp4a.40.2"><BaseURL>CMAF_AUDIO_128.mp4</BaseURL><SegmentBase indexRange="700-900"><Initialization range="0-699"/></SegmentBase></Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

/** Legacy DASH_* names, with audio. */
export const MPD_LEGACY_URL = "https://v.redd.it/p7q8r9s0/DASHPlaylist.mpd";
export const MPD_LEGACY = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT8S" xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v1" bandwidth="1500000" width="1280" height="720" codecs="avc1.4d401f"><BaseURL>DASH_720.mp4</BaseURL><SegmentBase indexRange="700-900"><Initialization range="0-699"/></SegmentBase></Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <Representation id="a1" bandwidth="64000" codecs="mp4a.40.2"><BaseURL>DASH_audio.mp4</BaseURL><SegmentBase indexRange="600-800"><Initialization range="0-599"/></SegmentBase></Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

/** A silent clip: no audio adaptation set. */
export const MPD_SILENT_URL = `${base("vid111")}DASHPlaylist.mpd`;
export const MPD_SILENT = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT5S" xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="s1" bandwidth="900000" width="640" height="360" codecs="avc1.4d401e"><BaseURL>CMAF_360.mp4</BaseURL><SegmentBase indexRange="700-900"><Initialization range="0-699"/></SegmentBase></Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
