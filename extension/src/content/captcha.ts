import { buildSelector, isVisible } from './detect';
import { findElementDeep, queryAllDeep } from './deep-query';
import { fillField, waitForElement } from './fill';

const GRAPHIC_CAPTCHA_HINT = /图形验证码|captcha|校验码|图形码/i;
const GENERIC_CODE_HINT = /验证码|verify\s*code/i;
const SMS_CODE_HINT = /短信|手机验证码|邮箱验证码|获取验证码/i;

function getElementLabel(element: Element): string {
  const parts = [
    element.getAttribute('placeholder') ?? '',
    element.getAttribute('aria-label') ?? '',
    element.getAttribute('name') ?? '',
    element.getAttribute('id') ?? '',
    element.getAttribute('title') ?? '',
  ];
  if (element instanceof HTMLInputElement) {
    parts.push(element.labels?.[0]?.textContent ?? '');
  }
  return parts.join(' ').trim();
}

function distanceBetween(a: Element, b: Element): number {
  const all = queryAllDeep<Element>('*');
  return Math.abs(all.indexOf(a) - all.indexOf(b));
}

export function isGraphicCaptchaField(element: Element): boolean {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    return false;
  }

  const label = getElementLabel(element);
  if (GRAPHIC_CAPTCHA_HINT.test(label)) {
    return true;
  }

  if (SMS_CODE_HINT.test(label)) {
    return false;
  }

  if (GENERIC_CODE_HINT.test(label) && findCaptchaImage(element)) {
    return true;
  }

  return false;
}

export function findCaptchaImage(input: Element): HTMLImageElement | null {
  const containers = [
    input.parentElement,
    input.parentElement?.parentElement,
    input.closest('form'),
    input.closest('[class*="captcha"]'),
    input.closest('[class*="verify"]'),
  ].filter(Boolean) as Element[];

  for (const container of containers) {
    const images = Array.from(container.querySelectorAll('img')).filter(isVisible);
    if (images.length > 0) {
      return images.sort((a, b) => distanceBetween(input, a) - distanceBetween(input, b))[0];
    }
  }

  const allImages = queryAllDeep<HTMLImageElement>('img').filter(isVisible);
  const nearby = allImages
    .filter((img) => distanceBetween(input, img) < 20)
    .sort((a, b) => distanceBetween(input, a) - distanceBetween(input, b));

  return nearby[0] ?? null;
}

async function imageElementToBlob(img: HTMLImageElement): Promise<Blob> {
  if (!img.complete || img.naturalWidth === 0) {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('验证码图片加载失败'));
    });
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('无法读取验证码图片'));
      }, 'image/png');
    });
  } catch {
    const response = await fetch(img.src, { credentials: 'include' });
    if (!response.ok) {
      throw new Error('验证码图片下载失败');
    }
    return response.blob();
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function normalizeCaptchaText(text: string): string {
  const cleaned = text.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (cleaned.length >= 4) {
    return cleaned.slice(0, 6);
  }
  return cleaned;
}

async function recognizeCaptchaWithTesseract(img: HTMLImageElement): Promise<string> {
  const { recognize } = await import('tesseract.js');
  const blob = await imageElementToBlob(img);
  const result = await recognize(blob, 'eng');
  const text = normalizeCaptchaText(result.data.text);
  if (!text) {
    throw new Error('未能识别验证码');
  }
  return text;
}

async function recognizeCaptchaWithLlm(img: HTMLImageElement): Promise<string> {
  const blob = await imageElementToBlob(img);
  const base64 = await blobToBase64(blob);
  const response = await chrome.runtime.sendMessage({
    type: 'LLM_SOLVE_CAPTCHA',
    imageBase64: base64,
  });

  if (response?.error) {
    throw new Error(response.error);
  }

  const text = normalizeCaptchaText(response?.text ?? '');
  if (!text) {
    throw new Error('大模型未能识别验证码');
  }
  return text;
}

async function getCaptchaSolverMode(): Promise<'tesseract' | 'llm' | 'auto'> {
  const response = await chrome.runtime.sendMessage({ type: 'LLM_GET_CAPTCHA_SOLVER' });
  const mode = response?.solver;
  if (mode === 'llm' || mode === 'auto' || mode === 'tesseract') {
    return mode;
  }
  return 'tesseract';
}

export async function recognizeCaptchaImage(img: HTMLImageElement): Promise<string> {
  const mode = await getCaptchaSolverMode();

  if (mode === 'llm') {
    return recognizeCaptchaWithLlm(img);
  }

  if (mode === 'auto') {
    try {
      return await recognizeCaptchaWithTesseract(img);
    } catch {
      return recognizeCaptchaWithLlm(img);
    }
  }

  return recognizeCaptchaWithTesseract(img);
}

export async function fillCaptchaField(
  inputSelector: string,
  imageSelector?: string,
): Promise<{ text: string; imageSelector: string }> {
  const input = await waitForElement(inputSelector);

  let image: HTMLImageElement | null = null;
  if (imageSelector) {
    const found = findElementDeep(imageSelector);
    image = found instanceof HTMLImageElement ? found : null;
  }
  if (!image) {
    image = findCaptchaImage(input);
  }
  if (!image) {
    throw new Error('未找到验证码图片');
  }

  const text = await recognizeCaptchaImage(image);
  fillField(input, text);

  return {
    text,
    imageSelector: imageSelector ?? buildSelector(image),
  };
}
