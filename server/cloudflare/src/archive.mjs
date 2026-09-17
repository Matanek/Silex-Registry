const block = 512;
export const maxExpanded = 48 * 1024 * 1024; // Bounded staging candidate, not the production limit.
const decoder = new TextDecoder('utf-8', { fatal: true });

export class ArchiveFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
function reject(code) { throw new ArchiveFailure(code); }
function allZero(bytes) { return bytes.every(byte => byte === 0); }
function text(bytes) {
  const end = bytes.indexOf(0);
  if (end >= 0 && !allZero(bytes.subarray(end))) reject('invalid_tar_header');
  try { return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end)); }
  catch { reject('invalid_tar_header'); }
}
function octal(bytes) {
  const value = text(bytes).trim();
  if (!/^[0-7]{1,11}$/.test(value)) reject('invalid_tar_header');
  return Number.parseInt(value, 8);
}
async function expand(source, limit) {
  let reader;
  try {
    reader = new Response(source).body.pipeThrough(new DecompressionStream('gzip')).getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) reject('expanded_limit');
      chunks.push(part.value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    if (error instanceof ArchiveFailure) throw error;
    reject('invalid_gzip');
  } finally {
    await reader?.cancel().catch(() => {});
  }
}

/** Check the actual gzip/USTAR bytes before their descriptor becomes public. */
export async function verifySourceArchive(source, descriptor, digest) {
  const limit = maxExpanded + (descriptor.files.length + 2) * 1024;
  const tar = await expand(source, limit);
  const expected = new Map(descriptor.files.map(file => [file.path, file]));
  const seen = new Set();
  let offset = 0;
  let expanded = 0;
  while (offset + block <= tar.length) {
    const header = tar.subarray(offset, offset + block);
    offset += block;
    if (allZero(header)) {
      if (tar.length - offset < block || (tar.length - offset) % block !== 0 || !allZero(tar.subarray(offset)))
        reject('trailing_tar');
      if (seen.size !== expected.size) reject('missing_tar_file');
      return;
    }
    let checksum = 0;
    for (let i = 0; i < block; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== octal(header.subarray(148, 156)) || text(header.subarray(257, 263)) !== 'ustar' ||
      ![0, 48].includes(header[156]) || !allZero(header.subarray(157, 257))) reject('invalid_tar_header');
    const prefix = text(header.subarray(345, 500));
    const name = `${prefix ? `${prefix}/` : ''}${text(header.subarray(0, 100))}`;
    const file = expected.get(name);
    if (!file || seen.has(name)) reject('unexpected_tar_file');
    seen.add(name);
    const size = octal(header.subarray(124, 136));
    if (size !== file.size || size > maxExpanded - expanded) reject('file_size_mismatch');
    expanded += size;
    if (offset + size > tar.length) reject('truncated_tar');
    const bytes = tar.subarray(offset, offset + size);
    if (await digest(bytes) !== file.sha256) reject('file_digest_mismatch');
    if (name === 'Package.json' && (size !== new TextEncoder().encode(descriptor.manifest).length ||
      decoder.decode(bytes) !== descriptor.manifest)) reject('manifest_mismatch');
    offset += size;
    const padding = (block - size % block) % block;
    if (offset + padding > tar.length || !allZero(tar.subarray(offset, offset + padding))) reject('invalid_tar_padding');
    offset += padding;
  }
  reject('truncated_tar');
}
