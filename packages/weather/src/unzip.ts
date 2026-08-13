/**
 * A minimal, dependency-free ZIP reader.
 *
 * climate.onebuilding.org ships each station as a ZIP holding the `.epw`,
 * `.ddy`, `.stat`, and a few other members. Rather than pull in a zip library,
 * this reads the archive's central directory and inflates deflate members with
 * `DecompressionStream('deflate-raw')`, which is baseline-available in browsers
 * and present in Node 20+. Store (method 0) and deflate (method 8) are the only
 * methods these archives use, so those are the only two handled.
 *
 * The reader is deliberately small: it trusts the central directory, does not
 * validate CRCs, and reads local-header name/extra lengths (which can differ
 * from the central directory's) to locate each member's data. That is enough
 * for well-formed archives from a known source.
 */

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/**
 * Read a ZIP archive into a map of member name to raw bytes.
 *
 * @throws if the buffer has no End Of Central Directory record, if a central
 * directory entry is malformed, or if a member uses an unsupported compression
 * method.
 */
export async function unzip(buffer: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Scan backwards for the End Of Central Directory record. It is 22 bytes plus
  // an optional trailing comment, so it starts at most 22 bytes from the end
  // when there is no comment.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Not a ZIP archive: no end-of-central-directory record found');

  const entryCount = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);

  const out = new Map<string, Uint8Array>();
  const latin1 = new TextDecoder('latin1');
  for (let n = 0; n < entryCount; n++) {
    if (view.getUint32(ptr, true) !== CENTRAL_SIGNATURE) {
      throw new Error('Corrupt ZIP: bad central-directory signature');
    }
    const method = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const name = latin1.decode(buffer.subarray(ptr + 46, ptr + 46 + nameLen));

    // The local header repeats the name and carries its own extra field, whose
    // length can differ from the central directory's — read it to find the data.
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

    let data: Uint8Array;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      data = await inflateRaw(compressed);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for member ${name}`);
    }
    out.set(name, data);

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
