const $ = id => document.getElementById(id);
let tabId, current;
let saving = false, domainDirty = false, timingDirty = false;

function render(state) {
  current = state;
  if (!domainDirty) $('site').value = state.domain || '';
  $('site').placeholder = state.origin ? '' : 'Открой страницу с фильмом';
  for (const id of ['toggle', 'site-save', 'timing-save']) $(id).disabled = !state.origin || saving;
  $('toggle').setAttribute('aria-pressed', String(state.settings.enabled));
  $('toggle').textContent = state.settings.enabled ? 'Выключить на этом сайте' : 'Включить на этом сайте';
  if (document.activeElement !== $('range')) $('range').value = state.settings.rangeDb;
  $('range-value').textContent = `≈ ${$('range').value} дБ`;
  if (!timingDirty) for (const key of ['attack', 'hold', 'release']) $(key).value = state.settings[`${key}Ms`];
  const players = state.frames.flatMap(frame => frame.players);
  const active = state.settings.enabled ? players.find(player => player.state === 'active') : null;
  const meter = active?.meter;
  const gain = Number.isFinite(meter?.gainDb) ? Math.round(meter.gainDb * 10) / 10 : null;
  const direction = gain === null ? 'idle' : gain > 0 ? 'boost' : gain < 0 ? 'cut' : 'neutral';
  $('gain-display').dataset.state = direction;
  $('gain-direction').textContent = gain === null ? (state.settings.enabled ? 'Нет сигнала' : 'Выключено') : meter.inputDb <= -90 ? 'Пауза' : gain > 0 ? 'Усиливает' : gain < 0 ? 'Приглушает' : 'Без изменения';
  $('gain-value').textContent = gain === null ? '' : `${gain > 0 ? '+' : gain < 0 ? '−' : ''}${Math.abs(gain).toFixed(1).replace('.', ',')} дБ`;
  const width = Math.min(Math.abs(gain ?? 0), 30) / 30 * 50;
  $('gain-fill').style.width = `${width}%`;
  $('gain-fill').style.transform = gain < 0 ? 'scaleX(-1)' : 'scaleX(1)';
  for (const type of ['input', 'output']) {
    const db = meter?.[`${type}Db`];
    $(`${type}-meter`).value = Number.isFinite(db) ? db : -60;
    $(`${type}-value`).textContent = Number.isFinite(db) && db > -90 ? `${Math.round(db)} dBFS` : 'нет сигнала';
  }
  let status = 'Выравнивание выключено.';
  if (state.settings.enabled) {
    if (active) status = 'Звук выравнивается. Громкость регулируй в плеере.';
    else if (players.some(player => player.state === 'gesture')) status = 'Нажми воспроизведение в плеере, чтобы включить обработку.';
    else if (players.some(player => player.state === 'error')) status = players.find(player => player.state === 'error').error;
    else status = 'Ждём звук. Запусти фильм в плеере.';
    if (active && players.some(player => player.state === 'error')) status += ' Один из других плееров недоступен.';
  }
  if (!state.origin) status = 'На служебных страницах браузера обработка недоступна.';
  if ($('status').textContent !== status) $('status').textContent = status;
}

async function refresh() {
  if (!tabId) return;
  try { render(await browser.runtime.sendMessage({ type: 'state', tabId })); }
  catch (error) { $('status').textContent = error.message; }
}

async function save(next, domain = current.domain) {
  saving = true;
  render(current);
  try {
    render(await browser.runtime.sendMessage({ type: 'settings', tabId, domain, settings: { ...current.settings, ...next } }));
    $('settings-error').hidden = true;
    return true;
  } catch (error) {
    $('settings-error').textContent = error.message;
    $('settings-error').hidden = false;
    return false;
  } finally { saving = false; render(current); }
}
$('site').addEventListener('input', () => { domainDirty = true; });
$('site-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (await save({}, $('site').value)) { domainDirty = false; render(current); }
});
for (const key of ['attack', 'hold', 'release']) $(key).addEventListener('input', () => { timingDirty = true; });
$('timing-form').addEventListener('submit', async event => {
  event.preventDefault();
  const next = Object.fromEntries(['attack', 'hold', 'release'].map(key => [`${key}Ms`, Number($(key).value)]));
  if (await save(next)) { timingDirty = false; render(current); }
});
$('toggle').addEventListener('click', () => save({ enabled: !current.settings.enabled }));
$('range').addEventListener('input', () => { $('range-value').textContent = `≈ ${$('range').value} дБ`; });
$('range').addEventListener('change', () => save({ rangeDb: Number($('range').value) }));
browser.tabs.query({ active: true, currentWindow: true }).then(tabs => { tabId = tabs[0]?.id; refresh(); });
setInterval(refresh, 200);
