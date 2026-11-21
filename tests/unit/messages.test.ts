import { describe, expect, it } from "vitest";
import { isContentToWorker, isJobEvent, isPopupToWorker, isWorkerToContent, isWorkerToPopup } from "../../src/core/messages";

const source = { id: "s", title: "t", variants: [], audioTracks: [] };

describe("message guards", () => {
  it("accepts well-formed popup messages and rejects malformed ones", () => {
    expect(isPopupToWorker({ t: "media/list", tabId: 1 })).toBe(true);
    expect(isPopupToWorker({ t: "media/list", tabId: "1" })).toBe(false);
    expect(isPopupToWorker({ t: "nope" })).toBe(false);
    expect(isPopupToWorker(null)).toBe(false);
    expect(isPopupToWorker("media/list")).toBe(false);
    expect(isPopupToWorker({ t: "demo/ping", tabId: 3, nonce: "n" })).toBe(true);
    expect(isPopupToWorker({ t: "demo/ping", tabId: 3 })).toBe(false);
  });

  it("validates job events", () => {
    expect(isJobEvent({ t: "queued", jobId: "j" })).toBe(true);
    expect(isJobEvent({ t: "queued" })).toBe(false);
    expect(isJobEvent({ t: "progress", jobId: "j", phase: "fetch", ratio: 0.5 })).toBe(true);
    expect(isJobEvent({ t: "progress", jobId: "j", phase: "bogus", ratio: 0.5 })).toBe(false);
    expect(isJobEvent({ t: "progress", jobId: "j", phase: "fetch", ratio: NaN })).toBe(false);
    expect(isJobEvent({ t: "done", jobId: "j", downloadId: 1, filename: "a.mp4" })).toBe(true);
    expect(isJobEvent({ t: "done", jobId: "j", downloadId: "1", filename: "a.mp4" })).toBe(false);
    expect(isJobEvent({ t: "failed", jobId: "j", error: { code: "network" }, resumable: true, keptRatio: 0.2 })).toBe(true);
    expect(isJobEvent({ t: "failed", jobId: "j", error: null, resumable: true, keptRatio: 0.2 })).toBe(false);
    expect(isJobEvent({ t: "cancelled", jobId: "j" })).toBe(true);
    expect(isJobEvent({ t: "resume-needs-pick", jobId: "j" })).toBe(true);
    expect(isJobEvent({ t: "zzz", jobId: "j" })).toBe(false);
  });

  it("validates worker-to-popup messages", () => {
    expect(isWorkerToPopup({ t: "media/updated", tabId: 1, sources: [source] })).toBe(true);
    expect(isWorkerToPopup({ t: "media/updated", tabId: 1, sources: "x" })).toBe(false);
    expect(isWorkerToPopup({ t: "media/updated", tabId: 1, sources: [{}] })).toBe(false);
    expect(isWorkerToPopup({ t: "job/event", event: { t: "cancelled", jobId: "j" } })).toBe(true);
    expect(isWorkerToPopup({ t: "job/event", event: { t: "cancelled" } })).toBe(false);
    expect(isWorkerToPopup({ t: "demo/pong", nonce: "n", reply: "hi" })).toBe(true);
    expect(isWorkerToPopup({ t: "demo/pong" })).toBe(false);
  });

  it("validates content-to-worker messages", () => {
    expect(isContentToWorker({ t: "dom/report", sources: [source], frameUrl: "https://a" })).toBe(true);
    expect(isContentToWorker({ t: "dom/report", sources: [source] })).toBe(false);
    expect(isContentToWorker({ t: "picker/picked", source })).toBe(true);
    expect(isContentToWorker({ t: "picker/picked", source: 1 })).toBe(false);
    expect(isContentToWorker({ t: "snap/data", dataUrl: "data:,", width: 1, height: 1, time: 0, title: "t" })).toBe(true);
    expect(isContentToWorker({ t: "snap/data", dataUrl: "data:,", width: "1", height: 1, time: 0, title: "t" })).toBe(false);
    expect(isContentToWorker({ t: "demo/pong", nonce: "n", reply: "hi" })).toBe(true);
    expect(isContentToWorker({ t: "x" })).toBe(false);
  });

  it("validates worker-to-content picker messages", () => {
    expect(isWorkerToContent({ t: "picker/start" })).toBe(true);
    expect(isWorkerToContent({ t: "picker/start", resumeJobId: "j", resumeTitle: "My clip" })).toBe(true);
    expect(isWorkerToContent({ t: "picker/start", resumeJobId: "" })).toBe(false);
    expect(isWorkerToContent({ t: "picker/cancel" })).toBe(true);
  });

  it("validates picker/action from content", () => {
    expect(isContentToWorker({ t: "picker/action", action: "gif", source })).toBe(true);
    expect(isContentToWorker({ t: "picker/action", action: "download", source })).toBe(true);
    expect(isContentToWorker({ t: "picker/action", action: "nuke", source })).toBe(false);
    expect(isContentToWorker({ t: "picker/action", action: "gif" })).toBe(false);
  });

  it("validates context target messages", () => {
    expect(isWorkerToContent({ t: "context/target" })).toBe(true);
    expect(isContentToWorker({ t: "context/target-report" })).toBe(true);
    expect(isContentToWorker({ t: "context/target-report", source })).toBe(true);
    expect(isContentToWorker({ t: "context/target-report", source: 42 })).toBe(false);
  });
});
