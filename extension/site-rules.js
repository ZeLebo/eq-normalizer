import { DEFAULT_AUDIO_SETTINGS } from './audio/settings.js';

export const DEFAULT_SETTINGS = { enabled: false, ...DEFAULT_AUDIO_SETTINGS };

export function webOrigin(url) {
  try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? parsed.origin : null; }
  catch { return null; }
}

const hostMatches = (host, domain) => host === domain || host.endsWith(`.${domain}`);

export function ruleMatches(origin, ruleOrigin) {
  if (!webOrigin(origin) || !webOrigin(ruleOrigin)) return false;
  const page = new URL(origin), rule = new URL(ruleOrigin);
  return page.protocol === rule.protocol && page.port === rule.port && hostMatches(page.hostname, rule.hostname);
}

export function resolveRule(origin, rules) {
  if (!origin) return { ruleOrigin: null, domain: null, settings: { ...DEFAULT_SETTINGS } };
  const ruleOrigin = Object.keys(rules).filter(key => key === webOrigin(key) && ruleMatches(origin, key))
    .sort((a, b) => new URL(b).hostname.length - new URL(a).hostname.length)[0] ?? null;
  return { ruleOrigin, domain: new URL(ruleOrigin || origin).hostname, settings: { ...DEFAULT_SETTINGS, ...(ruleOrigin ? rules[ruleOrigin] : {}) } };
}

export function domainRule(domain, origin) {
  if (typeof domain !== 'string' || !domain.trim() || domain.includes('*')) throw new Error('Укажи домен, например new-deaf.one.');
  let parsed;
  try { parsed = new URL(`https://${domain.trim()}`); } catch { throw new Error('Некорректный домен.'); }
  if (parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Укажи только домен, без адреса страницы и порта.');
  const current = new URL(origin);
  if (!hostMatches(current.hostname, parsed.hostname)) throw new Error('Укажи текущий домен или его родительский домен.');
  return `${current.protocol}//${parsed.hostname}${current.port ? `:${current.port}` : ''}`;
}
