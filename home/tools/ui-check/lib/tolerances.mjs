// Purpose: the single tolerance table used by the element check. Documented in standards/figma.md.
// Exports: TOLERANCE, PIXEL, VIEWPORT_DEFAULTS. Invariant: values are CSS px unless noted.

export const TOLERANCE = Object.freeze({
  box: 1, // x, y, w, h relative to the root
  fontSize: 0.5,
  lineHeight: 0.5,
  letterSpacing: 0.1,
  radius: 0.5,
  spacing: 0.5, // padding and gap
  colorChannel: 1, // 0-255 per channel
  colorAlpha: 0.02,
});

export const PIXEL = Object.freeze({
  threshold: 0.1, // odiff colour distance, 0-1
  maxDiffPercent: 0.5, // default gate, % of pixels
});

export const RESPONSIVE = Object.freeze({
  widths: [320, 360, 390, 768, 1024, 1280, 1440, 1920],
  height: 900,
  minTarget: 24, // WCAG 2.5.8
  minText: 12,
  smallViewport: 768,
  maxFindingsPerCheck: 50,
});
