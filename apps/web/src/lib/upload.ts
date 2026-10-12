import { DesignValidationError, parseDesign } from '@simonlunay/redline';
import type { Design } from '@simonlunay/redline';

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export type UploadResult = { ok: true; design: Design } | { ok: false; error: string };

/**
 * Validates an uploaded design file. Images must be embedded as data URLs: the site never
 * fetches anything from another origin, and a relative path has nothing to resolve against.
 */
export function readUpload(text: string, bytes: number): UploadResult {
  if (bytes > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `The file is ${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is 4 MB.`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `This isn't valid JSON: ${(err as Error).message}` };
  }
  let design: Design;
  try {
    design = parseDesign(json);
  } catch (err) {
    if (err instanceof DesignValidationError) return { ok: false, error: err.message };
    return { ok: false, error: (err as Error).message };
  }
  const external = design.elements.filter(
    (el) => el.type === 'image' && !/^data:image\//.test(el.src),
  );
  if (external.length) {
    const ids = external.map((el) => `"${el.id}"`).join(', ');
    return {
      ok: false,
      error: `Image ${ids} ${external.length === 1 ? 'uses' : 'use'} a file path or URL. Embed images as data URLs (data:image/png;base64,…); "Export JSON" on this site writes files that way.`,
    };
  }
  return { ok: true, design };
}
