import type { Credentials, FormSelectors, StepResult } from '../types';
import { findElementDeep, isVisible, queryAllDeep } from './detect';

const DEFAULT_TIMEOUT = 8000;
const RETRY_INTERVAL = 250;

function resolveElement(selector: string): HTMLElement | null {
  const direct = findElementDeep(selector, isVisible);
  if (direct) {
    return direct;
  }

  const matches = queryAllDeep<HTMLElement>(selector).filter(isVisible);
  return matches[0] ?? null;
}

export function waitForElement(
  selector: string,
  timeout = DEFAULT_TIMEOUT,
): Promise<HTMLElement> {
  return new Promise((resolve, reject) => {
    const started = Date.now();

    const attempt = () => {
      const element = resolveElement(selector);
      if (element) {
        resolve(element);
        return;
      }

      if (Date.now() - started >= timeout) {
        reject(new Error(`Element not found: ${selector}`));
        return;
      }

      window.setTimeout(attempt, RETRY_INTERVAL);
    };

    attempt();
  });
}

export function fillField(element: HTMLElement, value: string): void {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    element.focus();
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return;
  }

  if (element.isContentEditable) {
    element.focus();
    element.textContent = value;
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  }
}

function isInteractiveElement(element: HTMLElement): boolean {
  const tag = element.tagName;
  if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'LABEL') {
    return true;
  }

  const role = element.getAttribute('role');
  if (role === 'button' || role === 'link' || role === 'menuitem' || role === 'tab' || role === 'option') {
    return true;
  }

  if (
    element.hasAttribute('onclick') ||
    element.hasAttribute('ng-click') ||
    element.hasAttribute('tabindex')
  ) {
    return true;
  }

  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return style?.cursor === 'pointer';
}

function resolveClickTarget(element: HTMLElement): HTMLElement {
  if (isInteractiveElement(element)) {
    return element;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const hit = element.ownerDocument.elementFromPoint(centerX, centerY);
    if (hit instanceof HTMLElement && hit !== element && element.contains(hit)) {
      return resolveClickTarget(hit);
    }
  }

  const closest = element.closest(
    'a, button, input, textarea, select, label, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [onclick], [ng-click]',
  );
  if (closest instanceof HTMLElement) {
    return closest;
  }

  return element;
}

function dispatchPointerClick(element: HTMLElement): void {
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });

  if (typeof element.focus === 'function') {
    try {
      element.focus({ preventScroll: true });
    } catch {
      // Some elements cannot be focused.
    }
  }

  const rect = element.getBoundingClientRect();
  const clientX = rect.left + Math.max(rect.width / 2, 1);
  const clientY = rect.top + Math.max(rect.height / 2, 1);
  const base: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: element.ownerDocument.defaultView ?? window,
    clientX,
    clientY,
    screenX: clientX,
    screenY: clientY,
  };

  if (typeof PointerEvent !== 'undefined') {
    element.dispatchEvent(
      new PointerEvent('pointerover', { ...base, pointerId: 1, pointerType: 'mouse' }),
    );
    element.dispatchEvent(
      new PointerEvent('pointerenter', { ...base, pointerId: 1, pointerType: 'mouse', bubbles: false }),
    );
    element.dispatchEvent(
      new PointerEvent('pointerdown', { ...base, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 }),
    );
  }

  element.dispatchEvent(new MouseEvent('mouseover', base));
  element.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false }));
  element.dispatchEvent(new MouseEvent('mousedown', { ...base, button: 0, buttons: 1 }));

  if (typeof PointerEvent !== 'undefined') {
    element.dispatchEvent(
      new PointerEvent('pointerup', { ...base, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0 }),
    );
  }

  element.dispatchEvent(new MouseEvent('mouseup', { ...base, button: 0, buttons: 0 }));
  element.dispatchEvent(new MouseEvent('click', { ...base, button: 0, buttons: 0 }));
}

export function clickElement(element: HTMLElement): void {
  dispatchPointerClick(resolveClickTarget(element));
}

async function runStep(
  name: string,
  fn: () => Promise<void> | void,
): Promise<StepResult> {
  try {
    await fn();
    return { name, status: 'success' };
  } catch (error) {
    return {
      name,
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function fillAndSubmit(
  selectors: FormSelectors,
  credentials: Credentials,
  options: { submit?: boolean } = {},
): Promise<{ steps: StepResult[]; success: boolean }> {
  const steps: StepResult[] = [];
  const shouldSubmit = options.submit !== false;

  const usernameStep = await runStep('fill_username', async () => {
    const element = await waitForElement(selectors.username);
    fillField(element, credentials.username);
  });
  steps.push(usernameStep);
  if (usernameStep.status === 'failed') {
    return { steps, success: false };
  }

  const passwordStep = await runStep('fill_password', async () => {
    const element = await waitForElement(selectors.password);
    fillField(element, credentials.password);
  });
  steps.push(passwordStep);
  if (passwordStep.status === 'failed') {
    return { steps, success: false };
  }

  if (!shouldSubmit) {
    steps.push({ name: 'submit', status: 'skipped', message: 'Fill only' });
    return { steps, success: true };
  }

  const submitStep = await runStep('submit', async () => {
    const element = await waitForElement(selectors.submit);
    clickElement(element);
  });
  steps.push(submitStep);

  return { steps, success: submitStep.status === 'success' };
}

export async function fillOnly(
  selectors: FormSelectors,
  credentials: Credentials,
): Promise<{ steps: StepResult[]; success: boolean }> {
  return fillAndSubmit(selectors, credentials, { submit: false });
}
