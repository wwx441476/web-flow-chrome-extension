import { findElementDeep, getElementLabel, getElementText, queryAllDeep } from './deep-query';

const USERNAME_HINT = /用户|账号|帐户|登录名|user|login|account|email|phone|mobile|工号/i;
const PASSWORD_HINT = /密码|口令|pass/i;
const SUBMIT_HINT = /登录|登入|login|sign\s*in|log\s*in|submit|确定/i;
const INPUT_SELECTOR =
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea';

export function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  return true;
}

function shadowHostSelectors(element: Element): string[] {
  const selectors: string[] = [];
  let root = element.getRootNode();

  while (root instanceof ShadowRoot) {
    const host = root.host;
    if (host.id) {
      selectors.unshift(`#${CSS.escape(host.id)}`);
    } else {
      const name = host.getAttribute('name');
      if (name) {
        selectors.unshift(`${host.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`);
      } else {
        selectors.unshift(host.tagName.toLowerCase());
      }
    }
    root = host.getRootNode();
  }

  return selectors;
}

export function buildSelector(element: Element): string {
  if (element.id) {
    return `#${CSS.escape(element.id)}`;
  }

  const name = element.getAttribute('name');
  if (name) {
    return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
  }

  const placeholder = element.getAttribute('placeholder');
  if (placeholder) {
    return `${element.tagName.toLowerCase()}[placeholder="${CSS.escape(placeholder)}"]`;
  }

  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) {
    return `${element.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`;
  }

  if (element instanceof HTMLInputElement) {
    if (element.type === 'password') {
      const matches = queryAllDeep<HTMLInputElement>('input[type="password"]').filter(isVisible);
      if (matches.length === 1) {
        return 'input[type="password"]';
      }
      const index = matches.indexOf(element);
      if (index >= 0) {
        return `input[type="password"]:nth-of-type(${index + 1})`;
      }
    }

    const className = Array.from(element.classList)
      .filter((cls) => !cls.startsWith('ng-') && cls.length > 2)
      .slice(0, 2)
      .join('.');
    if (className) {
      const selector = `input.${className}`;
      const matches = queryAllDeep<HTMLInputElement>(selector).filter(isVisible);
      if (matches.length === 1) {
        return selector;
      }
    }
  }

  const path: string[] = [];
  let current: Element | null = element;

  while (current && current.tagName !== 'HTML') {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      path.unshift(`#${CSS.escape(current.id)}`);
      break;
    }

    const parentElement: Element | null = current.parentElement;
    if (parentElement) {
      const siblings = Array.from(parentElement.children).filter(
        (child: Element) => child.tagName === current!.tagName,
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }

    path.unshift(selector);
    current = parentElement;
  }

  const innerPath = path.join(' > ');
  const hosts = shadowHostSelectors(element);
  if (hosts.length > 0) {
    return `${hosts.join(' > ')} > ${innerPath}`;
  }

  return innerPath;
}

function queryVisibleInputs(selector: string = INPUT_SELECTOR): HTMLElement[] {
  return queryAllDeep<HTMLElement>(selector).filter(isVisible);
}

function isPasswordLike(input: HTMLInputElement): boolean {
  if (input.type === 'password') {
    return true;
  }

  const label = getElementLabel(input);
  return PASSWORD_HINT.test(label);
}

function isUsernameCandidate(input: HTMLInputElement): boolean {
  return !isPasswordLike(input);
}

function scoreUsernameInput(input: HTMLInputElement): number {
  let score = 0;
  const label = getElementLabel(input);

  if (isPasswordLike(input)) return -100;

  const autocomplete = input.getAttribute('autocomplete') ?? '';
  if (autocomplete === 'username') score += 100;
  if (autocomplete === 'email') score += 90;
  if (input.type === 'email') score += 80;
  if (USERNAME_HINT.test(input.name)) score += 70;
  if (USERNAME_HINT.test(input.id)) score += 60;
  if (USERNAME_HINT.test(label)) score += 85;
  if (input.type === 'text' || input.type === 'tel' || input.type === '') score += 10;
  return score;
}

function scorePasswordInput(input: HTMLInputElement): number {
  let score = 0;
  const label = getElementLabel(input);

  if (input.type === 'password') score += 100;
  if (PASSWORD_HINT.test(label)) score += 90;
  if (PASSWORD_HINT.test(input.name)) score += 70;
  if (PASSWORD_HINT.test(input.id)) score += 60;
  return score;
}

export function detectUsernameField(): HTMLInputElement | null {
  const candidates = queryVisibleInputs(INPUT_SELECTOR).filter(
    (el): el is HTMLInputElement => el instanceof HTMLInputElement && isUsernameCandidate(el),
  );

  if (candidates.length === 0) {
    return null;
  }

  const ranked = candidates
    .map((input) => ({ input, score: scoreUsernameInput(input) }))
    .sort((a, b) => b.score - a.score);

  if (ranked[0].score > 0) {
    return ranked[0].input;
  }

  const password = detectPasswordField(null);
  if (password) {
    const passwordForm = password.closest('form');
    const inForm = candidates.filter((input) => !passwordForm || passwordForm.contains(input));
    if (inForm.length > 0) {
      return inForm.sort(
        (a, b) => distanceBetween(password, a) - distanceBetween(password, b),
      )[0];
    }

    return candidates.sort(
      (a, b) => distanceBetween(password, a) - distanceBetween(password, b),
    )[0];
  }

  return candidates[0];
}

function distanceBetween(a: Element, b: Element): number {
  if (a === b) return 0;
  const all = queryAllDeep<Element>('*');
  return Math.abs(all.indexOf(a) - all.indexOf(b));
}

export function detectPasswordField(usernameField: HTMLInputElement | null): HTMLInputElement | null {
  const candidates = queryVisibleInputs(INPUT_SELECTOR).filter(
    (el): el is HTMLInputElement => el instanceof HTMLInputElement,
  );

  const passwords = candidates.filter((input) => scorePasswordInput(input) > 0);
  if (passwords.length === 0) {
    return null;
  }

  if (passwords.length === 1 || !usernameField) {
    return passwords.sort((a, b) => scorePasswordInput(b) - scorePasswordInput(a))[0];
  }

  const usernameForm = usernameField.closest('form');
  const sameForm = passwords.filter(
    (input) => usernameForm && usernameForm.contains(input),
  );
  if (sameForm.length > 0) {
    return sameForm[0];
  }

  return passwords.sort(
    (a, b) => distanceBetween(usernameField, a) - distanceBetween(usernameField, b),
  )[0];
}

function findSubmitNearFields(
  usernameField: HTMLInputElement | null,
  passwordField: HTMLInputElement | null,
): HTMLElement | null {
  const anchor = passwordField ?? usernameField;
  if (!anchor) return null;

  let container: Element | null =
    anchor.closest('form') ??
    anchor.closest('[class*="login"]') ??
    anchor.closest('[class*="Login"]') ??
    anchor.closest('[class*="form"]');

  if (!container) {
    container = anchor;
    for (let depth = 0; depth < 6 && container.parentElement; depth += 1) {
      container = container.parentElement;
    }
  }

  const localCandidates = queryAllDeep<HTMLElement>(
    'button, input[type="submit"], input[type="button"], a, div[role="button"], span[role="button"]',
  ).filter((candidate) => {
    if (!isVisible(candidate)) return false;
    return container?.contains(candidate) ?? false;
  });

  for (const candidate of localCandidates) {
    const text = getElementText(candidate);
    if (SUBMIT_HINT.test(text)) {
      return candidate;
    }
  }

  return null;
}

function findSubmitInForm(form: HTMLFormElement | null): HTMLElement | null {
  if (!form) return null;

  const explicit = queryAllDeep<HTMLElement>(
    'button[type="submit"], input[type="submit"]',
  ).find((element) => form.contains(element) && isVisible(element));
  if (explicit) {
    return explicit;
  }

  const buttons = queryAllDeep<HTMLElement>('button, input[type="button"], a').filter(
    (element) => form.contains(element) && isVisible(element),
  );
  for (const button of buttons) {
    const text = getElementText(button);
    if (SUBMIT_HINT.test(text)) {
      return button;
    }
  }

  return null;
}

export function detectSubmitButton(
  usernameField: HTMLInputElement | null,
  passwordField: HTMLInputElement | null,
): HTMLElement | null {
  const form = passwordField?.closest('form') ?? usernameField?.closest('form') ?? null;
  const inForm = findSubmitInForm(form);
  if (inForm) {
    return inForm;
  }

  const nearFields = findSubmitNearFields(usernameField, passwordField);
  if (nearFields) {
    return nearFields;
  }

  const globalCandidates = queryAllDeep<HTMLElement>(
    'button[type="submit"], input[type="submit"], button, a, div[role="button"]',
  ).filter(isVisible);

  for (const candidate of globalCandidates) {
    const text = getElementText(candidate);
    if (SUBMIT_HINT.test(text)) {
      return candidate;
    }
  }

  return null;
}

export function detectFormFields(): {
  username: HTMLInputElement;
  password: HTMLInputElement;
  submit: HTMLElement;
} | null {
  const username = detectUsernameField();
  const password = detectPasswordField(username);
  if (!username || !password) {
    return null;
  }

  const submit = detectSubmitButton(username, password);
  if (!submit) {
    return null;
  }

  return { username, password, submit };
}

export function detectFormSelectors(): {
  username: string;
  password: string;
  submit: string;
} | null {
  const fields = detectFormFields();
  if (!fields) {
    return null;
  }

  return {
    username: buildSelector(fields.username),
    password: buildSelector(fields.password),
    submit: buildSelector(fields.submit),
  };
}

export { findElementDeep, queryAllDeep };
