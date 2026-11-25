(() => {
  const routes = new Map();
  let watchdog;
  const nativeMuted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
  const post = data => window.postMessage({ source: 'night-leveler-page', ...data }, '*');

  function restore(id) {
    const route = routes.get(id);
    if (!route) return;
    route.graph.output.disconnect();
    route.media.removeEventListener('volumechange', route.onVolume);
    const current = Object.getOwnPropertyDescriptor(route.media, 'muted');
    if (current?.get === route.getMuted) delete route.media.muted;
    nativeMuted.set.call(route.media, route.muted);
    routes.delete(id);
    if (!routes.size) { clearInterval(watchdog); watchdog = null; }
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window || message?.source !== 'night-leveler-content') return;
    const { id, command, request } = message;
    if (command === 'lease') {
      for (const route of routes.values()) route.lease = performance.now();
      return;
    }
    if (command === 'release') {
      restore(id);
      return;
    }
    if (command !== 'route' || typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return;
    try {
      const media = document.querySelector(`[data-night-leveler="${id}"]`);
      if (!(media instanceof HTMLMediaElement)) throw new Error('Плеер больше не существует.');
      if (Object.hasOwn(media, 'muted')) throw new Error('Плеер использует собственное управление звуком.');
      const graph = media[id];
      if (!(graph?.output instanceof AudioNode)) throw new Error('Не удалось подключить аудиовыход.');
      const route = { media, graph, muted: media.muted, lease: performance.now() };
      route.getMuted = () => route.muted;
      const volume = () => ({ muted: route.muted, volume: media.volume });
      route.onVolume = () => {
        if (!nativeMuted.get.call(media)) { route.muted = false; nativeMuted.set.call(media, true); }
        post({ id, event: 'volume', ...volume() });
      };
      Object.defineProperty(media, 'muted', {
        configurable: true,
        get: route.getMuted,
        set(value) {
          route.muted = Boolean(value);
          media.dispatchEvent(new Event('volumechange'));
        }
      });
      routes.set(id, route);
      watchdog ??= setInterval(checkLeases, 2000);
      nativeMuted.set.call(media, true);
      media.addEventListener('volumechange', route.onVolume);
      post({ request, id, event: 'routed', ...volume() });
    } catch (error) {
      restore(id);
      post({ request, id, event: 'error', error: error.message });
    }
  });

  // MAIN-world getters survive extension unload; the lease restores native audio if its bridge disappears.
  function checkLeases() {
    const expiredContexts = new Set();
    for (const [id, route] of routes) {
      if (!route.media.isConnected || performance.now() - route.lease > 15000) {
        if (performance.now() - route.lease > 15000) expiredContexts.add(route.graph.context);
        restore(id);
        post({ id, event: 'expired' });
      }
    }
    for (const context of expiredContexts) if (context.state !== 'closed') context.close();
  }
  window.addEventListener('pagehide', () => {
    for (const id of routes.keys()) restore(id);
  });
})();
