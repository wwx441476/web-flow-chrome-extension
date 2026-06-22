import type { VariableMap } from '../types';
import { queryDeep } from './deep-query';

const HOST_ID = 'web-flow-chrome-manual-host';
const PANEL_ID = 'web-flow-chrome-manual-panel';
const POS_KEY = 'web-flow-chrome-manual-panel-pos';

export interface ManualLoginWaitOptions {
  variables: VariableMap;
  successSelector?: string;
  timeoutMs?: number;
  label?: string;
}

let shadowRoot: ShadowRoot | null = null;
let activeWait: {
  resolve: (reason: 'user' | 'detected') => void;
  reject: (error: Error) => void;
  pollTimer?: ReturnType<typeof setInterval>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
} | null = null;
let activeWaitPromise: Promise<'user' | 'detected'> | null = null;

function clearActiveWaitState(): void {
  activeWait = null;
  activeWaitPromise = null;
}

function isTopFrame(): boolean {
  try {
    return window.top === window.self;
  } catch {
    return false;
  }
}

interface PanelPosition {
  left: number;
  top: number;
}

function readPanelPosition(): PanelPosition | null {
  try {
    const raw = sessionStorage.getItem(POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PanelPosition;
    if (Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) {
      return parsed;
    }
  } catch {
    // Ignore invalid saved position.
  }
  return null;
}

function savePanelPosition(left: number, top: number): void {
  try {
    sessionStorage.setItem(POS_KEY, JSON.stringify({ left, top }));
  } catch {
    // Ignore quota errors.
  }
}

function clampPanelPosition(left: number, top: number, panel: HTMLElement): PanelPosition {
  const rect = panel.getBoundingClientRect();
  const width = rect.width || panel.offsetWidth || 300;
  const height = rect.height || panel.offsetHeight || 200;
  const maxLeft = Math.max(8, window.innerWidth - width - 8);
  const maxTop = Math.max(8, window.innerHeight - height - 8);
  return {
    left: Math.min(Math.max(8, left), maxLeft),
    top: Math.min(Math.max(8, top), maxTop),
  };
}

function attachPanelDrag(panel: HTMLElement, handle: HTMLElement): void {
  if (handle.dataset.dragBound === '1') return;
  handle.dataset.dragBound = '1';
  handle.style.cursor = 'move';
  handle.style.userSelect = 'none';

  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  const onMove = (event: MouseEvent): void => {
    if (!dragging) return;
    const next = clampPanelPosition(event.clientX - offsetX, event.clientY - offsetY, panel);
    panel.style.left = `${next.left}px`;
    panel.style.top = `${next.top}px`;
  };

  const onUp = (): void => {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    const left = Number.parseFloat(panel.style.left);
    const top = Number.parseFloat(panel.style.top);
    if (Number.isFinite(left) && Number.isFinite(top)) {
      savePanelPosition(left, top);
    }
  };

  handle.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button') || target.closest('input')) return;

    const rect = panel.getBoundingClientRect();
    dragging = true;
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    event.preventDefault();
  });
}

async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function getShadowRoot(): ShadowRoot {
  if (shadowRoot) {
    return shadowRoot;
  }

  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    Object.assign(host.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      zIndex: '2147483647',
      pointerEvents: 'none',
    });
    document.documentElement.appendChild(host);
  }

  shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  if (!shadowRoot.querySelector('style')) {
    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; }
      #${PANEL_ID} {
        position: fixed;
        width: 300px;
        background: #ffffff;
        color: #1f2937;
        border-radius: 12px;
        box-shadow: 0 16px 40px rgba(15, 23, 42, 0.22);
        border: 1px solid #fecdd3;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 12px;
        pointer-events: auto;
        overflow: hidden;
      }
      .header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        background: #fff1f2;
        border-bottom: 1px solid #fecdd3;
      }
      .header .title {
        flex: 1;
        font-weight: 600;
        font-size: 13px;
        color: #be123c;
      }
      .close-btn {
        border: none;
        background: #fee2e2;
        color: #dc2626;
        width: 22px;
        height: 22px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        padding: 0;
      }
      .close-btn:hover { background: #fecaca; }
      .body { padding: 12px; }
      .hint {
        margin: 0 0 10px;
        color: #6b7280;
        line-height: 1.45;
        font-size: 11px;
      }
      .cred-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
      }
      .cred-row label {
        width: 52px;
        flex-shrink: 0;
        color: #374151;
        font-weight: 500;
      }
      .cred-row input {
        flex: 1;
        min-width: 0;
        border: 1px solid #e5e7eb;
        border-radius: 6px;
        padding: 6px 8px;
        font-size: 12px;
        background: #f9fafb;
      }
      .icon-btn {
        border: none;
        background: #f3f4f6;
        color: #374151;
        width: 28px;
        height: 28px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 11px;
        flex-shrink: 0;
        padding: 0;
      }
      .icon-btn:hover { background: #e5e7eb; }
      .actions {
        display: flex;
        gap: 8px;
        margin-top: 12px;
      }
      .btn {
        flex: 1;
        border: none;
        border-radius: 8px;
        padding: 8px 10px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .btn-primary {
        background: #e11d48;
        color: #fff;
      }
      .btn-primary:hover { background: #be123c; }
      .btn-secondary {
        background: #f3f4f6;
        color: #374151;
      }
      .btn-secondary:hover { background: #e5e7eb; }
      .status {
        margin-top: 8px;
        font-size: 11px;
        color: #059669;
        min-height: 14px;
      }
    `;
    shadowRoot.appendChild(style);
  }

  return shadowRoot;
}

function cancelActiveWait(reason = '已取消手工登录'): void {
  if (!activeWait) return;
  if (activeWait.pollTimer) clearInterval(activeWait.pollTimer);
  if (activeWait.timeoutTimer) clearTimeout(activeWait.timeoutTimer);
  const { reject } = activeWait;
  clearActiveWaitState();
  reject(new Error(reason));
}

function finishActiveWait(reason: 'user' | 'detected'): void {
  if (!activeWait) return;
  if (activeWait.pollTimer) clearInterval(activeWait.pollTimer);
  if (activeWait.timeoutTimer) clearTimeout(activeWait.timeoutTimer);
  const { resolve } = activeWait;
  clearActiveWaitState();
  resolve(reason);
}

export function isManualLoginPanelActive(): boolean {
  return activeWaitPromise !== null;
}

function renderCredentialField(
  root: ShadowRoot,
  rowClass: string,
  label: string,
  value: string,
  secret = false,
): void {
  const body = root.querySelector('.body');
  if (!body) return;

  const row = document.createElement('div');
  row.className = `cred-row ${rowClass}`;

  const labelEl = document.createElement('label');
  labelEl.textContent = label;

  const input = document.createElement('input');
  input.type = secret ? 'password' : 'text';
  input.readOnly = true;
  input.value = value || '（未配置）';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'icon-btn';
  copyBtn.title = '复制';
  copyBtn.textContent = '⎘';
  copyBtn.addEventListener('click', async (event) => {
    event.stopPropagation();
    const ok = await copyText(value);
    const status = root.querySelector('.status');
    if (status) status.textContent = ok ? `已复制 ${label}` : '复制失败';
  });

  row.appendChild(labelEl);
  row.appendChild(input);

  if (secret) {
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'icon-btn';
    toggleBtn.title = '显示/隐藏';
    toggleBtn.textContent = '👁';
    toggleBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      input.type = input.type === 'password' ? 'text' : 'password';
    });
    row.appendChild(toggleBtn);
  }

  row.appendChild(copyBtn);
  body.appendChild(row);
}

function ensurePanel(options: ManualLoginWaitOptions): HTMLDivElement {
  const root = getShadowRoot();
  let panel = root.getElementById(PANEL_ID) as HTMLDivElement | null;

  if (panel) {
    panel.remove();
  }

  panel = document.createElement('div');
  panel.id = PANEL_ID;

  const header = document.createElement('div');
  header.className = 'header';

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = options.label ?? '手工登录';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'close-btn';
  closeBtn.title = '取消';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => {
    hideManualLoginPanel();
    cancelActiveWait();
  });

  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'body';

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent =
    '请在本页手工完成登录（验证码、短信、二次验证等）。完成后点击「继续执行」，自动化将运行后续步骤。';
  body.appendChild(hint);

  panel.appendChild(header);
  panel.appendChild(body);
  root.appendChild(panel);

  const username = options.variables.username ?? '';
  const password = options.variables.password ?? '';
  renderCredentialField(root, 'username-row', '用户名', username);
  renderCredentialField(root, 'password-row', '密码', password, true);

  const extraKeys = Object.keys(options.variables).filter(
    (key) => key !== 'username' && key !== 'password' && options.variables[key],
  );
  for (const key of extraKeys.slice(0, 4)) {
    renderCredentialField(root, `extra-${key}`, key, options.variables[key] ?? '');
  }

  const status = document.createElement('div');
  status.className = 'status';
  body.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const continueBtn = document.createElement('button');
  continueBtn.type = 'button';
  continueBtn.className = 'btn btn-primary';
  continueBtn.textContent = '继续执行';
  continueBtn.addEventListener('click', () => {
    hideManualLoginPanel();
    finishActiveWait('user');
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', () => {
    hideManualLoginPanel();
    cancelActiveWait();
  });

  actions.appendChild(continueBtn);
  actions.appendChild(cancelBtn);
  body.appendChild(actions);

  const saved = readPanelPosition();
  if (saved) {
    panel.style.left = `${saved.left}px`;
    panel.style.top = `${saved.top}px`;
  } else {
    panel.style.right = '16px';
    panel.style.top = '72px';
    panel.style.left = 'auto';
  }

  attachPanelDrag(panel, header);
  panel.style.display = 'block';

  return panel;
}

export function hideManualLoginPanel(): void {
  if (!isTopFrame()) return;
  const panel = getShadowRoot().getElementById(PANEL_ID);
  if (panel) {
    panel.style.display = 'none';
  }
}

export function waitForManualLoginComplete(options: ManualLoginWaitOptions): Promise<'user' | 'detected'> {
  if (!isTopFrame()) {
    return Promise.reject(new Error('手工登录面板仅在顶层页面可用'));
  }

  if (activeWaitPromise) {
    ensurePanel(options);
    return activeWaitPromise;
  }

  ensurePanel(options);

  activeWaitPromise = new Promise((resolve, reject) => {
    activeWait = { resolve, reject };

    if (options.successSelector) {
      const selector = options.successSelector;
      activeWait!.pollTimer = setInterval(() => {
        try {
          const element = queryDeep(selector);
          if (element) {
            hideManualLoginPanel();
            finishActiveWait('detected');
          }
        } catch {
          // Ignore selector errors while polling.
        }
      }, 500);
    }

    const timeoutMs = options.timeoutMs ?? 300000;
    if (timeoutMs > 0) {
      activeWait!.timeoutTimer = setTimeout(() => {
        hideManualLoginPanel();
        cancelActiveWait('手工登录超时，请重试');
      }, timeoutMs);
    }
  });

  return activeWaitPromise;
}
