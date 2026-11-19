import {
  PinSchema,
  ScreenSchema,
  type Command,
  type DomainEvent,
  type Anchor,
  type Pin,
  type Project,
  type Screen,
} from '@spec-studio/protocol';
import { filterPins, findPin, nextPinNumber, resolvePinSeq, sortPinsByNumber } from './pins';

export type DomainErrorCode =
  | 'screen_missing'
  | 'screen_mismatch'
  | 'pin_not_found'
  | 'invalid_input';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export interface ExecuteContext {
  /** Passed in, never read from the clock — core stays pure. */
  at: string;
  /** Ids are supplied by the caller for the same reason. */
  nextId: (kind: 'screen' | 'pin') => string;
}

export interface ExecutionResult {
  project: Project;
  events: DomainEvent[];
}

const round = (value: number, places = 4): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** A click or a drag both land in 0..1; anything else is a bug upstream. */
function requireAnchor(anchor: Anchor): Anchor {
  if (anchor.x < 0 || anchor.x > 1 || anchor.y < 0 || anchor.y > 1) {
    throw new DomainError('invalid_input', 'anchor must be inside the screen (0..1)');
  }
  return { x: round(clamp01(anchor.x)), y: round(clamp01(anchor.y)) };
}

export function createProject(input: { id: string; name: string; at: string }): Project {
  if (input.id.trim() === '') throw new DomainError('invalid_input', 'project id is required');
  const name = input.name.trim();
  if (name === '') throw new DomainError('invalid_input', 'project name is required');
  return {
    version: 1,
    id: input.id,
    name,
    screen: null,
    pins: [],
    pinSeq: 0,
    createdAt: input.at,
    updatedAt: input.at,
  };
}

/**
 * Brings state from outside (local storage, an import, a database) back to the
 * invariants: pins ordered by number, and the high-water mark at least as high
 * as every number still present.
 */
export function normalizeProject(project: Project): Project {
  const pins = sortPinsByNumber(project.pins);
  const pinSeq = resolvePinSeq(project.pinSeq, project.pins);
  const alreadyOrdered = project.pins.every((pin, index) => pin.id === pins[index]?.id);
  if (alreadyOrdered && pinSeq === project.pinSeq) return project;
  return { ...project, pins, pinSeq };
}

export function pinsForScreen(project: Project, screenId: string): Pin[] {
  return project.pins.filter((pin) => pin.screenId === screenId);
}

function requireScreen(project: Project, screenId: string): Screen {
  const screen = project.screen;
  if (screen === null) throw new DomainError('screen_missing', 'attach a screen first');
  if (screen.id !== screenId) {
    throw new DomainError('screen_mismatch', 'the command targets a different screen');
  }
  return screen;
}

/**
 * Applies one command. Every state change goes through here so the numbering
 * rule has exactly one implementation, and the UI can only inherit it.
 */
export function execute(
  project: Project,
  command: Command,
  ctx: ExecuteContext,
): ExecutionResult {
  switch (command.type) {
    case 'screen.attach': {
      const screen = command.screen;
      if (project.screen !== null && project.screen.id !== screen.id) {
        // A new screen is a new numbering space; the previous pins stay with
        // the previous screen and are not renumbered into this one.
        return {
          project: { ...project, screen, pins: [], pinSeq: 0, updatedAt: ctx.at },
          events: [{ type: 'screen.attached', screen }],
        };
      }
      return {
        project: { ...project, screen, updatedAt: ctx.at },
        events: [{ type: 'screen.attached', screen }],
      };
    }

    case 'screen.update': {
      const screen = requireScreen(project, command.screenId);
      const title = command.title === undefined ? screen.title : command.title.trim();
      if (title === '') throw new DomainError('invalid_input', 'a screen needs a title');
      const next = ScreenSchema.parse({
        ...screen,
        title,
        ...(command.figmaUrl === undefined ? {} : { figmaUrl: command.figmaUrl }),
        updatedAt: ctx.at,
      });
      return {
        project: { ...project, screen: next, updatedAt: ctx.at },
        events: [{ type: 'screen.updated', screen: next }],
      };
    }

    case 'pin.create': {
      const screen = requireScreen(project, command.screenId);
      const title = command.title.trim();
      if (title === '') throw new DomainError('invalid_input', 'a pin needs a title');
      const anchor = requireAnchor(command.anchor);
      const number = nextPinNumber(project.pinSeq);
      const pin = PinSchema.parse({
        id: ctx.nextId('pin'),
        screenId: screen.id,
        number,
        type: command.pinType,
        title,
        body: command.body.trim(),
        anchor,
        createdAt: ctx.at,
        updatedAt: ctx.at,
      });
      return {
        project: {
          ...project,
          pins: sortPinsByNumber([...project.pins, pin]),
          pinSeq: number,
          updatedAt: ctx.at,
        },
        events: [{ type: 'pin.created', pin }],
      };
    }

    case 'pin.update': {
      const screen = requireScreen(project, command.screenId);
      const current = findPin(project.pins, command.pinId);
      if (!current) throw new DomainError('pin_not_found', 'no pin with that id on this screen');
      if (current.screenId !== screen.id) {
        throw new DomainError('screen_mismatch', 'the pin belongs to another screen');
      }
      const title = command.title === undefined ? current.title : command.title.trim();
      if (title === '') throw new DomainError('invalid_input', 'a pin needs a title');
      const anchor =
        command.anchor === undefined ? current.anchor : requireAnchor(command.anchor);
      const pin = PinSchema.parse({
        ...current,
        type: command.pinType ?? current.type,
        title,
        body: command.body === undefined ? current.body : command.body.trim(),
        anchor,
        updatedAt: ctx.at,
      });
      return {
        project: {
          ...project,
          pins: project.pins.map((candidate) => (candidate.id === pin.id ? pin : candidate)),
          updatedAt: ctx.at,
        },
        events: [{ type: 'pin.updated', pin }],
      };
    }

    case 'pin.delete': {
      const screen = requireScreen(project, command.screenId);
      const current = findPin(project.pins, command.pinId);
      if (!current) throw new DomainError('pin_not_found', 'no pin with that id on this screen');
      return {
        project: {
          ...project,
          pins: project.pins.filter((pin) => pin.id !== current.id),
          updatedAt: ctx.at,
        },
        events: [
          { type: 'pin.deleted', screenId: screen.id, pinId: current.id, number: current.number },
        ],
      };
    }

    default: {
      const exhaustive: never = command;
      throw new DomainError('invalid_input', `unknown command ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Convenience for list views: pins of the screen, optionally filtered by type. */
export function visiblePins(project: Project, filter: Parameters<typeof filterPins>[1] = 'all'): Pin[] {
  return filterPins(project.pins, filter);
}
