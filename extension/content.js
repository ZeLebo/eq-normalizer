(() => {
  const players = new Map();
  let settings = { enabled: false };
  let context, moduleReady;
  const post = data => window.postMessage({ source: 'night-leveler-content', ...data }, '*');
  const report = () => browser.runtime.sendMessage({ type: 'report', status: {
    players: [...players.values()].map(player => ({ state: player.state, error: player.error, meter: player.meter }))
  } }).catch(() => {});

  async function audioContext() {
    if (!context || context.state === 'closed') {
      context = new AudioContext({ latencyHint: 'interactive' });
      const created = context;
      moduleReady = context.audioWorklet.addModule(browser.runtime.getURL('audio/worklet.js'));
      context.resume().catch(() => {});
      context.addEventListener('statechange', () => {
        if (context === created && created.state !== 'running') {
          for (const player of players.values()) if (player.stream) stop(player);
          report();
        }
      });
    }
    await moduleReady;
    return context;
  }

  function closeContext() {
    const previous = context;
    context = moduleReady = null;
    if (previous && previous.state !== 'closed') previous.close();
  }

  function stop(player) {
    player.generation++;
    player.output?.disconnect();
    player.source?.disconnect();
    player.processor?.disconnect();
    if (player.processor) player.processor.port.onmessage = null;
    player.stream?.getTracks().forEach(track => track.stop());
    player.output = player.source = player.processor = player.stream = null;
    post({ command: 'release', id: player.id });
    delete player.media.wrappedJSObject[player.id];
    player.state = 'idle';
    player.meter = null;
    if (![...players.values()].some(item => item.stream || item.state === 'starting')) closeContext();
  }

  async function start(player) {
    const media = player.media;
    if (!settings.enabled || media.paused || media.readyState < 2 || player.stream || player.state === 'starting') return;
    player.state = 'starting';
    player.error = null;
    const generation = ++player.generation;
    try {
      if (media.mediaKeys) throw new Error('Защищённое DRM-аудио недоступно для обработки.');
      const sourceURL = media.currentSrc ? new URL(media.currentSrc, location.href) : null;
      if (sourceURL && /^https?:$/.test(sourceURL.protocol) && !media.crossOrigin && sourceURL.origin !== window.origin) {
        throw new Error('Аудио с другого домена недоступно без CORS. Звучит оригинал.');
      }
      const capture = media.captureStream || media.mozCaptureStream;
      if (!capture) throw new Error('В этом браузере нет захвата аудио плеера.');
      const ctx = await audioContext();
      if (generation !== player.generation || !settings.enabled) return;
      if (ctx.state !== 'running') {
        player.state = 'gesture';
        report();
        return;
      }
      player.stream = capture.call(media);
      player.stream.getVideoTracks().forEach(track => track.stop());
      const track = player.stream.getAudioTracks()[0];
      if (!track) throw new Error('В плеере пока нет доступной аудиодорожки.');
      player.source = ctx.createMediaStreamSource(new MediaStream([track]));
      player.processor = new AudioWorkletNode(ctx, 'night-leveler');
      player.processor.port.postMessage(JSON.stringify(settings));
      player.output = ctx.createGain();
      player.output.gain.value = 0;
      media.wrappedJSObject[player.id] = cloneInto({ context: ctx, output: player.output }, window, { wrapReflectors: true });
      player.source.connect(player.processor).connect(player.output).connect(ctx.destination);
      player.state = 'checking';
      player.startedAt = performance.now();
      track.addEventListener('ended', () => { if (player.generation === generation) { stop(player); report(); } });
      player.processor.addEventListener('processorerror', () => {
        stop(player);
        player.state = 'error';
        player.error = 'Ошибка обработки аудио. Исходный звук восстановлен.';
        report();
      });
      player.processor.port.onmessage = event => {
        player.meter = event.data;
        if (player.state === 'checking' && event.data.inputDb > -90 && !track.muted) {
          player.state = 'routing';
          post({ command: 'route', id: player.id, request: player.id });
        } else if (player.state === 'checking' && performance.now() - player.startedAt > 4000 && track.muted) {
          stop(player);
          player.state = 'error';
          player.error = 'Браузер не даёт доступ к аудио (CORS или DRM). Звучит оригинал.';
        }
        report();
      };
      report();
    } catch (error) {
      stop(player);
      player.state = 'error';
      player.error = error.message;
      report();
    }
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window || message?.source !== 'night-leveler-page') return;
    const player = [...players.values()].find(item => item.id === message.id);
    if (!player) return;
    if (message.event === 'routed' && player.state !== 'routing') {
      post({ command: 'release', id: player.id });
      return;
    }
    if (message.event === 'routed' || message.event === 'volume') {
      if (!player.output) return;
      player.output.gain.setTargetAtTime(message.muted ? 0 : message.volume, context.currentTime, 0.005);
      player.state = 'active';
    } else if (message.event === 'error' || message.event === 'expired') {
      stop(player);
      player.state = 'error';
      player.error = message.error || 'Обработка прервана. Исходный звук восстановлен.';
    }
    report();
  });

  function scan() {
    for (const [media, player] of players) {
      if (!media.isConnected) {
        stop(player);
        player.listeners.abort();
        media.removeAttribute('data-night-leveler');
        players.delete(media);
      }
    }
    for (const media of document.querySelectorAll('video, audio')) {
      if (players.has(media)) continue;
      const player = { media, id: crypto.randomUUID(), state: 'idle', generation: 0, listeners: new AbortController() };
      media.setAttribute('data-night-leveler', player.id);
      players.set(media, player);
      const options = { signal: player.listeners.signal };
      media.addEventListener('playing', () => start(player), options);
      media.addEventListener('loadeddata', () => start(player), options);
      media.addEventListener('emptied', () => { stop(player); report(); }, options);
      media.addEventListener('pause', () => { stop(player); report(); }, options);
      media.addEventListener('encrypted', () => {
        stop(player);
        player.state = 'error';
        player.error = 'Защищённое DRM-аудио недоступно для обработки.';
        report();
      }, options);
      start(player);
    }
    report();
  }

  function apply(next) {
    settings = next;
    for (const player of players.values()) {
      if (!settings.enabled) stop(player);
      else if (player.processor) player.processor.port.postMessage(JSON.stringify(settings));
      else start(player);
    }
    if (!settings.enabled && context) {
      closeContext();
    }
    report();
  }

  browser.runtime.onMessage.addListener(message => {
    if (message?.type === 'settings') apply(message.settings);
  });
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, async () => {
    if (settings.enabled && context?.state === 'suspended') {
      await context.resume();
      for (const player of players.values()) start(player);
    }
  }, { capture: true, passive: true });
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; scan(); });
  }).observe(document, { childList: true, subtree: true });
  setInterval(() => { if (settings.enabled) post({ command: 'lease' }); }, 2000);
  window.addEventListener('pagehide', () => { for (const player of players.values()) stop(player); });
  window.addEventListener('pageshow', () => { for (const player of players.values()) start(player); });
  browser.runtime.sendMessage({ type: 'config' }).then(next => { settings = next; scan(); }).catch(error => console.error('eq-normalizer config', error));
})();
