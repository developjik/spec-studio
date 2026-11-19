import { buildOverlayMarkers, overlayMarkerFontSize } from '@spec-studio/core';
import type { Pin, Screen } from '@spec-studio/protocol';

export interface OverlayResult {
  dataUrl: string;
  blob: Blob;
  width: number;
  height: number;
  markers: number;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'sync';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('화면 이미지를 읽지 못해 오버레이를 만들 수 없습니다.'));
    image.src = src;
  });
}

/**
 * The marker geometry and colours come from `@spec-studio/core` — the same
 * module the static HTML uses — and this function only paints them. Composited
 * once at the source image's resolution, so the PNG stays sharp when it is
 * pasted into a document at full size.
 */
export async function renderOverlayPng(screen: Screen, pins: readonly Pin[]): Promise<OverlayResult> {
  if (screen.ref.kind !== 'image') {
    throw new Error('오버레이 PNG는 이미지 화면에서만 만들 수 있습니다.');
  }

  const image = await loadImage(screen.ref.value);
  const width = image.naturalWidth || screen.viewport?.width || 1440;
  const height = image.naturalHeight || screen.viewport?.height || 900;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('이 브라우저에서 캔버스를 사용할 수 없습니다.');

  context.drawImage(image, 0, 0, width, height);

  const markers = buildOverlayMarkers({ screen, pins, width, height });
  for (const marker of markers) {
    const radius = marker.size / 2;

    context.save();
    context.beginPath();
    context.arc(marker.x, marker.y, radius + marker.size * 0.09, 0, Math.PI * 2);
    context.fillStyle = 'rgba(255, 255, 255, 0.96)';
    context.fill();

    context.beginPath();
    context.arc(marker.x, marker.y, radius, 0, Math.PI * 2);
    context.fillStyle = marker.fill;
    context.fill();

    context.fillStyle = '#ffffff';
    context.font = `600 ${overlayMarkerFontSize(marker.size)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(`#${marker.number}`, marker.x, marker.y + marker.size * 0.02);
    context.restore();
  }

  const dataUrl = canvas.toDataURL('image/png');
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result === null) reject(new Error('PNG를 만들지 못했습니다.'));
      else resolve(result);
    }, 'image/png');
  });

  return { dataUrl, blob, width, height, markers: markers.length };
}
