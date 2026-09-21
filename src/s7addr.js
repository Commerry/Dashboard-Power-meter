/*
 * Siemens S7 variable addresses in Node-RED (node-red-contrib-s7 / nodes7) syntax.
 *
 * Shared by the server (validation, driver) and the browser (PLC settings page):
 * plain script in the browser (window.S7Addr), CommonJS module in Node.
 *
 *   DB1004,REAL20      REAL at byte 20 of DB1004
 *   DB1,X0.3           BOOL bit 3 of byte 0 in DB1
 *   DB1,INT4  DB1,DINT8  DB1,WORD2  DB1,DWORD4  DB1,BYTE6  DB1,LREAL16
 *   MR10  MW10  MD10  MB10  M0.0 / MX0.0      memory (flags)
 *   IX0.0  I0.0  IB0  IW0  ID0   (E0.0 also)  inputs
 *   QX0.0  Q0.0  QB0  QW0  QD0   (A0.0 also)  outputs
 *
 * parse(text)  -> { area, db, start, bit, type } or null
 * format(tag)  -> "DB1004,REAL20"
 * explain(text)-> human readable reason when parse() fails
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.S7Addr = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  // type code (as written in the address) -> canonical type used by the driver
  const TYPES = {
    X: 'BOOL', BOOL: 'BOOL',
    B: 'BYTE', BYTE: 'BYTE', C: 'BYTE', CHAR: 'BYTE', USINT: 'BYTE', SINT: 'BYTE',
    W: 'WORD', WORD: 'WORD', UINT: 'WORD',
    I: 'INT', INT: 'INT',
    D: 'DWORD', DW: 'DWORD', DWORD: 'DWORD', UDINT: 'DWORD',
    DI: 'DINT', DINT: 'DINT',
    R: 'REAL', REAL: 'REAL',
    LR: 'LREAL', LREAL: 'LREAL',
  };
  const SIZE = { BOOL: 1, BYTE: 1, INT: 2, WORD: 2, DINT: 4, DWORD: 4, REAL: 4, LREAL: 8 };
  // memory-area letters, German mnemonics included
  const AREAS = { M: 'M', I: 'I', E: 'I', Q: 'Q', A: 'Q' };

  const parse = (text) => {
    const s = String(text || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!s) return null;
    // DB<n>,<TYPE><byte>[.<bit>]
    let m = /^DB(\d+),([A-Z]+)(\d+)(?:\.(\d+))?$/.exec(s);
    if (m) {
      const type = TYPES[m[2]];
      if (!type) return null;
      const tag = { area: 'DB', db: Number(m[1]), start: Number(m[3]), type };
      if (type === 'BOOL') { tag.bit = m[4] === undefined ? 0 : Number(m[4]); if (tag.bit > 7) return null; } else if (m[4] !== undefined) return null;
      return tag;
    }
    // <AREA>[<TYPE>]<byte>[.<bit>]   (M0.0 = bit, MB0 byte, MW0 word, MD0 dword, MR0 real, MX0.0 bit)
    m = /^([MIEQA])([A-Z]*)(\d+)(?:\.(\d+))?$/.exec(s);
    if (m) {
      const area = AREAS[m[1]];
      let type;
      if (!m[2]) type = m[4] !== undefined ? 'BOOL' : null;
      else type = TYPES[m[2]] || null;
      if (!type) return null;
      const tag = { area, start: Number(m[3]), type };
      if (type === 'BOOL') { tag.bit = m[4] === undefined ? 0 : Number(m[4]); if (tag.bit > 7) return null; } else if (m[4] !== undefined) return null;
      return tag;
    }
    return null;
  };

  const explain = (text) => {
    const s = String(text || '').trim();
    if (!s) return 'address is empty';
    if (parse(s)) return '';
    if (/,\s*\w+\d+\s*,\s*\d+/.test(s) || /\bS\d+\.\d+/i.test(s) || /STRING/i.test(s)) return 'arrays and strings are not supported — one value per variable';
    if (/^DB/i.test(s) && !/,/.test(s)) return 'DB addresses need a comma: DB1004,REAL20';
    const m = /^(?:DB\d+,|[MIEQA])([A-Z]*)(\d+)(?:\.(\d+))?$/.exec(s.toUpperCase().replace(/\s+/g, ''));
    if (m && m[3] !== undefined && TYPES[m[1]] && TYPES[m[1]] !== 'BOOL') return `${TYPES[m[1]]} takes no bit number - write ${s.split('.')[0]}`;
    if (m && m[3] !== undefined && (!m[1] || TYPES[m[1]]) && Number(m[3]) > 7) return 'bit number must be 0-7';
    if (/^DB\d+,/i.test(s)) return 'unknown type — use X (bit), BYTE, INT, WORD, DINT, DWORD, REAL or LREAL';
    return 'use Node-RED syntax: DB1004,REAL20 · DB1,X0.3 · MW10 · I0.0 · QB2';
  };

  const format = (tag) => {
    if (!tag || !Number.isFinite(Number(tag.start))) return '';
    const type = String(tag.type || 'REAL').toUpperCase();
    const area = String(tag.area || 'DB').toUpperCase();
    const bit = type === 'BOOL' ? `.${tag.bit || 0}` : '';
    if (area === 'DB') return `DB${tag.db || 1},${type === 'BOOL' ? 'X' : type}${tag.start}${bit}`;
    const code = { BOOL: 'X', BYTE: 'B', INT: 'I', WORD: 'W', DINT: 'DI', DWORD: 'D', REAL: 'R', LREAL: 'LR' }[type] || 'R';
    return `${area}${code}${tag.start}${bit}`;
  };

  const sizeOf = (type) => SIZE[String(type || 'REAL').toUpperCase()] || 4;

  return { parse, format, explain, sizeOf, TYPES: Object.keys(SIZE) };
}));
