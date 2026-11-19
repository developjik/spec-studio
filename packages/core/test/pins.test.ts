import { describe, expect, it } from 'vitest';
import type { PinType, Project, Screen } from '@spec-studio/protocol';
import {
  DomainError,
  countByType,
  createProject,
  execute,
  filterPins,
  missingPinNumbers,
  nextPinNumber,
  normalizeProject,
  pinLabel,
  resolvePinSeq,
  type ExecuteContext,
} from '../src';

const AT = '2026-11-19T09:00:00.000Z';

let pinCounter = 0;
let counter = 0;

function context(at = AT): ExecuteContext {
  return {
    at,
    nextId: (kind): string => {
      if (kind === 'screen') return `S_${'a'.repeat(12)}`;
      if (kind !== 'pin') return `${kind === 'doc' ? 'D' : kind === 'block' ? 'B' : 'PR'}_${String(++counter).padStart(12, '0')}`;
      pinCounter += 1;
      return `P_${String(pinCounter).padStart(12, '0')}`;
    },
  };
}

const screen: Screen = {
  id: `S_${'a'.repeat(12)}`,
  title: '주문 상세',
  code: 'SCR-110',
  ref: { kind: 'image', value: 'data:image/svg+xml;base64,PHN2Zy8+' },
  viewport: { width: 1200, height: 800 },
  createdAt: AT,
  updatedAt: AT,
};

function withScreen(): Project {
  const base = createProject({ id: 'PRJ_000000000001', name: '주문 취소 정책', at: AT });
  return execute(base, { type: 'screen.attach', screen }, context()).project;
}

function add(
  project: Project,
  title: string,
  pinType: PinType = 'function',
  at = AT,
): Project {
  const current = project.screen;
  if (current === null) throw new Error('test setup: no screen');
  return execute(
    project,
    {
      type: 'pin.create',
      screenId: current.id,
      pinType,
      title,
      body: '',
      anchor: { x: 0.42, y: 0.61 },
    },
    context(at),
  ).project;
}

function remove(project: Project, number: number): Project {
  const current = project.screen;
  const pin = project.pins.find((candidate) => candidate.number === number);
  if (!current || !pin) throw new Error('test setup: pin not found');
  return execute(
    project,
    { type: 'pin.delete', screenId: current.id, pinId: pin.id },
    context(),
  ).project;
}

describe('pin numbering', () => {
  it('starts at 1 and allocates sequentially', () => {
    let project = withScreen();
    project = add(project, '취소 버튼');
    project = add(project, '배송 전 취소 가능', 'policy');
    project = add(project, '이미 배송 시작됨', 'exception');

    expect(project.pins.map((pin) => pin.number)).toEqual([1, 2, 3]);
    expect(project.pinSeq).toBe(3);
    expect(nextPinNumber(project.pinSeq)).toBe(4);
  });

  it('keeps the gap when a middle pin is deleted and never pulls later numbers down', () => {
    let project = withScreen();
    project = add(project, 'one');
    project = add(project, 'two', 'policy');
    project = add(project, 'three', 'exception');

    project = remove(project, 2);

    expect(project.pins.map((pin) => pin.number)).toEqual([1, 3]);
    expect(missingPinNumbers(project.pins)).toEqual([2]);
    expect(project.pinSeq).toBe(3);

    project = add(project, 'four');
    expect(project.pins.map((pin) => pin.number)).toEqual([1, 3, 4]);
    expect(missingPinNumbers(project.pins)).toEqual([2]);
  });

  it('does not reuse a deleted top number', () => {
    let project = withScreen();
    project = add(project, 'one');
    project = add(project, 'two', 'policy');
    project = add(project, 'three', 'exception');

    project = remove(project, 3);
    expect(project.pins.map((pin) => pin.number)).toEqual([1, 2]);

    project = add(project, 'four');
    expect(project.pins.map((pin) => pin.number)).toEqual([1, 2, 4]);
    expect(project.pinSeq).toBe(4);
  });

  it('editing a pin never changes its number', () => {
    let project = withScreen();
    project = add(project, '취소 버튼', 'function');
    const pin = project.pins[0];
    if (!pin || !project.screen) throw new Error('test setup: pin not found');

    project = execute(
      project,
      {
        type: 'pin.update',
        screenId: project.screen.id,
        pinId: pin.id,
        pinType: 'policy',
        title: '취소 버튼 (배송 전에만)',
        body: '배송 시작 후에는 비활성화한다.',
      },
      context('2026-11-19T09:05:00.000Z'),
    ).project;

    const updated = project.pins[0];
    expect(updated?.number).toBe(1);
    expect(updated?.type).toBe('policy');
    expect(updated?.title).toBe('취소 버튼 (배송 전에만)');
    expect(updated?.updatedAt).toBe('2026-11-19T09:05:00.000Z');
    expect(updated?.createdAt).toBe(AT);
  });

  it('labels a pin with its screen code', () => {
    expect(pinLabel('SCR-110', 3)).toBe('SCR-110-3');
  });

  it('filters by type without touching numbers', () => {
    let project = withScreen();
    project = add(project, 'one');
    project = add(project, 'two', 'policy');
    project = add(project, 'three', 'exception');

    expect(filterPins(project.pins, 'policy').map((pin) => pin.number)).toEqual([2]);
    expect(filterPins(project.pins, 'all')).toHaveLength(3);
    expect(countByType(project.pins)).toMatchObject({ function: 1, policy: 1, exception: 1 });
  });
});

describe('state coming from outside', () => {
  it('raises a missing high-water mark to the largest number present', () => {
    let project = withScreen();
    project = add(project, 'one');
    project = add(project, 'two', 'policy');

    const imported: Project = { ...project, pinSeq: 0 };
    const normalized = normalizeProject(imported);

    expect(normalized.pinSeq).toBe(2);
    expect(add(normalized, 'three').pins.map((pin) => pin.number)).toEqual([1, 2, 3]);
  });

  it('never lowers a high-water mark that is ahead of the pins', () => {
    let project = withScreen();
    project = add(project, 'one');
    project = remove(project, 1);

    expect(project.pins).toHaveLength(0);
    expect(project.pinSeq).toBe(1);
    expect(resolvePinSeq(project.pinSeq, project.pins)).toBe(1);
    expect(add(project, 'two').pins[0]?.number).toBe(2);
  });

  it('orders pins by number on normalize', () => {
    let project = withScreen();
    project = add(project, 'one');
    project = add(project, 'two', 'policy');
    const shuffled: Project = { ...project, pins: [...project.pins].reverse() };
    expect(normalizeProject(shuffled).pins.map((pin) => pin.number)).toEqual([1, 2]);
  });
});

describe('commands and events', () => {
  it('emits the created pin with its number', () => {
    const project = withScreen();
    const result = execute(
      project,
      {
        type: 'pin.create',
        screenId: screen.id,
        pinType: 'policy',
        title: '배송 전 취소 가능',
        body: '',
        anchor: { x: 0.1, y: 0.2 },
      },
      context(),
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: 'pin.created', pin: { number: 1 } });
  });

  it('reports the deleted number so copies can keep the gap', () => {
    let project = withScreen();
    project = add(project, 'one');
    project = add(project, 'two', 'policy');
    const pin = project.pins[1];
    if (!pin) throw new Error('test setup: pin not found');

    const result = execute(
      project,
      { type: 'pin.delete', screenId: screen.id, pinId: pin.id },
      context(),
    );
    expect(result.events[0]).toMatchObject({ type: 'pin.deleted', number: 2 });
  });

  it('starts a new numbering space for a new screen', () => {
    let project = withScreen();
    project = add(project, 'one');
    project = add(project, 'two', 'policy');

    const nextScreen: Screen = { ...screen, id: `S_${'b'.repeat(12)}`, title: '주문 목록' };
    project = execute(project, { type: 'screen.attach', screen: nextScreen }, context()).project;

    expect(project.pins).toHaveLength(0);
    expect(project.pinSeq).toBe(0);
    expect(add(project, 'first on the next screen').pins[0]?.number).toBe(1);
  });

  it('refuses to pin without a screen', () => {
    const base = createProject({ id: 'PRJ_000000000001', name: '빈 프로젝트', at: AT });
    expect(() =>
      execute(
        base,
        {
          type: 'pin.create',
          screenId: `S_${'a'.repeat(12)}`,
          pinType: 'function',
          title: 'x',
          body: '',
          anchor: { x: 0.5, y: 0.5 },
        },
        context(),
      ),
    ).toThrow(DomainError);
  });

  it('refuses to delete a pin that is not there', () => {
    const project = withScreen();
    expect(() =>
      execute(
        project,
        { type: 'pin.delete', screenId: screen.id, pinId: `P_${'z'.repeat(12)}` },
        context(),
      ),
    ).toThrow(/no pin with that id/);
  });
});
