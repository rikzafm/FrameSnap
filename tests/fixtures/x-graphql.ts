/** Trimmed X GraphQL payloads (TweetDetail / timeline shapes). */
const mp4 = (bitrate: number, size: string, id = "1700000000000000001") => ({
  bitrate,
  content_type: "video/mp4",
  url: `https://video.twimg.com/ext_tw_video/${id}/pu/vid/avc1/${size}/clip.mp4?tag=12`,
});
const hls = (id = "1700000000000000001") => ({
  content_type: "application/x-mpegURL",
  url: `https://video.twimg.com/ext_tw_video/${id}/pu/pl/master.m3u8?tag=12`,
});

export const tweet = (restId: string, mediaKey: string, mediaId: string, media: Record<string, unknown>, text = "hello") => ({
  __typename: "Tweet",
  rest_id: restId,
  legacy: {
    full_text: text,
    extended_entities: {
      media: [
        {
          id_str: mediaId,
          media_key: mediaKey,
          media_url_https: `https://pbs.twimg.com/ext_tw_video_thumb/${mediaId}/pu/img/a.jpg`,
          ...media,
        },
      ],
    },
  },
});

const entry = (result: unknown) => ({
  content: { itemContent: { tweet_results: { result } } },
});

export const TWEET_ID = "1700000000000000001";
export const MEDIA_KEY = "7_1700000000000000001";

export const detail3Bitrates = {
  data: {
    threaded_conversation_with_injections_v2: {
      instructions: [
        {
          entries: [
            entry(
              tweet(TWEET_ID, MEDIA_KEY, TWEET_ID, {
                type: "video",
                video_info: {
                  duration_millis: 12000,
                  variants: [mp4(256000, "320x568"), mp4(832000, "480x852"), mp4(2176000, "720x1280"), hls()],
                },
              }),
            ),
          ],
        },
      ],
    },
  },
};

/** Second tweet is visibility-wrapped (TweetWithVisibilityResults); third is a photo. */
export const timeline2Videos = {
  data: {
    home: {
      instructions: [
        {
          entries: [
            entry(
              tweet("1800000000000000001", "7_1800000000000000001", "1800000000000000001", {
                type: "video",
                video_info: { duration_millis: 5000, variants: [mp4(832000, "480x852", "1800000000000000001")] },
              }),
            ),
            entry({
              __typename: "TweetWithVisibilityResults",
              tweet: tweet("1800000000000000002", "7_1800000000000000002", "1800000000000000002", {
                type: "video",
                video_info: { duration_millis: 8000, variants: [mp4(2176000, "720x1280", "1800000000000000002")] },
              }),
            }),
            entry(tweet("1800000000000000003", "3_1", "1", { type: "photo" })),
          ],
        },
      ],
    },
  },
};

export const gifTweet = {
  data: {
    tweet: tweet("1900000000000000001", "16_1900000000000000001", "1900000000000000001", {
      type: "animated_gif",
      video_info: {
        variants: [{ bitrate: 0, content_type: "video/mp4", url: "https://video.twimg.com/tweet_video/abc123.mp4" }],
      },
    }),
  },
};

export const hlsOnlyTweet = {
  data: {
    tweet: tweet("2000000000000000001", "7_2000000000000000001", "2000000000000000001", {
      type: "video",
      video_info: { duration_millis: 30000, variants: [hls("2000000000000000001")] },
    }),
  },
};
