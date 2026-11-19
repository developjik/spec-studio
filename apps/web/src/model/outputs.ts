import { buildTextOutputs, outputFileName, type OutputKind } from '@spec-studio/core';
import type { Pin, Screen } from '@spec-studio/protocol';
import { formatBytes } from './downloads';
import { renderOverlayPng } from './overlay';

export interface BuiltOutput {
  kind: OutputKind;
  fileName: string;
  blob: Blob;
  /** Text outputs carry their source so the preview can show it. */
  text: string | null;
  /** The PNG carries its own preview and byte size. */
  dataUrl: string | null;
  bytes: number;
  detail: string;
}

export interface OutputSet {
  files: BuiltOutput[];
  generatedAt: string;
}

/**
 * Builds all three outputs from one read of the pins. No network, no server:
 * the PNG is composited on a canvas and the other two are strings from core.
 */
export async function buildOutputSet(input: {
  screen: Screen;
  pins: readonly Pin[];
  pinSeq: number;
  generatedAt: string;
}): Promise<OutputSet> {
  const { screen, pins, pinSeq, generatedAt } = input;
  const text = buildTextOutputs({ screen, pins, pinSeq, generatedAt });

  const files: BuiltOutput[] = [];

  const overlay = await renderOverlayPng(screen, pins);
  files.push({
    kind: 'overlay-png',
    fileName: outputFileName(screen, 'overlay-png'),
    blob: overlay.blob,
    text: null,
    dataUrl: overlay.dataUrl,
    bytes: overlay.blob.size,
    detail: `${overlay.width}×${overlay.height} · 핀 ${overlay.markers}개 합성`,
  });

  const htmlBlob = new Blob([text.html], { type: 'text/html;charset=utf-8' });
  files.push({
    kind: 'spec-html',
    fileName: outputFileName(screen, 'spec-html'),
    blob: htmlBlob,
    text: text.html,
    dataUrl: null,
    bytes: htmlBlob.size,
    detail: '외부 요청 0건 · 인라인 CSS · base64 이미지',
  });

  const csvBlob = new Blob([text.csv], { type: 'text/csv;charset=utf-8' });
  files.push({
    kind: 'qa-csv',
    fileName: outputFileName(screen, 'qa-csv'),
    blob: csvBlob,
    text: text.csv,
    dataUrl: null,
    bytes: csvBlob.size,
    detail: `UTF-8 BOM · 케이스 ${countCsvRows(text.csv)}건`,
  });

  return { files, generatedAt };
}

function countCsvRows(csv: string): number {
  const body = csv.replace(/^\uFEFF/, '');
  const lines = body.split('\r\n').filter((line) => line !== '');
  return Math.max(0, lines.length - 1);
}

export function outputDetailSize(output: BuiltOutput): string {
  return formatBytes(output.bytes);
}
