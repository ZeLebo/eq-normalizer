import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const binary = process.env.ZEN_BINARY;
if (!binary) throw new Error('Set ZEN_BINARY to a Zen executable.');
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'eq-normalizer-test-'));
const server = http.createServer(async (req, res) => {
  if (req.url === '/tone.wav') {
    const rate = 48000, length = rate * 2, wave = Buffer.alloc(44 + length * 2);
    wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
    wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(rate, 24); wave.writeUInt32LE(rate * 2, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
    wave.write('data', 36); wave.writeUInt32LE(length * 2, 40);
    for (let i = 0; i < length; i++) wave.writeInt16LE(Math.round(500 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wave.length }); res.end(wave); return;
  }
  if (req.url === '/test') {
    res.end('<!doctype html><title>Audio fixture</title><button id="play">Play</button><video id="v" controls loop src="/tone.wav"></video>'); return;
  }
  if (req.url === '/cross') {
    res.end(`<!doctype html><title>Cross-origin fixture</title><button id="play">Play</button><video id="v" controls loop src="http://localhost:${server.address().port}/tone.wav"></video>`); return;
  }
  if (req.url === '/preview') {
    const html = await readFile(`${root}extension/popup.html`, 'utf8');
    res.end(html.replace('<script src="popup.js" defer>', '<script src="mock.js"></script><script src="popup.js" defer>')); return;
  }
  if (req.url === '/mock.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(`var previewState = {origin:'https://15nov.new-deaf.one',domain:'15nov.new-deaf.one',settings:{enabled:true,rangeDb:6,attackMs:100,holdMs:500,releaseMs:1500},frames:[{players:[{state:'active',meter:{inputDb:-36,outputDb:-22,gainDb:12.4}}]}]}; var browser = {tabs:{query:async()=>[{id:1}]},runtime:{sendMessage:async m=>{if(m.settings)previewState.settings=m.settings;if(m.domain)previewState.domain=m.domain; return previewState;}}};`); return;
  }
  if (['/popup.css', '/popup.js', '/icon.svg'].includes(req.url)) {
    res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : req.url.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript');
    res.end(await readFile(`${root}extension${req.url}`)); return;
  }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const portServer = net.createServer();
await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
await writeFile(`${profile}/user.js`, [
  `user_pref("marionette.port", ${port});`,
  'user_pref("media.autoplay.default", 0);',
  'user_pref("network.dns.localDomains", "15nov.new-deaf.localhost,16nov.new-deaf.localhost,new-deaf.localhost");',
  'user_pref("media.volume_scale", "0.0");',
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.startup.homepage_override.mstone", "ignore");',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("devtools.console.stdout.chrome", true);',
  'user_pref("devtools.console.stdout.content", true);'
].join('\n'));
const proc = spawn(binary, ['--headless', '--no-remote', '--profile', profile, '--marionette', 'about:blank'], { env: { ...process.env, MOZ_HEADLESS: '1', MOZ_NO_REMOTE: '1', MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' } });
let log = '';
proc.stderr.on('data', data => { log += data; });
proc.stdout.on('data', data => { log += data; });
const deadline = setTimeout(() => { proc.kill('SIGTERM'); process.exitCode = 1; }, 90000);
let socket;
try {
  for (let i = 0; i < 100; i++) {
    try { socket = await new Promise((resolve, reject) => { const s = net.createConnection({ host: '127.0.0.1', port }); s.once('connect', () => resolve(s)); s.once('error', reject); }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 150)); }
  }
  if (!socket) throw new Error(`Marionette did not start: ${log}`);
  let buffer = Buffer.alloc(0), nextId = 0;
  const pending = new Map();
  socket.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    while (true) {
      const colon = buffer.indexOf(58);
      if (colon < 0) break;
      const length = Number(buffer.subarray(0, colon).toString());
      if (buffer.length < colon + 1 + length) break;
      const message = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length));
      buffer = buffer.subarray(colon + 1 + length);
      if (!Array.isArray(message)) continue;
      const waiter = pending.get(message[1]); pending.delete(message[1]);
      if (message[2]) waiter?.reject(new Error(JSON.stringify(message[2]))); else waiter?.resolve(message[3]);
    }
  });
  const command = (name, args = {}) => new Promise((resolve, reject) => {
    const id = ++nextId, body = JSON.stringify([0, id, name, args]);
    pending.set(id, { resolve, reject }); socket.write(`${Buffer.byteLength(body)}:${body}`);
  });
  const execute = async (script, args = []) => (await command('WebDriver:ExecuteScript', { script, args, newSandbox: false, sandbox: null })).value;
  const executeAsync = async (script, args = []) => (await command('WebDriver:ExecuteAsyncScript', { script, args, newSandbox: false, sandbox: null })).value;
  const until = async (fn, label, milliseconds = 8000) => {
    const end = Date.now() + milliseconds;
    let result;
    while (Date.now() < end) { result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 200)); }
    throw new Error(`Timed out: ${label}`);
  };
  const session = await command('WebDriver:NewSession', { capabilities: { alwaysMatch: {} } });
  console.log('Browser:', session.capabilities.browserName, session.capabilities.browserVersion);
  // A temporary extension-only page exercises the real runtime API without adding test hooks to the product.
  const addon = `${profile}/addon`;
  await cp(`${root}extension`, addon, { recursive: true });
  await writeFile(`${addon}/test.html`, '<!doctype html><title>Extension test driver</title>');
  console.log('Installed:', await command('Addon:Install', { path: addon, temporary: true }));
  await command('Marionette:SetContext', { value: 'chrome' });
  const extensionURL = await execute('return ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs").ExtensionParent.GlobalManager.getExtension("night-leveler@local.invalid").baseURI.spec;');
  await command('Marionette:SetContext', { value: 'content' });
  await command('WebDriver:Navigate', { url: `${extensionURL}test.html` });
  const target = await executeAsync(`const done = arguments[arguments.length-1]; browser.tabs.create({url:arguments[0],active:false}).then(async tab=>{await browser.tabs.update(tab.id,{muted:true});done(tab.id);}, error=>done({error:error.message}));`, [`${base}/test`]);
  assert.equal(typeof target, 'number', JSON.stringify(target));
  const api = async (type, extra = {}) => {
    const request = { type, tabId: target, ...extra };
    if (type === 'settings') {
      const current = await api('state', { tabId: request.tabId });
      request.domain = extra.domain ?? current.domain;
      request.settings = { ...current.settings, ...extra.settings };
    }
    return executeAsync('const done=arguments[arguments.length-1];browser.runtime.sendMessage(arguments[0]).then(done,error=>done({error:error.message}));', [request]);
  };
  await until(async () => (await api('state')).frames.length, 'content script registration');
  console.log('Initial state:', JSON.stringify(await api('state')));
  await api('settings', { settings: { enabled: true, rangeDb: 6 } });
  // Start media from its own tab; the browser tab is muted throughout the test.
  const driverHandle = (await command('WebDriver:GetWindowHandle')).value;
  const handles = await command('WebDriver:GetWindowHandles');
  let mediaHandle;
  for (const handle of handles) {
    await command('WebDriver:SwitchToWindow', { handle });
    const url = (await command('WebDriver:GetCurrentURL')).value;
    if (url === `${base}/test`) { mediaHandle = handle; break; }
  }
  assert.ok(mediaHandle, `No fixture tab in ${JSON.stringify(handles)}`);
  await command('WebDriver:SwitchToWindow', { handle: mediaHandle });
  const playback = await executeAsync('const done=arguments[arguments.length-1];document.querySelector("video").play().then(()=>done("playing"),error=>done(error.message));');
  console.log('Playback:', playback);
  const playButton = await command('WebDriver:FindElement', { using: 'css selector', value: '#play' });
  await command('WebDriver:ElementClick', { id: playButton.value['element-6066-11e4-a52e-4f735466cecf'] });
  await command('WebDriver:SwitchToWindow', { handle: driverHandle });
  let last;
  try {
    await until(async () => { last = await api('state'); return last.frames.some(frame => frame.players.some(player => player.state === 'active' || player.state === 'error')); }, 'audio routing');
  } catch (error) { throw new Error(`${error.message}: ${JSON.stringify(last)}`); }
  console.log('Processing:', JSON.stringify(last));
  assert.ok(last.frames.some(frame => frame.players.some(player => player.state === 'active')), JSON.stringify(last));
  const retimed = await api('settings', { settings: { attackMs: 250, holdMs: 700, releaseMs: 2000 } });
  assert.equal(retimed.settings.attackMs, 250);
  assert.equal(retimed.settings.holdMs, 700);
  assert.equal(retimed.settings.releaseMs, 2000);
  await command('WebDriver:SwitchToWindow', { handle: mediaHandle });
  assert.equal(await execute('return document.getElementById("v").muted;'), false, 'page mute getter preserves original value');
  assert.equal(await execute('return Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,"muted").get.call(document.getElementById("v"));'), true, 'native audio is muted while processing');
  await execute('document.getElementById("v").muted = true;');
  assert.equal(await execute('return document.getElementById("v").muted;'), true);
  await until(() => execute('const v=document.getElementById("v");return v[v.getAttribute("data-night-leveler")].output.gain.value < 0.001;'), 'mute reaches audio output');
  await execute('document.getElementById("v").muted = false; document.getElementById("v").volume = 0.35;');
  await until(() => execute('const v=document.getElementById("v");return Math.abs(v[v.getAttribute("data-night-leveler")].output.gain.value - 0.35) < 0.001;'), 'volume reaches audio output');
  await execute('document.getElementById("v").pause();');
  await until(() => execute('return !Object.hasOwn(document.getElementById("v"),"muted");'), 'pause restores original output');
  await executeAsync('const done=arguments[arguments.length-1];document.getElementById("v").play().then(()=>done(true),()=>done(false));');
  await command('WebDriver:SwitchToWindow', { handle: driverHandle });
  await until(async () => (await api('state')).frames.some(frame => frame.players.some(player => player.state === 'active')), 'resume after pause');
  await api('settings', { settings: { enabled: false, rangeDb: 6 } });
  await command('WebDriver:SwitchToWindow', { handle: mediaHandle });
  await until(() => execute('return !Object.hasOwn(document.getElementById("v"),"muted");'), 'restoring native mute');
  assert.equal(await execute('return document.getElementById("v").muted;'), false);
  assert.equal(await execute('return document.getElementById("v").volume;'), 0.35);
  console.log('Enable/disable, mute, and volume preservation: OK');
  await command('WebDriver:SwitchToWindow', { handle: driverHandle });
  await api('settings', { settings: { enabled: true, rangeDb: 6 } });
  await command('WebDriver:SwitchToWindow', { handle: mediaHandle });
  await until(() => execute('return Object.hasOwn(document.getElementById("v"),"muted");'), 're-enable');
  await execute('const f=document.createElement("iframe");f.src=arguments[0];document.body.append(f);', [`http://localhost:${server.address().port}/test`]);
  await command('WebDriver:SwitchToWindow', { handle: driverHandle });
  await until(async () => (await api('state')).frames.length === 2, 'cross-origin iframe registration');
  await command('WebDriver:SwitchToWindow', { handle: mediaHandle });
  await command('WebDriver:SwitchToFrame', { id: 0 });
  await executeAsync('const done=arguments[arguments.length-1];document.getElementById("v").play().then(()=>done(true),()=>done(false));');
  const frameButton = await command('WebDriver:FindElement', { using: 'css selector', value: '#play' });
  await command('WebDriver:ElementClick', { id: frameButton.value['element-6066-11e4-a52e-4f735466cecf'] });
  await command('WebDriver:SwitchToFrame', { id: null });
  await command('WebDriver:SwitchToWindow', { handle: driverHandle });
  await until(async () => (await api('state')).frames.filter(frame => frame.players.some(player => player.state === 'active')).length === 2, 'cross-origin iframe processing');
  console.log('Embedded third-party player: OK');
  await command('WebDriver:SwitchToWindow', { handle: mediaHandle });
  await command('WebDriver:Navigate', { url: `${base}/cross` });
  await executeAsync('const done=arguments[arguments.length-1];document.querySelector("video").play().then(()=>done(true),()=>done(false));');
  await command('WebDriver:SwitchToWindow', { handle: driverHandle });
  await api('settings', { settings: { enabled: true, rangeDb: 6 } });
  await command('WebDriver:SwitchToWindow', { handle: mediaHandle });
  const crossButton = await command('WebDriver:FindElement', { using: 'css selector', value: '#play' });
  await command('WebDriver:ElementClick', { id: crossButton.value['element-6066-11e4-a52e-4f735466cecf'] });
  await command('WebDriver:SwitchToWindow', { handle: driverHandle });
  try {
    await until(async () => { last = await api('state'); return last.frames.some(frame => frame.players.some(player => player.state === 'error')); }, 'cross-origin refusal');
  } catch (error) { throw new Error(`${error.message}: ${JSON.stringify(last)}`); }
  console.log('Cross-origin:', JSON.stringify(last));
  await command('WebDriver:SwitchToWindow', { handle: mediaHandle });
  assert.equal(await execute('return Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,"muted").get.call(document.getElementById("v"));'), false);
  console.log('Cross-origin original audio preserved: OK');
  await command('WebDriver:SwitchToWindow', { handle: driverHandle });
  const datedOrigin = `http://15nov.new-deaf.localhost:${server.address().port}`;
  const ruleTab = await executeAsync('const done=arguments[arguments.length-1];browser.tabs.create({url:arguments[0],active:false}).then(tab=>done(tab.id));', [`${datedOrigin}/test`]);
  await until(async () => { const value = await api('state', { tabId: ruleTab }); return value.origin === datedOrigin && value.frames.length > 0; }, 'dated domain navigation');
  await executeAsync('const done=arguments[arguments.length-1];browser.storage.local.set({[arguments[0]]:{enabled:true,rangeDb:8}}).then(()=>done(true));', [datedOrigin]);
  const originalRule = await api('state', { tabId: ruleTab });
  assert.equal(originalRule.settings.rangeDb, 8);
  assert.equal(originalRule.settings.attackMs, 100);
  const renamedRule = await api('settings', { tabId: ruleTab, domain: 'new-deaf.localhost', settings: { attackMs: 250, holdMs: 700, releaseMs: 2000 } });
  assert.equal(renamedRule.domain, 'new-deaf.localhost');
  assert.equal(renamedRule.settings.rangeDb, 8);
  assert.equal(await executeAsync('const done=arguments[arguments.length-1];browser.storage.local.get(arguments[0]).then(value=>done(Object.hasOwn(value,arguments[0])));', [datedOrigin]), false);
  const sibling = await executeAsync('const done=arguments[arguments.length-1];browser.tabs.create({url:arguments[0],active:false}).then(tab=>done(tab.id));', [`http://16nov.new-deaf.localhost:${server.address().port}/test`]);
  await until(async () => { const value = await api('state', { tabId: sibling }); return value.domain === 'new-deaf.localhost' && value.frames.length > 0; }, 'sibling domain navigation');
  const siblingRule = await api('state', { tabId: sibling });
  assert.equal(siblingRule.domain, 'new-deaf.localhost');
  assert.equal(siblingRule.settings.enabled, true);
  assert.equal(siblingRule.settings.holdMs, 700);
  console.log('Editable parent domain: legacy settings retained, sibling subdomain inherits rule');
  await command('WebDriver:SwitchToWindow', { handle: mediaHandle });
  await command('WebDriver:Navigate', { url: `${base}/preview` });
  await until(() => execute('return document.getElementById("status").textContent.includes("выравнивается");'), 'popup rendering');
  const layout = await execute('return {width:document.body.scrollWidth,height:document.body.scrollHeight,viewport:innerWidth,button:document.getElementById("toggle").textContent};');
  assert.ok(layout.width <= layout.viewport);
  assert.ok(layout.height <= 600, `Popup too tall: ${layout.height}`);
  await until(() => execute('return document.getElementById("gain-value").textContent === "+12,4 дБ" && document.getElementById("gain-display").dataset.state === "boost";'), 'positive gain display');
  assert.equal(await execute('return document.getElementById("gain-direction").textContent;'), 'Усиливает');
  assert.ok(await execute('return document.getElementById("gain-fill").getBoundingClientRect().width > 0;'));
  await mkdir(`${root}dist`, { recursive: true });
  const screenshot = await command('WebDriver:TakeScreenshot', { id: null, highlights: [], full: false });
  await writeFile(`${root}dist/popup-preview.png`, Buffer.from(screenshot.value, 'base64'));
  console.log('Popup rendered:', layout);
  await execute('previewState.frames[0].players[0].meter.gainDb = -8;');
  await until(() => execute('return document.getElementById("gain-value").textContent === "−8,0 дБ" && document.getElementById("gain-display").dataset.state === "cut";'), 'negative gain display');
  assert.equal(await execute('return document.getElementById("gain-direction").textContent;'), 'Приглушает');
  await until(() => execute('const fill=document.getElementById("gain-fill").getBoundingClientRect();const scale=document.querySelector(".gain-scale").getBoundingClientRect();return fill.right <= scale.left + scale.width / 2 + 0.5 && Math.abs(fill.width - scale.width * 8 / 60) < 1;'), 'attenuation bar stays left of zero');
  await writeFile(`${root}dist/popup-cut-preview.png`, Buffer.from((await command('WebDriver:TakeScreenshot', { id: null, highlights: [], full: false })).value, 'base64'));
  await execute('previewState.frames[0].players[0].meter.inputDb = -120;');
  await until(() => execute('return document.getElementById("gain-direction").textContent === "Пауза" && document.getElementById("gain-value").textContent === "−8,0 дБ";'), 'silence shows held gain instead of a fake reset');
  await execute('previewState.settings.enabled = false; previewState.frames[0].players[0].meter.inputDb = -36;');
  await until(() => execute('return document.getElementById("gain-direction").textContent === "Выключено" && document.getElementById("gain-fill").style.width === "0%";'), 'disabled gain display');
  console.log('Gain display: boost, attenuation, silence, and disabled states OK');
  await execute('document.getElementById("site").value="new-deaf.one";document.getElementById("site").dispatchEvent(new Event("input"));document.getElementById("site-form").requestSubmit();');
  await until(() => execute('return previewState.domain === "new-deaf.one" && document.getElementById("site").value === "new-deaf.one";'), 'domain editor saves parent domain');
  await execute('document.getElementById("timing-panel").open=true;for(const [key,value] of [["attack",250],["hold",1000],["release",3000]]){const input=document.getElementById(key);input.value=value;input.dispatchEvent(new Event("input"));}document.getElementById("timing-form").requestSubmit();');
  await until(() => execute('return previewState.settings.attackMs === 250 && previewState.settings.holdMs === 1000 && previewState.settings.releaseMs === 3000;'), 'timing controls save');
  assert.equal(await execute('return previewState.settings.rangeDb;'), 6);
  assert.ok(await execute('return document.body.clientHeight <= 600;'));
  await writeFile(`${root}dist/popup-settings-preview.png`, Buffer.from((await command('WebDriver:TakeScreenshot', { id: null, highlights: [], full: false })).value, 'base64'));
  console.log('Domain and timing forms: saved without changing range');
  await command('WebDriver:Navigate', { url: `${base}/test` });
  await executeAsync('const done=arguments[arguments.length-1];document.getElementById("v").play().then(()=>done(true),()=>done(false));');
  const unloadButton = await command('WebDriver:FindElement', { using: 'css selector', value: '#play' });
  await command('WebDriver:ElementClick', { id: unloadButton.value['element-6066-11e4-a52e-4f735466cecf'] });
  await until(() => execute('return Object.hasOwn(document.getElementById("v"),"muted");'), 'routing before extension removal');
  await execute('const v=document.getElementById("v");window.graphForTest=v[v.getAttribute("data-night-leveler")];');
  await command('Addon:Uninstall', { id: 'night-leveler@local.invalid' });
  await until(() => execute('return !Object.hasOwn(document.getElementById("v"),"muted") && window.graphForTest.context.state === "closed";'), 'extension removal restores audio and closes context', 20000);
  assert.equal(await execute('return document.getElementById("v").muted;'), false);
  console.log('Extension removal: original restored, processed context closed');
  await command('Marionette:Quit', { flags: ['eForceQuit'] });
} catch (error) {
  console.error(log.split('\n').filter(line => /night|leveler|Error|error/.test(line)).slice(-20).join('\n'));
  throw error;
} finally {
  socket?.destroy(); proc.kill('SIGTERM'); clearTimeout(deadline); server.closeAllConnections(); server.close();
}
