import { describe, expect, it } from "vitest";
import { decipher, formatUrl, parseCipherManifest, parsePlayerVersion } from "../../src/adapters/youtube-cipher";
import { FAKE_BASE_JS } from "../helpers/fake-base-js";

/** What FAKE_BASE_JS does to a signature, step by step. */
function reference(s: string): string {
  const a = s.split("");
  a.reverse();
  const c = a[0]!;
  a[0] = a[3 % a.length]!;
  a[3 % a.length] = c;
  a.splice(0, 2);
  a.reverse();
  return a.join("");
}

describe("youtube signature cipher", () => {
  it("reads the signature timestamp and the steps, in callsite order", () => {
    expect(parseCipherManifest(FAKE_BASE_JS)).toEqual({
      signatureTimestamp: "20123",
      operations: [{ op: "reverse" }, { op: "swap", index: 3 }, { op: "splice", index: 2 }, { op: "reverse" }],
    });
  });

  it("deciphers exactly as the player script would", () => {
    const m = parseCipherManifest(FAKE_BASE_JS)!;
    for (const s of ["ABCDEFGHIJKLMNOP", "0123456789abcdefghij=="]) expect(decipher(m, s)).toBe(reference(s));
  });

  it("rejects a script it cannot read", () => {
    expect(parseCipherManifest("var x=1;")).toBeUndefined();
    expect(parseCipherManifest("sts:12345;")).toBeUndefined();
  });

  it("finds the player version in iframe_api, escaped or not", () => {
    expect(parsePlayerVersion(String.raw`var scriptUrl = 'https:\/\/www.youtube.com\/s\/player\/0b866fa6\/www-widgetapi.vflset\/www-widgetapi.js';`)).toBe("0b866fa6");
    expect(parsePlayerVersion("/s/player/deadbeef/x.js")).toBe("deadbeef");
    expect(parsePlayerVersion("nothing here")).toBeUndefined();
  });

  it("puts the deciphered signature on the URL under sp, keeping plain URLs as they are", () => {
    const m = parseCipherManifest(FAKE_BASE_JS)!;
    const url = "https://rr1.googlevideo.com/videoplayback?itag=18&expire=1";
    const signatureCipher = new URLSearchParams({ s: "ABCDEFGHIJKLMNOP", sp: "sig", url }).toString();
    const out = new URL(formatUrl({ signatureCipher }, m)!);
    expect(out.searchParams.get("sig")).toBe(reference("ABCDEFGHIJKLMNOP"));
    expect(out.searchParams.get("itag")).toBe("18");
    const noSp = new URLSearchParams({ s: "ABCDEFGHIJKLMNOP", url }).toString();
    expect(new URL(formatUrl({ cipher: noSp }, m)!).searchParams.has("sig")).toBe(true);
    expect(formatUrl({ signatureCipher })).toBeUndefined();
    expect(formatUrl({ url: "https://x/plain", signatureCipher }, m)).toBe("https://x/plain");
  });
});
