import Gio from 'gi://Gio';

export const MAX_TEXT_BYTES = 16 * 1024 * 1024;
export const MAX_LOG_BYTES = 256 * 1024 * 1024;

// Count UTF-8 without allocating a second copy of clipboard contents.
export function textFitsLimit(text, limit = MAX_TEXT_BYTES) {
  if (typeof text !== 'string' || text.length > limit) return false;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
    if (bytes > limit) return false;
  }
  return true;
}

// The stream limit also covers growth between the stat and the read.
export function readBoundedFile(path, limit) {
  const file = Gio.File.new_for_path(path);
  const info = file.query_info(
    'standard::size,standard::type',
    Gio.FileQueryInfoFlags.NONE,
    null,
  );
  if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > limit)
    throw new Error('Input exceeds size limit or is not a regular file');
  const stream = file.read(null);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const bytes = stream
        .read_bytes(Math.min(65536, limit + 1 - size), null)
        .get_data();
      if (!bytes.length) break;
      size += bytes.length;
      if (size > limit) throw new Error('Input exceeds size limit');
      chunks.push(bytes);
    }
  } finally {
    stream.close(null);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const bytes of chunks) {
    result.set(bytes, offset);
    offset += bytes.length;
  }
  return result;
}
