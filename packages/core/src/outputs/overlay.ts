import type { Pin, PinType, Screen } from '@spec-studio/protocol';
import { pinLabel, sortPinsByNumber } from '../pins';

/**
 * Marker colour per pin type. The app, the overlay PNG and the static HTML
 * read the same table, so #3 is the same blue in all three.
 */
export const PIN_TYPE_COLOR: Record<PinType, string> = {
  function: '#0f1216',
  policy: '#2453c9',
  exception: '#b4690e',
  state: '#0e7a6b',
  data: '#5b45b8',
  permission: '#a3261b',
};

export interface OverlayMarker {
  pinId: string;
  number: number;
  label: string;
  title: string;
  type: PinType;
  /** Absolute pixel position on the source image. */
  x: number;
  y: number;
  /** Diameter in pixels of the marker circle. */
  size: number;
  fill: string;
}

/**
 * Markers scale with the image, not with the viewport: a 1200px screenshot and
 * a 3200px one must both read clearly, and the overlay is composited once at
 * full resolution.
 */
export function overlayMarkerSize(width: number, height: number): number {
  const shortEdge = Math.min(width, height);
  return Math.round(Math.min(64, Math.max(26, shortEdge * 0.026)));
}

export function buildOverlayMarkers(input: {
  screen: Screen;
  pins: readonly Pin[];
  width: number;
  height: number;
}): OverlayMarker[] {
  const size = overlayMarkerSize(input.width, input.height);
  return sortPinsByNumber(input.pins).map((pin) => ({
    pinId: pin.id,
    number: pin.number,
    label: pinLabel(input.screen.code, pin.number),
    title: pin.title,
    type: pin.type,
    x: Math.round(pin.anchor.x * input.width),
    y: Math.round(pin.anchor.y * input.height),
    size,
    fill: PIN_TYPE_COLOR[pin.type],
  }));
}

/** Font size for the `#12` text inside a marker, at overlay resolution. */
export function overlayMarkerFontSize(size: number): number {
  return Math.max(9, Math.round(size * 0.4));
}
