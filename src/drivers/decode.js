/*
 * Register block planning + decoding shared by the Modbus driver.
 *
 * planBlocks() groups a template's registers into as few Modbus reads as
 * possible (max 120 words per request, gaps up to `maxGap` words are read and
 * thrown away - one round trip beats two).
 *
 * decodeBlock() turns the raw 16-bit words of one read into metric values,
 * honouring the data type, word order, scale and optional transform.
 */
const WORDS = { int16: 1, uint16: 1, int32: 2, uint32: 2, float32: 2, int64: 4, uint64: 4, float64: 4 };

const wordsOf = (type) => WORDS[type] || 2;

const planBlocks = (registers, { maxWords = 120, maxGap = 16 } = {}) => {
  const regs = registers
    .filter((r) => Number.isFinite(r.addr))
    .map((r) => ({ ...r, words: wordsOf(r.type) }))
    .sort((a, b) => a.addr - b.addr);
  const blocks = [];
  let cur = null;
  for (const r of regs) {
    const end = r.addr + r.words; // exclusive
    if (cur && r.addr - cur.end <= maxGap && end - cur.start <= maxWords) {
      cur.end = Math.max(cur.end, end);
      cur.regs.push(r);
    } else {
      cur = { start: r.addr, end, regs: [r] };
      blocks.push(cur);
    }
  }
  return blocks.map((b) => ({ start: b.start, count: b.end - b.start, regs: b.regs }));
};

// Reorder the raw bytes of one value according to the word order flag.
//   ABCD - big endian (default for Schneider, Eastron, Siemens)
//   CDAB - word swapped (many Chinese meters)
//   BADC - byte swapped within each word
//   DCBA - little endian
const orderBytes = (buf, wordOrder) => {
  if (!wordOrder || wordOrder === 'ABCD') return buf;
  const words = [];
  for (let i = 0; i < buf.length; i += 2) words.push(buf.subarray(i, i + 2));
  let out;
  if (wordOrder === 'CDAB') out = Buffer.concat(words.reverse());
  else if (wordOrder === 'BADC') out = Buffer.concat(words.map((w) => Buffer.from([w[1], w[0]])));
  else if (wordOrder === 'DCBA') out = Buffer.from([...buf].reverse());
  else out = buf;
  return out;
};

const readValue = (buf, type) => {
  switch (type) {
    case 'int16': return buf.readInt16BE(0);
    case 'uint16': return buf.readUInt16BE(0);
    case 'int32': return buf.readInt32BE(0);
    case 'uint32': return buf.readUInt32BE(0);
    case 'int64': return Number(buf.readBigInt64BE(0));
    case 'uint64': return Number(buf.readBigUInt64BE(0));
    case 'float64': return buf.readDoubleBE(0);
    case 'float32':
    default: return buf.readFloatBE(0);
  }
};

/**
 * @param words   Array of 16-bit words returned by the read (block.count long)
 * @param block   the planned block (start, regs)
 * @param wordOrder
 * @param transforms  { name: fn } lookup for register.transform
 */
const decodeBlock = (words, block, wordOrder, transforms = {}) => {
  const buf = Buffer.alloc(words.length * 2);
  words.forEach((w, i) => buf.writeUInt16BE(w & 0xffff, i * 2));
  const out = {};
  for (const r of block.regs) {
    const off = (r.addr - block.start) * 2;
    const raw = buf.subarray(off, off + r.words * 2);
    if (raw.length < r.words * 2) continue;
    let v = readValue(orderBytes(Buffer.from(raw), r.wordOrder || wordOrder), r.type || 'float32');
    if (!Number.isFinite(v)) continue;
    if (Number.isFinite(r.scale) && r.scale !== 1) v *= r.scale;
    if (Number.isFinite(r.offset)) v += r.offset;
    if (r.transform && transforms[r.transform]) v = transforms[r.transform](v);
    if (!Number.isFinite(v)) continue;
    out[r.key] = v;
  }
  return out;
};

/** Pull metric values out of a JSON object using a { metricKey: 'dotted.path' } map. */
const pickJson = (obj, jsonMap) => {
  const out = {};
  if (!obj || !jsonMap) return out;
  for (const [key, pathStr] of Object.entries(jsonMap)) {
    const parts = String(pathStr).split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur === null || cur === undefined) break;
      cur = cur[p];
    }
    const n = typeof cur === 'string' ? parseFloat(cur) : cur;
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
};

module.exports = { planBlocks, decodeBlock, pickJson, wordsOf };
