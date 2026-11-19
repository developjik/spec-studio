import { createHash } from 'node:crypto';
import { buildTextOutputs, outputFileName } from '@spec-studio/core';
import { PIN_TYPE_LABEL, type Pin, type Screen } from '@spec-studio/protocol';
import {
  publishTitle,
  renderPublishBody,
  type PublishAttachmentInfo,
  type PublishAttachmentKind,
} from './body';

/**
 * One publish, assembled before any network call: the fingerprint that decides
 * idempotency, the Storage-Format body, and the three files that travel with it.
 * Everything is derived from the local project, so the same pins always produce
 * the same hash — which is what lets a restarted daemon recognise its own work.
 */

export interface PublishAttachment extends PublishAttachmentInfo {
  data: Uint8Array;
}

export interface PublishPackage {
  specHash: string;
  title: string;
  body: string;
  attachments: PublishAttachment[];
  generatedAt: string;
}

export interface PublishPackageInput {
  projectName: string;
  screen: Screen;
  pins: readonly Pin[];
  pinSeq: number;
  figmaUrl: string | null;
  generatedAt: string;
  /** Rendered in the browser, where the screenshot and canvas live. */
  overlayPng: Uint8Array;
}

/**
 * Content hash of what will be copied. Timestamps and ids that do not change
 * what a reader sees are left out; numbers, types, titles, bodies, anchors, the
 * screen and its Figma link are in — an edit to any of them is a new spec.
 */
export function specFingerprint(input: {
  screen: Screen;
  pins: readonly Pin[];
  figmaUrl: string | null;
}): string {
  const pins = [...input.pins]
    .sort((a, b) => a.number - b.number)
    .map((pin) => ({
      number: pin.number,
      type: pin.type,
      title: pin.title,
      body: pin.body,
      anchor: { x: pin.anchor.x, y: pin.anchor.y },
    }));
  const canonical = JSON.stringify({
    screen: {
      id: input.screen.id,
      code: input.screen.code,
      title: input.screen.title,
      ref: input.screen.ref,
      figmaUrl: input.figmaUrl,
      viewport: input.screen.viewport,
    },
    pins,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function buildPublishPackage(input: PublishPackageInput): PublishPackage {
  const specHash = specFingerprint({
    screen: input.screen,
    pins: input.pins,
    figmaUrl: input.figmaUrl,
  });
  const text = buildTextOutputs({
    screen: input.screen,
    pins: input.pins,
    pinSeq: input.pinSeq,
    generatedAt: input.generatedAt,
  });

  const attachments: PublishAttachment[] = [
    {
      kind: 'overlay-png',
      fileName: outputFileName(input.screen, 'overlay-png'),
      label: '오버레이 PNG',
      detail:
        input.screen.viewport === null
          ? '번호 핀이 합성된 화면 이미지'
          : `${input.screen.viewport.width}×${input.screen.viewport.height} · 번호 핀 합성`,
      contentType: 'image/png',
      bytes: input.overlayPng.byteLength,
      data: input.overlayPng,
    },
    {
      kind: 'spec-html',
      fileName: outputFileName(input.screen, 'spec-html'),
      label: '정적 HTML',
      detail: '앱 없이 열리는 자기완결형 화면설계서',
      contentType: 'text/html; charset=utf-8',
      bytes: bytesOf(text.html).byteLength,
      data: bytesOf(text.html),
    },
    {
      kind: 'qa-csv',
      fileName: outputFileName(input.screen, 'qa-csv'),
      label: 'QA CSV',
      detail: `UTF-8 BOM · ${PIN_TYPE_LABEL.function}·${PIN_TYPE_LABEL.policy}·${PIN_TYPE_LABEL.exception} 검증 케이스`,
      contentType: 'text/csv; charset=utf-8',
      bytes: bytesOf(text.csv).byteLength,
      data: bytesOf(text.csv),
    },
  ];

  return {
    specHash,
    title: publishTitle({ projectName: input.projectName, screen: input.screen }),
    body: renderPublishBody({
      projectName: input.projectName,
      screen: input.screen,
      pins: input.pins,
      pinSeq: input.pinSeq,
      figmaUrl: input.figmaUrl,
      generatedAt: input.generatedAt,
      specHash,
      attachments,
    }),
    attachments,
    generatedAt: input.generatedAt,
  };
}

export type { PublishAttachmentKind };
