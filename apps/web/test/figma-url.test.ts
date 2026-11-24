import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EntryGate } from '../src/components/EntryGate';
import {
  FIGMA_URL_FORMAT_ERROR,
  FIGMA_URL_HOST_ERROR,
  FIGMA_URL_HTTPS_ERROR,
  figmaUrlInputError,
} from '../src/model/figmaUrl';

describe('figmaUrlInputError', () => {
  it('reports malformed input', () => {
    expect(figmaUrlInputError('abc')).toBe(FIGMA_URL_FORMAT_ERROR);
  });

  it('requires HTTPS for Figma hosts', () => {
    expect(figmaUrlInputError('http://www.figma.com/file/example')).toBe(FIGMA_URL_HTTPS_ERROR);
  });

  it('rejects non-Figma hosts and lookalike suffixes', () => {
    expect(figmaUrlInputError('https://example.com/file/example')).toBe(FIGMA_URL_HOST_ERROR);
    expect(figmaUrlInputError('https://figma.com.example.org/file/example')).toBe(FIGMA_URL_HOST_ERROR);
  });

  it('accepts HTTPS on the figma.com domain and its subdomains', () => {
    expect(figmaUrlInputError('https://www.figma.com/file/example')).toBeNull();
    expect(figmaUrlInputError('https://figma.com/file/example')).toBeNull();
  });

  it('leaves an empty field without a URL error', () => {
    expect(figmaUrlInputError('  ')).toBeNull();
  });
});

describe('EntryGate Figma server markup', () => {
  it('keeps native URL markup and the accessible error path without event attributes', () => {
    const markup = renderToStaticMarkup(
      createElement(EntryGate, {
        error: '주소 형식을 확인해 주세요.',
        onSample: () => undefined,
        onFile: () => undefined,
        onFigma: () => undefined,
      }),
    );

    expect(markup).toContain('<form class="entry">');
    expect(markup).toContain('type="url"');
    expect(markup).toContain('aria-label="Figma 프레임 URL"');
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain('novalidate');
    expect(markup.toLowerCase()).not.toContain('oninvalid');
    expect(markup).not.toContain('data-surface');
  });
});
