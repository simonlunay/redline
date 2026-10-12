import { createCanvas } from '@napi-rs/canvas';
import { parseDesign } from '@simonlunay/redline';
import type { Design, ImageElement, ShapeElement } from '@simonlunay/redline';
import { describe, expect, it } from 'vitest';
import { assembleDesign } from '../src/assemble.js';
import { templatePlan } from '../src/director/template.js';
import { measureFootprint } from '../src/node/cutout.js';
import {
  DEFAULT_SHADOW_OPACITY,
  contactShadow,
  setContactShadow,
  shadowIdFor,
  syncContactShadows,
} from '../src/shadow.js';
import type { Footprint } from '../src/shadow.js';

const FOOT: Footprint = { left: 0.2, right: 0.8, bottom: 1 };

const design = (): Design =>
  parseDesign({
    version: '0.1',
    canvas: { width: 1000, height: 1000, background: '#ffffff' },
    elements: [
      {
        id: 'bg',
        type: 'image',
        role: 'background',
        x: 0,
        y: 0,
        width: 1000,
        height: 1000,
        src: 'bg.jpg',
        naturalWidth: 1000,
        naturalHeight: 1000,
        fit: 'cover',
      },
      {
        id: 'product',
        type: 'image',
        role: 'product',
        x: 300,
        y: 400,
        width: 400,
        height: 400,
        zIndex: 1,
        src: 'cut.png',
        naturalWidth: 400,
        naturalHeight: 400,
        fit: 'contain',
      },
    ],
  });

const shadowOf = (d: Design) => d.elements.find((e) => e.id === 'product-shadow') as ShapeElement;
const product = (d: Design) => d.elements.find((e) => e.id === 'product') as ImageElement;

describe('contact shadows', () => {
  it('is a soft, flat, semi-transparent ellipse centered under the footprint', () => {
    const s = contactShadow(product(design()), FOOT, { width: 1000, height: 1000 });
    expect(s).toMatchObject({
      id: 'product-shadow',
      type: 'shape',
      kind: 'ellipse',
      role: 'decoration',
      fill: '#000000',
      opacity: DEFAULT_SHADOW_OPACITY,
      zIndex: 1,
      groupId: 'product',
    });
    // Footprint 240 px wide -> shadow 20% wider, centered at x 500.
    expect(s.width).toBeCloseTo(288, 0);
    expect(s.x + s.width / 2).toBeCloseTo(500, 0);
    expect(s.height).toBeCloseTo(288 * 0.22, 0);
    // Blurred by under half its height, so the core stays dark.
    expect(s.blur).toBeLessThan(s.height / 2);
    // Straddles the contact line (y 800) so it peeks out under the subject.
    expect(s.y).toBeLessThan(800);
    expect(s.y + s.height).toBeGreaterThan(800);
    expect(s.blur).toBeGreaterThan(0);
  });

  it('stays inside the canvas when the subject sits on the bottom edge', () => {
    const p = { ...product(design()), y: 600 };
    const s = contactShadow(p, FOOT, { width: 1000, height: 1000 });
    expect(s.y + s.height).toBeLessThanOrEqual(1000);
  });

  it('is painted directly behind its subject, which joins its group', () => {
    const d = setContactShadow(design(), 'product', FOOT, { enabled: true }) as Design;
    expect(d.elements.map((e) => e.id)).toEqual(['bg', 'product-shadow', 'product']);
    expect(product(d).groupId).toBe('product');
    expect(shadowIdFor('product')).toBe('product-shadow');
  });

  it('sets the opacity within limits, keeps 0 as "off", and removes it at assembly', () => {
    const on = setContactShadow(design(), 'product', FOOT, { enabled: true, opacity: 0.95 });
    expect(shadowOf(on as Design).opacity).toBe(0.8);
    const off = setContactShadow(on as Design, 'product', FOOT, { enabled: true, opacity: 0 });
    expect(shadowOf(off as Design).opacity).toBe(0);
    const removed = setContactShadow(on as Design, 'product', FOOT, { enabled: false });
    expect(shadowOf(removed as Design)).toBeUndefined();
  });

  it('refuses subjects without a footprint and elements that are not images', () => {
    expect(setContactShadow(design(), 'product', undefined, { enabled: true })).toMatch(
      /not a cut-out subject/,
    );
    expect(setContactShadow(design(), 'nope', FOOT, { enabled: true })).toMatch(
      /not an image element/,
    );
  });

  it('follows its subject when it is moved, resized or regenerated, keeping its opacity', () => {
    const start = setContactShadow(design(), 'product', FOOT, {
      enabled: true,
      opacity: 0.5,
    }) as Design;
    const moved = {
      ...start,
      elements: start.elements.map((e) =>
        e.id === 'product' ? { ...e, x: e.x + 100, y: e.y - 50, src: 'new.png' } : e,
      ),
    };
    const synced = syncContactShadows(moved, (src) =>
      src === 'new.png' ? { left: 0, right: 1, bottom: 0.9 } : undefined,
    );
    const s = shadowOf(synced);
    expect(s.opacity).toBe(0.5);
    expect(s.x + s.width / 2).toBeCloseTo(600, 0);
    expect(s.width).toBeCloseTo(480, 0);
    expect(s.y).toBeLessThan(350 + 360);
    expect(s.y + s.height).toBeGreaterThan(350 + 360);
    // Nothing to do: the same object comes back.
    expect(syncContactShadows(synced, () => ({ left: 0, right: 1, bottom: 0.9 }))).toBe(synced);
  });

  it('switches a shadow off (not removes it) when its subject is no longer a cutout', () => {
    const start = setContactShadow(design(), 'product', FOOT, { enabled: true }) as Design;
    const synced = syncContactShadows(start, () => undefined);
    expect(shadowOf(synced).opacity).toBe(0);
    expect(synced.elements).toHaveLength(3);
  });
});

describe('footprints', () => {
  it('measures where a cut-out subject touches the ground', async () => {
    // A bottle: narrow neck at the top, a 60 px wide base on the bottom rows of a 100x200 PNG.
    const c = createCanvas(100, 200);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#e8701a';
    ctx.fillRect(40, 10, 20, 60);
    ctx.fillRect(20, 70, 60, 120);
    const fp = await measureFootprint(new Uint8Array(await c.encode('png')));
    expect(fp).toEqual({ left: 0.2, right: 0.8, bottom: 0.95 });
  });

  it('is null for an empty image', async () => {
    const c = createCanvas(20, 20);
    expect(await measureFootprint(new Uint8Array(await c.encode('png')))).toBeNull();
  });
});

describe('assembly', () => {
  const plan = templatePlan({
    prompt: 'poster for a charity 5K, energetic, blue and orange',
    canvas: { width: 1080, height: 1350 },
    layouts: 1,
    fonts: ['Inter'],
  });
  const images = (footprint?: Footprint) =>
    new Map([
      ['background', { src: 'bg.jpg', width: 1080, height: 1350 }],
      ['subject', { src: 'cut.png', width: 400, height: 500, ...(footprint ? { footprint } : {}) }],
    ]);

  it('gives a subject that rests on a surface a contact shadow, directly behind it', () => {
    const d = assembleDesign(plan, 0, { width: 1080, height: 1350 }, images(FOOT));
    const ids = d.elements.map((e) => e.id);
    const subject = d.elements.find((e) => e.type === 'image' && e.src === 'cut.png')!;
    expect(ids.indexOf(shadowIdFor(subject.id))).toBe(ids.indexOf(subject.id) - 1);
    expect(d.elements.find((e) => e.id === shadowIdFor(subject.id))).toMatchObject({
      type: 'shape',
      role: 'decoration',
    });
  });

  it('gives no shadow to a floating subject or one without a footprint', () => {
    const floating = structuredClone(plan);
    for (const slot of floating.layouts[0]!.imageSlots) slot.grounding = 'floating';
    for (const d of [
      assembleDesign(floating, 0, { width: 1080, height: 1350 }, images(FOOT)),
      assembleDesign(plan, 0, { width: 1080, height: 1350 }, images()),
    ]) {
      expect(d.elements.some((e) => e.id.endsWith('-shadow'))).toBe(false);
    }
  });
});
