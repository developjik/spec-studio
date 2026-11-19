import type { Pin, PinType } from '@spec-studio/protocol';

export type PinFilter = PinType | 'all';

/** Numbers start at 1. */
export function nextPinNumber(pinSeq: number): number {
  return Math.max(0, Math.trunc(pinSeq)) + 1;
}

/** The largest number currently on the screen, or 0 when it is empty. */
export function pinHighWater(pins: readonly Pin[]): number {
  return pins.reduce((max, pin) => Math.max(max, pin.number), 0);
}

/**
 * `pinSeq` is a high-water mark, not a count. When state comes from outside
 * (an import, a reload, a future database read) the mark can be missing or
 * behind, so it is raised to the largest number still present — never lowered.
 */
export function resolvePinSeq(pinSeq: number, pins: readonly Pin[]): number {
  return Math.max(Math.trunc(pinSeq), pinHighWater(pins));
}

/** "SCR-110" + 3 → "SCR-110-3" — the label a published document cites. */
export function pinLabel(screenCode: string, number: number): string {
  return `${screenCode}-${number}`;
}

/**
 * Numbers that were handed out and are no longer present. They stay gaps
 * forever: a renumbering would make every published reference to them false.
 *
 * `upTo` is the screen's high-water mark (`pinSeq`). It matters when the
 * *last* pin was deleted: without the mark there is no surviving pin to
 * compare against, and the gap would silently disappear.
 */
export function missingPinNumbers(pins: readonly Pin[], upTo?: number): number[] {
  const present = new Set(pins.map((pin) => pin.number));
  const top = Math.max(pinHighWater(pins), Math.trunc(upTo ?? 0));
  const gaps: number[] = [];
  for (let n = 1; n <= top; n += 1) {
    if (!present.has(n)) gaps.push(n);
  }
  return gaps;
}

export function filterPins(pins: readonly Pin[], filter: PinFilter): Pin[] {
  return filter === 'all' ? [...pins] : pins.filter((pin) => pin.type === filter);
}

/** Sorting never touches the stored number; it only changes the display order. */
export function sortPinsByNumber(pins: readonly Pin[]): Pin[] {
  return [...pins].sort((a, b) => a.number - b.number);
}

export function findPin(pins: readonly Pin[], pinId: string): Pin | undefined {
  return pins.find((pin) => pin.id === pinId);
}

export function countByType(pins: readonly Pin[]): Record<PinType, number> {
  const counts: Record<PinType, number> = {
    function: 0,
    policy: 0,
    exception: 0,
    state: 0,
    data: 0,
    permission: 0,
  };
  for (const pin of pins) counts[pin.type] += 1;
  return counts;
}
