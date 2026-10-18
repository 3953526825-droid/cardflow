'use strict';
/*
 * 极简 zip 读写，供「离线版的备份 / 恢复」用（安卓壳里没有 node:zlib）。
 *
 * 写：只用 store（不压缩）—— 备份包本来就很小，换来的是完全同步、无依赖的实现；
 *     结构是最标准的 zip，电脑版的 src/zip.js（unzipSync）能直接读。
 * 读：同时支持 store(0) 与 deflate(8) —— 电脑上生成的备份包是 deflate 的，手机上要能还原。
 *     浏览器用 DecompressionStream('deflate-raw')，Node 里用 node:zlib（测试跑在 Node 上）。
 *
 * 注意：只有 Zip64 / 加密 / 多卷不支持，我们这两种包都用不到。
 */
(function (root) {
  const nodeZlib = (typeof module !== 'undefined' && module.exports) ? require('node:zlib') : null;

  const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0 ^ -1;
    for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xff];
    return (c ^ -1) >>> 0;
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function bytesOf(value) {
    if (typeof value === 'string') return encoder.encode(value);
    // 宽松认定「字节序列」：不同 realm（vm 沙箱、iframe）里的 Uint8Array 用 instanceof 认不出来
    if (value && typeof value === 'object' && typeof value.length === 'number' && typeof value.subarray === 'function') return value;
    if (value && value.buffer && typeof value.buffer.byteLength === 'number') return new Uint8Array(value.buffer);
    return encoder.encode(String(value == null ? '' : value));
  }
  const textOf = value => decoder.decode(bytesOf(value));

  /** dos 时间：zip 头要求 1980 起的 MS-DOS 格式 */
  function dosTime(date) {
    return {
      time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff,
      day: (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
    };
  }

  /** entries: [{name, data}]（data 可以是字符串、Uint8Array）→ zip 字节 */
  function zip(entries) {
    const { time, day } = dosTime(new Date());
    const chunks = [];
    const central = [];
    let offset = 0;
    entries.forEach(entry => {
      const nameBuf = encoder.encode(String(entry.name));
      const raw = bytesOf(entry.data);
      const crc = crc32(raw);

      const local = new Uint8Array(30);
      const localView = new DataView(local.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);          // version needed
      localView.setUint16(6, 0, true);           // flags
      localView.setUint16(8, 0, true);           // method: store
      localView.setUint16(10, time, true);
      localView.setUint16(12, day, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, raw.length, true); // 压缩后大小 = 原大小
      localView.setUint32(22, raw.length, true);
      localView.setUint16(26, nameBuf.length, true);
      localView.setUint16(28, 0, true);
      chunks.push(local, nameBuf, raw);

      const cd = new Uint8Array(46);
      const cdView = new DataView(cd.buffer);
      cdView.setUint32(0, 0x02014b50, true);
      cdView.setUint16(4, 20, true);
      cdView.setUint16(6, 20, true);
      cdView.setUint16(8, 0, true);
      cdView.setUint16(10, 0, true);             // method: store
      cdView.setUint16(12, time, true);
      cdView.setUint16(14, day, true);
      cdView.setUint32(16, crc, true);
      cdView.setUint32(20, raw.length, true);
      cdView.setUint32(24, raw.length, true);
      cdView.setUint16(28, nameBuf.length, true);
      cdView.setUint16(30, 0, true);             // extra
      cdView.setUint16(32, 0, true);             // comment
      cdView.setUint16(34, 0, true);             // disk
      cdView.setUint16(36, 0, true);             // internal attrs
      cdView.setUint32(38, 0, true);             // external attrs
      cdView.setUint32(42, offset, true);
      central.push(cd, nameBuf);

      offset += local.length + nameBuf.length + raw.length;
    });

    const total = offset + central.reduce((sum, part) => sum + part.length, 0) + 22;
    const out = new Uint8Array(total);
    let at = 0;
    [...chunks, ...central].forEach(part => { out.set(part, at); at += part.length; });
    const end = new DataView(out.buffer, at, 22);
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, central.reduce((sum, part) => sum + part.length, 0), true);
    end.setUint32(16, offset, true);
    end.setUint16(20, 0, true);
    return out;
  }

  async function inflateRaw(bytes) {
    if (nodeZlib) return new Uint8Array(nodeZlib.inflateRawSync(Buffer.from(bytes)));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** zip 字节 → { name: Uint8Array } */
  async function unzip(input) {
    const buffer = bytesOf(input);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let eocd = -1;
    for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - 65535; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录。');
    const count = view.getUint16(eocd + 10, true);
    let pointer = view.getUint32(eocd + 16, true);
    const files = {};
    for (let i = 0; i < count; i++) {
      if (view.getUint32(pointer, true) !== 0x02014b50) throw new Error('zip 中央目录损坏。');
      const method = view.getUint16(pointer + 10, true);
      const compressedSize = view.getUint32(pointer + 20, true);
      const nameLength = view.getUint16(pointer + 28, true);
      const extraLength = view.getUint16(pointer + 30, true);
      const commentLength = view.getUint16(pointer + 32, true);
      const localOffset = view.getUint32(pointer + 42, true);
      const name = decoder.decode(buffer.subarray(pointer + 46, pointer + 46 + nameLength));

      // 本地头里的名字/额外字段长度可能与中央目录不同，按本地头的来算数据起点
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(start, start + compressedSize);
      files[name] = method === 8 ? await inflateRaw(raw) : raw.slice();
      pointer += 46 + nameLength + extraLength + commentLength;
    }
    return files;
  }

  const api = { zip, unzip, crc32, bytesOf, textOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CardFlowZip = api;
})(typeof window !== 'undefined' ? window : globalThis);
