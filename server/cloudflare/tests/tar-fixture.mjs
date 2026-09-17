import { gzipSync } from 'node:zlib';

const block = 512;
function octal(header, offset, length, value) {
  header.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii');
  header[offset + length - 1] = 0;
}
export function archive(files) {
  const parts = [];
  for (const [name, body] of files) {
    const bytes = Buffer.from(body);
    const header = Buffer.alloc(block);
    header.write(name, 0, 100, 'utf8');
    octal(header, 100, 8, 0o644);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, bytes.length);
    octal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    octal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
    parts.push(header, bytes, Buffer.alloc((block - bytes.length % block) % block));
  }
  parts.push(Buffer.alloc(block * 2));
  return gzipSync(Buffer.concat(parts), { mtime: 0 });
}
