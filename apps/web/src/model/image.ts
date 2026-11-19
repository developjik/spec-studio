export interface LoadedImage {
  dataUrl: string;
  width: number;
  height: number;
  name: string;
}

const MAX_EDGE = 1600;
const MAX_BYTES = 12 * 1024 * 1024;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
    reader.readAsDataURL(file);
  });
}

function measure(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('이미지를 해석하지 못했습니다.'));
    image.src = dataUrl;
  });
}

/**
 * Screenshots are pasted straight from a design tool, so they arrive huge.
 * Downscaling to 1600px on the long edge keeps text readable and the data URL
 * small enough for localStorage.
 */
export async function imageFromFile(file: File): Promise<LoadedImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('이미지 파일만 화면으로 등록할 수 있습니다.');
  }
  if (file.size > MAX_BYTES) {
    throw new Error('12MB 이하 이미지를 사용해 주세요.');
  }

  const name = file.name === '' || file.name === 'image.png' ? '붙여넣은 이미지' : file.name;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas unavailable');
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const dataUrl = canvas.toDataURL('image/webp', 0.92);
    return { dataUrl, width, height, name };
  } catch {
    const dataUrl = await readAsDataUrl(file);
    const size = await measure(dataUrl);
    return { dataUrl, ...size, name };
  }
}
