/** A fixture MSE player: just enough MediaSource / SourceBuffer for the hook to wrap. */
export class FakeSourceBuffer {
  appended: Uint8Array[] = [];
  appendBuffer(data: BufferSource): void {
    this.appended.push(data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
}

export class FakeMediaSource {
  buffers: FakeSourceBuffer[] = [];
  addSourceBuffer(mime: string): FakeSourceBuffer {
    void mime;
    const sb = new FakeSourceBuffer();
    this.buffers.push(sb);
    return sb;
  }
}

export function fakeMseWindow() {
  let n = 0;
  const URLCtor = {
    createObjectURL: (obj: unknown): string => (void obj, `blob:https://site.test/${++n}`),
    revokeObjectURL: (url: string): void => void url,
  };
  return { MediaSource: FakeMediaSource, SourceBuffer: FakeSourceBuffer, URL: URLCtor };
}

const box = (type: string, payload: number[] = []): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
};

export const concatBytes = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** ftyp + moov. */
export const initSegment = (tag = 0): Uint8Array<ArrayBuffer> => concatBytes(box("ftyp", [tag]), box("moov", [tag]));
/** moof + mdat. */
export const mediaSegment = (n: number, size = 4): Uint8Array<ArrayBuffer> => concatBytes(box("moof", [n]), box("mdat", new Array<number>(size).fill(n)));
