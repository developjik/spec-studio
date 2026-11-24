import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Maturity } from '@spec-studio/core';
import { TopBar } from '../src/components/TopBar';

const noop = () => {};

function renderModeSwitch(uiMode: 'easy' | 'pro'): string {
  return renderToStaticMarkup(
    createElement(TopBar, {
      screen: null,
      daemonStatus: 'offline',
      view: 'studio',
      maturity: null as unknown as Maturity,
      uiMode,
      onToggleMode: noop,
      onView: noop,
      onExport: noop,
      onImport: noop,
      onBackup: noop,
      onReset: noop,
      onOpenOutputs: noop,
      onOpenPublish: noop,
      onOpenAi: noop,
      aiSource: null,
    }),
  );
}

describe('TopBar mode switch label', () => {
  it('names the destination mode when currently in easy mode', () => {
    expect(renderModeSwitch('easy')).toContain('>전문 모드로 전환</button>');
  });

  it('names the destination mode when currently in pro mode', () => {
    expect(renderModeSwitch('pro')).toContain('>간편 모드로 전환</button>');
  });
});
