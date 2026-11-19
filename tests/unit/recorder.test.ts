import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordVideo, type RecorderCtor } from "../../src/content/recorder";

class FakeRecorder {
  static last: FakeRecorder | undefined;
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  readonly mimeType = "video/webm";
  constructor(
    readonly stream: unknown,
    readonly options?: { mimeType?: string },
  ) {
    FakeRecorder.last = this;
  }
  start(): void {
    this.state = "recording";
  }
  pause(): void {
    this.state = "paused";
  }
  resume(): void {
    this.state = "recording";
  }
  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["webm-bytes"], { type: "video/webm" }) });
    this.onstop?.();
  }
  static isTypeSupported = (t: string) => t.startsWith("video/webm");
}

function fakeVideo(over: Partial<{ paused: boolean; ended: boolean; currentTime: number; duration: number }> = {}) {
  const listeners = new Map<string, (() => void)[]>();
  return {
    paused: false,
    ended: false,
    currentTime: 0,
    duration: 60,
    captureStream: vi.fn(() => ({ getTracks: () => [] })),
    addEventListener: (t: string, fn: () => void) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
    removeEventListener: () => undefined,
    fire: (t: string) => listeners.get(t)?.forEach((f) => f()),
    ...over,
  };
}

describe("recordVideo (MediaRecorder fallback)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("records the requested seconds in real time and reports progress", async () => {
    const video = fakeVideo();
    const ratios: number[] = [];
    const p = recordVideo(video as never, { durationSec: 5, Recorder: FakeRecorder as unknown as RecorderCtor, onProgress: (r) => ratios.push(r) });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(FakeRecorder.last!.state).toBe("recording");
    expect(ratios.at(-1)!).toBeGreaterThan(0.3);
    expect(ratios.at(-1)!).toBeLessThan(0.7);
    await vi.advanceTimersByTimeAsync(2_600);
    const out = await p;
    expect(FakeRecorder.last!.state).toBe("inactive");
    expect(out.mime).toBe("video/webm");
    expect(out.container).toBe("webm");
    expect(out.blob.size).toBeGreaterThan(0);
    expect(ratios.at(-1)).toBe(1);
  });

  it("pauses the recorder and the clock while the video is paused or buffering", async () => {
    const video = fakeVideo();
    const p = recordVideo(video as never, { durationSec: 4, Recorder: FakeRecorder as unknown as RecorderCtor });
    await vi.advanceTimersByTimeAsync(2_000);
    video.paused = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeRecorder.last!.state).toBe("paused");
    video.paused = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeRecorder.last!.state).toBe("recording");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(FakeRecorder.last!.state).toBe("inactive");
    expect((await p).blob.size).toBeGreaterThan(0);
  });

  it("stops early when the video ends", async () => {
    const video = fakeVideo();
    const p = recordVideo(video as never, { durationSec: 30, Recorder: FakeRecorder as unknown as RecorderCtor });
    await vi.advanceTimersByTimeAsync(1_000);
    video.fire("ended");
    expect((await p).blob.size).toBeGreaterThan(0);
  });

  it("asks to play the video when it is paused and cannot be started", async () => {
    const opts = { durationSec: 5, Recorder: FakeRecorder as unknown as RecorderCtor };
    await expect(recordVideo(fakeVideo({ paused: true }) as never, opts)).rejects.toMatchObject({ appError: { code: "not-playing" } });
    const refused = { ...fakeVideo({ paused: true }), play: vi.fn(async () => Promise.reject(new DOMException("blocked", "NotAllowedError"))) };
    await expect(recordVideo(refused as never, opts)).rejects.toMatchObject({ appError: { code: "not-playing" } });
    expect(refused.play).toHaveBeenCalledOnce();
    await expect(recordVideo(fakeVideo({ paused: true, ended: true }) as never, opts)).rejects.toMatchObject({ appError: { code: "not-playing" } });
  });

  it("starts a paused video itself when the page allows it", async () => {
    const video = fakeVideo({ paused: true });
    const playable = Object.assign(video, {
      play: vi.fn(async () => {
        video.paused = false;
      }),
    });
    const p = recordVideo(playable as never, { durationSec: 1, Recorder: FakeRecorder as unknown as RecorderCtor });
    await vi.advanceTimersByTimeAsync(1_300);
    expect(playable.play).toHaveBeenCalledOnce();
    expect((await p).blob.size).toBeGreaterThan(0);
  });

  it("stops and rejects as cancelled when aborted", async () => {
    const video = fakeVideo();
    const ac = new AbortController();
    const p = recordVideo(video as never, { durationSec: 30, Recorder: FakeRecorder as unknown as RecorderCtor, signal: ac.signal });
    const settled = expect(p).rejects.toMatchObject({ appError: { code: "cancelled" } });
    await vi.advanceTimersByTimeAsync(1_000);
    ac.abort();
    await settled;
    expect(FakeRecorder.last!.state).toBe("inactive");
  });
});
