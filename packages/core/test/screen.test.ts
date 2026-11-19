import { describe, expect, it } from 'vitest';
import type { Project, Screen } from '@spec-studio/protocol';
import { createProject, DomainError, execute, type ExecuteContext } from '../src';

const AT = '2026-11-19T09:00:00.000Z';

let counter = 0;
const context = (): ExecuteContext => ({
  at: AT,
  nextId: (kind) => (kind === 'screen' ? `S_${'b'.repeat(12)}` : `P_${String(++counter).padStart(12, '0')}`),
});

const screen = (overrides: Partial<Screen> = {}): Screen => ({
  id: `S_${'b'.repeat(12)}`,
  title: '주문 상세',
  code: 'SCR-110',
  ref: { kind: 'image', value: 'data:image/svg+xml;base64,PHN2Zy8+' },
  viewport: { width: 1200, height: 800 },
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

function project(): Project {
  const base = createProject({ id: 'PRJ_000000000001', name: '주문 취소 정책', at: AT });
  const withScreen = execute(base, { type: 'screen.attach', screen: screen() }, context()).project;
  return execute(
    withScreen,
    {
      type: 'pin.create',
      screenId: `S_${'b'.repeat(12)}`,
      pinType: 'function',
      title: '취소 요청',
      body: '',
      anchor: { x: 0.2, y: 0.3 },
    },
    context(),
  ).project;
}

describe('screen metadata', () => {
  it('registers a Figma frame without touching the pins or their numbers', () => {
    const before = project();
    const result = execute(
      before,
      { type: 'screen.update', screenId: `S_${'b'.repeat(12)}`, figmaUrl: 'https://www.figma.com/design/x/Shop' },
      context(),
    );

    expect(result.project.screen?.figmaUrl).toBe('https://www.figma.com/design/x/Shop');
    expect(result.project.pins.map((pin) => pin.number)).toEqual([1]);
    expect(result.project.pinSeq).toBe(1);
    expect(result.events.map((event) => event.type)).toEqual(['screen.updated']);
  });

  it('clears the frame with null', () => {
    const before = execute(
      project(),
      { type: 'screen.update', screenId: `S_${'b'.repeat(12)}`, figmaUrl: 'https://www.figma.com/design/x/Shop' },
      context(),
    ).project;
    const result = execute(
      before,
      { type: 'screen.update', screenId: `S_${'b'.repeat(12)}`, figmaUrl: null },
      context(),
    );
    expect(result.project.screen?.figmaUrl).toBeNull();
  });

  it('rejects a value that is not a URL', () => {
    expect(() =>
      execute(
        project(),
        { type: 'screen.update', screenId: `S_${'b'.repeat(12)}`, figmaUrl: 'not a url' },
        context(),
      ),
    ).toThrow();
  });

  it('refuses to edit another screen', () => {
    expect(() =>
      execute(
        project(),
        { type: 'screen.update', screenId: `S_${'z'.repeat(12)}`, title: '다른 화면' },
        context(),
      ),
    ).toThrow(DomainError);
  });
});
