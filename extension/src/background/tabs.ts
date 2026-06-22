import type { FillResult } from '../types';

export function waitForTabComplete(tabId: number, timeout = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, timeout);

    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

export async function getFrameIds(tabId: number): Promise<number[]> {
  if (chrome.webNavigation?.getAllFrames) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return frames?.map((frame) => frame.frameId).filter((id): id is number => id !== undefined) ?? [0];
  }
  return [0];
}

function getContentScriptFiles(): string[] {
  const manifest = chrome.runtime.getManifest();
  const scripts = manifest.content_scripts?.[0]?.js;
  return scripts ?? [];
}

async function isContentScriptLoaded(tabId: number, frameId: number): Promise<boolean> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => Boolean((window as Window & { __webFlowContentLoaded?: boolean }).__webFlowContentLoaded),
    });
    return Boolean(result?.result);
  } catch {
    return false;
  }
}

async function injectContentScript(tabId: number, frameId: number): Promise<void> {
  const files = getContentScriptFiles();
  if (files.length === 0) {
    throw new Error('未找到 content script 配置');
  }

  const loaded = await isContentScriptLoaded(tabId, frameId);
  if (loaded) {
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    files,
  });
}

export async function broadcastToAllFrames(tabId: number, message: unknown): Promise<boolean> {
  const frameIds = await getFrameIds(tabId);
  let delivered = false;

  for (const frameId of frameIds) {
    try {
      await chrome.tabs.sendMessage(tabId, message, { frameId });
      delivered = true;
      continue;
    } catch {
      try {
        await injectContentScript(tabId, frameId);
        await chrome.tabs.sendMessage(tabId, message, { frameId });
        delivered = true;
      } catch {
        // Frame may be cross-origin or unavailable.
      }
    }
  }

  return delivered;
}

export async function sendContentMessage<T>(
  tabId: number,
  message: unknown,
  retries = 8,
): Promise<T> {
  let lastError: unknown;
  const frameIds = await getFrameIds(tabId);

  for (let attempt = 0; attempt < retries; attempt += 1) {
    let lastFailure: T | undefined;

    for (const frameId of frameIds) {
      try {
        const result = await chrome.tabs.sendMessage(tabId, message, { frameId });
        const fillResult = result as FillResult;
        if (fillResult?.success) {
          return result as T;
        }
        lastFailure = result as T;
      } catch (error) {
        lastError = error;
        try {
          await injectContentScript(tabId, frameId);
          const result = await chrome.tabs.sendMessage(tabId, message, { frameId });
          const fillResult = result as FillResult;
          if (fillResult?.success) {
            return result as T;
          }
          lastFailure = result as T;
        } catch (retryError) {
          lastError = retryError;
        }
      }
    }

    if (lastFailure !== undefined) {
      return lastFailure;
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function runFillAndSubmitOnTab(
  tabId: number,
  payload: unknown,
): Promise<FillResult> {
  await waitForTabComplete(tabId);
  await new Promise((resolve) => setTimeout(resolve, 800));
  return sendContentMessage<FillResult>(tabId, payload);
}
