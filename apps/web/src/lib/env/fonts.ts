import type { FontSpec } from '@simonlunay/redline';
import { asset } from '../base-path';

/**
 * The bundled Inter files, registered under their own family name so a system-installed Inter
 * can never stand in for them. Every design family maps to it, as in the CLI (only Inter ships).
 */
export const DESIGN_FONT_FAMILY = 'Redline Inter';

export const DESIGN_FONT_FILES: Record<number, string> = {
  400: 'Inter-Regular.ttf',
  600: 'Inter-SemiBold.ttf',
  700: 'Inter-Bold.ttf',
  900: 'Inter-Black.ttf',
};

export function cssFont(font: FontSpec): string {
  return `${font.weight} ${font.size}px "${DESIGN_FONT_FAMILY}"`;
}

let loading: Promise<void> | undefined;

/** Loads the design fonts once; text can't be measured or drawn correctly before this resolves. */
export function loadDesignFonts(): Promise<void> {
  loading ??= Promise.all(
    Object.entries(DESIGN_FONT_FILES).map(async ([weight, file]) => {
      const face = new FontFace(DESIGN_FONT_FAMILY, `url(${asset(`fonts/${file}`)})`, { weight });
      document.fonts.add(await face.load());
    }),
  ).then(() => undefined);
  return loading;
}
