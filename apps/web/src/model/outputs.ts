import {
  buildSpecSummaryMd,
  buildTasksMd,
  buildTextOutputs,
  outputFileName,
  type OutputKind,
} from '@spec-studio/core';
import type { Doc, Pin, Project, Screen } from '@spec-studio/protocol';
import { formatBytes } from './downloads';
import { renderOverlayPng } from './overlay';
import { bundleOf } from './storage';
import type { ZipEntry } from './zip';

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
  /** W4: the document is part of the handoff sheet when there is one. */
  doc?: Doc | null;
  generatedAt: string;
}): Promise<OutputSet> {
  const { screen, pins, pinSeq, generatedAt } = input;
  const text = buildTextOutputs({ screen, pins, pinSeq, doc: input.doc ?? null, generatedAt });

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

/** The six files a handoff package carries (F4 · AC-8), in zip order. */
export const PACKAGE_FILE_COUNT = 6;

export function packageZipName(screen: Screen): string {
  return `spec-studio-${screen.code.toLowerCase()}-handoff.zip`;
}

/**
 * One read of the project → the six files of one zip. Deterministic on
 * purpose: the stamp is `project.updatedAt`, not the wall clock, so a
 * re-export of an untouched project writes the same bytes (멱등 — AC-8).
 */
export async function buildPackageFiles(input: {
  project: Project;
  screen: Screen;
  pins: readonly Pin[];
  pinSeq: number;
  doc?: Doc | null;
}): Promise<ZipEntry[]> {
  const { project, screen, pins } = input;
  const generatedAt = project.updatedAt;
  const encoder = new TextEncoder();
  const text = (value: string) => encoder.encode(value);

  const overlay = await renderOverlayPng(screen, pins);
  const outputs = buildTextOutputs({
    screen,
    pins,
    pinSeq: input.pinSeq,
    doc: input.doc ?? null,
    generatedAt,
  });
  const bundle = JSON.stringify(bundleOf(project, generatedAt), null, 2);

  return [
    { name: 'spec-summary.md', data: text(buildSpecSummaryMd({ project, generatedAt })) },
    {
      name: outputFileName(screen, 'overlay-png'),
      data: new Uint8Array(await overlay.blob.arrayBuffer()),
    },
    { name: outputFileName(screen, 'spec-html'), data: text(outputs.html) },
    { name: outputFileName(screen, 'qa-csv'), data: text(outputs.csv) },
    { name: 'tasks.md', data: text(buildTasksMd({ project, generatedAt })) },
    { name: 'bundle.json', data: text(bundle) },
  ];
}
