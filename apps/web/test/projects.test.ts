import { describe, expect, it } from 'vitest';
import { DEFAULT_TITLE, projectsByRecent, switcherLabel, windowTitle } from '../src/model/projects';

const screen = (title: string) => ({ title }) as never;

describe('windowTitle', () => {
  it('names the project before the screen', () => {
    expect(windowTitle({ name: '결제 개편', screen: screen('로그인') })).toBe(
      '결제 개편 · 로그인 · spec-studio',
    );
  });

  it('tells apart two projects whose screens share a title', () => {
    const a = windowTitle({ name: 'A 프로젝트', screen: screen('로그인') });
    const b = windowTitle({ name: 'B 프로젝트', screen: screen('로그인') });
    expect(a).not.toBe(b);
    expect(a).toContain('A 프로젝트');
    expect(b).toContain('B 프로젝트');
  });

  it('does not repeat a name that equals the screen title', () => {
    expect(windowTitle({ name: '로그인', screen: screen('로그인') })).toBe('로그인 · spec-studio');
  });

  it('keeps the entry title before a screen exists', () => {
    expect(windowTitle(null)).toBe(DEFAULT_TITLE);
    expect(windowTitle({ name: '새 화면', screen: null })).toBe(DEFAULT_TITLE);
  });
});

describe('projectsByRecent', () => {
  it('puts the most recently touched first without mutating the input', () => {
    const list = [
      { id: 'a', updatedAt: '2026-11-20T00:00:00.000Z' },
      { id: 'b', updatedAt: '2026-11-22T00:00:00.000Z' },
      { id: 'c', updatedAt: '2026-11-21T00:00:00.000Z' },
    ];
    expect(projectsByRecent(list).map((p) => p.id)).toEqual(['b', 'c', 'a']);
    expect(list.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('switcherLabel', () => {
  it('adds the screen when it says more than the name', () => {
    expect(switcherLabel({ name: '결제 개편', screenTitle: '로그인' })).toBe('결제 개편 — 로그인');
    expect(switcherLabel({ name: '로그인', screenTitle: '로그인' })).toBe('로그인');
    expect(switcherLabel({ name: '새 화면', screenTitle: null })).toBe('새 화면');
  });
});
