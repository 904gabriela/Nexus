/**
 * Character-card metadata extraction from PNG/APNG files.
 *
 * The de-facto standard (TavernAI / SillyTavern) stores the card JSON as a
 * base64 payload inside a PNG `tEXt` chunk keyed `chara` (v2 cards also use
 * `ccv3`). We parse the chunk stream directly — the original file is never
 * modified, and the image itself remains usable as the avatar.
 */

export interface PngCardResult {
  ok: boolean;
  json?: unknown;
  keyword?: string;
  error?: string;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
}

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[start + i]);
  return out;
}

/** base64 → UTF-8 string (cards are UTF-8, so atob alone would mangle them). */
function decodeBase64Utf8(value: string): string {
  const clean = value.replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

interface TextChunk {
  keyword: string;
  text: string;
}

function readTextChunks(bytes: Uint8Array): TextChunk[] {
  const chunks: TextChunk[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8; // skip signature

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = readAscii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    if (dataStart + length > bytes.length) break;

    if (type === 'tEXt') {
      const data = bytes.subarray(dataStart, dataStart + length);
      const nullIndex = data.indexOf(0);
      if (nullIndex > 0) {
        const keyword = readAscii(data, 0, nullIndex);
        const text = new TextDecoder('latin1').decode(data.subarray(nullIndex + 1));
        chunks.push({ keyword, text });
      }
    } else if (type === 'iTXt') {
      const data = bytes.subarray(dataStart, dataStart + length);
      const nullIndex = data.indexOf(0);
      if (nullIndex > 0) {
        const keyword = readAscii(data, 0, nullIndex);
        // compressionFlag, compressionMethod, then two null-terminated strings.
        const compressionFlag = data[nullIndex + 1];
        if (compressionFlag === 0) {
          let cursor = nullIndex + 3;
          let seen = 0;
          while (cursor < data.length && seen < 2) {
            if (data[cursor] === 0) seen += 1;
            cursor += 1;
          }
          const text = new TextDecoder('utf-8').decode(data.subarray(cursor));
          chunks.push({ keyword, text });
        }
      }
    } else if (type === 'IEND') {
      break;
    }

    offset = dataStart + length + 4; // + CRC
  }
  return chunks;
}

const CARD_KEYWORDS = ['ccv3', 'chara', 'character', 'Chara'];

export async function readCharacterCardFromPng(file: File | Blob): Promise<PngCardResult> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    return { ok: false, error: `Could not read the file: ${(err as Error).message}` };
  }

  if (!isPng(bytes)) {
    return {
      ok: false,
      error:
        'This is not a PNG file. Character card metadata is only embedded in PNG cards — ' +
        'JPEG and WEBP images cannot carry it. You can still use the image as an avatar.',
    };
  }

  let chunks: TextChunk[];
  try {
    chunks = readTextChunks(bytes);
  } catch (err) {
    return { ok: false, error: `The PNG chunk stream is malformed: ${(err as Error).message}` };
  }

  if (!chunks.length) {
    return {
      ok: false,
      error:
        'This PNG has no text metadata chunks. It is a plain image, not a character card. ' +
        'You can still import it as an avatar.',
    };
  }

  for (const keyword of CARD_KEYWORDS) {
    const chunk = chunks.find((c) => c.keyword.toLowerCase() === keyword.toLowerCase());
    if (!chunk) continue;
    // Cards store base64 JSON; some tools store raw JSON.
    const candidates = [() => decodeBase64Utf8(chunk.text), () => chunk.text];
    for (const decode of candidates) {
      try {
        const parsed = JSON.parse(decode());
        return { ok: true, json: parsed, keyword: chunk.keyword };
      } catch {
        /* try the next decoding */
      }
    }
    return {
      ok: false,
      error: `The PNG contains a "${chunk.keyword}" chunk but its contents are not valid card JSON.`,
    };
  }

  return {
    ok: false,
    error: `This PNG has metadata (${chunks
      .map((c) => c.keyword)
      .join(', ')}) but no character card chunk. You can still import it as an avatar.`,
  };
}
