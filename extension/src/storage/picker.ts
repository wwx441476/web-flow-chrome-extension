const PICKER_RESULT_KEY = 'elementPickerResult';
const PICKER_ACTIVE_KEY = 'elementPickerActive';

export interface ElementPickerResult {
  selector: string;
  label?: string;
  pickedAt: number;
}

export async function setElementPickerActive(active: boolean): Promise<void> {
  if (active) {
    await chrome.storage.session.set({ [PICKER_ACTIVE_KEY]: true });
  } else {
    await chrome.storage.session.remove(PICKER_ACTIVE_KEY);
  }
}

export async function isElementPickerActive(): Promise<boolean> {
  const result = await chrome.storage.session.get(PICKER_ACTIVE_KEY);
  return Boolean(result[PICKER_ACTIVE_KEY]);
}

export async function saveElementPickerResult(result: ElementPickerResult): Promise<void> {
  await chrome.storage.session.set({ [PICKER_RESULT_KEY]: result });
  await setElementPickerActive(false);
}

export async function peekElementPickerResult(): Promise<ElementPickerResult | undefined> {
  const result = await chrome.storage.session.get(PICKER_RESULT_KEY);
  return result[PICKER_RESULT_KEY] as ElementPickerResult | undefined;
}

export async function consumeElementPickerResult(): Promise<ElementPickerResult | undefined> {
  const picked = await peekElementPickerResult();
  if (picked) {
    await chrome.storage.session.remove(PICKER_RESULT_KEY);
  }
  return picked;
}
