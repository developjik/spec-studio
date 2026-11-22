import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject } from '@spec-studio/core';
import {
  loadLocalSettings,
  loadUiMode,
  resolveUiMode,
  saveUiMode,
  SETTINGS_KEY,
} from '../src/model/settings';
import { loadProject, saveProject } from '../src/model/storage';

/**
 * E4 F1 — the easy/pro preference is a *local setting*, never project data
 * (§4.3-A2): it lives under its own localStorage key so bundle exports stay
 * byte-identical across mode flips (AC-4) and no command is issued (DG-2).
 *
 * Detection contract (U-3 + §4.3-A2): a saved choice always wins; with none,
 * "기존 로컬 데이터 부재" — `loadProject()` returning null — means a new user
 * and the default is easy; a stored project means an existing user → pro.
 * The resolved default is persisted immediately so the mode never flips under
 * someone who simply kept working.
 */

function memoryLocalStorage(): Storage {
  const map = new Map<string, string>();
  const stub: Storage = {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
  return stub;
}

declare global {
  // The node test env has no DOM; settings/storage only ever touch
  // `window.localStorage`, so a stub on globalThis is the whole harness.
  // eslint-disable-next-line no-var
  var window: { localStorage: Storage } | undefined;
}

let store: Storage;

beforeEach(() => {
  store = memoryLocalStorage();
  globalThis.window = { localStorage: store };
});

afterEach(() => {
  globalThis.window = undefined;
});

function seedStoredProject(): void {
  const project = createProject({ id: 'P_test0001', name: '기존 프로젝트', at: '2026-11-23T00:00:00.000Z' });
  const outcome = saveProject(project);
  expect(outcome.ok).toBe(true);
  expect(loadProject()).not.toBeNull();
}

describe('resolveUiMode — 신규/기존 판정', () => {
  it('기존 로컬 데이터 부재(loadProject null) → 간편 모드, 즉시 기억', () => {
    expect(loadProject()).toBeNull();
    expect(resolveUiMode(loadProject() !== null)).toBe('easy');
    // The detected default is persisted: next boot must not re-detect and flip.
    expect(loadUiMode()).toBe('easy');
  });

  it('저장된 프로젝트 존재 → 전문 모드, 즉시 기억', () => {
    seedStoredProject();
    expect(resolveUiMode(loadProject() !== null)).toBe('pro');
    expect(loadUiMode()).toBe('pro');
  });

  it('저장된 선택이 판정보다 우선 — 기억한 선택은 절대 덮어쓰지 않는다', () => {
    seedStoredProject();
    saveUiMode('easy');
    expect(resolveUiMode(loadProject() !== null)).toBe('easy');

    store.clear();
    saveUiMode('pro');
    expect(resolveUiMode(loadProject() !== null)).toBe('pro');
  });
});

describe('loadLocalSettings — 견고성', () => {
  it('키가 없으면 빈 설정', () => {
    expect(loadLocalSettings()).toEqual({});
    expect(loadUiMode()).toBeNull();
  });

  it('깨진 JSON은 저장값이 없는 것과 같이 취급', () => {
    store.setItem(SETTINGS_KEY, '{broken');
    expect(loadLocalSettings()).toEqual({});
    expect(resolveUiMode(false)).toBe('easy');
  });

  it('알 수 없는 mode 값은 미저장과 같이 취급', () => {
    store.setItem(SETTINGS_KEY, JSON.stringify({ mode: 'ultra' }));
    expect(loadUiMode()).toBeNull();
    expect(resolveUiMode(true)).toBe('pro');
  });
});

describe('saveUiMode — 로컬 설정 입출력', () => {
  it('settings 키에 쓰고 프로젝트 키는 건드리지 않는다(A2·AC-4)', () => {
    seedStoredProject();
    const projectRaw = store.getItem('spec-studio.project.v1');
    saveUiMode('easy');
    expect(store.getItem('spec-studio.project.v1')).toBe(projectRaw);
    expect(JSON.parse(store.getItem(SETTINGS_KEY) as string)).toMatchObject({ mode: 'easy' });
  });

  it('다른 설정 필드를 보존하며 병합한다(온보딩 진행 상태 등 후속 필드)', () => {
    store.setItem(SETTINGS_KEY, JSON.stringify({ tour: { done: true } }));
    saveUiMode('pro');
    expect(loadLocalSettings()).toMatchObject({ mode: 'pro', tour: { done: true } });
  });

  it('왕복 저장: easy→pro→easy 전부 그대로 읽힌다', () => {
    saveUiMode('easy');
    saveUiMode('pro');
    expect(loadUiMode()).toBe('pro');
    saveUiMode('easy');
    expect(loadUiMode()).toBe('easy');
  });
});
