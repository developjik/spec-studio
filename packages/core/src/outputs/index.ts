import type { Pin, Screen } from '@spec-studio/protocol';
import { slug } from './base64';
import { buildQaCsv } from './csv';
import { renderStaticHtml } from './html';

/**
 * The three outputs W2 promises, named and described in one place so the web
 * app's preview and the download buttons cannot drift apart.
 */
export const OUTPUT_SPECS = [
  {
    kind: 'overlay-png',
    title: '오버레이 PNG',
    hint: '원본 화면 위에 번호 핀이 합성된 이미지',
    extension: 'png',
  },
  {
    kind: 'spec-html',
    title: '정적 HTML',
    hint: '앱 없이 열리는 자기완결형 화면설계서',
    extension: 'html',
  },
  {
    kind: 'qa-csv',
    title: 'QA CSV',
    hint: '엑셀에서 바로 여는 검증 케이스 목록',
    extension: 'csv',
  },
] as const;

export type OutputKind = (typeof OUTPUT_SPECS)[number]['kind'];

export function outputFileName(screen: Screen, kind: OutputKind): string {
  const base = `spec-studio-${slug(screen.code)}`;
  switch (kind) {
    case 'overlay-png':
      return `${base}-overlay.png`;
    case 'spec-html':
      return `${base}.html`;
    case 'qa-csv':
      return `${base}-qa.csv`;
  }
}

/** Everything the text-based outputs need; the PNG is drawn in the browser. */
export function buildTextOutputs(input: {
  screen: Screen;
  pins: readonly Pin[];
  pinSeq?: number;
  generatedAt: string;
}): { html: string; csv: string } {
  return {
    html: renderStaticHtml(input),
    csv: buildQaCsv({ screen: input.screen, pins: input.pins }),
  };
}

export * from './base64';
export * from './csv';
export * from './html';
export * from './overlay';
export * from './tables';
