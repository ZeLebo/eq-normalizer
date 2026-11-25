import { webOrigin, resolveRule, domainRule, ruleMatches } from './site-rules.js';
import { validateAudioSettings } from './audio/settings.js';

const frames = new Map();

async function state(tabId) {
  const tab = await browser.tabs.get(tabId);
  const origin = webOrigin(tab.url);
  const rule = resolveRule(origin, await browser.storage.local.get(null));
  const liveFrames = new Set((await browser.webNavigation.getAllFrames({ tabId }) ?? []).map(frame => frame.frameId));
  return { origin, ...rule, frames: [...(frames.get(tabId)?.entries() ?? [])].filter(([id]) => liveFrames.has(id)).map(([, status]) => status) };
}

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (message?.type === 'config') {
    const origin = webOrigin(sender.tab?.url);
    return resolveRule(origin, await browser.storage.local.get(null)).settings;
  }
  if (message?.type === 'report' && sender.tab) {
    if (!frames.has(sender.tab.id)) frames.set(sender.tab.id, new Map());
    frames.get(sender.tab.id).set(sender.frameId, message.status);
    return;
  }
  if (sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL(''))) return;
  if (message?.type === 'state') return state(message.tabId);
  if (message?.type !== 'settings') return;
  const current = await state(message.tabId);
  if (!current.origin) throw new Error('Открой обычную страницу с видео.');
  const { enabled, rangeDb, attackMs, holdMs, releaseMs } = message.settings;
  if (typeof enabled !== 'boolean') throw new Error('Некорректные настройки.');
  validateAudioSettings(message.settings);
  const ruleOrigin = domainRule(message.domain, current.origin);
  const next = { enabled, rangeDb, attackMs, holdMs, releaseMs };
  await browser.storage.local.set({ [ruleOrigin]: next });
  if (current.ruleOrigin && current.ruleOrigin !== ruleOrigin) await browser.storage.local.remove(current.ruleOrigin);
  const rules = await browser.storage.local.get(null);
  const tabs = await browser.tabs.query({});
  await Promise.all(tabs.filter(tab => ruleMatches(tab.url, ruleOrigin) || (current.ruleOrigin && ruleMatches(tab.url, current.ruleOrigin))).map(async tab => {
    const settings = resolveRule(webOrigin(tab.url), rules).settings;
    const targets = await browser.webNavigation.getAllFrames({ tabId: tab.id });
    await Promise.all(targets.map(frame => browser.tabs.sendMessage(tab.id, { type: 'settings', settings }, { frameId: frame.frameId }).catch(() => {})));
  }));
  return state(message.tabId);
});

browser.webNavigation.onCommitted.addListener(details => {
  if (details.frameId === 0) frames.delete(details.tabId);
  else frames.get(details.tabId)?.delete(details.frameId);
});
browser.tabs.onRemoved.addListener(tabId => frames.delete(tabId));
