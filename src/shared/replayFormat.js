// Replay container: a small JSON header + columnar typed arrays, one binary blob.
// Columnar layout (all x's together, all y's together...) compresses far better than
// row-wise records, and loads in the browser with zero parsing: typed-array views only.
//
// Layout: [u32 headerBytes][header JSON utf8][pad to 8][column 0][pad][column 1]...

const TYPES = { Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array };

export function packReplay(meta, cols) {
  const entries = [];
  let offset = 0;
  for (const [name, arr] of Object.entries(cols)) {
    offset = (offset + 7) & ~7;
    const type = Object.keys(TYPES).find((k) => arr instanceof TYPES[k]);
    entries.push({ name, type, offset, length: arr.length });
    offset += arr.byteLength;
  }
  const header = new TextEncoder().encode(JSON.stringify({ meta, cols: entries }));
  const base = (4 + header.length + 7) & ~7;
  const out = new Uint8Array(base + offset);
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  let k = 0;
  for (const arr of Object.values(cols)) {
    out.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), base + entries[k++].offset);
  }
  return out;
}

export function unpackReplay(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Copy so the buffer is aligned and owned.
  const buf = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer;
  const hlen = new DataView(buf).getUint32(0, true);
  const { meta, cols } = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen)));
  const base = (4 + hlen + 7) & ~7;
  const out = {};
  for (const c of cols) out[c.name] = new TYPES[c.type](buf, base + c.offset, c.length);
  return { meta, cols: out };
}

/** Growable typed column used by the recorder. */
export class Col {
  constructor(Type, cap = 1024) { this.T = Type; this.a = new Type(cap); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) { const b = new this.T(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
    return this.n - 1;
  }
  set(i, v) { this.a[i] = v; }
  done() { return this.a.slice(0, this.n); }
}
