import type { BackgroundMessage, RecordedStep } from '../types';
import type { DesignerContext } from '../storage/designer-context';
import { getDesignerContext, saveDesignerContext } from '../storage/designer-context';
import { getStepMeta } from '../shared/step-meta';
import {
  buildStepFromForm,
  clearStepForm,
  collectStepFormRefs,
  populateStepForm,
  updateStepFormVisibility,
  type StepFormRefs,
} from '../shared/step-form';

type EditTarget = number | 'add' | null;

let context: DesignerContext | null = null;
let flow: RecordedStep[] = [];
let selectedIndex: number | null = null;
let editingTarget: EditTarget = null;
let dragIndex: number | null = null;
let formRefs: StepFormRefs;

function $(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
}

function sendMessage<T>(message: BackgroundMessage): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function showToast(text: string, type: 'success' | 'error' | 'info' = 'info'): void {
  const toast = $('toast');
  toast.textContent = text;
  toast.className = `toast ${type}`;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2600);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setDirty(): void {
  document.title = `Web Flow · 流程画布 *`;
}

function renderMeta(): void {
  const meta = $('workflow-meta');
  const sourceLabel = context?.source === 'workflow' ? '已保存工作流' : '录制草稿';
  meta.textContent = `${sourceLabel} · ${context?.entryUrl ?? ''}`;
  ($('workflow-name') as HTMLInputElement).value = context?.name ?? '';
}

function renderCanvas(): void {
  const container = $('flow-nodes');
  const empty = $('canvas-empty');
  container.innerHTML = '';

  if (flow.length === 0) {
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  flow.forEach((step, index) => {
    const meta = getStepMeta(step);
    const wrap = document.createElement('div');
    wrap.className = 'flow-node-wrap';
    wrap.dataset.index = String(index);

    wrap.innerHTML = `
      <article class="flow-node ${selectedIndex === index ? 'selected' : ''}" data-index="${index}" draggable="false">
        <span class="flow-node-handle" draggable="true" title="拖拽排序" data-handle="1">⠿</span>
        <div class="flow-node-icon tone-${meta.tone}">${meta.icon}</div>
        <div class="flow-node-body">
          <div class="flow-node-index">步骤 ${index + 1}</div>
          <div class="flow-node-title">${escapeHtml(meta.title)}</div>
          <div class="flow-node-detail">${escapeHtml(meta.detail)}</div>
        </div>
        <div class="flow-node-actions">
          <button type="button" class="icon-btn" data-action="insert" title="在此前插入">+</button>
          <button type="button" class="icon-btn" data-action="delete" title="删除">×</button>
        </div>
      </article>
    `;

    container.appendChild(wrap);
  });

  requestAnimationFrame(drawConnectors);
}

function anchorCenter(element: Element): { x: number; y: number } {
  const scroll = $('canvas-scroll');
  const scrollRect = scroll.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left - scrollRect.left + scroll.scrollLeft + rect.width / 2,
    y: rect.top - scrollRect.top + scroll.scrollTop + rect.height / 2,
  };
}

function drawConnectors(): void {
  const svg = document.getElementById('flow-svg') as SVGSVGElement | null;
  if (!svg) return;
  const scroll = $('canvas-scroll');
  svg.setAttribute('width', String(scroll.scrollWidth));
  svg.setAttribute('height', String(scroll.scrollHeight));
  svg.innerHTML = '';

  const points: { x: number; y: number }[] = [];
  const start = document.querySelector('.start-node');
  if (start) points.push(anchorCenter(start));

  document.querySelectorAll('.flow-node').forEach((node) => {
    points.push(anchorCenter(node));
  });

  const end = document.querySelector('.end-node');
  if (end) points.push(anchorCenter(end));

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const midY = (from.y + to.y) / 2;
    path.setAttribute(
      'd',
      `M ${from.x} ${from.y} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y}`,
    );
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#94a3b8');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);

    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    arrow.setAttribute('cx', String(to.x));
    arrow.setAttribute('cy', String(to.y - 6));
    arrow.setAttribute('r', '3');
    arrow.setAttribute('fill', '#64748b');
    svg.appendChild(arrow);
  }
}

function openInspector(target: EditTarget, step?: RecordedStep): void {
  editingTarget = target;
  $('inspector').classList.remove('hidden');
  $('inspector-placeholder').classList.add('hidden');

  const title = $('inspector-title');
  if (target === 'add') {
    title.textContent = '添加步骤';
    clearStepForm(formRefs);
  } else {
    title.textContent = `编辑步骤 ${(target as number) + 1}`;
    if (step) populateStepForm(formRefs, step);
  }
}

function closeInspector(): void {
  editingTarget = null;
  $('inspector').classList.add('hidden');
  $('inspector-placeholder').classList.remove('hidden');
}

function selectStep(index: number): void {
  selectedIndex = index;
  renderCanvas();
  openInspector(index, flow[index]);
}

async function persistFlow(showMessage = false): Promise<void> {
  if (!context) return;

  const name = ($('workflow-name') as HTMLInputElement).value.trim() || context.name;

  await sendMessage({
    action: 'SAVE_DESIGNER_FLOW',
    designerSource: context.source,
    workflowId: context.workflowId,
    flow,
    workflowName: name,
    entryUrl: context.entryUrl,
  });

  context = { ...context, name, steps: flow };
  await saveDesignerContext(context);
  document.title = 'Web Flow · 流程画布';

  if (showMessage) {
    showToast('流程已保存', 'success');
  }
}

function applyStepFromInspector(): void {
  const step = buildStepFromForm(formRefs, (message) => showToast(message, 'error'));
  if (!step || editingTarget === null) return;

  if (editingTarget === 'add') {
    const insertAt = selectedIndex === null ? flow.length : selectedIndex;
    flow = [...flow.slice(0, insertAt), step, ...flow.slice(insertAt)];
    selectedIndex = insertAt;
  } else {
    flow = flow.map((item, index) => (index === editingTarget ? step : item));
    selectedIndex = editingTarget;
  }

  setDirty();
  renderCanvas();
  openInspector(selectedIndex, flow[selectedIndex]);
  void persistFlow();
  showToast('步骤已更新', 'success');
}

function deleteStep(index: number): void {
  flow = flow.filter((_, stepIndex) => stepIndex !== index);
  if (selectedIndex === index) {
    selectedIndex = null;
    closeInspector();
  } else if (selectedIndex !== null && selectedIndex > index) {
    selectedIndex -= 1;
  }
  setDirty();
  renderCanvas();
  void persistFlow();
}

function moveStep(from: number, to: number): void {
  if (from === to || from < 0 || to < 0 || from >= flow.length || to >= flow.length) return;
  const next = [...flow];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  flow = next;

  if (selectedIndex === from) {
    selectedIndex = to;
  } else if (selectedIndex !== null) {
    if (from < selectedIndex && to >= selectedIndex) selectedIndex -= 1;
    if (from > selectedIndex && to <= selectedIndex) selectedIndex += 1;
  }

  setDirty();
  renderCanvas();
  void persistFlow();
}

function bindDragAndDrop(): void {
  const container = $('flow-nodes');

  container.addEventListener('dragstart', (event) => {
    const handle = (event.target as HTMLElement).closest('[data-handle="1"]');
    if (!handle) return;

    const node = handle.closest('.flow-node');
    if (!node) return;

    dragIndex = Number(node.getAttribute('data-index'));
    node.classList.add('dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(dragIndex));
    }
  });

  container.addEventListener('dragend', (event) => {
    (event.target as HTMLElement).closest('.flow-node')?.classList.remove('dragging');
    document.querySelectorAll('.flow-node.drop-target').forEach((node) => {
      node.classList.remove('drop-target');
    });
    dragIndex = null;
  });

  container.addEventListener('dragover', (event) => {
    if (dragIndex === null) return;
    event.preventDefault();
    const node = (event.target as HTMLElement).closest('.flow-node');
    document.querySelectorAll('.flow-node.drop-target').forEach((item) => {
      item.classList.remove('drop-target');
    });
    node?.classList.add('drop-target');
  });

  container.addEventListener('drop', (event) => {
    event.preventDefault();
    const node = (event.target as HTMLElement).closest('.flow-node');
    if (!node || dragIndex === null) return;
    const to = Number(node.getAttribute('data-index'));
    moveStep(dragIndex, to);
  });
}

function bindCanvasEvents(): void {
  const container = $('flow-nodes');

  container.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const action = target.dataset.action;
    const node = target.closest('.flow-node') as HTMLElement | null;

    if (action === 'delete' && node) {
      event.stopPropagation();
      deleteStep(Number(node.dataset.index));
      return;
    }

    if (action === 'insert' && node) {
      event.stopPropagation();
      selectedIndex = Number(node.dataset.index);
      openInspector('add');
      return;
    }

    if (node && !target.closest('[data-action]') && !target.closest('[data-handle="1"]')) {
      selectStep(Number(node.dataset.index));
    }
  });

  bindDragAndDrop();
  $('canvas-scroll').addEventListener('scroll', drawConnectors);
  window.addEventListener('resize', drawConnectors);
}

async function startElementPicker(): Promise<void> {
  try {
    await sendMessage({
      action: 'START_ELEMENT_PICKER',
      tabId: context?.targetTabId,
      entryUrl: context?.entryUrl,
    });
    showToast('已切换到目标页面，请点击要拾取的元素', 'info');
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function applyElementPickerResult(): Promise<void> {
  const picked = await sendMessage<{ selector?: string; label?: string } | undefined>({
    action: 'GET_ELEMENT_PICKER_RESULT',
  });
  if (!picked?.selector) return;

  formRefs.selectorInput.value = picked.selector;
  if (!formRefs.labelInput.value.trim() && picked.label) {
    formRefs.labelInput.value = picked.label;
  }
  showToast('元素已拾取', 'success');
}

async function init(): Promise<void> {
  formRefs = collectStepFormRefs(document);

  context = (await getDesignerContext()) ?? null;
  if (!context) {
    $('canvas-empty').textContent = '未找到流程上下文。请从扩展弹窗点击「流程画布」打开。';
    $('canvas-empty').classList.remove('hidden');
    return;
  }

  flow = [...context.steps];
  renderMeta();
  renderCanvas();
  bindCanvasEvents();

  formRefs.typeSelect.addEventListener('change', () => updateStepFormVisibility(formRefs));
  $('save-step-btn').addEventListener('click', applyStepFromInspector);
  $('delete-step-btn').addEventListener('click', () => {
    if (editingTarget === null || editingTarget === 'add') return;
    deleteStep(editingTarget);
    closeInspector();
  });
  $('close-inspector-btn').addEventListener('click', closeInspector);
  $('pick-element-btn').addEventListener('click', () => void startElementPicker());
  $('add-step-btn').addEventListener('click', () => {
    selectedIndex = flow.length;
    openInspector('add');
  });
  $('save-btn').addEventListener('click', () => void persistFlow(true));
  ($('workflow-name') as HTMLInputElement).addEventListener('input', setDirty);

  await applyElementPickerResult();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    if (changes.elementPickerResult?.newValue) {
      void applyElementPickerResult();
    }
  });
}

void init();
