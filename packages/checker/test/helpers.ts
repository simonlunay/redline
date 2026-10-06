import { parseDesign } from '../src/core/schema.js';
import type { Design, DesignInput } from '../src/core/schema.js';

type ElementInput = DesignInput['elements'][number];
type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

let counter = 0;
const nextId = (prefix: string) => `${prefix}${++counter}`;

/** Builds a validated design. Canvas defaults to a 1080x1080 white square. */
export function makeDesign(
  elements: ElementInput[],
  canvas: Partial<DesignInput['canvas']> = {},
): Design {
  return parseDesign({
    version: '0.1',
    canvas: { width: 1080, height: 1080, background: '#ffffff', ...canvas },
    elements,
  });
}

export function text(
  props: Partial<Without<Extract<ElementInput, { type: 'text' }>, 'type'>> = {},
): ElementInput {
  return {
    type: 'text',
    id: nextId('text'),
    x: 100,
    y: 100,
    width: 600,
    height: 100,
    content: 'Hello',
    fontSize: 40,
    color: '#111111',
    ...props,
  };
}

export function shape(
  props: Partial<Without<Extract<ElementInput, { type: 'shape' }>, 'type'>> = {},
): ElementInput {
  return {
    type: 'shape',
    id: nextId('shape'),
    kind: 'rect',
    x: 100,
    y: 100,
    width: 200,
    height: 200,
    fill: '#3366ff',
    ...props,
  };
}

export function image(
  props: Partial<Without<Extract<ElementInput, { type: 'image' }>, 'type'>> = {},
): ElementInput {
  return {
    type: 'image',
    id: nextId('image'),
    src: 'photo.png',
    x: 100,
    y: 100,
    width: 400,
    height: 300,
    naturalWidth: 800,
    naturalHeight: 600,
    ...props,
  };
}
