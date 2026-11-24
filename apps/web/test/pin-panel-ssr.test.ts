import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PinPanel } from '../src/components/PinPanel';

describe('PinPanel filter scope SSR markup', () => {
  it('associates the list-only explanation with the filter controls', () => {
    const markup = renderToStaticMarkup(
      createElement(PinPanel, {
        pins: [],
        doc: null,
        onFocusBlock: () => undefined,
        filter: 'all',
        screenCode: 'SCR-110',
        nextNumber: 1,
        pinSeq: 1,
        selectedPinId: null,
        onFilter: () => undefined,
        onSelect: () => undefined,
        onDelete: () => undefined,
        onUpdate: () => undefined,
        onCloseEditor: () => undefined,
      }),
    );

    expect(markup).toContain('aria-describedby="pin-filter-scope"');
    expect(markup).toContain('<p id="pin-filter-scope"');
    expect(markup).toContain(
      '핀 타입 필터는 핀 목록에만 적용됩니다. 캔버스의 핀 표시는 바뀌지 않습니다.',
    );
  });
});
