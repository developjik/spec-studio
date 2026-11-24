import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Screen } from '@spec-studio/protocol';
import { CanvasStage } from '../src/components/CanvasStage';

const originalUrl = 'https://www.figma.com/design/original-file';
const editedUrl = 'https://www.figma.com/design/updated-file';

const screen: Screen = {
  id: 'SCR_test0001',
  title: 'Figma frame',
  code: 'SCR-101',
  ref: { kind: 'figma_frame', value: originalUrl },
  viewport: null,
  createdAt: '2026-11-24T00:00:00.000Z',
  updatedAt: '2026-11-24T00:00:00.000Z',
};

function renderScreen(currentScreen: Screen) {
  return renderToStaticMarkup(
    createElement(CanvasStage, {
      screen: currentScreen,
      pins: [],
      selectedPinId: null,
      draft: null,
      nextNumber: 1,
      onCanvasClick: () => undefined,
      onSelectPin: () => undefined,
      onMovePin: () => undefined,
      onSavePin: () => undefined,
      onCancelDraft: () => undefined,
    }),
  );
}

describe('CanvasStage Figma placeholder', () => {
  it('shows the edited URL while preserving the server-rendered markup structure', () => {
    const before = renderScreen(screen);
    const after = renderScreen({ ...screen, figmaUrl: editedUrl });

    expect(before).toContain(originalUrl);
    expect(after).toContain(editedUrl);
    expect(after).not.toContain(originalUrl);
    expect(after.replace(editedUrl, '__FIGMA_URL__')).toBe(
      before.replace(originalUrl, '__FIGMA_URL__'),
    );
  });
});
