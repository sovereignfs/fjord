/**
 * Getting a picture ready to leave the browser (RFC 0004): scaled down to a bound, re-encoded (which drops EXIF, a photo's position among it),
 * unless it is animated, already small enough, or the person asks for the original. The server never decodes a picture; this is the one
 * place one is.
 */

/** The longest side a picture is uploaded at, unless the person keeps the original. */
export const MAX_SIDE = 2560;
/** WebP's and JPEG's quality when a picture is re-encoded. */
export const QUALITY = 0.85;

/** The size to scale a picture to, or null when it is within the bound. The longer side becomes `MAX_SIDE`, the shorter keeps the proportion. */
export function scaledSize(
  width: number,
  height: number,
  maxSide: number = MAX_SIDE,
): { width: number; height: number } | null {
  if (!(width > 0) || !(height > 0)) return null;
  const longest = Math.max(width, height);
  if (longest <= maxSide) return null;
  const ratio = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

/**
 * Whether re-encoding would lose frames: a GIF (every one is kept as it is, since telling a still from an animation means walking its blocks), an
 * APNG (an `acTL` chunk before the image data) or an animated WebP (an `ANIM` chunk in its header).
 */
export function mayBeAnimated(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 4096);
  if (ascii(head, 0, 3) === 'GIF') return true;
  if (PNG_SIGNATURE.every((byte, index) => head[index] === byte))
    return ascii(head, 0, head.length).includes('acTL');
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP')
    return ascii(head, 12, head.length).includes('ANIM');
  return false;
}

export interface Prepared {
  file: File;
  /** Whether the picture was scaled and re-encoded, and from what. */
  resized: {
    from: { width: number; height: number };
    to: { width: number; height: number };
  } | null;
}

/**
 * The picture to upload: `file` itself when it is animated, within the bound, a type the browser cannot draw, or `keepOriginal` is set; else a WebP
 * (a JPEG where the browser cannot make one) scaled to `MAX_SIDE`. Never throws: a picture that cannot be drawn is sent as it is, and the server's
 * own checks decide.
 */
export async function prepareImage(
  file: File,
  options: { keepOriginal?: boolean } = {},
): Promise<Prepared> {
  const asIs: Prepared = { file, resized: null };
  if (options.keepOriginal) return asIs;
  try {
    const bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    if (mayBeAnimated(bytes)) return asIs;
    const bitmap = await createImageBitmap(file);
    const size = scaledSize(bitmap.width, bitmap.height);
    if (!size) {
      bitmap.close();
      return asIs;
    }
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return asIs;
    }
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const from = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    const encode = (type: string) =>
      new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, QUALITY));
    let blob = await encode('image/webp');
    if (blob?.type !== 'image/webp') blob = await encode('image/jpeg');
    if (!blob || blob.size === 0) return asIs;
    const stem = file.name.replace(/\.[^.]*$/, '') || 'image';
    return {
      file: new File([blob], `${stem}.${blob.type === 'image/webp' ? 'webp' : 'jpg'}`, {
        type: blob.type,
      }),
      resized: { from, to: size },
    };
  } catch {
    return asIs;
  }
}
