import { UPLOAD_LIMITS, type UploadKindSchema } from "@myroom/schema";
import type { z } from "zod";

type UploadKind = z.infer<typeof UploadKindSchema>;

/**
 * Magic-byte validation (docs/03 §3: "server validates magic bytes + runs AV
 * scan"). Extension alone is a claim by the client; the leading bytes are
 * evidence. A file whose bytes disagree with its extension is rejected rather
 * than handed to a parser.
 */
export interface FormatCheck {
  ok: boolean;
  /** the format the bytes actually are, when recognized */
  format: string | null;
  reason: string | null;
}

const ascii = (bytes: Uint8Array, at: number, text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
};

const startsWith = (bytes: Uint8Array, sig: number[]): boolean =>
  sig.every((b, i) => bytes[i] === b);

/** Extension → the formats whose magic bytes we accept for it. */
const EXTENSION_FORMATS: Record<string, string[]> = {
  ".jpg": ["jpeg"],
  ".jpeg": ["jpeg"],
  ".png": ["png"],
  ".webp": ["webp"],
  ".heic": ["heic"],
  ".json": ["json"],
  ".usdz": ["zip"],
  ".ply": ["ply"],
  ".glb": ["glb"],
  ".e57": ["e57"],
  ".las": ["las"],
  ".laz": ["las"],
};

export function sniffFormat(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "webp";
  // HEIC/HEIF: an ISO-BMFF box whose brand starts with heic/heix/mif1/hevc.
  if (ascii(bytes, 4, "ftyp")) {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return "heic";
  }
  if (ascii(bytes, 0, "glTF")) return "glb";
  if (ascii(bytes, 0, "ply")) return "ply";
  if (ascii(bytes, 0, "ASTM-E57")) return "e57";
  if (ascii(bytes, 0, "LASF")) return "las";
  // USDZ is an uncompressed zip; RoomPlan exports pair it with a .json sidecar.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return "zip";
  // JSON, skipping a UTF-8 BOM and leading whitespace.
  let i = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  while (i < bytes.length && [0x20, 0x09, 0x0a, 0x0d].includes(bytes[i]!)) i++;
  if (bytes[i] === 0x7b) return "json";
  return null;
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

export function checkUpload(kind: UploadKind, filename: string, bytes: Uint8Array): FormatCheck {
  const ext = extensionOf(filename);
  const allowed: readonly string[] = UPLOAD_LIMITS[kind].extensions;
  if (!allowed.includes(ext)) {
    return { ok: false, format: null, reason: `${ext || "That file type"} isn't accepted here.` };
  }
  const format = sniffFormat(bytes);
  if (!format) {
    return { ok: false, format: null, reason: "This file doesn't look like the format its name claims." };
  }
  const expected = EXTENSION_FORMATS[ext] ?? [];
  if (!expected.includes(format)) {
    return {
      ok: false,
      format,
      reason: `This file is named ${ext} but its contents are ${format}.`,
    };
  }
  return { ok: true, format, reason: null };
}
