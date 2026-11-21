import { describe, expect, it } from 'vitest';
import type { Doc, Pin, Project, Screen } from '@spec-studio/protocol';
import {
  QA_CSV_COLUMNS,
  buildOverlayMarkers,
  buildQaCsv,
  buildSpecOverview,
  createProject,
  execute,
  extractPrecondition,
  inlineImage,
  missingPinNumbers,
  outputFileName,
  overlayMarkerSize,
  renderStaticHtml,
  utf8Bytes,
  base64FromBytes,
  csvCell,
  type ExecuteContext,
} from '../src';

const AT = '2026-11-19T09:00:00.000Z';

const screen: Screen = {
  id: `S_${'a'.repeat(12)}`,
  title: '주문 상세',
  code: 'SCR-110',
  ref: { kind: 'image', value: 'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22x%22%2F%3E' },
  viewport: { width: 1200, height: 800 },
  createdAt: AT,
  updatedAt: AT,
};

let counter = 0;

function pin(number: number, type: Pin['type'], title: string, body = ''): Pin {
  counter += 1;
  return {
    id: `P_${String(counter).padStart(12, '0')}`,
    screenId: screen.id,
    number,
    type,
    title,
    body,
    anchor: { x: number / 10, y: number / 10 },
    createdAt: AT,
    updatedAt: AT,
  };
}

const pins: Pin[] = [
  pin(1, 'function', '취소 요청 버튼', '주문 상태가 배송 준비 중일 때만 눌린다.'),
  pin(2, 'policy', '배송 시작 후 취소 불가', '사전조건: 주문 상태 = 배송 시작\n고객센터 문의로만 처리한다.'),
  pin(4, 'exception', '재고 없음', ''),
];

let contextPinCounter = 0;

function context(): ExecuteContext {
  return {
    at: AT,
    nextId: (kind) =>
      kind === 'screen' ? screen.id : `P_${String((contextPinCounter += 1)).padStart(12, '0')}`,
  };
}

describe('spec tables', () => {
  it('splits pins into the three W2 tables, sorted by number', () => {
    const overview = buildSpecOverview({ screen, pins });
    expect(overview.tables.map((table) => table.pinType)).toEqual([
      'function',
      'policy',
      'exception',
    ]);
    expect(overview.tables[0]?.rows.map((row) => row.number)).toEqual([1]);
    expect(overview.tables[1]?.rows.map((row) => row.number)).toEqual([2]);
    expect(overview.tables[2]?.rows.map((row) => row.number)).toEqual([4]);
    expect(overview.total).toBe(3);
  });

  it('labels every row with the screen code and keeps gaps as gaps', () => {
    const overview = buildSpecOverview({ screen, pins });
    expect(overview.tables[0]?.rows[0]?.label).toBe('SCR-110-1');
    expect(overview.gaps).toEqual([3]);
    expect(overview.nextNumber).toBe(5);
  });

  it('reads a 사전조건 line out of the body without inventing one', () => {
    expect(extractPrecondition('사전조건: 주문 상태 = 배송 시작\n본문')).toBe('주문 상태 = 배송 시작');
    expect(extractPrecondition('조건：로그인 필요')).toBe('로그인 필요');
    expect(extractPrecondition('아무 설명')).toBe('');
  });

  it('keeps pins outside the W1 three in an extras list', () => {
    const overview = buildSpecOverview({ screen, pins: [...pins, pin(5, 'state', '로딩')] });
    expect(overview.extras.map((row) => row.number)).toEqual([5]);
    expect(overview.tables.flatMap((table) => table.rows).length).toBe(3);
  });

  it('reports a deleted top number as a gap once the high-water mark is known', () => {
    const three = [pin(1, 'function', 'a'), pin(2, 'policy', 'b')];
    expect(missingPinNumbers(three)).toEqual([]);
    expect(missingPinNumbers(three, 3)).toEqual([3]);
    expect(buildSpecOverview({ screen, pins: three, pinSeq: 3 }).gaps).toEqual([3]);
    expect(buildSpecOverview({ screen, pins: three, pinSeq: 3 }).nextNumber).toBe(4);
  });
});

describe('qa csv', () => {
  it('starts with a BOM and the promised columns, in CRLF', () => {
    const csv = buildQaCsv({ screen, pins });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(QA_CSV_COLUMNS.join(','));
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('derives the case id from the pin number so a deletion cannot renumber it', () => {
    const rows = buildQaCsv({ screen, pins: [pins[2] as Pin] }).slice(1).split('\r\n');
    expect(rows[1]).toContain('TC-004');
    expect(buildQaCsv({ screen, pins }).slice(1)).toContain('TC-001,');
  });

  it('fills 유형, 사전조건 and the untouched result column', () => {
    const csv = buildQaCsv({ screen, pins: [pins[1] as Pin] });
    expect(csv).toContain('정책');
    expect(csv).toContain('주문 상태 = 배송 시작');
    expect(csv).toContain('미실행');
  });

  it('quotes a cell only when it has to and doubles inner quotes', () => {
    const tricky = pin(6, 'function', '쉼표, 따옴표 "포함"', '여러\n줄');
    const csv = buildQaCsv({ screen, pins: [tricky] });
    expect(csv).toContain('"여러\n줄"');
    expect(csv).toContain('"쉼표, 따옴표 ""포함"""');
  });

  it('neutralises a cell a spreadsheet would run as a formula', () => {
    expect(csvCell('=cmd|calc')).toBe("'=cmd|calc");
    expect(csvCell('+1+1')).toBe("'+1+1");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\t=cmd')).toBe("'\t=cmd");
    expect(csvCell('\r=cmd')).toBe('"\'\r=cmd"');
    // A '=' that is not the first character is prose, and stays as written.
    expect(csvCell('사전조건: 주문 상태 = 배송 시작')).toBe('사전조건: 주문 상태 = 배송 시작');
  });

  it('keeps the formula guard when the cell also needs quoting', () => {
    const risky = pin(8, 'function', '=HYPERLINK("http://evil.example","주문")');
    const csv = buildQaCsv({ screen, pins: [risky] });
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""주문"")"`);
    expect(csv).not.toContain(',=HYPERLINK');
  });
});

describe('static html', () => {
  const html = renderStaticHtml({ screen, pins, generatedAt: AT });

  it('carries the image inline as base64', () => {
    expect(html).toContain('src="data:image/svg+xml;base64,');
    expect(html).not.toContain('charset=utf-8,%3Csvg');
  });

  it('requests nothing from the network', () => {
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('<link');
    expect(html).not.toContain('@import');
    expect(html).not.toContain('<script');
  });

  it('prints all three tables and the gap notice', () => {
    expect(html).toContain('기능 표');
    expect(html).toContain('정책 표');
    expect(html).toContain('예외 표');
    expect(html).toContain('결번 <b>#3</b>');
    expect(html).toContain('다음 핀은 <b>#5</b>');
  });

  it('escapes text that came from a pin', () => {
    const risky = pin(7, 'function', '<script>alert(1)</script>', '"quoted" & <b>');
    const document = renderStaticHtml({ screen, pins: [risky], generatedAt: AT });
    expect(document).not.toContain('<script>alert(1)</script>');
    expect(document).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(document).toContain('&quot;quoted&quot; &amp; &lt;b&gt;');
  });

  it('carries a policy that keeps the document inert wherever it is opened', () => {
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('img-src data:');
  });

  it('refuses to build a document around an image it would not embed', () => {
    const hostile = {
      ...screen,
      ref: { kind: 'image' as const, value: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' },
    };
    expect(() => renderStaticHtml({ screen: hostile, pins, generatedAt: AT })).toThrow(
      /allowed image type/,
    );
  });

  it('names the file after the screen code', () => {
    expect(outputFileName(screen, 'spec-html')).toBe('spec-studio-scr-110.html');
    expect(outputFileName(screen, 'qa-csv')).toBe('spec-studio-scr-110-qa.csv');
    expect(outputFileName(screen, 'overlay-png')).toBe('spec-studio-scr-110-overlay.png');
  });
});

describe('overlay markers', () => {
  it('places markers at the anchor in pixels of the source image', () => {
    const markers = buildOverlayMarkers({ screen, pins, width: 1200, height: 800 });
    expect(markers[0]).toMatchObject({ number: 1, x: 120, y: 80 });
    expect(markers.map((marker) => marker.number)).toEqual([1, 2, 4]);
  });

  it('scales the marker with the image and stays inside readable bounds', () => {
    expect(overlayMarkerSize(1200, 800)).toBe(26);
    expect(overlayMarkerSize(300, 200)).toBe(26);
    expect(overlayMarkerSize(6000, 4000)).toBe(64);
  });

  it('gives each type its own colour, shared with the app', () => {
    const markers = buildOverlayMarkers({ screen, pins, width: 1200, height: 800 });
    expect(markers[0]?.fill).toBe('#0f1216');
    expect(markers[1]?.fill).toBe('#2453c9');
    expect(markers[2]?.fill).toBe('#b4690e');
  });
});

describe('base64', () => {
  it('encodes UTF-8 the way Buffer does', () => {
    for (const text of ['', 'abc', '가나다', 'SCR-110 · 주문 상세', 'x'.repeat(1000)]) {
      expect(base64FromBytes(utf8Bytes(text))).toBe(Buffer.from(text, 'utf8').toString('base64'));
    }
  });

  it('turns a percent-encoded svg into a base64 data url', () => {
    const inlined = inlineImage(
      'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E',
    );
    expect(inlined.mime).toBe('image/svg+xml');
    expect(inlined.dataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(Buffer.from(inlined.base64, 'base64').toString('utf8')).toContain('<svg');
  });

  it('passes a base64 png through untouched', () => {
    const inlined = inlineImage('data:image/png;base64,AA==');
    expect(inlined.base64).toBe('AA==');
    expect(inlined.dataUrl).toBe('data:image/png;base64,AA==');
  });

  it('refuses a data url that is not a screenshot this app will embed', () => {
    for (const hostile of [
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'data:application/xhtml+xml;base64,PHNjcmlwdD4=',
      'data:image/png" onerror="alert(1);base64,AA==',
      'data:image/png;base64,AA=="><script>alert(1)</script>',
      'https://example.com/shot.png',
      'data:image/png;base64,',
    ]) {
      expect(() => inlineImage(hostile)).toThrow(/allowed image type/);
    }
  });
});

describe('editing and moving a pin', () => {
  function projectWithPins(): Project {
    const created = createProject({ id: 'PRJ_000000000001', name: '주문 상세', at: AT });
    const attached = execute(created, { type: 'screen.attach', screen }, context()).project;
    let project = attached;
    for (const draft of [
      { pinType: 'function' as const, title: '취소 요청', anchor: { x: 0.2, y: 0.3 } },
      { pinType: 'policy' as const, title: '배송 전 취소', anchor: { x: 0.4, y: 0.5 } },
    ]) {
      project = execute(
        project,
        {
          type: 'pin.create',
          screenId: screen.id,
          pinType: draft.pinType,
          title: draft.title,
          body: '',
          anchor: draft.anchor,
        },
        context(),
      ).project;
    }
    return project;
  }

  it('moves the anchor without touching the number', () => {
    const project = projectWithPins();
    const target = project.pins[0] as Pin;
    const moved = execute(
      project,
      { type: 'pin.update', screenId: screen.id, pinId: target.id, anchor: { x: 0.75, y: 0.6 } },
      context(),
    );
    expect(moved.project.pins[0]?.number).toBe(target.number);
    expect(moved.project.pins[0]?.anchor).toEqual({ x: 0.75, y: 0.6 });
    expect(moved.events[0]?.type).toBe('pin.updated');
  });

  it('edits type, title and body in one command and keeps the number', () => {
    const project = projectWithPins();
    const target = project.pins[1] as Pin;
    const edited = execute(
      project,
      {
        type: 'pin.update',
        screenId: screen.id,
        pinId: target.id,
        pinType: 'exception',
        title: '  재고 없음  ',
        body: ' 재고 0일 때 ',
      },
      context(),
    ).project;
    const after = edited.pins.find((candidate) => candidate.id === target.id);
    expect(after).toMatchObject({
      number: target.number,
      type: 'exception',
      title: '재고 없음',
      body: '재고 0일 때',
      anchor: target.anchor,
    });
  });

  it('refuses a move outside the image', () => {
    const project = projectWithPins();
    const target = project.pins[0] as Pin;
    expect(() =>
      execute(
        project,
        { type: 'pin.update', screenId: screen.id, pinId: target.id, anchor: { x: 1.4, y: 0.2 } },
        context(),
      ),
    ).toThrow();
  });
});

describe('the static HTML carries the document (W4)', () => {
  const doc: Doc = {
    id: `D_${'d'.repeat(12)}`,
    title: '주문 상세 문서',
    rev: 2,
    blocks: [
      {
        id: `B_${'b'.repeat(12)}`,
        type: 'paragraph',
        text: '배송이 시작되기 전까지만 취소할 수 있다.',
        pinRefs: [{ pinId: pins[0]!.id, fingerprint: 'ffffffff', linkedAt: AT }],
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    createdAt: AT,
    updatedAt: AT,
  };

  it('prints the paragraph, its pin and the stale mark without an app', () => {
    const html = renderStaticHtml({ screen, pins, doc, generatedAt: AT });
    expect(html).toContain('주문 상세 문서');
    expect(html).toContain('배송이 시작되기 전까지만 취소할 수 있다.');
    expect(html).toContain('#1 취소 요청');
    // the recorded fingerprint no longer matches the pin, so the sheet says so
    expect(html).toContain('핀이 바뀜 · 확인 필요');
    // and the sheet is still self-contained
    expect(html).not.toContain('src="http');
  });

  it('leaves the sheet unchanged when the project has no document', () => {
    const withOut = renderStaticHtml({ screen, pins, generatedAt: AT });
    expect(withOut).not.toContain('주문 상세 문서');
    expect(withOut).toContain('화면설계서');
  });
});
