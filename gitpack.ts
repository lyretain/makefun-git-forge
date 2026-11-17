// Smart-HTTP pkt-lines and pack v2 (sha1, plain objects). No git binary.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface Obj {
  type: ObjType;
  data: Buffer;
}

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > 65520) throw new Error('pkt-line exceeds 65520 bytes');
  const head = Buffer.allocUnsafe(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body]);
}

export function concat(parts: Buffer[]): Buffer {
  return Buffer.concat(parts);
}

/**
 * Read pkt-lines until the first flush. Bytes after that flush are `rest` (a receive-pack pack
 * starts with `PACK`, which is not a pkt-line).
 */
export function splitPackRequest(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const hex = buf.toString('ascii', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const n = parseInt(hex, 16);
    if (n === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      break;
    }
    if (n === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (n === 2) {
      packets.push({ kind: 'end' });
      off += 4;
      continue;
    }
    if (n < 4 || off + n > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + n) });
    off += n;
  }
  return { packets, rest: buf.subarray(off) };
}

/** Decode a complete pkt-line stream. `rest` is the bytes after the last full packet. */
export function decodePackets(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const hex = buf.toString('ascii', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line length');
    const n = parseInt(hex, 16);
    if (n === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (n === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (n === 2) {
      packets.push({ kind: 'end' });
      off += 4;
      continue;
    }
    if (n < 4) throw new Error('pkt-line length is too small');
    if (off + n > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + n) });
    off += n;
  }
  return { packets, rest: buf.subarray(off) };
}

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`);
  hash.update(data);
  return hash.digest('hex');
}

export function writePack(objects: readonly Obj[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(writePackHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function writePackHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  if (code === undefined) throw new Error(`unknown object type ${type}`);
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export interface PackedObj extends Obj {
  oid: string;
}

/** Read a pack of plain objects. Deltas are rejected; the caller reports unpack failure. */
export function readPack(pack: Buffer): PackedObj[] {
  if (pack.length < 32) throw new Error('pack is truncated');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack magic is missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const body = pack.subarray(0, pack.length - 20);
  const expected = createHash('sha1').update(body).digest();
  if (!trailer.equals(expected)) throw new Error('pack checksum does not match');
  const out: PackedObj[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const header = readPackHeader(body, offset);
    if (header.typeCode === 6 || header.typeCode === 7) throw new Error('pack deltas are not accepted');
    const type = CODE_TYPE[header.typeCode];
    if (type === undefined) throw new Error(`pack type ${header.typeCode} is unknown`);
    const inflated = inflateAt(body, header.next);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry declared ${header.size} bytes and inflated to ${inflated.data.length}`);
    }
    const data = inflated.data;
    out.push({ type, data, oid: hashObject(type, data) });
    offset = inflated.next;
  }
  if (offset !== body.length) throw new Error('pack has trailing bytes before the checksum');
  return out;
}

function readPackHeader(buf: Buffer, offset: number): { typeCode: number; size: number; next: number } {
  if (offset >= buf.length) throw new Error('pack header is truncated');
  let byte = buf[offset]!;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let next = offset + 1;
  while (byte & 0x80) {
    if (next >= buf.length) throw new Error('pack header is truncated');
    byte = buf[next]!;
    next += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { typeCode, size, next };
}

function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + consumed };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.toString('ascii', offset, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

export function commitTree(data: Buffer): string | null {
  const nl = data.indexOf(0x0a);
  if (nl < 5) return null;
  const line = data.toString('ascii', 0, nl);
  return line.startsWith('tree ') ? line.slice(5) : null;
}

export function commitParents(data: Buffer): string[] {
  const parents: string[] = [];
  let start = 0;
  while (start < data.length) {
    const nl = data.indexOf(0x0a, start);
    const end = nl === -1 ? data.length : nl;
    if (end === start) break;
    if (data.subarray(start, start + 7).toString('ascii') === 'parent ') {
      parents.push(data.toString('ascii', start + 7, end));
    }
    if (nl === -1) break;
    start = nl + 1;
  }
  return parents;
}

export function commitMessage(data: Buffer): string {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  if (split < 0) return '';
  const message = text.slice(split + 2);
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}

export function tagTarget(data: Buffer): string | null {
  const nl = data.indexOf(0x0a);
  if (nl < 0) return null;
  const line = data.toString('ascii', 0, nl);
  return line.startsWith('object ') ? line.slice(7).trim() : null;
}

/** Wrap already-encoded bytes as sideband-64k band 1 pkt-lines. */
export function sideband(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  const max = 65515;
  for (let off = 0; off < data.length; off += max) {
    const chunk = data.subarray(off, Math.min(data.length, off + max));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}
