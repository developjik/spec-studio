import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EntryGate } from '../src/components/EntryGate';
import { parseFigmaUrl } from '../src/model/figmaUrl';

describe('parseFigmaUrl', () => {
  it('accepts HTTPS Figma URLs and subdomains', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/file')).toEqual(
      new URL('https://www.figma.com/design/file'),
    );
    expect(parseFigmaUrl('https://figma.com/file')).toEqual(new URL('https://figma.com/file'));
  });

  it('rejects non-HTTPS, non-Figma, and malformed URLs', () => {
    expect(parseFigmaUrl('http://www.figma.com/design/file')).toBeNull();
    expect(parseFigmaUrl('https://example.com/figma.com')).toBeNull();
    expect(parseFigmaUrl('https://figma.com.attacker.example/file')).toBeNull();
    expect(parseFigmaUrl('not a URL')).toBeNull();
  });
});

describe('EntryGate Figma form', () => {
  it('bypasses silent browser URL rejection and exposes errors as an alert', () => {
    const markup = renderToStaticMarkup(
      createElement(EntryGate, {
        error: 'Figma 주소는 HTTPS를 사용하고 figma.com 도메인이어야 합니다.',
        onSample: () => undefined,
        onFile: () => undefined,
        onFigma: () => undefined,
      }),
    );

    expect(markup).toContain('novalidate=""');
    expect(markup).toContain('type="url"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Figma 주소는 HTTPS를 사용하고 figma.com 도메인이어야 합니다.');
  });
});
