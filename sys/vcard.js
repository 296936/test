const email0 = '356';
const vcardFileMode = location.protocol === 'file:';
// Initial navigation owns the viewport; the browser must not override it
// with the previous card's scroll position after bootstrap.
if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
const vcardVisualizationAvailable = () => !vcardFileMode
  && Boolean(window.AudioContext || window.webkitAudioContext)
  && window.VCardVisualization?.available() !== false;
const vcardAnimationPlaybackRate = (() => {
  const rate = Number(window.VCardUI?.animationPlaybackRate ?? 1);
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
})();
const vcardBackgroundPlaybackRate = 1;
// Media lists may finish loading before the lifecycle scripts have executed.
let resolveVCardSelectionReady;
const vcardSelectionReady = new Promise((resolve) => { resolveVCardSelectionReady = resolve; });
const vcardSelectionBags = new Map();
const vcardDecisionOrigin = (event, page = false) => {
  const context = window.VCLife?.random?.context?.() || {};
  return { commandId: null, revision: 0, runId: null, launch: null, profile: null, entryKey: null,
    ...context, event: context.event || event,
    ...(page ? { commandId: null, runId: null, launch: null, profile: null, entryKey: null } : {}) };
};
const vcardSelectionBag = (name, items, key = (item) => item) => {
  let bag = vcardSelectionBags.get(name);
  if (!bag) {
    bag = new window.VCLifeCore.TShuffleBag(items, key, window.VCPlayer.randomStream(name));
    vcardSelectionBags.set(name, bag);
  } else bag.update(items);
  return bag;
};
window.VCardSelectionReady = () => resolveVCardSelectionReady();
const vcardMagicTimeSeconds = (() => {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--vc-magictime')
    .trim();
  const match = value.match(/^(\d*\.?\d+)(ms|s)$/i);
  if (!match) return 2;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 2;
  return match[2].toLowerCase() === 'ms' ? amount / 1000 : amount;
})();
const frozenVideoRequests = new Map();
window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  for (const request of frozenVideoRequests.values()) request.abort();
  frozenVideoRequests.clear();
});
const cancelFrozenVideoRequest = (video) => {
  frozenVideoRequests.get(video)?.abort();
  frozenVideoRequests.delete(video);
};
const playVCardAnimation = (video, playbackRate = vcardAnimationPlaybackRate) => {
  cancelFrozenVideoRequest(video);
  video.playbackRate = playbackRate;
  if (window.VCardMotionPolicy?.snapshot().renderingActive === false) { video.pause(); return; }
  video.play().catch(() => { });
};

const freezeVCardVideo = (video) => {
  if (!video) return;
  cancelFrozenVideoRequest(video);
  video.pause();
  const source = video.src;
  if (!source) return;
  const showFirstFrame = () => {
    if (!video.paused || video.src !== source) return;
    try { video.currentTime = 0; } catch (_error) { }
  };
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) showFirstFrame();
  else {
    const request = new AbortController();
    frozenVideoRequests.set(video, request);
    vcardMedia.prepareVideo(video, { signal: request.signal,
      readyState: HTMLMediaElement.HAVE_METADATA }).then(() => {
      if (!request.signal.aborted && frozenVideoRequests.get(video) === request) showFirstFrame();
    }).catch(() => {}).finally(() => {
      if (frozenVideoRequests.get(video) === request) frozenVideoRequests.delete(video);
    });
  }
};

class TKeyboardBridge {
  constructor() {
    this.handlers = [];
    this.scope = new AbortController();
    const { signal } = this.scope;
    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.isComposing) return;
      for (const { handle } of this.handlers) {
        if (!handle(event)) continue;
        event.preventDefault();
        event.stopImmediatePropagation();
        break;
      }
    }, { capture: true, signal });
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) {
        this.scope.abort();
        this.handlers.length = 0;
      }
    }, { signal });
  }

  register(handle, priority = 0) {
    this.handlers.push({ handle, priority });
    this.handlers.sort((a, b) => b.priority - a.priority);
  }
}
const vcardKeyboard = new TKeyboardBridge();

class TViewProjection {
  constructor(scope, project) {
    this.scope = scope;
    this.project = project;
    this.revision = -1;
    document.addEventListener('vcard:vcplayer-state', (event) => this.render(event.detail),
      { signal: scope.signal });
    this.render(window.VCPlayer?.current?.());
  }

  render(snapshot) {
    if (this.scope.signal.aborted || !Number.isSafeInteger(snapshot?.revision)
      || snapshot.revision <= this.revision) return;
    this.revision = snapshot.revision;
    this.project(snapshot);
  }
}

const vcardCssDefault = (name, fallback = '') => {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(`--def-${name}`)
    .trim();
  return value || fallback;
};

const vcardStorageSchemaVersion = 2;
// Existing keys remain the wire format; only Preferences are read once.
const vcardStorageSchema = (() => {
  const choice = (values, fallback, aliases = {}) => (value) => {
    const key = String(value ?? '').toLowerCase();
    return values.includes(aliases[key] || key) ? aliases[key] || key : fallback();
  };
  const definitions = {};
  const add = (key, normalize, defaultValue, group = 'Preferences', area = 'local', version = 1) => {
    definitions[key] = Object.freeze({ key, type: group === 'Preferences' ? 'string' : 'json', normalize, defaultValue, group, area, version });
  };
  const enumSetting = (key, values, fallback, css = null, aliases = {}) => {
    const defaultValue = () => {
      const value = css ? vcardCssDefault(css, fallback).toLowerCase() : fallback;
      return values.includes(aliases[value] || value) ? aliases[value] || value : fallback;
    };
    add(key, choice(values, defaultValue, aliases), defaultValue);
  };
  for (const [key, css, fallback] of [
    ['autopilot', null, 'on'], ['debug', 'debug', 'off'], ['debug-rainbow', 'debug-rainbow', 'off'],
    ['images-visible', 'images-visible', 'on'], ['trackplay', 'trackplay', 'on'],
    ['random-color', 'random-color', 'on'], ['accent', 'accent', 'on'], ['mono-color', 'mono-color', 'off'],
  ]) enumSetting(`vcard-${key}`, ['on', 'off'], fallback, css);
  enumSetting('vcard-portal-size', ['small', 'mid'], 'mid');
  enumSetting('vcard-show-profile', ['img', 'mon'], 'img');
  enumSetting('vcard-playlist-alternation', ['none', 'previous', 'next', 'repeat', 'random'], 'random');
  enumSetting('vcard-song-alternation', ['none', 'sequential', 'repeat', 'random'], 'random');
  enumSetting('vcard-volume-boost', ['1', '1.5', '2', '3'], '1');
  enumSetting('vcard-color-scheme', ['black', 'white'], 'black', 'color-scheme');
  enumSetting('vcard-preset', ['night', 'mono', 'duo', 'newspaper', 'custom'], 'duo');
  enumSetting('vcard-song-scale', ['xs', 's', 'm', 'l', 'xl'], 'm', 'font-size',
    { '75%': 's', '100%': 'm', '125%': 'l' });
  enumSetting('vcard-visualization', ['off', 'h', 'v'], 'v', 'visualization',
    { horizontal: 'h', vertical: 'v' });
  const backgroundAliases = { off: 'wallpaper', light: 'wallpaper', h: 'graph1', horizontal: 'graph1', v: 'graph2', vertical: 'graph2' };
  enumSetting('vcard-background-mode', ['wallpaper', 'graph1', 'graph2', 'smoke'], 'smoke', null, backgroundAliases);
  const brightnessDefault = () => String(Math.max(0, Math.min(5, Number.parseInt(vcardCssDefault('visualization-brightness', '2'), 10) || 0)));
  add('vcard-visualization-brightness', choice(['0', '1', '2', '3', '4', '5'], brightnessDefault), brightnessDefault);
  for (const key of ['vcard-active-playlist', 'vcard-background-image']) {
    add(key, (value) => String(value ?? ''), () => '');
  }
  // Bootstrap owns format migration; catalog reconciliation belongs to owners.
  const jsonObject = (version, migrate = (value) => value) => (value) => {
    if (value === null) return null;
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      if (Number(parsed.version || 1) > version) return null;
      const migrated = migrate(parsed);
      return migrated === null ? null : JSON.stringify(migrated);
    } catch (_error) { return null; }
  };
  add('vcard-selection-memory', jsonObject(2, (value) => (
    [1, 2].includes(value.version) && Array.isArray(value.recent)
      ? { ...value, version: 2, epoch: value.epoch || '0000000000000:initial' } : null
  )), () => null, 'Session', 'local', 2);
  add('aliswb:vclife:stats', jsonObject(1, (value) => value.version === 1 ? {
    ...value, lifetime: { counters: { ...(value.lifetime?.counters || {}) }, last: { ...(value.lifetime?.last || {}) } },
    sessions: Array.isArray(value.sessions) ? value.sessions.slice(-10) : [],
    currentSession: value.currentSession && typeof value.currentSession === 'object' ? value.currentSession : null,
  } : null), () => null, 'Statistics');
  add('vcard-media-cache-session-v1', jsonObject(1, (value) => (
    Array.isArray(value.resources) ? { ...value, resources: value.resources.filter((item) => (
      item && typeof item.url === 'string' && Number.isFinite(item.bytes) && item.bytes >= 0
    )) } : null
  )), () => null, 'Reports');
  return Object.freeze(definitions);
})();

const vcardStorage = (() => {
  const errors = [];
  const area = (name) => {
    const areaName = name === 'localStorage' ? 'local' : 'session';
    const definitions = Object.values(vcardStorageSchema).filter((item) => item.area === areaName);
    const memory = new Map();
    const pending = new Set();
    const futureKeys = new Set();
    const inspectVersion = (key, value, definition) => {
      if (!definition || definition.group === 'Preferences' || value === null) return;
      try {
        if (Number(JSON.parse(value)?.version || 1) > definition.version && !futureKeys.has(key)) {
          futureKeys.add(key);
          errors.push({ area: name, key, message: 'Newer structured format preserved; automatic writes skipped' });
        }
      } catch (_error) { /* Invalid JSON is handled by normalization. */ }
    };
    let backend = null;
    let cleared = false;
    let reported = false;
    const report = (error) => {
      if (reported) return;
      reported = true;
      errors.push({ area: name, message: String(error?.message || error) });
      console.warn(`VCard ${name}: using temporary settings when storage fails`, error);
    };
    try { backend = window[name]; } catch (error) { report(error); }
    let canMigrate = true;
    if (areaName === 'local') {
      try {
        const version = Number(backend?.getItem('vcard-storage-schema') || 0);
        if (version > vcardStorageSchemaVersion) {
          canMigrate = false;
          errors.push({ area: name, message: `Storage schema ${version} is newer than ${vcardStorageSchemaVersion}; automatic writes skipped` });
        }
      } catch (error) { report(error); }
    }
    const storage = {
      getItem(key) {
        key = String(key);
        const definition = vcardStorageSchema[key];
        if (definition?.area === areaName && definition.group === 'Preferences') {
          return memory.has(key) ? memory.get(key) : definition.defaultValue();
        }
        if (cleared || pending.has(key) || !backend) {
          const value = memory.get(key) ?? null;
          return definition?.area === areaName ? definition.normalize(value) : value;
        }
        try {
          const value = backend.getItem(key);
          inspectVersion(key, value, definition);
          if (value === null) memory.delete(key);
          else memory.set(key, value);
          return definition?.area === areaName ? definition.normalize(value) : value;
        } catch (error) {
          report(error);
          const value = memory.get(key) ?? null;
          return definition?.area === areaName ? definition.normalize(value) : value;
        }
      },
      setItem(key, value) {
        key = String(key);
        const definition = vcardStorageSchema[key];
        if (definition?.area === areaName) {
          value = definition.normalize(String(value));
          if (value === null) return this.removeItem(key);
        }
        memory.set(key, String(value));
        pending.add(key);
        if (!backend || !canMigrate || futureKeys.has(key)) return false;
        try {
          if (definition?.group !== 'Preferences') {
            inspectVersion(key, backend.getItem(key), definition);
            if (futureKeys.has(key)) return false;
          }
          backend.setItem(key, String(value));
          pending.delete(key);
          return true;
        } catch (error) { report(error); return false; }
      },
      removeItem(key) {
        key = String(key);
        memory.delete(key);
        pending.add(key);
        if (!backend || !canMigrate || futureKeys.has(key)) return false;
        try {
          inspectVersion(key, backend.getItem(key), vcardStorageSchema[key]);
          if (futureKeys.has(key)) return false;
          backend.removeItem(key);
          pending.delete(key);
          return true;
        } catch (error) { report(error); return false; }
      },
      clear() {
        memory.clear();
        pending.clear();
        cleared = true;
        if (!backend) return false;
        try { backend.clear(); cleared = false; return true; }
        catch (error) { report(error); return false; }
      },
      available: () => Boolean(backend) && !reported && canMigrate,
    };
    const raw = new Map();
    for (const definition of definitions.filter((item) => item.group === 'Preferences')) {
      try { raw.set(definition.key, backend?.getItem(definition.key) ?? null); }
      catch (error) { report(error); raw.set(definition.key, null); }
    }
    for (const definition of definitions.filter((item) => item.group === 'Preferences')) {
      let value = raw.get(definition.key);
      if (definition.key === 'vcard-background-mode' && !value) {
        value = raw.get('vcard-visualization');
      }
      const normalized = definition.normalize(value);
      memory.set(definition.key, normalized);
      if (canMigrate && value !== null && (normalized !== raw.get(definition.key))) storage.setItem(definition.key, normalized);
    }
    for (const definition of definitions.filter((item) => item.group !== 'Preferences')) {
      let value;
      try { value = backend?.getItem(definition.key) ?? null; }
      catch (error) { report(error); continue; }
      inspectVersion(definition.key, value, definition);
      if (value === null || futureKeys.has(definition.key)) continue;
      const normalized = definition.normalize(value);
      if (canMigrate && normalized !== value) {
        if (normalized === null || normalized === 'null') storage.removeItem(definition.key);
        else storage.setItem(definition.key, normalized);
      }
    }
    if (areaName === 'local') {
      // Retired transient flags have no successor value; schema acknowledgement
      // must reach disk before removing them.
      if (canMigrate && pending.size === 0 && storage.setItem('vcard-storage-schema', vcardStorageSchemaVersion)) {
        for (const key of ['vcard-portal-view', 'vcard-portal-fullscreen', 'vcard-player-simplified', 'vcard-auto-color', 'vcard-win-color']) storage.removeItem(key);
      }
    }
    return Object.freeze(storage);
  };
  const local = area('localStorage');
  const session = area('sessionStorage');
  const snapshot = () => Object.freeze({ schemaVersion: vcardStorageSchemaVersion,
    preferences: Object.freeze(Object.fromEntries(Object.values(vcardStorageSchema)
      .filter((item) => item.group === 'Preferences').map(({ key }) => [key, local.getItem(key)]))),
    available: Object.freeze({ local: local.available(), session: session.available() }),
    errors: Object.freeze(errors.map((error) => Object.freeze({ ...error }))),
  });
  return Object.freeze({ local, session, errors, schema: vcardStorageSchema,
    schemaVersion: vcardStorageSchemaVersion, ready: true, snapshot });
})();
window.VCardStorage = vcardStorage;

const vcardEnvironment = (() => {
  const queries = new Map();
  const scope = new AbortController();
  let state = null;
  let pending = false;
  let suspended = false;
  let dispatch = (apply) => apply();
  const capabilities = Object.freeze({
    protocol: vcardFileMode ? 'file' : 'http',
    webAudio: !vcardFileMode && Boolean(window.AudioContext || window.webkitAudioContext),
    mediaSession: Boolean(navigator.mediaSession),
    serviceWorker: !vcardFileMode && Boolean(navigator.serviceWorker),
    cacheStorage: !vcardFileMode && Boolean(window.caches),
    clipboard: Boolean(navigator.clipboard?.writeText),
    idleCallback: typeof window.requestIdleCallback === 'function',
  });
  const media = (query) => {
    if (!queries.has(query)) {
      const list = window.matchMedia(query);
      list.addEventListener('change', schedule, { signal: scope.signal });
      queries.set(query, list);
    }
    return queries.get(query);
  };
  const commit = () => {
    if (scope.signal.aborted) return;
    const dynamic = { width: window.innerWidth, height: window.innerHeight,
      orientation: media('(orientation: portrait)').matches ? 'portrait' : 'landscape',
      coarsePointer: media('(pointer: coarse)').matches, hover: media('(hover: hover)').matches,
      reducedMotion: media('(prefers-reduced-motion: reduce)').matches,
      visible: !document.hidden && !suspended, focused: document.hasFocus(), suspended };
    if (state && Object.keys(dynamic).every((key) => state[key] === dynamic[key])) return;
    state = Object.freeze({ ...dynamic, capabilities, storage: vcardStorage.snapshot().available });
    document.dispatchEvent(new CustomEvent('vcard:environment-state', { detail: state }));
  };
  function schedule() {
    if (pending || scope.signal.aborted) return;
    pending = true;
    queueMicrotask(() => { pending = false; if (!scope.signal.aborted) dispatch(commit); });
  }
  for (const type of ['resize', 'orientationchange', 'focus', 'blur']) {
    window.addEventListener(type, schedule, { signal: scope.signal });
  }
  document.addEventListener('visibilitychange', schedule, { signal: scope.signal });
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) scope.abort();
    else { suspended = true; schedule(); }
  }, { signal: scope.signal });
  window.addEventListener('pageshow', () => { suspended = false; schedule(); }, { signal: scope.signal });
  commit();
  return Object.freeze({
    snapshot: () => Object.freeze({ ...state, storage: vcardStorage.snapshot().available,
      mediaSessionActions: Object.freeze([...(window.VCLife?.mediaSessionBridge?.actions || [])]) }),
    connect(run) { dispatch = run; schedule(); },
    media(query) {
      return media(query);
    },
  });
})();
window.VCardEnvironment = vcardEnvironment;

class TVCMotionPolicy {
  constructor() {
    this.scope = new AbortController();
    const { signal } = this.scope;
    this.brightness = document.documentElement.dataset.visBri !== '0';
    this.suspended = false;
    this.playbackMotion = false;
    this.state = null;
    document.addEventListener('vcard:environment-state', () => this.publish(), { signal });
    document.addEventListener('vcard:visualization-state', (event) => {
      this.brightness = Number(event.detail?.brightnessLevel) > 0;
      this.publish();
    }, { signal });
    document.addEventListener('vcard:vcplayer-state', (event) => {
      this.playbackMotion = ['AudioPlaying', 'OutroRunning'].includes(event.detail?.phase);
      this.publish();
    }, { signal });
    window.addEventListener('pagehide', (event) => {
      this.suspended = true;
      this.publish();
      if (!event.persisted) this.scope.abort();
    }, { signal });
    window.addEventListener('pageshow', () => { this.suspended = false; this.publish(); }, { signal });
    this.publish();
  }

  snapshot() { return this.state; }

  publish() {
    if (this.scope.signal.aborted) return;
    const environment = vcardEnvironment.snapshot();
    const pageVisible = environment.visible && !this.suspended;
    const motionAllowed = this.brightness;
    const next = { motionAllowed, pageVisible, playbackMotion: this.playbackMotion,
      renderingActive: motionAllowed && pageVisible, reducedMotion: environment.reducedMotion };
    if (this.state && Object.keys(next).every((key) => next[key] === this.state[key])) return;
    this.state = Object.freeze(next);
    document.documentElement.dataset.motionPolicy = JSON.stringify(next);
    document.documentElement.dataset.motionAllowed = motionAllowed ? 'on' : 'off';
    document.documentElement.dataset.renderingActive = next.renderingActive ? 'on' : 'off';
    document.dispatchEvent(new CustomEvent('vcard:motion-state', { detail: this.state }));
  }
}
const vcardMotionPolicy = new TVCMotionPolicy();
window.VCardMotionPolicy = vcardMotionPolicy;

class TRenderScheduler {
  constructor() {
    this.closed = false;
    this.tasks = new Map();
    this.nextId = 1;
    this.frame = 0;
    this.budgetMs = 8;
    this.lastFrameMs = 0;
    this.cancelled = 0;
    this.deferred = 0;
    this.tick = this.tick.bind(this);
  }

  request(callback, { owner = null, scope = owner?.scope, revision = window.VCLife?.revision || 0,
    priority = 10, phase = 'write', essential = true, isCurrent = () => true, onCancel = null } = {}) {
    if (this.closed) {
      this.notifyCancellation({ owner, onCancel });
      return 0;
    }
    const id = this.nextId++;
    this.tasks.set(id, { id, callback, owner, scope, revision, priority, phase, essential,
      isCurrent, onCancel, deferrals: 0 });
    if (!this.frame) this.frame = requestAnimationFrame(this.tick);
    return id;
  }

  cancel(id) {
    const task = this.tasks.get(id);
    if (this.tasks.delete(id)) {
      this.cancelled += 1;
      this.notifyCancellation(task);
    }
    if (!this.tasks.size && this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }

  notifyCancellation(task) {
    try { task.onCancel?.(); }
    catch (error) {
      if (window.VCLife) window.VCLife.reportFault(error, { type: 'Render.Cancel', owner: task.owner });
      else console.error('VCard render cancellation failed', error);
    }
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.tasks.keys()]) this.cancel(id);
  }

  prepare(callback, { signal = null, isCurrent = () => true, owner = null } = {}) {
    return new Promise((resolve, reject) => {
      let id = 0;
      const cancelled = () => {
        signal?.removeEventListener('abort', abort);
        reject(new DOMException('Render preparation cancelled', 'AbortError'));
      };
      const abort = () => this.cancel(id);
      if (this.closed || signal?.aborted || !isCurrent()) { cancelled(); return; }
      id = this.request(() => {
        signal?.removeEventListener('abort', abort);
        try { resolve(callback()); } catch (error) { reject(error); }
      }, { owner, priority: 30, phase: 'draw', essential: false, isCurrent,
        onCancel: cancelled });
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  tick(timestamp) {
    this.frame = 0;
    if (this.closed) return;
    const started = performance.now();
    const phases = { write: 0, measure: 1, draw: 2 };
    // Work added by a callback belongs to the next browser frame.
    const batch = [...this.tasks.values()].sort((a, b) => (
      (phases[a.phase] ?? 0) - (phases[b.phase] ?? 0) || a.priority - b.priority || a.id - b.id
    ));
    for (const task of batch) {
      if (!this.tasks.has(task.id)) continue;
      try {
        if (task.owner?.dead || task.scope?.alive === false || task.scope?.signal?.aborted || !task.isCurrent()) {
          this.cancel(task.id);
          continue;
        }
        if (!task.essential && performance.now() - started >= this.budgetMs && task.deferrals < 2) {
          task.deferrals += 1;
          this.deferred += 1;
          continue;
        }
        this.tasks.delete(task.id);
        task.callback(timestamp);
      } catch (error) {
        this.tasks.delete(task.id);
        this.notifyCancellation(task);
        if (window.VCLife) window.VCLife.reportFault(error, { type: 'Render.Frame', owner: task.owner });
        else console.error('VCard render task failed', error);
      }
    }
    this.lastFrameMs = performance.now() - started;
    if (this.tasks.size && !this.frame) this.frame = requestAnimationFrame(this.tick);
  }

  snapshot() {
    return { closed: this.closed, pending: this.tasks.size, lastFrameMs: this.lastFrameMs, budgetMs: this.budgetMs,
      cancelled: this.cancelled, deferred: this.deferred,
      tasks: [...this.tasks.values()].map(({ id, revision, priority, phase, essential, owner }) => (
        { id, revision, priority, phase, essential, owner: owner?.id || owner?.constructor?.name || 'page' }
      )) };
  }
}
const vcardRenderScheduler = new TRenderScheduler();
window.VCardRenderScheduler = vcardRenderScheduler;
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) vcardRenderScheduler.dispose();
});

window.VCardBootstrap = { state: 'Loading', error: null,
  storageReady: vcardStorage.ready, settings: vcardStorage.snapshot(),
  environment: vcardEnvironment.snapshot() };
const vcardSetBootstrapState = (state, error = null) => {
  window.VCardBootstrap.state = state;
  window.VCardBootstrap.error = error ? String(error.message || error) : null;
  window.VCardBootstrap.settings = vcardStorage.snapshot();
  window.VCardBootstrap.environment = vcardEnvironment.snapshot();
  document.dispatchEvent(new CustomEvent('vcard:bootstrap-state', {
    detail: { state, error: window.VCardBootstrap.error },
  }));
  if (state === 'Failed') console.error('VCard startup failed', error);
};
window.VCardBootstrap.setState = vcardSetBootstrapState;
document.addEventListener('DOMContentLoaded', () => {
  if (!['Interactive', 'Failed'].includes(window.VCardBootstrap.state)) {
    vcardSetBootstrapState('Failed', new Error('VCLife runtime did not finish startup'));
  }
}, { once: true });

const vcardStoredSetting = (storageKey, defaultName, fallback) => {
  const stored = vcardStorage.local.getItem(storageKey);
  return stored === null ? vcardCssDefault(defaultName, fallback) : stored;
};

let vcardAutopilotActive = vcardStorage.local.getItem('vcard-autopilot') !== 'off';
const vcardAutopilotEnabled = () => vcardAutopilotActive;

const vcardSetAutopilotEnabled = (enabled) => {
  const active = Boolean(enabled);
  vcardAutopilotActive = active;
  vcardStorage.local.setItem('vcard-autopilot', active ? 'on' : 'off');
  document.dispatchEvent(new CustomEvent('vcard:autopilot-state', {
    detail: { enabled: active }
  }));
};

// The director flag is published configuration; subsequent locking is owned
// by decoration. DOM attributes below are projections, never policy inputs.
const directorStyleLocked = document.documentElement.hasAttribute('data-director-style-locked');
let playlistStyleLocked = document.documentElement.dataset.playlistStyleLocked === 'on';
const vcardPlaylistStyleLocked = () => playlistStyleLocked || directorStyleLocked;

const vcardPublishedMediaVersions = new Map((window.VCardMediaManifest?.resources || []).map((item) => {
  const url = new URL(item.url, document.baseURI);
  return [url.pathname, url.searchParams.get('v')];
}));
const vcardPublishedMediaUrl = (value) => {
  const url = new URL(value, document.baseURI);
  const version = url.origin === location.origin ? vcardPublishedMediaVersions.get(url.pathname) : '';
  if (version && !url.searchParams.has('v')) url.searchParams.set('v', version);
  return url.href;
};

const vcardMediaCache = (() => {
  const CACHE_NAME = 'vcard-media-v1';
  const MEDIA_PATH = /\/(?:sys|usr)\//i;
  const MEDIA_EXT = /\.(?:aac|aiff?|avif|flac|gif|jpe?g|m4a|m4v|mov|mp3|mp4|oga|ogg|ogv|opus|png|svg|wav|webm|webp)$/i;
  const AUDIO_EXT = /\.(?:aac|aiff?|flac|m4a|mp3|oga|ogg|opus|wav)$/i;
  const SESSION_REPORT_KEY = 'vcard-media-cache-session-v1';
  const scope = new AbortController();
  const sessionResources = new Map();
  let resourceObserver = null;
  let scheduleNonAudioCache = null;
  let cacheGeneration = 0;
  const cacheRequests = new Set();

  const saveSessionReport = () => {
    try {
      vcardStorage.local.setItem(SESSION_REPORT_KEY, JSON.stringify({
        savedAt: new Date().toISOString(),
        resources: [...sessionResources].map(([url, item]) => ({
          url,
          source: item.source,
          bytes: item.bytes,
        })),
      }));
    } catch (_error) { }
  };

  const recordSessionResource = (value, source = 'loaded', bytes = 0, replaceBytes = false) => {
    if (scope.signal.aborted || !isMediaUrl(value)) return;
    const url = new URL(value, document.baseURI).href;
    const previous = sessionResources.get(url);
    if (!previous) {
      sessionResources.set(url, { source, bytes: Math.max(0, Number(bytes) || 0) });
      saveSessionReport();
      return;
    }
    const nextBytes = Math.max(0, Number(bytes) || 0);
    previous.bytes = replaceBytes
      ? Math.max(previous.bytes, nextBytes)
      : previous.bytes + nextBytes;
    // A service-worker answer is authoritative.  A performance entry seen
    // earlier is only a fallback and must not turn a real cache hit into a load.
    if (source === 'cached') previous.source = 'cached';
    saveSessionReport();
  };

  saveSessionReport();

  const isMediaUrl = (value) => {
    try {
      const url = new URL(value, document.baseURI);
      return url.origin === location.origin && MEDIA_PATH.test(url.pathname) && MEDIA_EXT.test(url.pathname);
    } catch (_error) {
      return false;
    }
  };

  const isAudioUrl = (value) => {
    try {
      return AUDIO_EXT.test(new URL(value, document.baseURI).pathname);
    } catch (_error) {
      return false;
    }
  };

  const mediaManifestResources = () => {
    const resources = window.VCardMediaManifest?.resources;
    if (!Array.isArray(resources)) return [];
    const seen = new Set();
    return resources.filter((item) => {
      if (!item || !isMediaUrl(item.url)) return false;
      const url = new URL(item.url, document.baseURI).href;
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });
  };

  const manifestStats = () => mediaManifestResources().reduce((result, item) => {
    result.files += 1;
    result.bytes += Math.max(0, Number(item.size) || 0);
    return result;
  }, { files: 0, bytes: 0 });

  const observe = (entry) => {
    if (scope.signal.aborted || !isMediaUrl(entry.name)) return;
    // transferSize=0 means only that the browser did not transfer bytes.  It
    // can be the browser HTTP cache, not necessarily the VCard Cache Storage.
    // Service-worker messages below replace this fallback with the real source.
    recordSessionResource(entry.name, 'loaded', entry.transferSize);
    if (!isAudioUrl(entry.name)) scheduleNonAudioCache?.();
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const detail = event.data;
      if (!detail || detail.type !== 'vcard-media-source') return;
      recordSessionResource(detail.url, detail.source === 'cache' ? 'cached' : 'loaded');
    }, { signal: scope.signal });
  }

  if ('PerformanceObserver' in window) {
    try {
      resourceObserver = new PerformanceObserver((list) => list.getEntries().forEach(observe));
      resourceObserver.observe({ type: 'resource', buffered: true });
    } catch (_error) {
      resourceObserver?.disconnect();
      resourceObserver = null;
    }
  }
  // Buffered observation includes existing entries; a separate initial read
  // would count their transferSize twice. Read directly only as a fallback.
  if (!resourceObserver) performance.getEntriesByType('resource').forEach(observe);

  const getStats = async () => {
    const session = [...sessionResources.values()].reduce((result, item) => {
      result.files += 1;
      result.bytes += item.bytes;
      if (item.source === 'cached') result.cached += 1;
      else result.downloaded += 1;
      return result;
    }, { files: 0, cached: 0, downloaded: 0, bytes: 0 });
    if (!('caches' in window)) return { cache: { files: 0, bytes: 0 }, session, persistent: false };
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    let bytes = 0;
    let files = 0;
    await Promise.all(keys.map(async (key) => {
      const response = await cache.match(key);
      if (!response?.ok || response.status === 206 || response.headers.has('Content-Range')) return;
      files += 1;
      bytes += Math.max(0, Number(response?.headers.get('Content-Length')) || 0);
    }));
    const persistent = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    return { cache: { files, bytes }, session, persistent };
  };

  const discardObsoleteVersions = async (cache, currentRequest) => {
    const currentUrl = new URL(currentRequest.url);
    if (!currentUrl.searchParams.has('v')) return;
    const keys = await cache.keys();
    await Promise.all(keys
      .filter((key) => {
        const candidate = new URL(key.url);
        return candidate.origin === currentUrl.origin
          && candidate.pathname === currentUrl.pathname
          && candidate.searchParams.has('v')
          && candidate.href !== currentUrl.href;
      })
      .map((key) => cache.delete(key)));
  };

  const cacheUrls = async (urls, onProgress = null) => {
    if (scope.signal.aborted || !('caches' in window)) return;
    const generation = cacheGeneration;
    if (navigator.storage?.persist) {
      try { await navigator.storage.persist(); } catch (_error) { }
    }
    if (generation !== cacheGeneration) return;
    const cache = await caches.open(CACHE_NAME);
    if (generation !== cacheGeneration) return;
    const unique = [...new Map((urls || [])
      .filter((item) => isMediaUrl(typeof item === 'string' ? item : item?.url))
      .map((item) => {
        const url = new URL(typeof item === 'string' ? item : item.url, document.baseURI).href;
        return [url, typeof item === 'string' ? { url, size: 0 } : { ...item, url }];
      })).values()];
    const progress = { total: unique.length, completed: 0, cached: 0, loaded: 0, failed: 0, bytes: 0 };
    const reportProgress = () => { if (generation === cacheGeneration) onProgress?.({ ...progress }); };
    reportProgress();
    let cursor = 0;
    const cacheOne = async () => {
      while (cursor < unique.length && generation === cacheGeneration) {
        const item = unique[cursor++];
        let controller = null;
        try {
          const request = new Request(item.url);
          let source = 'cached';
          let response = await cache.match(request);
          if (generation !== cacheGeneration) return;
          if (!response?.ok || response.status === 206 || response.headers.has('Content-Range')) {
            source = 'loaded';
            controller = new AbortController();
            cacheRequests.add(controller);
            response = await fetch(request, { cache: 'force-cache', credentials: 'same-origin', signal: controller.signal });
            if (!response.ok || response.status === 206 || response.headers.has('Content-Range')
              || generation !== cacheGeneration) throw new Error('Media response is unavailable');
            await cache.put(request, response.clone());
            if (generation !== cacheGeneration) return;
            await discardObsoleteVersions(cache, request);
          }
          if (generation !== cacheGeneration) return;
          const bytes = Math.max(
            0,
            Number(item.size) || Number(response?.headers.get('Content-Length')) || 0
          );
          recordSessionResource(item.url, source, bytes, true);
          progress[source] += 1;
          progress.bytes += bytes;
        } catch (_error) {
          progress.failed += 1;
        } finally {
          if (controller) cacheRequests.delete(controller);
          progress.completed += 1;
          reportProgress();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, unique.length) }, cacheOne));
    if (generation === cacheGeneration) {
      document.dispatchEvent(new CustomEvent('vcard:media-cache-change'));
    }
    return progress;
  };

  const cacheLoadedNonAudioMedia = () => cacheUrls(
    [...sessionResources.keys()].filter((url) => !isAudioUrl(url))
  );
  let nonAudioCacheTimer = 0;
  scheduleNonAudioCache = () => {
    if (scope.signal.aborted || nonAudioCacheTimer) return;
    nonAudioCacheTimer = window.setTimeout(() => {
      nonAudioCacheTimer = 0;
      cacheLoadedNonAudioMedia().catch(() => {});
    }, 1200);
  };
  if (document.readyState === 'complete') scheduleNonAudioCache();
  else window.addEventListener('load', scheduleNonAudioCache, { once: true, signal: scope.signal });
  let preloadAllPromise = null;
  const preloadAll = () => {
    if (preloadAllPromise) return preloadAllPromise;
    const resources = mediaManifestResources();
    preloadAllPromise = cacheUrls(resources, (detail) => {
      document.dispatchEvent(new CustomEvent('vcard:media-cache-progress', { detail }));
    }).finally(() => {
      preloadAllPromise = null;
    });
    return preloadAllPromise;
  };
  const cancelPendingCache = () => {
    cacheGeneration += 1;
    cacheRequests.forEach((controller) => controller.abort());
    cacheRequests.clear();
    if (nonAudioCacheTimer) {
      window.clearTimeout(nonAudioCacheTimer);
      nonAudioCacheTimer = 0;
    }
  };
  scope.signal.addEventListener('abort', () => {
    cancelPendingCache();
    resourceObserver?.disconnect();
  }, { once: true });
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) scope.abort();
  }, { signal: scope.signal });
  const clear = async () => {
    if (scope.signal.aborted || !('caches' in window)) return false;
    cancelPendingCache();
    sessionResources.clear();
    saveSessionReport();
    try { performance.clearResourceTimings(); } catch (_error) { }
    const cleared = await caches.delete(CACHE_NAME);
    if (!scope.signal.aborted) document.dispatchEvent(new CustomEvent('vcard:media-cache-change'));
    return cleared;
  };
  return {
    CACHE_NAME,
    cacheLoadedNonAudioMedia,
    cacheUrls,
    clear,
    getStats,
    manifestStats,
    preloadAll,
  };
})();

window.vcardMediaCache = vcardMediaCache;

const vcardSettingEnabled = (storageKey, defaultName, fallback = 'on') => (
  vcardStoredSetting(storageKey, defaultName, fallback).toLowerCase() !== 'off'
);

const vcardHorizontalWaveBounds = () => {
  const viewportHeight = window.innerHeight;
  const portalSpaceMinimum = 0.5;
  const portal = document.querySelector(
    '.song__preview.is-visible .song-portal-stage:not([hidden])'
  );
  const rect = portal && portal.getBoundingClientRect();
  if (
    rect
    && rect.height > 0
    && rect.bottom > 0
    && rect.top < viewportHeight
  ) {
    const top = Math.max(0, Math.min(viewportHeight, rect.bottom));
    const spaceBelow = viewportHeight - top;
    if (spaceBelow > 1 && spaceBelow >= viewportHeight * portalSpaceMinimum) {
      return { top, bottom: viewportHeight, height: spaceBelow };
    }
  }
  return { top: 0, bottom: viewportHeight, height: viewportHeight };
};

const vcardUiConfig = window.VCardUI || {};
const vcardHints = vcardUiConfig.hints || {};

const vcardPortalConfig = Object.freeze({
  settings: Object.freeze({
    FrameTransitionTime: 0,
    FirstFrameFade: 2,
    FinishFade: 2,
    CassettePosterFile: 'sys/v_cass/cass.webp',
    CassetteVideoFile: 'sys/v_cass/cass.mp4',
    HandsAniFile: 'sys/v_handsani/list.js',
  }),
  frame: Object.freeze({
    mediaType: 'image',
    source: 'img',
    style: 'vc s_alarm vc_mask',
    brightness: 0,
    contrast: 0,
    transitionDuration: 0,
  }),
});

const vcardPortalPlan = (() => {
  const portal = vcardPortalConfig;
  const values = portal.settings || {};
  const configuredFrame = portal.frame || null;
  const effectPlans = new WeakMap();
  const lastEffects = new WeakMap();
  const frame = () => configuredFrame ? { ...configuredFrame } : null;
  const frameFor = (directive) => {
    if (!configuredFrame) return null;
    if (!directive) return frame();
    const styles = Array.isArray(directive.styles)
      ? directive.styles.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const maskMode = String(directive.mask || 'off').toLowerCase();
    if (maskMode !== 'off') styles.push('vc_mask');
    return {
      ...configuredFrame,
      source: String(directive.source || configuredFrame.source || 'img'),
      style: styles.join(' ') || '0',
      maskMode,
      pick: String(directive.pick || 'shuffle-bag'),
      glow: Math.max(0, Math.min(10, Number(directive.glow) || 0)),
      glowPulse: Boolean(directive.glowPulse),
      glowPulses: Math.max(1, Math.floor(Number(directive.glowPulses) || 1)),
      keepPhysicalIndex: Boolean(directive.keepPhysicalIndex),
      transitionDuration: Number.isFinite(Number(directive.fade))
        ? Number(directive.fade)
        : configuredFrame.transitionDuration,
    };
  };
  const transition = (preview, verseNumber) => {
    const plan = preview ? effectPlans.get(preview) : null;
    const effects = plan?.verseNumber === verseNumber
      ? (plan.effects || []).filter((item) => ['HandsAni', 'CrossImg'].includes(item.name))
      : [];
    const frameEffect = effects.find((item) => item.name === 'CrossImg') || null;
    const overlayEffect = effects.find((item) => item.name === 'HandsAni') || null;
    return {
      kind: frameEffect && overlayEffect
        ? 'crossimg+handsani'
        : (frameEffect ? 'crossimg' : (overlayEffect ? 'handsani' : 'none')),
      lead: Math.max(
        0,
        Number(frameEffect?.lead) || 0,
        Number(overlayEffect?.lead) || 0
      ),
      frame: frameEffect ? { ...frameEffect } : null,
      overlay: overlayEffect ? { ...overlayEffect } : null,
      pick: String(plan?.portalFrame?.pick || 'shuffle-bag'),
      effects: effects.map((effect) => ({ ...effect })),
    };
  };
  const setVersePlan = (detail = {}) => {
    const preview = detail.preview;
    if (!preview) return;
    const index = Number(detail.index);
    if (!Number.isInteger(index) || index < 0) {
      effectPlans.delete(preview);
      lastEffects.delete(preview);
      return;
    }
    const effects = Array.isArray(detail.effects) ? detail.effects : [];
    effectPlans.set(preview, {
      verseNumber: index + 1,
      effects,
      portalFrame: detail.portalFrame ? { ...detail.portalFrame } : null,
    });
    if (detail.seeked) lastEffects.delete(preview);
    const endsAt = Number(detail.endsAt);
    if (effects.length && Number.isFinite(endsAt)) {
      lastEffects.set(preview, effects.map((effect) => ({ ...effect, endsAt })));
    }
  };
  return {
    beginPlayback: () => Boolean(configuredFrame),
    frame,
    frameFor,
    restart: frame,
    settings: () => values,
    setVersePlan,
    transition,
    effectDiagnostics: (preview, currentTime, paused) => (
      (preview ? lastEffects.get(preview) : null) || []
    ).map((effect) => {
      const now = Math.max(0, Number(currentTime) || 0);
      const startsAt = effect.endsAt - Math.max(0, Number(effect.lead) || 0);
      const finishesAt = effect.endsAt + Math.max(0, Number(effect.fade) || 0);
      let status = 'pending';
      if (now >= finishesAt) status = 'done';
      else if (now >= startsAt) status = paused ? 'paused' : 'running';
      return { ...effect, status };
    }),
  };
})();

const playerText = {
  play: 'Play',
  pause: 'Pause',
  mute: 'Mute',
  unmute: 'Unmute',
  volume: 'Volume',
  seek: 'Seek',
  seekLabel: '{seek}: {currentTime} из {duration}',
  close: 'ЗАКРЫТЬ',
  previousTrack: 'Previous track',
  nextTrack: 'Next track',
  ...(vcardUiConfig.player || {}),
};

const ensurePlyrIconSprite = () => {
  if (document.getElementById('vcard-plyr-icons')) return;
  const sprite = document.createElement('div');
  sprite.id = 'vcard-plyr-icons';
  sprite.hidden = true;
  sprite.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <symbol id="plyr-play" viewBox="0 0 18 18"><path d="M15.562 8.1 3.87.225c-.818-.562-1.87 0-1.87.9v15.75c0 .9 1.052 1.462 1.87.9L15.563 9.9c.584-.45.584-1.35 0-1.8"/></symbol>
      <symbol id="plyr-pause" viewBox="0 0 18 18"><path d="M6 1H3c-.6 0-1 .4-1 1v14c0 .6.4 1 1 1h3c.6 0 1-.4 1-1V2c0-.6-.4-1-1-1m6 0c-.6 0-1 .4-1 1v14c0 .6.4 1 1 1h3c.6 0 1-.4 1-1V2c0-.6-.4-1-1-1z"/></symbol>
      <symbol id="plyr-volume" viewBox="0 0 18 18"><path d="M15.6 3.3c-.4-.4-1-.4-1.4 0s-.4 1 0 1.4C15.4 5.9 16 7.4 16 9s-.6 3.1-1.8 4.3c-.4.4-.4 1 0 1.4.2.2.5.3.7.3.3 0 .5-.1.7-.3C17.1 13.2 18 11.2 18 9s-.9-4.2-2.4-5.7"/><path d="M11.282 5.282a.91.91 0 0 0 0 1.316c.735.735.995 1.458.995 2.402 0 .936-.425 1.917-.995 2.487a.91.91 0 0 0 0 1.316c.145.145.636.262 1.018.156a.7.7 0 0 0 .298-.156C13.773 11.733 14.13 10.16 14.13 9q.001-.255-.011-.51c-.053-.992-.319-2.005-1.522-3.208a.91.91 0 0 0-1.316 0m-7.495.726H.714C.286 6.008 0 6.31 0 6.76v4.512c0 .452.286.752.714.752h3.072l4.071 3.858c.5.3 1.143 0 1.143-.602V2.752c0-.601-.643-.977-1.143-.601z"/></symbol>
      <symbol id="plyr-muted" viewBox="0 0 18 18"><path d="m12.4 12.5 2.1-2.1 2.1 2.1 1.4-1.4L15.9 9 18 6.9l-1.4-1.4-2.1 2.1-2.1-2.1L11 6.9 13.1 9 11 11.1zM3.786 6.008H.714C.286 6.008 0 6.31 0 6.76v4.512c0 .452.286.752.714.752h3.072l4.071 3.858c.5.3 1.143 0 1.143-.602V2.752c0-.601-.643-.977-1.143-.601z"/></symbol>
      <symbol id="plyr-previous-track" viewBox="0 0 18 18"><path d="M2 3h2v12H2zM16 3 6 9l10 6z"/></symbol>
      <symbol id="plyr-next-track" viewBox="0 0 18 18"><path d="m2 3 10 6-10 6zM14 3h2v12h-2z"/></symbol>
    </svg>`;
  document.body.prepend(sprite);
};

const ensurePageSideFade = () => {
  let layer = document.querySelector('.vc-page-side-fade');
  if (layer) return layer;
  layer = document.createElement('div');
  layer.className = 'vc-page-side-fade';
  layer.setAttribute('aria-hidden', 'true');
  document.body.prepend(layer);
  return layer;
};

ensurePageSideFade();

const publishPlayerMp3Info = (preview) => {
  document.dispatchEvent(new CustomEvent('vcard:mp3-info-change', {
    detail: {
      text: preview
        ? (preview.dataset.downloadTitle || preview.dataset.downloadName || '')
        : ''
    }
  }));
};

const sharedSongAudio = (() => {
  const firstHost = document.querySelector('[ids="audio"][data-audio-src]');
  const audio = document.createElement('audio');
  audio.className = 'song__audio block-full';
  audio.controls = true;
  audio.preload = 'none';
  audio.dataset.sharedPlayer = 'true';
  (firstHost || document.body).append(audio);
  return audio;
})();

/* Video logos open their configured provider URL directly. */
const mediaLinkScope = new AbortController();
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) mediaLinkScope.abort();
}, { signal: mediaLinkScope.signal });
document.addEventListener('click', (event) => {
  const link = event.target.closest('.song-video-link');
  if (!link) return;
  if (sharedSongAudio && !sharedSongAudio.paused) sharedSongAudio.pause();
}, { signal: mediaLinkScope.signal });

// Only the completed audio source is committed; unfinished songs stay out of
// the automatic audio cache. Non-audio resources have their own delayed path.
sharedSongAudio?.addEventListener('ended', () => {
  const source = sharedSongAudio.currentSrc || sharedSongAudio.src;
  if (source) vcardMediaCache.cacheUrls([source]).catch((error) => {
    if (!mediaLinkScope.signal.aborted && document.documentElement.dataset.debug === 'on') console.warn('VCard completed-audio cache failed', error);
  });
}, { signal: mediaLinkScope.signal });

/*
 * Song portal scene adapter.
 *
 * TPortalScene owns two permanent main slots and computes their opacity from
 * the playback clock. A slot may contain a prepared photo compositor or video.
 * HandsAni is an independent overlay and cannot mutate either main slot.
 */
const portalController = (() => {
  if (!sharedSongAudio) return;

  // Template-owned animation sets. An instance sys/<folder> replaces the
  // corresponding template folder as a whole during the build.
  const portalSettings = vcardPortalPlan.settings();
  const CASSETTE_POSTER_FILE = String(
    portalSettings?.CassettePosterFile || 'sys/v_cass/cass.webp'
  );
  const CASSETTE_VIDEO_FILE = String(
    portalSettings?.CassetteVideoFile || 'sys/v_cass/cass.mp4'
  );
  let portalMotionAllowed = vcardMotionPolicy.snapshot().motionAllowed;

  const mediaUrl = vcardPublishedMediaUrl;

  const state = {
    preview: null,
    frame: null,
    layer: null,
    image: null,
    tapeStill: null,
    tapeVideo: null,
    surfaceFade: null,
    surfaceUnfades: [],
    crossVideo: null,
    action: null,
    controls: null,
    chain: {
      phase: 'Idle',
      action: 'play',
      continuationReserved: false,
      countdown: 0,
    },
    clickFrame: null,
    generation: 0,
    phase: 'start',
    mode: 'closed',
    surface: 'none',
    overlay: 'none',
    playback: 'idle',
    photoAspectRatio: 16 / 9,
    started: false,
    firstVerseActivated: false,
    activeInsert: null,
    pendingPhotoFade: null,
    endSequenceStarted: false,
    seeking: false,
    finishMedia: null,
    finishPosterPreparation: null,
    handsAniSource: '',
    handsAniItems: null,
    handsAniPromise: null,
    handsReservation: null,
    handsBegin: null,
    handsAbort: null,
    handsOperation: null,
    handsFrameCallback: 0,
    handsFrameNative: false,
    lastHandsAniSource: '',
    portalClickTimer: 0,
    portalClickPending: false,
    pendingPhotoGeneration: 0,
    pendingPhotoFrameVersion: 0,
    pendingPhotoResolve: null,
    pendingPhotoPromise: null,
    pendingPhotoPreserveOverlay: false,
    verseRunGeneration: 0,
    verseSlotKind: '',
    handsGeneration: 0,
    scene: null,
  };

  const finishPendingPhoto = (ready = false) => {
    const resolve = state.pendingPhotoResolve;
    state.pendingPhotoFrameVersion = 0;
    state.pendingPhotoResolve = null;
    state.pendingPhotoPromise = null;
    if (resolve) resolve(Boolean(ready));
  };

  const portalNumber = (name, fallback = 0) => {
    const value = Number(vcardPortalPlan.settings(state.preview)[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };

  const cassetteMediaScope = new AbortController();
  const portalAnimationRequests = new Map();
  const cancelPortalAnimation = (video) => portalAnimationRequests.get(video)?.abort();
  const pausePortalAnimation = (video) => {
    cancelPortalAnimation(video);
    video?.pause();
  };
  cassetteMediaScope.signal.addEventListener('abort', () => {
    [...portalAnimationRequests.values()].forEach((scope) => scope.abort());
    state.handsAbort?.abort();
    state.handsOperation?.cancel('page-died');
    state.handsOperation = null;
    state.handsReservation?.cancel();
    state.handsReservation = null;
    state.handsBegin = null;
  }, { once: true });
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) cassetteMediaScope.abort();
  }, { signal: cassetteMediaScope.signal });

  const playPortalAnimation = (video, { allowPausedPlayback = false } = {}) => {
    if (!video || cassetteMediaScope.signal.aborted) return;
    cancelPortalAnimation(video);
    const scope = new AbortController();
    portalAnimationRequests.set(video, scope);
    let frame = 0;
    let timer = 0;
    scope.signal.addEventListener('abort', () => {
      vcardRenderScheduler.cancel(frame);
      window.clearTimeout(timer);
      if (portalAnimationRequests.get(video) === scope) portalAnimationRequests.delete(video);
    }, { once: true });
    const source = video.dataset.portalSource || '';
    let retryPending = false;
    const kind = video.dataset.portalKind || '';
    const generation = kind === 'handsani' ? state.handsGeneration : state.generation;
    const isCurrent = () => (
      !scope.signal.aborted && !cassetteMediaScope.signal.aborted
      && portalAnimationRequests.get(video) === scope
      && video === (kind === 'tape' ? state.tapeVideo : state.crossVideo)
      && generation === (kind === 'handsani' ? state.handsGeneration : state.generation)
      && portalMotionAllowed
      && window.VCLife?.renderingActive !== false
      && (
        (kind === 'tape' && ['tape-still', 'tape-video'].includes(state.surface))
        || (
          kind === 'handsani'
          && ['scene', 'photo', 'tape-still', 'tape-video'].includes(state.surface)
          && (state.overlay === 'handsani'
            || (state.activeInsert?.handsFramePending && !state.activeInsert.handsAniShown))
        )
      )
      && state.controls?.dataset.ending !== 'hold'
      && (
        state.phase === 'finish'
        || allowPausedPlayback
        || (!sharedSongAudio.paused && !sharedSongAudio.ended)
      )
      && (video.dataset.portalSource || '') === source
    );
    const attempt = () => {
      retryPending = false;
      if (!isCurrent()) { scope.abort(); return; }
      video.playbackRate = vcardAnimationPlaybackRate;
      video.play().catch(() => {
        if (!isCurrent() || retryPending) return;
        retryPending = true;
        video.addEventListener('canplay', attempt, { once: true, signal: scope.signal });
      });
    };
    // Media can report play() before its first decoded frame. Reassert the
    // request after the current UI turn and when the source becomes playable.
    video.addEventListener('canplay', attempt, { once: true, signal: scope.signal });
    attempt();
    if (scope.signal.aborted) return;
    frame = vcardRenderScheduler.request(() => {
      frame = 0;
      attempt();
    }, { owner: video, scope, priority: 1 });
    timer = window.setTimeout(() => { timer = 0; attempt(); }, 120);
  };

  const createPortalVideo = (kind) => {
    const video = document.createElement('video');
    video.className = `song-portal-video song-portal-video--${kind}`;
    video.dataset.portalKind = kind;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.disablePictureInPicture = true;
    video.setAttribute('aria-hidden', 'true');
    return video;
  };

  const portalTapeStill = () => {
    if (state.tapeStill) return state.tapeStill;
    const image = document.createElement('img');
    image.className = 'song-portal-tape-still';
    image.alt = '';
    image.draggable = false;
    image.setAttribute('aria-hidden', 'true');
    state.tapeStill = image;
    return image;
  };

  const portalTapeVideo = () => {
    if (state.tapeVideo) return state.tapeVideo;
    const video = createPortalVideo('tape');
    video.loop = true;
    video.addEventListener('error', () => {
      if (!['tape-still', 'tape-video'].includes(state.surface)) return;
      activateSurface('tape-still');
      setControllerMode(
        state.phase === 'finish' ? 'cassette-finish-static' : 'cassette-static'
      );
    });
    state.tapeVideo = video;
    return video;
  };

  const portalCrossVideo = () => {
    if (state.crossVideo) return state.crossVideo;
    const video = createPortalVideo('handsani');
    video.loop = false;
    state.crossVideo = video;
    return video;
  };

  const cleanupPortalResources = (type, actions) => {
    let failure = null;
    for (const action of actions) {
      try { action(); }
      catch (error) { failure ||= error; }
    }
    if (!failure) return;
    const life = window.VCLife;
    if (life) life.queue.post(() => life.reportFault(failure, { type, owner: life }, 'ComponentFailure'),
      { type, owner: life, scope: life.scope });
    else console.warn(`VCard portal: ${type}`, failure);
  };

  const cancelHandsFrame = (video = state.crossVideo) => {
    const callback = state.handsFrameCallback;
    state.handsFrameCallback = 0;
    if (state.activeInsert) state.activeInsert.handsFramePending = false;
    if (callback) {
      if (state.handsFrameNative) video?.cancelVideoFrameCallback?.(callback);
      else vcardRenderScheduler.cancel(callback);
    }
  };

  const releaseCrossVideo = (reason = 'overlay-released') => {
    state.handsGeneration += 1;
    const operation = state.handsOperation;
    const reservation = state.handsReservation;
    const preparation = state.handsAbort;
    const video = state.crossVideo;
    state.handsOperation = null;
    state.handsReservation = null;
    state.handsBegin = null;
    state.handsAbort = null;
    state.crossVideo = null;
    state.overlay = 'none';
    cleanupPortalResources('Overlay.Cleanup', [
      () => operation?.cancel(reason),
      () => reservation?.cancel(),
      () => preparation?.abort(),
      () => cancelHandsFrame(video),
      () => video && pausePortalAnimation(video),
      () => video?.classList.remove('is-visible'),
      () => video?.removeAttribute('src'),
      () => video?.load(),
      () => video?.remove(),
    ]);
  };

  const releaseSurfaceFade = () => {
    const fade = state.surfaceFade;
    if (!fade) return;
    fade.getAnimations().forEach((animation) => animation.cancel());
    fade.remove();
    state.surfaceFade = null;
  };

  const releaseSurfaceUnfades = () => {
    state.surfaceUnfades.splice(0).forEach((animation) => animation.cancel());
  };

  const unfadeSurfaces = (nodes, duration) => {
    releaseSurfaceUnfades();
    const seconds = portalMotionAllowed ? Math.max(0, Number(duration) || 0) : 0;
    if (!seconds) return;
    state.surfaceUnfades = (nodes || []).filter(Boolean).map((node) => {
      const animation = node.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: seconds * 1000,
        easing: 'ease-in-out',
      });
      animation.finished.then(() => {
        const index = state.surfaceUnfades.indexOf(animation);
        if (index >= 0) state.surfaceUnfades.splice(index, 1);
      }).catch(() => {});
      return animation;
    });
  };

  const capturePhotoSurface = () => {
    if (state.surface !== 'photo' || !state.layer || !state.image) return null;
    const snapshot = document.createElement('div');
    snapshot.className = 'song-portal-surface-fade';
    snapshot.setAttribute('aria-hidden', 'true');
    const layerStyle = getComputedStyle(state.layer);
    [
      '--vc-director-brightness',
      '--vc-director-contrast',
      '--vc-pulse-image-brightness',
      '--vc-pulse-image-contrast',
    ].forEach((name) => snapshot.style.setProperty(name, layerStyle.getPropertyValue(name)));
    const image = state.image.cloneNode(true);
    image.removeAttribute('id');
    snapshot.append(image);
    state.layer.querySelectorAll(
      ':scope > .vcard-portal-mask-overlay.is-ready, :scope > .vcard-portal-mask-glow'
    ).forEach((source) => {
      if (!source.width || !source.height) return;
      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      canvas.getContext('2d').drawImage(source, 0, 0);
      const style = getComputedStyle(source);
      canvas.style.opacity = style.opacity;
      canvas.style.filter = style.filter;
      canvas.style.mixBlendMode = style.mixBlendMode;
      snapshot.append(canvas);
    });
    return snapshot;
  };

  const captureTapeSurface = () => {
    if (!['tape-still', 'tape-video'].includes(state.surface)) return null;
    const source = state.surface === 'tape-video' ? state.tapeVideo : state.tapeStill;
    if (!source) return null;
    const snapshot = document.createElement('div');
    snapshot.className = 'song-portal-surface-fade';
    snapshot.setAttribute('aria-hidden', 'true');
    if (
      source instanceof HTMLVideoElement
      && source.readyState >= 2
      && source.videoWidth
      && source.videoHeight
    ) {
      const canvas = document.createElement('canvas');
      canvas.width = source.videoWidth;
      canvas.height = source.videoHeight;
      canvas.getContext('2d').drawImage(source, 0, 0);
      canvas.style.filter = getComputedStyle(source).filter;
      snapshot.append(canvas);
    } else {
      const image = state.tapeStill?.cloneNode(true);
      if (!image) return null;
      image.style.filter = getComputedStyle(source).filter;
      snapshot.append(image);
    }
    return snapshot;
  };

  const fadePhotoSurface = (snapshot, duration) => {
    releaseSurfaceFade();
    const seconds = portalMotionAllowed ? Math.max(0, Number(duration) || 0) : 0;
    if (!snapshot || !state.frame || !seconds) return;
    state.surfaceFade = snapshot;
    state.frame.insertBefore(snapshot, state.controls || null);
    const animation = snapshot.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: seconds * 1000,
      easing: 'ease-in-out',
      fill: 'forwards',
    });
    const finishFade = () => {
      if (state.surfaceFade !== snapshot) return;
      snapshot.remove();
      state.surfaceFade = null;
    };
    animation.finished.then(finishFade).catch(finishFade);
  };

  const portalAction = () => {
    if (state.action) return state.action;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'song-portal-action';
    action.setAttribute('aria-label', 'Воспроизвести MP3');
    action.innerHTML = [
      `<img class="song-portal-action__logo song-portal-action__logo--play" src="${mediaUrl('sys/playbutton/audio-play.png')}" alt="" aria-hidden="true" draggable="false">`,
      `<img class="song-portal-action__logo song-portal-action__logo--pause" src="${mediaUrl('sys/playbutton/audio-pause.png')}" alt="" aria-hidden="true" draggable="false">`,
    ].join('');
    state.action = action;
    return action;
  };

  const portalControls = () => {
    if (state.controls) return state.controls;
    const controls = document.createElement('div');
    controls.className = 'song-portal-controls';
    controls.append(portalAction());
    state.controls = controls;
    return controls;
  };

  const setVideoSource = (video, source, { poster = '' } = {}) => {
    if (video.poster !== poster) video.poster = poster;
    if (video.dataset.portalSource === source) return video;
    video.pause();
    video.dataset.portalSource = source;
    video.src = source;
    video.load();
    return video;
  };

  const setPortalStatic = (isStatic) => {
    if (state.frame) state.frame.classList.toggle('is-portal-static', isStatic);
  };

  class TPortalSceneSlot {
    constructor(scene, index) {
      this.scene = scene;
      this.index = index;
      this.element = document.createElement('div');
      this.element.className = `song-portal-scene-slot slot-${index + 1}`;
      this.element.setAttribute('aria-hidden', 'true');
      this.element.style.opacity = '0';
      this.kind = '';
      this.plan = null;
      this.photoImage = null;
      this.photoLayer = null;
      this.tapeStill = null;
      this.tapeVideo = null;
      this.resourceId = 0;
      this.motionSuppressed = false;
    }

    ensurePhoto() {
      if (this.photoImage) {
        vcardMedia.registerPortalClone(this.scene.sourceImage, this.photoImage, 0);
        return this.photoImage;
      }
      const source = this.scene.sourceImage;
      const image = source.cloneNode(false);
      image.removeAttribute('id');
      image.removeAttribute('src');
      image.alt = '';
      image.draggable = false;
      image.setAttribute('aria-hidden', 'true');
      const layer = document.createElement('div');
      layer.className = 'vcard-portal-motion-layer';
      layer.append(image);
      this.element.append(layer);
      if (!vcardMedia.registerPortalClone(source, image, 0)) {
        layer.remove();
        return null;
      }
      this.photoImage = image;
      this.photoLayer = layer;
      return image;
    }

    ensureCassette() {
      if (this.tapeStill && this.tapeVideo) return;
      const media = loadFinishMedia();
      const still = document.createElement('img');
      still.className = 'song-portal-tape-still';
      still.alt = '';
      still.draggable = false;
      still.setAttribute('aria-hidden', 'true');
      still.src = media.poster;
      const video = createPortalVideo('tape');
      video.preload = 'auto';
      video.loop = true;
      video.poster = media.poster;
      setVideoSource(video, media.video, { poster: media.poster });
      this.element.append(still, video);
      this.tapeStill = still;
      this.tapeVideo = video;
      video.addEventListener('error', () => {
        if (this.kind === 'cassette') this.setCassetteMotion(false);
      });
      still.addEventListener('error', () => {
        if (this.kind === 'cassette' && video.hidden) {
          still.hidden = true;
          this.element.style.backgroundColor = '#000';
        }
      });
    }

    async prepareImage(plan, reservation, resourceId, signal) {
      const image = this.ensurePhoto();
      const frame = vcardPortalPlan.frameFor(plan.portalFrame);
      if (!image || !frame || signal?.aborted) return false;
      this.resourceId = resourceId;
      this.kind = 'image';
      this.element.style.backgroundColor = '';
      this.motionSuppressed = !portalMotionAllowed;
      this.plan = plan;
      this.photoLayer.hidden = false;
      if (this.tapeStill) this.tapeStill.hidden = true;
      if (this.tapeVideo) this.tapeVideo.hidden = true;
      const ready = await vcardMedia.renderPortalFrameAt(
        image,
        reservation.index,
        frame,
        () => !signal?.aborted && this.resourceId === resourceId,
        signal
      );
      if (!ready || signal?.aborted || this.resourceId !== resourceId) return false;
      applyVerseAppearance(image, plan, frame);
      const glow = this.photoLayer.querySelector(':scope > .vcard-portal-image-glow');
      if (glow && frame.glowPulse) glow.style.opacity = '0';
      return true;
    }

    prepareCassette(plan, resourceId, animated = true) {
      this.ensureCassette();
      animated = Boolean(animated && portalMotionAllowed);
      this.resourceId = resourceId;
      this.kind = 'cassette';
      this.plan = plan;
      if (this.photoLayer) this.photoLayer.hidden = true;
      this.setCassetteMotion(animated);
      return true;
    }

    waitForCassetteFrames(signal = null) {
      if (this.tapeStill && !this.tapeStill.hidden) {
        return vcardMedia.prepareImage(this.tapeStill.src, { signal }).then(() => true, () => false);
      }
      const video = this.tapeVideo;
      if (!video || signal?.aborted) return Promise.resolve(false);
      return vcardMedia.prepareVideo(video, { signal, timeoutMs: 4000 })
        .then(() => true, () => {
          if (signal?.aborted || this.kind !== 'cassette') return false;
          this.setCassetteMotion(false);
          return vcardMedia.prepareImage(this.tapeStill.src, { signal }).then(() => true, () => false);
        });
    }

    setCassetteMotion(animated, reset = false) {
      this.ensureCassette();
      animated = Boolean(animated && portalMotionAllowed && !this.tapeVideo.error);
      this.kind = 'cassette';
      this.tapeStill.hidden = animated || (this.tapeStill.complete && this.tapeStill.naturalWidth === 0);
      this.tapeVideo.hidden = !animated;
      this.element.style.backgroundColor = this.tapeStill.hidden && this.tapeVideo.hidden ? '#000' : '';
      if (!animated) {
        this.tapeVideo.pause();
        return;
      }
      if (reset) {
        try { this.tapeVideo.currentTime = 0; } catch (_error) { }
      }
      this.playVideo();
    }

    playVideo() {
      if (
        this.kind !== 'cassette'
        || !this.tapeVideo
        || this.tapeVideo.hidden
        || !portalMotionAllowed
        || ['waiting', 'failed'].includes(state.playback)
        || window.VCLife?.renderingActive === false
        || (sharedSongAudio.paused && this.plan?.phase !== 'finish')
        || !this.tapeVideo.paused
      ) return;
      this.tapeVideo.playbackRate = vcardAnimationPlaybackRate;
      this.tapeVideo.play().catch(() => {});
    }

    pauseVideo() {
      this.tapeVideo?.pause();
    }

    render(now) {
      if (this.kind === 'cassette') {
        // The finish sequence belongs to TransitionClock and continues after
        // the audio element has ended. Ordinary cassette slots still freeze
        // together with Pause and Buffering.
        if (sharedSongAudio.paused && this.plan?.phase !== 'finish') this.pauseVideo();
        else this.playVideo();
        return;
      }
      const frame = vcardPortalPlan.frameFor(this.plan?.portalFrame);
      const glow = this.photoLayer?.querySelector(':scope > .vcard-portal-image-glow');
      if (!glow || !frame?.glowPulse) return;
      if (!portalMotionAllowed || this.motionSuppressed) { glow.style.opacity = '0'; return; }
      const startsAt = Number(this.plan?.displayStartsAt);
      const endsAt = Number(this.plan?.displayEndsAt);
      const duration = endsAt - startsAt;
      const position = duration > 0
        ? Math.max(0, Math.min(1, (now - startsAt) / duration))
        : 0;
      const maximum = Math.max(0, Math.min(1, (Number(frame.glow) || 0) / 10));
      const pulses = Math.max(1, Math.floor(Number(frame.glowPulses) || 1));
      glow.style.opacity = String(
        Math.abs(Math.sin(Math.PI * pulses * position)) * maximum
      );
    }

    clear() {
      this.resourceId += 1;
      const image = this.photoImage;
      const layer = this.photoLayer;
      this.photoImage = null;
      this.photoLayer = null;
      this.kind = '';
      this.plan = null;
      cleanupPortalResources('SceneSlot.Cleanup', [
        () => this.pauseVideo(),
        () => image && vcardMedia.release(image),
        () => layer?.remove(),
        () => { this.element.style.opacity = '0'; },
        () => { this.element.hidden = true; },
      ]);
    }

    destroy() {
      this.clear();
      const video = this.tapeVideo;
      const still = this.tapeStill;
      this.tapeVideo = null;
      this.tapeStill = null;
      cleanupPortalResources('SceneSlot.Destroy', [
        () => video?.removeAttribute('src'),
        () => video?.removeAttribute('poster'),
        () => { if (video) delete video.dataset.portalSource; },
        () => video?.load(),
        () => video?.remove(),
        () => still?.removeAttribute('src'),
        () => still?.remove(),
      ]);
    }
  }

  class TPortalScene {
    constructor(frame, sourceImage, sourceLayer, keepImage = false) {
      this.frame = frame;
      this.sourceImage = sourceImage;
      this.sourceLayer = sourceLayer;
      this.root = document.createElement('div');
      this.root.className = 'song-portal-scene';
      this.root.setAttribute('aria-hidden', 'true');
      this.slots = [new TPortalSceneSlot(this, 0), new TPortalSceneSlot(this, 1)];
      this.slots.forEach((slot) => this.root.append(slot.element));
      this.current = null;
      this.reserved = null;
      this.transition = null;
      this.preparing = null;
      this.preparationAbort = null;
      this.cassetteRevision = 0;
      this.destroyed = false;
      this.nextResourceId = 1;
      this.frameHandle = 0;
      if (keepImage) this.root.append(sourceLayer);
      else sourceLayer.remove();
      vcardMedia.setActive(sourceImage, false);
      frame.insertBefore(this.root, state.controls || null);
      this.tick = this.tick.bind(this);
      this.frameHandle = vcardRenderScheduler.request(this.tick, { owner: this });
    }

    now(clock = 'audio') {
      return clock === 'audio'
        ? (Number(sharedSongAudio.currentTime) || 0)
        : performance.now() / 1000;
    }

    freeSlot() {
      return this.slots.find((slot) => (
        slot !== this.current
        && slot !== this.reserved?.slot
        && slot !== this.transition?.incoming
      )) || null;
    }

    async prepare(kind, plan, signal = null) {
      if (this.destroyed || signal?.aborted) return null;
      this.cassetteRevision += 1;
      while (this.preparing) {
        await this.preparing;
        if (this.destroyed || signal?.aborted) return null;
      }
      if (this.destroyed || signal?.aborted) return null;
      if (this.transition) this.cancel(this.transition.resource);
      if (this.reserved) this.cancel(this.reserved);
      let releasePreparation;
      const preparation = new Promise((resolve) => { releasePreparation = resolve; });
      this.preparing = preparation;
      const callerSignal = signal;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      callerSignal?.addEventListener('abort', onAbort, { once: true });
      this.preparationAbort = controller;
      signal = controller.signal;
      let slot = null;
      let reservation = null;
      try {
        slot = this.freeSlot();
        if (!slot) return null;
        const resourceId = this.nextResourceId++;
        if (kind === 'image') {
          const frame = vcardPortalPlan.frameFor(plan.portalFrame);
          const attempted = new Set();
          while (true) {
            reservation = await vcardMedia.reservePortalFrame(
              this.sourceImage, frame, signal, attempted, plan.decisionOrigin
            );
            if (!reservation || signal?.aborted || attempted.has(reservation.index)) {
              if (reservation) vcardMedia.cancelPortalFrame(this.sourceImage, reservation);
              return null;
            }
            attempted.add(reservation.index);
            const ready = await slot.prepareImage(plan, reservation, resourceId, signal);
            if (ready && !signal?.aborted) break;
            if (signal?.aborted) {
              vcardMedia.cancelPortalFrame(this.sourceImage, reservation);
              slot.clear();
              return null;
            }
            vcardMedia.cancelPortalFrame(this.sourceImage, reservation);
            slot.clear();
          }
        } else {
          slot.prepareCassette(plan, resourceId, true);
          const ready = await slot.waitForCassetteFrames(signal);
          if (!ready || signal?.aborted) {
            slot.clear();
            return null;
          }
        }
        slot.element.hidden = false;
        slot.element.style.opacity = '0';
        const resource = { id: resourceId, kind, plan, slot, reservation };
        this.reserved = resource;
        return resource;
      } catch (error) {
        if (reservation) vcardMedia.cancelPortalFrame(this.sourceImage, reservation);
        slot?.clear();
        throw error;
      } finally {
        callerSignal?.removeEventListener('abort', onAbort);
        if (this.preparationAbort === controller) this.preparationAbort = null;
        if (this.preparing === preparation) this.preparing = null;
        releasePreparation();
      }
    }

    cancel(resource = this.reserved) {
      if (!resource || resource.cancelled || resource.completed) return;
      if (resource.slot?.scene !== this || resource.slot.resourceId !== resource.id) return;
      resource.cancelled = true;
      if (this.reserved === resource) this.reserved = null;
      const transition = this.transition?.resource === resource ? this.transition : null;
      if (transition) this.transition = null;
      cleanupPortalResources('Scene.Cleanup', [
        () => resource.kind === 'image' && resource.reservation
          && vcardMedia.cancelPortalFrame(this.sourceImage, resource.reservation),
        () => transition?.signal?.removeEventListener('abort', transition.abort),
        () => { if (resource.slot !== this.current) resource.slot.clear(); },
        () => {
          if (!transition?.outgoing) return;
          transition.outgoing.element.hidden = false;
          transition.outgoing.element.style.opacity = '1';
        },
        () => transition?.resolve(false),
      ]);
    }

    show(resource, timing = {}, signal = null, clock = 'audio', publication = null) {
      if (this.destroyed || resource?.slot?.scene !== this) return Promise.resolve(false);
      if (resource.slot.resourceId !== resource.id) return Promise.resolve(false);
      if (!resource || resource !== this.reserved || signal?.aborted || window.VCLife?.renderingActive === false) {
        this.cancel(resource);
        return Promise.resolve(false);
      }
      this.reserved = null;
      const incoming = resource.slot;
      incoming.element.hidden = false;
      const keepCurrent = this.current?.kind === 'cassette' && resource.kind === 'cassette';
      const animate = this.current && !keepCurrent && portalMotionAllowed;
      const fade = animate ? Math.max(0, Number(timing.fade) || 0) : 0;
      const unfade = animate ? Math.max(0, Number(timing.unfade) || 0) : 0;
      const duration = Math.max(fade, unfade);
      incoming.element.style.opacity = '0';
      if (resource.kind === 'cassette' && duration) incoming.playVideo();
      return new Promise((resolve) => {
        const transition = {
          resource,
          outgoing: this.current,
          incoming,
          startsAt: this.now(clock),
          fade,
          unfade,
          duration,
          clock,
          resolve,
          signal,
          abort: null,
          publication,
          keepCurrent,
          finishing: false,
        };
        transition.abort = () => {
          if (this.transition === transition) this.cancel(resource);
        };
        this.transition = transition;
        signal?.addEventListener('abort', transition.abort, { once: true });
        if (!duration) this.renderTransition();
      });
    }

    async showCassette({ animated = false, reset = false, phase = 'play', timing = null } = {}) {
      const revision = ++this.cassetteRevision;
      while (this.preparing) {
        this.preparationAbort?.abort();
        await this.preparing;
        if (this.destroyed || revision !== this.cassetteRevision) return false;
      }
      if (this.destroyed) return Promise.resolve(false);
      if (this.transition) this.cancel(this.transition.resource);
      if (this.reserved) this.cancel(this.reserved);
      if (this.current?.kind === 'cassette') {
        this.current.plan = { ...this.current.plan, phase, showFallback: 'none' };
        this.current.setCassetteMotion(animated, reset);
        return Promise.resolve(true);
      }
      const slot = this.freeSlot();
      if (!slot) return Promise.resolve(false);
      const plan = { phase, displayStartsAt: this.now('audio'), displayEndsAt: Infinity };
      const resource = {
        id: this.nextResourceId++, kind: 'cassette', plan, slot, reservation: null,
      };
      slot.prepareCassette(plan, resource.id, animated);
      this.reserved = resource;
      return this.show(resource, timing || {}, null, phase === 'finish' ? 'life' : 'audio')
        .then((shown) => {
          if (shown && !this.destroyed && this.current === slot && slot.plan === plan) {
            this.current.setCassetteMotion(animated, reset);
          }
          return shown;
        });
    }

    renderTransition() {
      const transition = this.transition;
      if (!transition || transition.finishing) return;
      if (transition.signal?.aborted) {
        this.cancel(transition.resource);
        return;
      }
      const elapsed = Math.max(0, this.now(transition.clock) - transition.startsAt);
      const outgoingOpacity = transition.fade > 0
        ? 1 - Math.min(1, elapsed / transition.fade)
        : 0;
      const incomingOpacity = transition.unfade > 0
        ? Math.min(1, elapsed / transition.unfade)
        : 1;
      if (transition.duration) {
        if (transition.outgoing) transition.outgoing.element.style.opacity = String(outgoingOpacity);
        transition.incoming.element.style.opacity = String(incomingOpacity);
      }
      if (elapsed < transition.duration) return;
      transition.finishing = true;
      const commitSurface = () => {
        if (this.transition !== transition || transition.resource.cancelled
          || transition.incoming.resourceId !== transition.resource.id
          || transition.signal?.aborted || window.VCLife?.renderingActive === false) return false;
        if (transition.resource.kind === 'image'
          && !vcardMedia.commitPortalFrame(this.sourceImage, transition.resource.reservation)) return false;
        if (transition.keepCurrent) {
          this.current.plan = transition.resource.plan;
          this.current.setCassetteMotion(true);
          transition.incoming.clear();
        } else {
          transition.outgoing?.clear();
          transition.incoming.element.style.opacity = '1';
          this.current = transition.incoming;
          if (transition.resource.kind === 'cassette') this.current.playVideo();
        }
        this.sourceLayer.remove();
        this.transition = null;
        transition.signal?.removeEventListener('abort', transition.abort);
        transition.resource.completed = true;
        return true;
      };
      Promise.resolve().then(() => transition.publication
        ? transition.publication(commitSurface)
        : commitSurface()).then((committed) => {
        if (!committed) this.cancel(transition.resource);
        transition.resolve(Boolean(committed));
      }).catch((error) => {
        cleanupPortalResources('Scene.Publish', [
          () => { throw error; },
          () => this.cancel(transition.resource),
          () => transition.resolve(false),
        ]);
      });
    }

    tick() {
      this.frameHandle = 0;
      if (this.destroyed) return;
      if (window.VCLife?.renderingActive === false) { this.pause(); return; }
      const now = this.now('audio');
      const render = (type, action, recover) => {
        try { action(); }
        catch (error) {
          cleanupPortalResources(type, [() => { throw error; }, recover]);
        }
      };
      render('Scene.Transition', () => {
        this.renderTransition();
        this.transition?.incoming.render(now);
      }, () => { if (this.transition) this.cancel(this.transition.resource); });
      render('Scene.Render', () => {
        if (this.current && (this.current !== this.failedRenderSlot?.slot
          || this.current.resourceId !== this.failedRenderSlot.resourceId)) this.current.render(now);
      }, () => {
        const slot = this.current;
        this.failedRenderSlot = { slot, resourceId: slot?.resourceId };
        slot?.pauseVideo();
      });
      render('Overlay.Render', () => renderHandsAniOverlay(now), () => releaseCrossVideo('render-failure'));
      if (!this.destroyed) this.frameHandle = vcardRenderScheduler.request(this.tick, { owner: this });
    }

    pause() {
      this.slots.forEach((slot) => slot.pauseVideo());
      this.setImageMotion(false);
    }

    setImageMotion(running) {
      const visibleSlots = new Set([this.current, this.transition?.incoming]);
      visibleSlots.forEach((slot) => {
        if (slot?.kind !== 'image' || !slot.photoLayer) return;
        slot.photoLayer.getAnimations({ subtree: true }).forEach((animation) => {
          if (!running) animation.pause();
          else if (animation.playState === 'paused') animation.play();
        });
      });
    }

    finishMotion() {
      this.slots.forEach((slot) => {
        slot.motionSuppressed = true;
        if (slot.kind === 'cassette') slot.setCassetteMotion(false);
        slot.render(this.now('audio'));
      });
      if (this.transition && !this.transition.finishing) {
        this.transition.fade = this.transition.unfade = this.transition.duration = 0;
        this.renderTransition();
      }
    }

    resume() {
      if (this.destroyed || window.VCLife?.renderingActive === false) return;
      if (!this.frameHandle) this.frameHandle = vcardRenderScheduler.request(this.tick, { owner: this });
      this.slots.forEach((slot) => slot.playVideo());
      this.setImageMotion(!sharedSongAudio.paused && state.playback !== 'waiting');
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      const preparation = this.preparationAbort;
      const frameHandle = this.frameHandle;
      const transition = this.transition?.resource;
      const reserved = this.reserved;
      this.preparationAbort = null;
      this.frameHandle = 0;
      cleanupPortalResources('Scene.Destroy', [
        () => preparation?.abort(),
        () => { if (frameHandle) vcardRenderScheduler.cancel(frameHandle); },
        () => { if (transition) this.cancel(transition); },
        () => { if (reserved) this.cancel(reserved); },
        ...this.slots.map((slot) => () => slot.destroy()),
        () => this.root.remove(),
        () => { this.sourceLayer.style.visibility = 'hidden'; },
        () => {
          if (this.sourceLayer.parentElement !== this.frame) {
            this.frame.insertBefore(this.sourceLayer, state.controls || null);
          }
        },
      ]);
    }
  }

  const syncPortalSurfaceRatio = (frame, layer, image) => {
    if (!frame || !image) return;
    const naturalWidth = Number(image.naturalWidth) || 0;
    const naturalHeight = Number(image.naturalHeight) || 0;
    const rect = layer?.isConnected ? layer.getBoundingClientRect() : null;
    const renderedWidth = Number(rect?.width) || 0;
    const renderedHeight = Number(rect?.height) || 0;
    const ratio = naturalWidth > 0 && naturalHeight > 0
      ? naturalWidth / naturalHeight
      : (renderedWidth > 0 && renderedHeight > 0
        ? renderedWidth / renderedHeight
        : state.photoAspectRatio);
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    state.photoAspectRatio = ratio;
    frame.style.setProperty('--vc-portal-surface-ratio', String(ratio));
  };

  const ensurePortal = (preview, keepImage = false) => {
    const image = preview === state.preview && state.image
      ? state.image
      : preview && preview.querySelector('.song__preview-image');
    const frame = preview === state.preview && state.frame
      ? state.frame
      : image && image.closest('.song-vibeframe');
    if (!image || !frame) return false;
    const layer = preview === state.preview && state.layer
      ? state.layer
      : vcardMedia.ensurePortalMotionLayer(image);
    if (!layer) return false;
    syncPortalSurfaceRatio(frame, layer, image);
    if (!image.complete) {
      image.addEventListener('load', () => {
        if (state.image === image && state.frame === frame) {
          syncPortalSurfaceRatio(frame, layer, image);
        }
      }, { once: true, signal: cassetteMediaScope.signal });
    }
    const controls = portalControls();
    // Keep controls outside the breathing motion layer. Their geometry must
    // match the fixed controls of the external video card exactly.
    if (controls.parentElement !== frame) frame.append(controls);
    if (state.clickFrame !== frame) {
      if (state.clickFrame) {
        state.clickFrame.removeEventListener('click', onPortalClick, true);
        state.clickFrame.removeEventListener('pointerdown', onPortalMiddlePress, true);
      }
      frame.addEventListener('click', onPortalClick, { capture: true, signal: cassetteMediaScope.signal });
      frame.addEventListener('pointerdown', onPortalMiddlePress, { capture: true, signal: cassetteMediaScope.signal });
      state.clickFrame = frame;
    }
    state.preview = preview;
    state.frame = frame;
    state.layer = layer;
    state.image = image;
    if (state.scene && state.scene.frame !== frame) {
      state.scene.destroy();
      state.scene = null;
    }
    if (!state.scene) state.scene = new TPortalScene(frame, image, layer, keepImage);
    return true;
  };

  const portalImage = (preview = state.preview) => (
    preview === state.preview && state.image
      ? state.image
      : preview?.querySelector('.song__preview-image') || null
  );

  const publishPortalControllerState = () => {
    if (cassetteMediaScope.signal.aborted) return;
    document.dispatchEvent(new CustomEvent('vcard:portal-controller-state', {
      detail: window.VCardPortal?.current() || null,
    }));
  };

  const portalActionFor = (preview) => {
    const entryKey = window.VCardCatalogView?.forPreview(preview)?.entryKey;
    return entryKey && entryKey === state.chain?.actionEntryKey
      ? String(state.chain.action || 'play') : 'play';
  };

  const refreshPortalAction = () => {
    if (!state.action) return;
    const phase = String(state.chain?.phase || 'Idle');
    const chainVisible = [
      'ReadyPaused', 'AudioPlaying', 'AudioBuffering', 'AudioPaused', 'OutroRunning',
      'NextPending', 'FinishedStopped', 'Failed',
    ].includes(phase);
    const visible = chainVisible && state.mode !== 'closed';
    const action = portalActionFor(state.preview);
    state.action.classList.toggle('is-visible', visible);
    state.action.disabled = !visible;
    state.action.classList.remove('is-playing', 'is-finished');
    projectPortalButton(state.action, action);
  };

  const setPlaybackState = (playback) => {
    state.playback = playback;
    refreshPortalAction();
    publishPortalControllerState();
  };

  const setControllerMode = (mode) => {
    state.mode = mode;
    if (state.frame) state.frame.dataset.portalState = mode;
    refreshPortalAction();
    publishPortalControllerState();
  };

  const projectPortalButton = (button, action) => {
    if (button.dataset.action !== action) button.dataset.action = action;
    button.classList.toggle('is-playback-active',
      action === 'pause' && ['AudioPlaying', 'AudioBuffering'].includes(state.chain?.phase));
    const label = action === 'pause' ? 'Пауза' : 'Воспроизвести MP3';
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
  };

  const projectPortalState = (snapshot) => {
    const gray = snapshot.playingSong?.playback?.environment?.grayUntilEnd ? 'on' : 'off';
    if (document.documentElement.dataset.showGray !== gray) {
      document.documentElement.dataset.showGray = gray;
      vcardMedia.refreshPortalFrames();
    }
    if (!snapshot.playbackChain) return;
    state.chain = { ...snapshot.playbackChain, revision: snapshot.revision,
      actionEntryKey: (snapshot.playbackChain.autoReadyPending
        ? snapshot.openedSong : snapshot.playingSong)?.entryKey || '' };
    document.querySelectorAll('.song-portal-idle-action').forEach((action) => {
      projectPortalButton(action, portalActionFor(action.closest('.song__preview')));
    });
    refreshPortalAction();
    publishPortalControllerState();
  };

  const activateSurface = (surface) => {
    if (!state.frame || !state.layer || !state.image) return false;
    state.surface = surface;
    const photoActive = surface === 'photo';
    if (photoActive) state.layer.style.removeProperty('visibility');
    const selected = photoActive
      ? state.layer
      : (surface === 'tape-video' ? state.tapeVideo : state.tapeStill);
    [state.layer, state.tapeStill, state.tapeVideo].forEach((node) => {
      if (node && node !== selected) node.remove();
    });
    if (selected && selected.parentElement !== state.frame) {
      selected.classList.remove('is-priming');
      selected.hidden = false;
      state.frame.insertBefore(selected, state.controls || null);
    }
    if (!photoActive) {
      vcardMedia.setActive(state.image, false);
    } else {
      vcardMedia.setActive(state.image, true);
    }
    publishPortalControllerState();
    return true;
  };


  const setPhase = (phase) => {
    state.phase = phase;
    if (phase !== 'finish' && state.controls) delete state.controls.dataset.ending;
    refreshPortalAction();
  };


  new TViewProjection(cassetteMediaScope, projectPortalState);

  const loadFinishMedia = () => {
    if (state.finishMedia) return state.finishMedia;
    const poster = mediaUrl(CASSETTE_POSTER_FILE);
    const video = mediaUrl(CASSETTE_VIDEO_FILE);
    state.finishMedia = { video, poster };
    // Media helpers are initialized later in this same script. Warm the shared
    // poster after initialization, using the same decoded resource as slots.
    state.finishPosterPreparation = Promise.resolve().then(() => (
      vcardMedia.prepareImage(poster, { signal: cassetteMediaScope.signal })
    )).catch((error) => {
      if (error?.name !== 'AbortError') console.warn('VCard cassette poster: cannot prepare', error);
    });
    return state.finishMedia;
  };


  const cancelPortalClick = () => {
    if (state.portalClickTimer) {
      window.clearTimeout(state.portalClickTimer);
      state.portalClickTimer = 0;
    }
    state.portalClickPending = false;
  };

  cassetteMediaScope.signal.addEventListener('abort', cancelPortalClick, { once: true });
  const portalPlaybackAvailable = ({ preview, target, generation } = {}) => Boolean(
    !cassetteMediaScope.signal.aborted
    && generation === state.generation && preview?.isConnected
    && preview === window.VCardSongControls?.currentPreview?.()
    && ((preview === state.preview && target === state.frame)
      || (target === preview?.querySelector('.song-vibeframe')
        && target.querySelector(':scope > .song-portal-idle-action')))
    && target?.isConnected && !target.hidden && !target.closest('[inert]')
    && target.getClientRects().length
    && !window.VCardSettingsContext?.isOpen?.()
    && window.VCardCatalogView?.forPreview(preview)?.playable
  );
  const togglePortalPlayback = (input) => {
    if (!portalPlaybackAvailable(input)) return false;
    const { preview } = input;
    if (input.target.querySelector(':scope > .song-portal-idle-action')
        && state.chain?.phase === 'ReadyPaused' && state.chain?.autoReadyPending) {
      window.VCPlayer?.pause?.();
      return true;
    }
    if (sharedSongAudio.vcardPlayingPreview !== preview) {
      document.dispatchEvent(new CustomEvent('vcard:portal-idle-play', {
        detail: { preview },
      }));
      return true;
    }
    window.VCPlayer?.toggle?.(preview, { surface: 'portal' });
    return true;
  };
  const requestPortalPlayback = (input) => window.VCCommands
    ? window.VCCommands.dispatch(input) : togglePortalPlayback(input);

  const onPortalClick = (event) => {
    const idleFrame = event.target.closest?.('.song-vibeframe:has(> .song-portal-idle-action)');
    const frame = idleFrame || state.frame;
    if (!frame || !frame.contains(event.target) || event.button !== 0) return;
    const input = { type: 'Portal.TogglePlayback', source: 'Portal', target: frame,
      preview: idleFrame ? idleFrame.closest('.song__preview') : state.preview,
      generation: state.generation, trusted: event.isTrusted };
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!portalPlaybackAvailable(input)) return;
    // Resume Web Audio while this trusted pointer gesture is still active.
    // The playback toggle itself is delayed to distinguish a single click
    // from portal resize by double click, but that timeout is too late for
    // browsers that require synchronous user activation for AudioContext.
    document.dispatchEvent(new CustomEvent('vcard:prepare-audio-context'));
    cancelPortalClick();
    // Keyboard activation has no competing double click. Pointer activation,
    // including the overlay button, must wait for the same resize decision.
    if (event.detail === 0 && event.target.closest('.song-portal-action')) {
      requestPortalPlayback(input);
      return;
    }
    // `click` fires twice before `dblclick`. Delay the playback toggle so a
    // double click can exclusively change portal size without pausing audio.
    if (event.detail > 1) return;
    state.portalClickPending = true;
    state.portalClickTimer = window.setTimeout(() => {
      state.portalClickTimer = 0;
      state.portalClickPending = false;
      requestPortalPlayback(input);
    }, 320);
  };

  document.addEventListener('vcard:portal-double-click', cancelPortalClick,
    { signal: cassetteMediaScope.signal });

  // Capture portal playback clicks at document level because the frame can be
  // rebuilt while a song opens. Size changes are handled separately by
  // `dblclick` and cancel the delayed playback action above.
  document.addEventListener('click', onPortalClick,
    { capture: true, signal: cassetteMediaScope.signal });

  const loadHandsAniItems = () => {
    if (cassetteMediaScope.signal.aborted) return Promise.resolve([]);
    const configured = String(
      vcardPortalPlan.settings(state.preview).HandsAniFile || ''
    ).trim();
    const source = configured ? mediaUrl(configured) : '';
    if (!source) return Promise.resolve([]);
    if (state.handsAniSource !== source) {
      state.handsAniSource = source;
      state.handsAniItems = null;
      state.handsAniPromise = null;
    }
    if (state.handsAniItems) return Promise.resolve(state.handsAniItems);
    if (state.handsAniPromise) return state.handsAniPromise;
    const listSource = source.split(/[?#]/, 1)[0].toLocaleLowerCase().endsWith('.js');
    const current = () => !cassetteMediaScope.signal.aborted
      && state.handsAniSource === source && state.handsAniPromise === loading;
    const loading = (listSource
      ? vcardMedia.loadList(source).then(
        (items) => items.map((item) => vcardMedia.listItemUrl(source, item))
      )
      : Promise.resolve([source]))
      .then((items) => {
        if (!current()) return [];
        state.handsAniItems = items;
        return state.handsAniItems;
      })
      .catch((error) => {
        if (!current() || error?.name === 'AbortError') return [];
        console.warn('VCard portal: cannot load HandsAni media; using CrossImg', error);
        state.handsAniItems = [];
        return state.handsAniItems;
      })
      .finally(() => {
        if (state.handsAniPromise === loading) state.handsAniPromise = null;
      });
    state.handsAniPromise = loading;
    return loading;
  };

  const handsAniStats = (items = state.handsAniItems || []) => {
    const source = state.lastHandsAniSource || '';
    const index = source ? items.indexOf(source) : -1;
    const path = String(source).split(/[?#]/, 1)[0];
    let name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1) || '-';
    try { name = decodeURIComponent(name); } catch (_error) { }
    return {
      name,
      current: index >= 0 ? index + 1 : 0,
      total: items.length,
    };
  };

  const publishHandsAniState = (items = state.handsAniItems || []) => {
    if (cassetteMediaScope.signal.aborted) return;
    document.dispatchEvent(new CustomEvent('vcard:handsani-state', {
      detail: handsAniStats(items),
    }));
  };

  const adjacentHandsAniSource = (items, direction) => {
    if (!items.length) return '';
    const current = items.indexOf(state.lastHandsAniSource);
    const start = current >= 0 ? current : (direction < 0 ? 0 : -1);
    const index = (start + direction + items.length) % items.length;
    return items[index];
  };

  const stopHandsAniOverlay = (slot, status = 'failed') => {
    if (state.activeInsert !== slot) return;
    slot.overlayStatus = status;
    if (!slot.handsAniShown) delete slot.handsAniSource;
    releaseCrossVideo(status);
    if (state.activeInsert === slot) state.activeInsert = null;
    state.overlay = 'none';
    if (state.surface === 'scene') {
      const imageCurrent = state.scene?.current?.kind === 'image';
      setPhase(imageCurrent ? 'photo' : 'play');
      setControllerMode(imageCurrent ? 'photo' : 'cassette-playing');
    } else if (state.surface === 'photo') {
      setPhase('photo');
      setControllerMode('photo');
    } else if (['tape-still', 'tape-video'].includes(state.surface)) {
      setPhase('play');
    }
  };

  const finishHandsAniOverlay = () => {
    const slot = state.activeInsert;
    const video = state.crossVideo;
    if (!slot || !video || state.overlay !== 'handsani') {
      if (slot) stopHandsAniOverlay(slot);
      return;
    }
    const now = Number(sharedSongAudio.currentTime) || 0;
    if (now >= Number(slot.endsAt)) stopHandsAniOverlay(slot, 'completed');
  };

  const renderHandsAniOverlay = (now = Number(sharedSongAudio.currentTime) || 0) => {
    state.handsBegin?.();
    const slot = state.activeInsert;
    const video = state.crossVideo;
    if (!slot || !video || state.overlay !== 'handsani') return;
    const startsAt = Number(slot.startsAt) || 0;
    const peakAt = Number(slot.fadeOutStartsAt ?? slot.fadeStartsAt) || startsAt;
    const endsAt = Number(slot.endsAt) || peakAt;
    if (now >= endsAt) {
      stopHandsAniOverlay(slot, 'completed');
      return;
    }
    const target = Math.max(0, Math.min(1, Number(slot.opacity) || 0));
    const unfade = Math.max(0, Number(slot.unfade) || 0);
    const fade = Math.max(0, Number(slot.fade) || 0);
    let opacity = target;
    if (now < peakAt) {
      opacity = unfade > 0
        ? target * Math.max(0, Math.min(1, (now - startsAt) / unfade))
        : target;
    } else {
      opacity = fade > 0
        ? target * Math.max(0, Math.min(1, 1 - ((now - peakAt) / fade)))
        : 0;
    }
    video.style.opacity = String(opacity);
  };

  const startHandsAniInsert = (slot, onVisible = null) => {
    state.activeInsert = slot;
    slot.overlayStatus = 'preparing';
    if (!['scene', 'photo', 'tape-still', 'tape-video'].includes(state.surface)) {
      stopHandsAniOverlay(slot);
      return;
    }
    const generation = ++state.handsGeneration;
    const preparation = new AbortController();
    const life = window.VCLife;
    const playback = life?.playingSong?.playback;
    state.handsAbort?.abort();
    state.handsOperation?.cancel('overlay-replaced');
    const operation = playback && window.VCLifeCore?.TOperation
      ? new window.VCLifeCore.TOperation(playback, 'hands-publication') : null;
    state.handsAbort = preparation;
    state.handsOperation = operation;
    operation?.scope.signal.addEventListener('abort', () => {
      if (operation.status === 'Cancelled' && state.handsOperation === operation) {
        stopHandsAniOverlay(slot, 'cancelled');
      }
    }, { once: true });
    const current = () => !preparation.signal.aborted && !cassetteMediaScope.signal.aborted
      && generation === state.handsGeneration && state.activeInsert === slot;
    const postHands = (type, apply) => {
      const run = () => current() ? apply() : false;
      return life ? life.queue.post(run, { type, owner: playback, scope: playback?.scope }) : Promise.resolve(run());
    };
    const failHands = (error, kind = 'ComponentFailure', reservation = state.handsReservation) => {
      if (error?.name === 'AbortError') return Promise.resolve(false);
      return postHands('Operation.Fail', () => {
        reservation?.invalidate();
        operation?.fail(error);
        stopHandsAniOverlay(slot, 'failed');
        life?.reportFault(error, { type: 'Operation.Fail', owner: operation || playback }, kind);
        return false;
      });
    };
    preparation.signal.addEventListener('abort', () => {
      if (state.handsAbort === preparation) cancelHandsFrame();
      slot.handsFramePending = false;
    }, { once: true });
    slot.handsFramePending = false;
    loadHandsAniItems().then((items) => postHands('Overlay.Prepare', () => {
      if (
        preparation.signal.aborted || cassetteMediaScope.signal.aborted
        || generation !== state.handsGeneration
        || state.activeInsert !== slot
        || !ensurePortal(state.preview)
      ) return;
      if (!items.length) {
        stopHandsAniOverlay(slot);
        return;
      }
      const reservation = slot.handsAniSource ? null
        : window.VCPlayer.reserveHands(state.handsAniSource, items, slot.decisionOrigin);
      const source = slot.handsAniSource || reservation?.item;
      if (!source) {
        stopHandsAniOverlay(slot, 'unavailable');
        return;
      }
      state.handsReservation = reservation;
      slot.handsAniSource = source;
      const video = portalCrossVideo();
      video.dataset.overlayStartsAt = String(slot.startsAt);
      video.dataset.overlayEndsAt = String(slot.endsAt);
      if (video.parentElement !== state.frame) {
        state.frame.insertBefore(video, state.controls || null);
      }
      video.preload = 'auto';
      setVideoSource(video, source);
      const requestedOpacity = Number(slot.opacity);
      const targetOpacity = Number.isFinite(requestedOpacity)
        ? Math.max(0, Math.min(1, requestedOpacity))
        : 0.5;
      video.style.setProperty('--vc-handsani-opacity', String(targetOpacity));
      video.style.transitionDuration = '0s';
      const begin = () => {
        if (
          preparation.signal.aborted || cassetteMediaScope.signal.aborted
          || generation !== state.handsGeneration
          || state.activeInsert !== slot
          || !['scene', 'photo', 'tape-still', 'tape-video'].includes(state.surface)
          || state.crossVideo !== video
        ) return;
        const now = Number(sharedSongAudio.currentTime) || 0;
        if (now >= slot.endsAt) {
          stopHandsAniOverlay(slot, 'missed');
          return;
        }
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !slot.handsFramePending) {
          if (slot.overlayStatus !== 'ready') {
            postHands('Overlay.Ready', () => {
              slot.overlayStatus = 'ready';
              life?.publish();
            });
          }
        }
        if (now < slot.startsAt || slot.handsFramePending
          || window.VCLife?.renderingActive === false
          || !portalMotionAllowed || sharedSongAudio.paused || state.playback === 'waiting'
          || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
        const duration = Number(video.duration);
        if (!Number.isFinite(duration) || duration <= 0) {
          reservation?.invalidate();
          stopHandsAniOverlay(slot);
          return;
        }
        try {
          const handsAniStart = Number.isFinite(slot.handsAniStart)
            ? slot.handsAniStart
            : window.VCPlayer.handsStart(source, duration,
              slot.duration * vcardAnimationPlaybackRate, vcardMagicTimeSeconds);
          slot.handsAniStart = handsAniStart;
          const elapsed = Math.max(0, now - (Number(slot.startsAt) || 0));
          const offset = Number.isFinite(slot.videoTime)
            ? slot.videoTime
            : handsAniStart + elapsed * vcardAnimationPlaybackRate;
          video.currentTime = Math.min(Math.max(0, offset), Math.max(0, duration - 0.05));
        } catch (_error) { }
        slot.handsFramePending = true;
        const isCurrent = () => generation === state.handsGeneration
          && state.activeInsert === slot && state.crossVideo === video && !preparation.signal.aborted;
        const canShow = () => isCurrent() && window.VCLife?.renderingActive !== false
          && portalMotionAllowed && !sharedSongAudio.paused && !sharedSongAudio.ended
          && !['waiting', 'failed'].includes(state.playback);
        const commit = () => {
          slot.handsFramePending = false;
          if (!canShow()) return false;
          const shownAt = Number(sharedSongAudio.currentTime) || 0;
          if (shownAt >= slot.endsAt) { stopHandsAniOverlay(slot, 'missed'); return false; }
          if (reservation && !reservation.commit()) { stopHandsAniOverlay(slot); return false; }
          if (state.surface === 'photo' || state.surface === 'scene') setPortalStatic(false);
          state.overlay = 'handsani';
          if (state.surface === 'photo' || state.surface === 'scene') {
            setPhase('overlay');
            setControllerMode('photo-handsani');
          }
          video.classList.add('is-visible');
          slot.handsAniShown = true;
          slot.overlayStatus = 'active';
          operation?.complete({ source, cueId: slot.id ?? null, shownAt });
          if (state.handsOperation === operation) state.handsOperation = null;
          onVisible?.();
          state.handsReservation = null;
          state.handsBegin = null;
          state.lastHandsAniSource = source;
          publishHandsAniState(items);
          renderHandsAniOverlay(shownAt);
          window.VCLife?.publish();
          return true;
        };
        const firstFrame = () => {
          if (!isCurrent()) return;
          state.handsFrameCallback = 0;
          if (!canShow()) { slot.handsFramePending = false; return; }
          if (video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            waitForFrame();
            return;
          }
          const life = window.VCLife;
          if (life) life.queue.post(commit, { type: 'Overlay.Commit',
            owner: life.playingSong?.playback, scope: life.playingSong?.playback?.scope });
          else commit();
        };
        const waitForFrame = () => {
          state.handsFrameNative = typeof video.requestVideoFrameCallback === 'function';
          state.handsFrameCallback = state.handsFrameNative
            ? video.requestVideoFrameCallback(firstFrame)
            : vcardRenderScheduler.request(firstFrame, { owner: video, scope: preparation, priority: 0,
              isCurrent: canShow, onCancel: () => {
                if (isCurrent()) { state.handsFrameCallback = 0; slot.handsFramePending = false; }
              } });
        };
        video.style.opacity = '0';
        waitForFrame();
        playPortalAnimation(video);
      };
      video.addEventListener('error', () => {
        if (
          generation === state.handsGeneration
          && state.activeInsert === slot
          && state.crossVideo === video
        ) {
          failHands(video.error || new Error('HandsAni media failed'), 'ResourceFailure', reservation);
        }
      }, { once: true, signal: preparation.signal });
      state.handsBegin = begin;
      vcardMedia.prepareVideo(video, {
        signal: preparation.signal, readyState: HTMLMediaElement.HAVE_CURRENT_DATA,
      }).then(() => postHands('Operation.Complete', begin)).catch((error) => {
        if (error?.name === 'AbortError' || generation !== state.handsGeneration
          || state.activeInsert !== slot) return;
        return failHands(error, 'ResourceFailure', reservation);
      });
    })).catch((error) => {
      if (preparation.signal.aborted || cassetteMediaScope.signal.aborted
        || error?.name === 'AbortError' || generation !== state.handsGeneration || state.activeInsert !== slot) return;
      return failHands(error);
    });
  };

  const showOverlay = (cue, onVisible = null) => {
    if (
      !cue
      || window.VCLife?.renderingActive === false
      || cue.name !== 'HandsAni'
      || !portalMotionAllowed
      || state.endSequenceStarted
      || sharedSongAudio.paused
      || sharedSongAudio.ended
      || (state.activeInsert && state.activeInsert !== cue)
    ) return false;
    if (state.activeInsert === cue) { state.handsBegin?.(); return true; }
    startHandsAniInsert(cue, onVisible);
    return true;
  };

  const cancelOverlay = (cue = state.activeInsert, status = 'cancelled') => {
    if (!cue || state.activeInsert !== cue) return false;
    stopHandsAniOverlay(cue, status);
    return true;
  };

  const startManualHandsAni = (startsAt, source = '') => {
    if (cassetteMediaScope.signal.aborted || !portalMotionAllowed || state.endSequenceStarted
      || sharedSongAudio.paused || sharedSongAudio.ended || state.playback === 'failed') return;
    if (state.activeInsert?.overlayStatus === 'active') return;
    if (state.activeInsert) stopHandsAniOverlay(state.activeInsert, 'superseded-manual');
    const slot = {
      ...makeInsertSlot(startsAt),
      kind: 'handsani',
      manual: true,
    };
    if (source) slot.handsAniSource = source;
    startHandsAniInsert(slot);
  };

  const onPortalMiddlePress = (event) => {
    if (event.button === 0 && !window.VCardPortalLayout?.isFullscreen(state.image)) {
      // Keep pointer focus from scrolling the portal's Play button into view.
      event.preventDefault();
      return;
    }
    if (event.button !== 1) return;
    if (!['play', 'photo', 'overlay'].includes(state.phase)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!state.preview || sharedSongAudio.paused || sharedSongAudio.ended) return;
    // Middle click is an explicit HandsAni preview, independent from the
    // active VerseChain, so it is useful for checking the overlay treatment.
    startManualHandsAni(Number(sharedSongAudio.currentTime) || 0);
  };

  document.addEventListener('vcard:debug-handsani', (event) => {
    const preview = event.detail?.preview;
    if (
      document.documentElement.dataset.debug !== 'on'
      || !preview
      || preview !== state.preview
      || sharedSongAudio.paused
      || sharedSongAudio.ended
    ) return;
    const direction = Number(event.detail?.direction) || 0;
    if (!direction) {
      startManualHandsAni(Number(sharedSongAudio.currentTime) || 0);
      return;
    }
    const generation = state.generation;
    loadHandsAniItems().then((items) => {
      if (!items.length || cassetteMediaScope.signal.aborted
        || generation !== state.generation || preview !== state.preview) return;
      const source = adjacentHandsAniSource(items, direction);
      startManualHandsAni(Number(sharedSongAudio.currentTime) || 0, source);
    });
  }, { signal: cassetteMediaScope.signal });

  const makeInsertSlot = (startsAt, timing = { lead: 2, unfade: 2, fade: 2 }) => {
    const visibleTime = Math.max(0, Number(timing.lead) || 0);
    const fadeTime = Math.max(0, Number(timing.fade) || 0);
    const fadeStartsAt = startsAt + visibleTime;
    const endsAt = fadeStartsAt + fadeTime;
    return {
      startsAt,
      duration: endsAt - startsAt,
      fadeStartsAt,
      endsAt,
      unfade: Math.max(0, Number(timing.unfade) || 0),
      fade: fadeTime,
      opacity: Number.isFinite(Number(timing?.opacity))
        ? Math.max(0, Math.min(1, Number(timing.opacity)))
        : 0.5,
    };
  };

  const update = ({ seeked = false } = {}) => {
    if (!state.preview || state.preview.hidden) return;
    const now = Number(sharedSongAudio.currentTime) || 0;
    if (sharedSongAudio.ended) return;
    if (seeked) {
      const image = state.preview?.querySelector('.song__preview-image');
      if (image) vcardMedia.clearPreload(image);
      state.generation += 1;
      if (state.activeInsert && !state.activeInsert.manual) {
        releaseCrossVideo();
        state.activeInsert = null;
        state.overlay = 'none';
        if (state.surface === 'photo' || state.surface === 'scene') {
          const imageCurrent = state.surface === 'photo'
            || state.scene?.current?.kind === 'image';
          setPhase(imageCurrent ? 'photo' : 'play');
          setControllerMode(imageCurrent ? 'photo' : 'cassette-playing');
        }
      }
      return;
    }
    if (state.overlay === 'handsani') {
      renderHandsAniOverlay(now);
      if (
        !state.activeInsert
        || now >= (state.activeInsert.fadeOutStartsAt ?? state.activeInsert.fadeStartsAt)
      ) finishHandsAniOverlay();
      else return;
    }
  };

  const parkPhotoSurface = () => {
    if (!state.layer || !state.frame) return;
    if (state.image) vcardMedia.setActive(state.image, false);
    state.layer.style.visibility = 'hidden';
    if (state.layer.parentElement !== state.frame) {
      state.frame.insertBefore(state.layer, state.controls || null);
    }
  };

  const selectTrack = (preview, keepImage = false) => {
    if (preview !== state.preview) {
      // The motion layer owns the canonical preview image. Keep it parked in
      // its card so reopening the song can discover and reuse that image.
      parkPhotoSurface();
      state.tapeStill?.remove();
      state.tapeVideo?.remove();
      releaseCrossVideo();
      releaseSurfaceFade();
      releaseSurfaceUnfades();
      state.surface = 'none';
    }
    state.scene?.destroy();
    state.scene = null;
    if (!ensurePortal(preview, keepImage)) return;
    cancelPortalClick();
    pausePortalAnimation(state.tapeVideo);
    releaseCrossVideo();
    releaseSurfaceFade();
    releaseSurfaceUnfades();
    if (state.frame) delete state.frame.dataset.playbackPaused;
    state.generation += 1;
    state.verseRunGeneration += 1;
    finishPendingPhoto(false);
    state.pendingPhotoGeneration = 0;
    state.pendingPhotoFade = null;
    state.started = false;
    state.activeInsert = null;
    state.firstVerseActivated = false;
    state.endSequenceStarted = false;
    state.seeking = false;
    state.tapeStill?.remove();
    state.tapeVideo?.remove();
    state.surface = 'none';
    vcardMedia.setActive(state.image, false);
    vcardMedia.clearPreload(state.image);
    if (state.layer) state.layer.style.visibility = keepImage ? 'visible' : 'hidden';
    setPlaybackState('idle');
    setControllerMode('closed');
    // Keep the inactive compositor connected until TrackOpen atomically
    // selects its surface. Detaching the layer here also detaches the source
    // image, so a following Cassette command can no longer resolve the frame.
    setPhase('start');
  };

  // Every song shares this fixed cassette URL; warming joins normal slot loads.
  loadFinishMedia();

  const open = (preview, { keepImage = false } = {}) => {
    selectTrack(preview, keepImage);
    const image = portalImage(preview);
    if (image) vcardMedia.setPortalFrame(image, vcardPortalPlan.frame(preview));
    state.started = false;
    setPlaybackState('idle');
    return Boolean(state.preview);
  };

  const openIdle = (preview, directive = null) => {
    const image = preview?.querySelector('.song__preview-image');
    const frame = image?.closest('.song-vibeframe');
    if (!frame) return false;
    const layer = image.closest('.vcard-portal-motion-layer');
    if (layer) layer.style.display = directive ? '' : 'none';
    vcardMedia.setActive(image, false);
    let still = frame.querySelector(':scope > .song-portal-idle-still');
    if (directive) {
      still?.remove();
      if (layer) layer.style.visibility = 'visible';
      vcardMedia.setPortalFrame(image, vcardPortalPlan.frameFor(directive));
      vcardMedia.setActive(image, true);
    } else if (!still) {
      still = document.createElement('img');
      still.className = 'song-portal-tape-still song-portal-idle-still';
      still.alt = '';
      still.setAttribute('aria-hidden', 'true');
      still.src = mediaUrl(CASSETTE_POSTER_FILE);
      frame.append(still);
    }
    if (!frame.querySelector(':scope > .song-portal-idle-action')) {
      const action = portalAction().cloneNode(true);
      action.classList.add('song-portal-idle-action', 'is-visible');
      action.classList.remove('is-playing', 'is-finished');
      action.disabled = false;
      projectPortalButton(action, portalActionFor(preview));
      frame.append(action);
    }
    return true;
  };

  const closeIdle = (preview) => {
    const image = preview?.querySelector('.song__preview-image');
    const frame = image?.closest('.song-vibeframe');
    frame?.querySelector(':scope > .song-portal-idle-still')?.remove();
    frame?.querySelector(':scope > .song-portal-idle-action')?.remove();
    if (image) vcardMedia.setActive(image, false);
    const layer = image?.closest('.vcard-portal-motion-layer');
    if (layer) layer.style.removeProperty('display');
  };

  const showCassette = ({
    phase = 'start', motion = 'static', fade = null, unfade = fade,
  } = {}) => {
    if (!state.preview || !state.scene) return;
    const requestedFade = Number(fade);
    const requestedUnfade = Number(unfade);
    const timing = phase === 'finish' && motion === 'animated' ? {
      fade: Number.isFinite(requestedFade)
        ? Math.max(0, requestedFade)
        : portalNumber('FinishFade', 0),
      unfade: Number.isFinite(requestedUnfade)
        ? Math.max(0, requestedUnfade)
        : portalNumber('FinishFade', 0),
    } : { fade: 0, unfade: 0 };
    if (phase === 'finish') {
      state.endSequenceStarted = true;
      state.started = false;
      if (state.controls) state.controls.dataset.ending = motion === 'static' ? 'hold' : 'cassette';
    }
    setPhase(phase);
    state.surface = 'scene';
    state.verseSlotKind = 'cassette';
    const scene = state.scene;
    const preview = state.preview;
    const generation = state.generation;
    scene.showCassette({
      animated: motion === 'animated',
      reset: phase === 'start' || phase === 'finish',
      phase,
      timing,
    }).then((shown) => {
      if (!shown || state.scene !== scene || state.preview !== preview
        || state.generation !== generation || cassetteMediaScope.signal.aborted) return;
      setPortalStatic(true);
      setControllerMode(
        phase === 'finish'
          ? (motion === 'animated' ? 'cassette-finish-playing' : 'cassette-finish-static')
          : (motion === 'animated' ? 'cassette-playing' : 'cassette-static')
      );
    });
  };

  const beginPortalRun = (preview) => {
    const ready = vcardPortalPlan.beginPlayback(
      preview,
      Number(sharedSongAudio.currentTime) || 0
    );
    const image = portalImage(preview);
    if (image && ready) vcardMedia.setPortalFrame(
      image,
      vcardPortalPlan.frame(preview)
    );
    loadHandsAniItems().then(publishHandsAniState);
  };

  const verseFrameTiming = (plan = {}) => {
    const effect = (plan.effects || []).find((item) => item?.name === 'CrossImg');
    return {
      fade: Math.max(0, Number(effect?.fade) || 0),
      unfade: Math.max(0, Number(effect?.unfade) || 0),
    };
  };

  const applyVerseAppearance = (image, plan, frame, maskStartsAtMinimum = false) => {
    const layer = image?.closest('.vcard-portal-motion-layer');
    const mask = layer?.querySelector(':scope > .vcard-portal-mask-overlay.is-ready');
    if (mask) {
      mask.style.setProperty(
        '--vc-pulse-mask-opacity',
        maskStartsAtMinimum ? '0' : '1'
      );
      mask.style.setProperty('--vc-pulse-mask-brightness', '1');
    }
    const frameGlow = Math.max(0, Math.min(10, Number(frame?.glow) || 0));
    const displayStartsAt = Number(plan.displayStartsAt ?? plan.startsAt);
    const displayEndsAt = Number(plan.displayEndsAt ?? plan.endsAt);
    const pulseDuration = Number.isFinite(displayStartsAt)
      && Number.isFinite(displayEndsAt)
      && displayEndsAt > displayStartsAt
      ? displayEndsAt - displayStartsAt
      : 0;
    const pulseElapsed = pulseDuration > 0
      ? Math.max(0, Math.min(
        pulseDuration,
        (Number(sharedSongAudio.currentTime) || 0) - displayStartsAt
      ))
      : 0;
    const sceneManaged = Boolean(image.closest('.song-portal-scene-slot'));
    vcardMedia.setPortalImageGlow(image, frameGlow, sceneManaged
      ? 0
      : (frame?.glowPulse ? {
        pulse: true,
        pulses: frame.glowPulses,
        duration: pulseDuration,
        elapsed: pulseElapsed,
      } : verseFrameTiming(plan).unfade));
  };

  const selectPlaybackShow = (preview, options) => {
    if (!ensurePortal(preview)) return Promise.resolve(null);
    const request = { preview, promise: null };
    state.showRequest = request;
    request.promise = vcardMedia.selectPlaybackShow(portalImage(preview), {
      ...options,
      isCurrent: () => options.isCurrent() && state.showRequest === request,
    }).catch((error) => {
      if (options.isCurrent() && state.showRequest === request
        && error?.name !== 'AbortError') {
        console.warn('VCard PortalTV: show preparation failed', error);
      }
      return null;
    });
    return request.promise;
  };

  const prepareIdleShow = (preview, options) => vcardMedia.selectPlaybackShow(
    preview?.querySelector('.song__preview-image'), options
  );

  const prepareVerseDisplay = async ({ kind = 'image', plan = {} } = {}, signal = null) => {
    const preview = plan.preview || null;
    if (
      signal?.aborted
      || !preview
      || preview !== state.preview
      || !ensurePortal(preview)
      || !state.scene
    ) return null;
    const scene = state.scene;
    const image = portalImage(preview);
    const request = state.showRequest;
    const initialized = kind !== 'image'
      || (request?.preview === preview
        ? Boolean(await request.promise)
        : await vcardMedia.initializePortalImage?.(image));
    if (
      signal?.aborted
      || !initialized
      || preview !== state.preview
      || state.scene !== scene
    ) return null;
    vcardPortalPlan.setVersePlan(plan);
    return scene.prepare(kind, plan, signal);
  };

  const showVerseDisplay = async (resource, timing = {}, signal = null, publication = null) => {
    if (!resource || signal?.aborted || !state.scene
      || resource.slot?.scene !== state.scene) return false;
    // The intro cassette keeps the portal in its static state.  Enable photo
    // motion before the incoming image starts fading in, so its initial
    // breathe scale is already applied while it is still invisible.  Doing
    // this after scene.show() makes the fully visible first frame jump from
    // scale(1) to the first breathe keyframe.
    if (resource.kind === 'image') setPortalStatic(false);
    return state.scene.show(resource, timing, signal, 'audio', (commitSurface) => {
      const commit = () => {
        if (!commitSurface()) return false;
        state.surface = 'scene';
        state.verseSlotKind = resource.kind;
        state.firstVerseActivated = Number.isInteger(resource.plan?.index)
          && resource.plan.index >= 0;
        setPortalStatic(false);
        setPhase(resource.kind === 'image'
          ? (state.overlay === 'handsani' ? 'overlay' : 'photo')
          : 'play');
        setControllerMode(resource.kind === 'image' ? 'photo' : 'cassette-playing');
        return true;
      };
      return publication ? publication(commit) : commit();
    });
  };

  const cancelVerseDisplay = (resource = null) => {
    if (resource) resource.slot?.scene?.cancel(resource);
    else state.scene?.cancel(state.scene.reserved);
  };

  const cancelVerseFrame = () => {
    state.verseRunGeneration += 1;
    if (state.scene?.transition) state.scene.cancel(state.scene.transition.resource);
    if (state.scene?.reserved) state.scene.cancel(state.scene.reserved);
    const image = portalImage();
    if (image) vcardMedia.clearPreload(image);
  };

  const start = (preview) => {
    if (!preview || preview !== state.preview) open(preview);
    beginPortalRun(preview);
    state.endSequenceStarted = false;
    state.started = true;
    state.firstVerseActivated = false;
    state.verseSlotKind = '';
    setPlaybackState('starting');
  };

  const finishAnimated = (timing = 0) => {
    if (!state.preview) return;
    const fade = typeof timing === 'object' ? Number(timing.fade) || 0 : Number(timing) || 0;
    const unfade = typeof timing === 'object' ? Number(timing.unfade) || 0 : fade;
    state.activeInsert = null;
    state.endSequenceStarted = true;
    state.firstVerseActivated = false;
    state.started = false;
    showCassette({
      phase: 'finish',
      motion: 'animated',
      fade,
      unfade,
    });
  };

  const finishStatic = () => {
    if (!state.preview) return;
    if (state.controls) state.controls.dataset.ending = 'hold';
    const scene = state.scene;
    const preview = state.preview;
    const generation = state.generation;
    scene?.showCassette({ animated: false, phase: 'finish' }).then((shown) => {
      if (shown && state.scene === scene && state.preview === preview
        && state.generation === generation && !cassetteMediaScope.signal.aborted) {
        setControllerMode('cassette-finish-static');
      }
    });
  };


  const setMotionAllowed = (allowed) => {
    const nextAllowed = Boolean(allowed);
    if (nextAllowed === portalMotionAllowed) return;
    portalMotionAllowed = nextAllowed;
    if (!portalMotionAllowed) {
      state.scene?.pause();
      state.scene?.finishMotion();
      releaseSurfaceFade();
      releaseSurfaceUnfades();
      if (state.surface === 'tape-video') {
        pausePortalAnimation(state.tapeVideo);
        activateSurface('tape-still');
      }
      if (state.activeInsert) stopHandsAniOverlay(state.activeInsert, 'skipped-motion');
      return;
    }
    if (state.playback !== 'failed') state.scene?.resume();
    if (state.overlay === 'handsani' && !sharedSongAudio.paused && !sharedSongAudio.ended) {
      playPortalAnimation(state.crossVideo);
    }
  };

  const close = (preview = state.preview) => {
    if (preview !== state.preview) return;
    cancelPortalClick();
    releaseCrossVideo();
    state.activeInsert = null;
    state.generation += 1;
    state.verseRunGeneration += 1;
    finishPendingPhoto(false);
    state.pendingPhotoGeneration = 0;
    [state.tapeVideo, state.crossVideo].forEach((video) => {
      if (!video) return;
      pausePortalAnimation(video);
      video.removeAttribute('src');
      video.load();
      video.remove();
    });
    state.crossVideo = null;
    state.overlay = 'none';
    releaseSurfaceFade();
    releaseSurfaceUnfades();
    state.scene?.destroy();
    state.scene = null;
    parkPhotoSurface();
    state.tapeStill?.remove();
    state.tapeVideo?.remove();
    state.tapeStill = null;
    state.tapeVideo = null;
    state.surface = 'none';
    state.verseSlotKind = '';
    setPlaybackState('idle');
    setControllerMode('closed');
    state.preview = null;
    state.frame = null;
    state.layer = null;
    state.image = null;
  };

  cassetteMediaScope.signal.addEventListener('abort', () => {
    close(state.preview);
  }, { once: true });

  const resume = () => {
    if (!state.preview) return;
    setPlaybackState('starting');
    if (state.frame) delete state.frame.dataset.playbackPaused;
    const image = portalImage();
    if (image) vcardMedia.resume(image);
    state.scene?.resume();
    state.surfaceUnfades.forEach((animation) => animation.play());
    if (
      portalMotionAllowed
      && (!state.firstVerseActivated || state.verseSlotKind === 'cassette')
      && state.mode === 'cassette-static'
    ) {
      state.scene?.current?.setCassetteMotion(true);
      setControllerMode('cassette-playing');
    }
    if (portalMotionAllowed && state.overlay === 'handsani') {
      playPortalAnimation(state.crossVideo, { allowPausedPlayback: true });
    }
    if (portalMotionAllowed && state.surface === 'tape-video') {
      playPortalAnimation(state.tapeVideo, { allowPausedPlayback: true });
    }
    setPhase(state.phase);
    update();
  };
  const setGlowPlayback = (running) => {
    const glow = state.layer?.querySelector(':scope > .vcard-portal-image-glow');
    glow?.getAnimations().forEach((animation) => {
      if (running) {
        if (animation.playState === 'paused') animation.play();
      } else {
        animation.pause();
      }
    });
  };
  const playing = () => {
    if (!state.preview) return;
    setPlaybackState('playing');
    setGlowPlayback(true);
    state.scene?.resume();
    if (portalMotionAllowed && state.overlay === 'handsani') {
      playPortalAnimation(state.crossVideo);
    }
    state.surfaceUnfades.forEach((animation) => animation.play());
    const image = portalImage();
    if (image) vcardMedia.resume(image);
    state.handsBegin?.();
  };
  const waiting = () => {
    if (!state.preview || sharedSongAudio.paused) return;
    cancelHandsFrame();
    setGlowPlayback(false);
    state.scene?.pause();
    pausePortalAnimation(state.tapeVideo);
    pausePortalAnimation(state.crossVideo);
    state.surfaceUnfades.forEach((animation) => animation.pause());
    const image = portalImage();
    if (image) vcardMedia.freeze(image);
    setPlaybackState('waiting');
  };
  const failed = () => {
    if (!state.preview) return;
    setPlaybackState('failed');
    cancelVerseFrame();
    if (state.activeInsert) stopHandsAniOverlay(state.activeInsert, 'playback-failed');
    setRenderingActive(false);
    setPortalStatic(true);
  };
  const finishCurrent = () => {
    setRenderingActive(false);
    setPortalStatic(true);
  };
  const pause = () => {
    if (!state.preview || sharedSongAudio.ended) return;
    cancelHandsFrame();
    // Pause freezes the current exclusive surface. It does not invalidate the
    // verse plan, choose another frame, or recreate any portal media.
    pausePortalAnimation(state.tapeVideo);
    state.scene?.pause();
    pausePortalAnimation(state.crossVideo);
    state.surfaceUnfades.forEach((animation) => animation.pause());
    if (state.frame) state.frame.dataset.playbackPaused = 'on';
    const image = portalImage();
    if (image) vcardMedia.freeze(image);
    setPlaybackState('paused');
  };
  const tick = () => update();
  const setRenderingActive = (active) => {
    const renderActive = active && state.playback !== 'failed';
    const running = renderActive && !sharedSongAudio.paused && !sharedSongAudio.ended;
    const image = portalImage();
    if (!renderActive && state.scene?.frameHandle) {
      vcardRenderScheduler.cancel(state.scene.frameHandle);
      state.scene.frameHandle = 0;
    } else if (renderActive && state.scene && !state.scene.frameHandle) {
      state.scene.frameHandle = vcardRenderScheduler.request(state.scene.tick, { owner: state.scene });
    }
    if (!running) {
      cancelHandsFrame();
      pausePortalAnimation(state.tapeVideo);
      pausePortalAnimation(state.crossVideo);
      state.scene?.pause();
      state.surfaceUnfades.forEach((animation) => animation.pause());
      if (image) vcardMedia.freeze(image);
    } else {
      state.scene?.resume();
      state.surfaceUnfades.forEach((animation) => animation.play());
      if (image) vcardMedia.resume(image);
      if (state.surface === 'tape-video') playPortalAnimation(state.tapeVideo);
    }
    setGlowPlayback(running);
  };
  const seek = () => {
    if (!state.preview) return;
    state.seeking = true;
  };
  const seeked = () => {
    state.seeking = false;
    update({ seeked: true });
  };
  const ended = () => {
    if (!state.preview) return;
    // The playback controller owns the complete ending timeline.
    state.started = false;
    setPlaybackState('ended');
  };

  const beforeFirstVerse = (isPlaying) => {
    state.firstVerseActivated = false;
    state.verseSlotKind = '';
    state.activeInsert = null;
    showCassette({
      motion: isPlaying ? 'animated' : 'static',
      phase: isPlaying ? 'play' : 'start',
    });
  };

  const holdSongPreview = () => {
    const image = portalImage();
    if (!image || !state.layer) return;
    vcardMedia.setPortalFrame(image, vcardPortalPlan.frameFor({
      styles: ['vc', 's_alarm'], mask: 'off', pick: 'keep', keepPhysicalIndex: true,
    }));
    state.layer.style.visibility = 'visible';
    state.surface = 'photo';
    setPortalStatic(true);
    setPhase('photo');
    setControllerMode('photo');
    vcardMedia.setActive(image, true);
  };

  const portalSnapshot = () => Object.freeze({
    state: state.mode,
    surface: state.scene?.current?.kind || state.surface,
    mainTrack: {
      current: state.scene?.current?.kind || '',
      incoming: state.scene?.transition?.incoming?.kind || '',
      reserved: state.scene?.reserved?.kind || '',
      transitioning: Boolean(state.scene?.transition),
    },
    playback: state.playback,
    overlay: state.overlay,
    media: vcardMedia.resourceSnapshot(),
    renderScheduler: vcardRenderScheduler.snapshot(),
    playbackChain: { ...state.chain },
  });
  return Object.freeze({
    beforeFirstVerse,
    holdSongPreview,
    canTogglePlayback: portalPlaybackAvailable,
    togglePlayback: togglePortalPlayback,
    close,
    closeIdle,
    current: portalSnapshot,
    publishedFrame: (preview) => {
      if (preview !== state.preview) return null;
      const slot = state.scene?.current;
      if (!slot) return null;
      const media = slot.kind === 'image' ? vcardMedia.mediaStates.get(slot.photoImage) : null;
      const group = media?.groups[media.index];
      const source = group?.base || group?.source;
      return { kind: slot.kind, fallback: slot.plan?.showFallback || 'none', source: source
        ? new URL(source, new URL(media.listUrl || window.location.href, window.location.href)).href : null };
    },
    ended,
    failed,
    finishCurrent,
    finishAnimated,
    finishStatic,
    imageFor: portalImage,
    open,
    openIdle,
    pause,
    playing,
    prepareOverlay: showOverlay,
    showOverlay,
    cancelOverlay,
    prepareVerseDisplay,
    hasVerseImages: (plan) => vcardMedia.hasPortalFrames(
      portalImage(plan.preview), vcardPortalPlan.frameFor(plan.portalFrame)
    ),
    selectPlaybackShow,
    prepareIdleShow,
    resume,
    seek,
    seeked,
    showCassette,
    setMotionAllowed,
    setRenderingActive,
    start,
    tick,
    waiting,
    showVerseDisplay,
    cancelVerseDisplay,
    cancelVerseFrame,
  });

})();
if (portalController) {
  window.VCardPortal = Object.freeze({
    beforeFirstVerse: portalController.beforeFirstVerse,
    holdSongPreview: portalController.holdSongPreview,
    canTogglePlayback: portalController.canTogglePlayback,
    togglePlayback: portalController.togglePlayback,
    close: portalController.close,
    closeIdle: portalController.closeIdle,
    current: portalController.current,
    imageFor: portalController.imageFor,
    ended: portalController.ended,
    failed: portalController.failed,
    finishAnimated: portalController.finishAnimated,
    finishStatic: portalController.finishStatic,
    open: portalController.open,
    openIdle: portalController.openIdle,
    pause: portalController.pause,
    playing: portalController.playing,
    prepareOverlay: portalController.prepareOverlay,
    showOverlay: portalController.showOverlay,
    cancelOverlay: portalController.cancelOverlay,
    prepareVerseDisplay: portalController.prepareVerseDisplay,
    hasVerseImages: portalController.hasVerseImages,
    selectPlaybackShow: portalController.selectPlaybackShow,
    prepareIdleShow: portalController.prepareIdleShow,
    selectionSnapshot: (preview) => {
      const image = portalController.imageFor(preview);
      const frame = vcardMedia.mediaStates.get(image)?.frameBag;
      const show = image?.vcardShowBag;
      const snapshot = (bag) => bag ? { total: bag.items.length, remaining: bag.remaining.length,
        reserved: Boolean(bag.reservation), last: bag.last } : null;
      return { frame: snapshot(frame), show: snapshot(show), published: portalController.publishedFrame(preview) };
    },
    resume: portalController.resume,
    seek: portalController.seek,
    seeked: portalController.seeked,
    showCassette: portalController.showCassette,
    finishCurrent: portalController.finishCurrent,
    setMotionAllowed: portalController.setMotionAllowed,
    setRenderingActive: portalController.setRenderingActive,
    start: portalController.start,
    tick: portalController.tick,
    waiting: portalController.waiting,
    showVerseDisplay: portalController.showVerseDisplay,
    cancelVerseDisplay: portalController.cancelVerseDisplay,
    cancelVerseFrame: portalController.cancelVerseFrame,
  });
}

class TBackgroundBrightness {
  static LEVEL_COUNT = 6;

  constructor(scope, defaultLevel, mode) {
    this.scope = scope;
    this.mode = mode;
    this.storageKey = 'vcard-visualization-brightness';
    const stored = Number.parseInt(vcardStorage.local.getItem(this.storageKey), 10);
    this.level = Number.isInteger(stored) && stored >= 0 && stored < TBackgroundBrightness.LEVEL_COUNT
      ? stored : defaultLevel;
    const { signal } = scope;
    document.addEventListener('vcard:toggle-visualization-brightness', () => this.set(this.level + 1), { signal });
    document.addEventListener('vcard:step-visualization-brightness', (event) => {
      const delta = Number(event.detail?.delta);
      if (Number.isInteger(delta) && delta !== 0) this.set(this.level + delta);
    }, { signal });
    document.addEventListener('vcard:set-visualization-brightness', (event) => {
      const level = Number(event.detail?.level);
      if (Number.isInteger(level) && level >= 0 && level < TBackgroundBrightness.LEVEL_COUNT) this.set(level);
    }, { signal });
    document.addEventListener('vcard:request-visualization-state', () => this.publish(), { signal });
  }

  set(level) {
    if (this.scope.signal.aborted) return;
    const next = Math.max(0, Math.min(TBackgroundBrightness.LEVEL_COUNT - 1, level));
    if (next === this.level) return;
    this.level = next;
    vcardStorage.local.setItem(this.storageKey, String(next));
    this.publish();
  }

  publish() {
    if (this.scope.signal.aborted) return;
    document.documentElement.dataset.visBri = String(this.level);
    document.dispatchEvent(new CustomEvent('vcard:visualization-state', {
      detail: { mode: this.mode(), brightnessLevel: this.level },
    }));
  }
}

(() => {
  const STORAGE_KEY = 'vcard-visualization';
  const visualizationScope = new AbortController();
  const { signal } = visualizationScope;
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) visualizationScope.abort();
  }, { signal });
  const VOLUME_BOOST_STORAGE_KEY = 'vcard-volume-boost';
  const VOLUME_BOOST_VALUES = [1, 1.5, 2, 3];
  const BRIGHTNESS_LEVEL_COUNT = TBackgroundBrightness.LEVEL_COUNT;
  const MODE_OFF = 'off';
  const MODE_HORIZONTAL = 'h';
  const MODE_VERTICAL = 'v';
  const defaultMode = ({
    off: MODE_OFF,
    horizontal: MODE_HORIZONTAL,
    vertical: MODE_VERTICAL,
    h: MODE_HORIZONTAL,
    v: MODE_VERTICAL,
  })[vcardCssDefault('visualization', 'vertical').toLowerCase()] || MODE_VERTICAL;
  const defaultBrightness = Number.parseInt(
    vcardCssDefault('visualization-brightness', '2'),
    10
  );
  const DEFAULT_BRIGHTNESS_LEVEL = Number.isInteger(defaultBrightness)
    ? Math.max(0, Math.min(BRIGHTNESS_LEVEL_COUNT - 1, defaultBrightness))
    : 0;
  const normalizeVolumeBoost = (value) => {
    const numericValue = Number.parseFloat(value);
    return VOLUME_BOOST_VALUES.includes(numericValue) ? numericValue : 1;
  };

  let visualizationMode = vcardStorage.local.getItem(STORAGE_KEY) || defaultMode;
  if (![MODE_OFF, MODE_HORIZONTAL, MODE_VERTICAL].includes(visualizationMode)) visualizationMode = MODE_VERTICAL;
  const backgroundBrightness = new TBackgroundBrightness(visualizationScope, DEFAULT_BRIGHTNESS_LEVEL, () => visualizationMode);
  window.VCardBrightness = Object.freeze({ current: () => String(backgroundBrightness.level) });

  // Static backgrounds retain the common brightness control without Web Audio.
  if (vcardFileMode) {
    visualizationMode = MODE_OFF;
    backgroundBrightness.publish();
    return;
  }

  const audios = sharedSongAudio ? [sharedSongAudio] : [];
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!audios.length || !AudioContextClass) {
    visualizationMode = MODE_OFF;
    backgroundBrightness.publish();
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.className = 'audio-spectrum';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);

  const canvasContext = canvas.getContext('2d', {
    alpha: true,
    desynchronized: true,
  });
  let audioContext = null;
  let audioOutputReady = false;
  let analyser = null;
  let analysisFailed = false;
  window.VCardVisualization = Object.freeze({ available: () => !analysisFailed });
  let volumeGain = null;
  let volumeLimiter = null;
  let volumeBoost = normalizeVolumeBoost(vcardStorage.local.getItem(VOLUME_BOOST_STORAGE_KEY));
  window.VCardVolumeBoost = Object.freeze({ current: () => String(volumeBoost) });
  let waveformData = null;
  let frequencyData = null;
  const mediaSources = [];
  const mediaSourceFallbacks = new Set();
  let animationFrame = 0;
  let lastVisualizationFrame = 0;
  let brightnessLevel = backgroundBrightness.level;
  let smoothedAmplitude = 0;
  let lastWaveformSample = 0;
  let horizontalScale = 1;
  let horizontalScaleTarget = 1;
  let horizontalScaleStartedAt = 0;
  let horizontalScaleCalibrated = false;
  let horizontalNoiseFloor = 0;
  let horizontalNoiseFloorTarget = 0;
  let horizontalNoiseFloorUpdatedAt = 0;
  let horizontalNoiseFloorReady = false;
  let horizontalUpperShape = 1;
  let horizontalLowerShape = 1;
  let lastVerticalFrame = 0;
  const waveformHistory = [];
  const visualizationFrameInterval = Math.max(
    16,
    30
  );
  const visualizationPixelRatio = Math.max(
    0.5,
    Math.min(
      window.devicePixelRatio || 1,
      1
    )
  );
  const requestedFftSize = Math.round(
    512
  );
  const visualizationFftSize = [32, 64, 128, 256, 512, 1024, 2048]
    .reduce((best, size) => (
      Math.abs(size - requestedFftSize) < Math.abs(best - requestedFftSize)
        ? size
        : best
    ), 512);
  const horizontalSampleInterval = Math.max(
    25,
    80
  );
  const horizontalScrollSpeed = Math.max(
    10,
    90
  );
  const horizontalColumnStep = horizontalScrollSpeed * horizontalSampleInterval / 1000;
  const horizontalBarWidth = Math.max(
    1,
    Math.min(
      horizontalColumnStep,
      6
    )
  );
  const HORIZONTAL_VIEWPORT_MARGIN = Math.max(
    0,
    Math.min(
      0.49,
      0.04
    )
  );
  const HORIZONTAL_RESPONSE_CURVE = Math.max(
    0.1,
    Math.min(
      1,
      0.6
    )
  );
  const HORIZONTAL_DEAD_ZONE_PERCENTILE = Math.max(
    0,
    Math.min(
      0.5,
      0.05
    )
  );
  const HORIZONTAL_DEAD_ZONE_CUT = Math.max(
    0,
    Math.min(
      1,
      0.8
    )
  );
  const HORIZONTAL_DEAD_ZONE_INTERVAL = Math.max(
    250,
    1000
  );
  const HORIZONTAL_ASYMMETRY = Math.max(
    0,
    Math.min(
      0.45,
      0.5
    )
  );
  const HORIZONTAL_ASYMMETRY_SMOOTHING = Math.max(
    0.01,
    Math.min(
      1,
      0.1
    )
  );
  const HORIZONTAL_SCALE_INTERVAL = Math.max(
    250,
    2000
  );
  const HORIZONTAL_SCALE_TARGET = Math.max(
    0.5,
    Math.min(
      1,
      0.96
    )
  );
  const HORIZONTAL_SCALE_MAX = Math.max(
    1,
    6
  );
  const VERTICAL_BAR_COUNT = Math.max(
    1,
    40
  );
  const VERTICAL_RELEASE_RATE = Math.max(
    0,
    Math.min(1, 0.06)
  );
  const verticalAmplitudes = Array.from(
    { length: VERTICAL_BAR_COUNT },
    () => 0
  );

  const visualizationColor = () => {
    const pageColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--vc-acc')
      .trim();
    return pageColor || getComputedStyle(document.body).color;
  };

  const horizontalAdjustedAmplitude = (amplitude) => Math.max(
    0,
    amplitude - horizontalNoiseFloor * HORIZONTAL_DEAD_ZONE_CUT
  );

  const verticalWaveBounds = () => {
    const probe = document.querySelector('.vcard-player-dock.block-mid')
      || document.querySelector('.list.block-mid:not([hidden])')
      || document.querySelector('.block-mid:not([hidden])');
    const rect = probe && probe.getBoundingClientRect();
    if (rect && rect.width > 0) {
      const left = Math.max(0, rect.left);
      const right = Math.min(window.innerWidth, rect.right);
      if (right > left) {
        return {
          left,
          right,
          width: right - left,
        };
      }
    }
    return {
      left: 0,
      right: window.innerWidth,
      width: window.innerWidth,
    };
  };

  const resizeCanvas = () => {
    const pixelRatio = visualizationPixelRatio;
    canvas.width = Math.round(window.innerWidth * pixelRatio);
    canvas.height = Math.round(window.innerHeight * pixelRatio);
    canvasContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    scheduleHorizontalBoundsRefresh();
  };

  let cachedHorizontalBounds = vcardHorizontalWaveBounds();
  let horizontalBoundsFrame = 0;
  signal.addEventListener('abort', () => {
    vcardRenderScheduler.cancel(animationFrame);
    vcardRenderScheduler.cancel(horizontalBoundsFrame);
    animationFrame = 0;
    horizontalBoundsFrame = 0;
    clearVisualizationFrame();
  }, { once: true });
  const refreshHorizontalBounds = () => {
    horizontalBoundsFrame = 0;
    cachedHorizontalBounds = vcardHorizontalWaveBounds();
  };
  const scheduleHorizontalBoundsRefresh = () => {
    if (signal.aborted || brightnessLevel === 0) return;
    if (horizontalBoundsFrame) vcardRenderScheduler.cancel(horizontalBoundsFrame);
    horizontalBoundsFrame = vcardRenderScheduler.request(() => {
      horizontalBoundsFrame = vcardRenderScheduler.request(refreshHorizontalBounds, {
        owner: canvas, scope: visualizationScope, phase: 'measure', priority: 0,
      });
    }, { owner: canvas, scope: visualizationScope, phase: 'measure', priority: 0 });
  };

  const clearVisualizationFrame = () => {
    canvasContext.clearRect(0, 0, window.innerWidth, window.innerHeight);
    waveformHistory.length = 0;
    verticalAmplitudes.fill(0);
    smoothedAmplitude = 0;
    horizontalScale = 1;
    horizontalScaleTarget = 1;
    horizontalScaleStartedAt = 0;
    horizontalScaleCalibrated = false;
    horizontalNoiseFloor = 0;
    horizontalNoiseFloorTarget = 0;
    horizontalNoiseFloorUpdatedAt = 0;
    horizontalNoiseFloorReady = false;
    horizontalUpperShape = 1;
    horizontalLowerShape = 1;
  };

  const applyVolumeBoost = (context = audioContext, gain = volumeGain, limiter = volumeLimiter) => {
    if (!context || !gain || !limiter) return;
    const now = context.currentTime;
    const boosted = volumeBoost > 1;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setTargetAtTime(volumeBoost, now, 0.015);
    limiter.threshold.setValueAtTime(boosted ? -3 : 0, now);
    limiter.knee.setValueAtTime(boosted ? 3 : 0, now);
    limiter.ratio.setValueAtTime(boosted ? 12 : 1, now);
    limiter.attack.setValueAtTime(0.003, now);
    limiter.release.setValueAtTime(0.25, now);
  };

  const reportedAudioFaults = new WeakSet();
  const reportAudioFault = (error, type) => {
    if (signal.aborted || error?.name === 'AbortError') return;
    if (error && typeof error === 'object') {
      if (reportedAudioFaults.has(error)) return;
      reportedAudioFaults.add(error);
    }
    const life = window.VCLife;
    if (!life || life.dead) {
      console.warn(`VCard ${type} failed`, error);
      return;
    }
    const owner = { id: type };
    life.queue.post(() => life.reportFault(error, { type, owner }), {
      type, owner, scope: visualizationScope,
    });
  };

  const disableAudioAnalysis = (error, type = 'Visualization.Analyser') => {
    if (analysisFailed) return;
    analysisFailed = true;
    mediaSources.forEach((source) => {
      source.connect(volumeGain);
      if (analyser) {
        try { source.disconnect(analyser); } catch (_error) { }
      }
    });
    try { analyser?.disconnect(); } catch (_error) { }
    analyser = null;
    stopVisualization();
    canvas.classList.remove('is-enabled');
    reportAudioFault(error, type);
    document.dispatchEvent(new CustomEvent('vcard:visualization-availability', {
      detail: { available: false },
    }));
  };

  const initializeAudio = () => {
    if (audioOutputReady) return;
    if (!audioContext) {
      let context;
      try {
        context = new AudioContextClass({ latencyHint: 'playback' });
      } catch (_error) {
        context = new AudioContextClass();
      }
      try {
        const gain = context.createGain();
        const limiter = context.createDynamicsCompressor();
        applyVolumeBoost(context, gain, limiter);
        gain.connect(limiter);
        limiter.connect(context.destination);
        // Commit only a usable output; no audio element has been captured yet.
        audioContext = context;
        volumeGain = gain;
        volumeLimiter = limiter;
      } catch (error) {
        context.close().catch(() => { });
        throw error;
      }
    }
    if (!analyser && !analysisFailed) {
      try {
        analyser = audioContext.createAnalyser();
        analyser.fftSize = visualizationFftSize;
        analyser.smoothingTimeConstant = 0;
        waveformData = new Uint8Array(analyser.fftSize);
        frequencyData = new Uint8Array(analyser.frequencyBinCount);
        analyser.connect(volumeGain);
      } catch (error) {
        disableAudioAnalysis(error);
      }
    }

    audios.forEach((audio, index) => {
      // A MediaElementSource cannot be recreated for the same audio element.
      const source = mediaSources[index] || audioContext.createMediaElementSource(audio);
      mediaSources[index] = source;
      try {
        source.connect(analyser || volumeGain);
        if (mediaSourceFallbacks.has(source)) {
          source.disconnect(audioContext.destination);
          mediaSourceFallbacks.delete(source);
        }
      } catch (error) {
        // Keep an already captured audio element connected to a usable output.
        source.connect(audioContext.destination);
        mediaSourceFallbacks.add(source);
        throw error;
      }
    });
    audioOutputReady = true;
  };

  const resetAudioAnalysis = () => {
    waveformData?.fill(0);
    frequencyData?.fill(0);
  };

  const prepareAudioOutput = async ({ boost = false } = {}) => {
    if (signal.aborted) return false;
    try {
      initializeAudio();
      if (boost) applyVolumeBoost();
    } catch (error) {
      reportAudioFault(error, 'Audio.Output.Prepare');
      return false;
    }
    try {
      if (audioContext.state === 'suspended') await audioContext.resume();
    } catch (error) {
      reportAudioFault(error, 'Audio.Output.Resume');
      return false;
    }
    return !signal.aborted && audioOutputReady;
  };

  const drawHorizontalVisualization = (timestamp) => {
    const frameTime = typeof timestamp === 'number' ? timestamp : performance.now();
    const shouldSample = (
      !lastWaveformSample
      || frameTime - lastWaveformSample >= horizontalSampleInterval
    );

    if (shouldSample) {
      lastWaveformSample = frameTime;

      analyser.getByteTimeDomainData(waveformData);
      analyser.getByteFrequencyData(frequencyData);
      let sampleMean = 0;
      waveformData.forEach((value) => {
        sampleMean += value;
      });
      sampleMean /= waveformData.length;

      let peak = 0;
      let squareSum = 0;
      waveformData.forEach((value) => {
        const sample = Math.abs(value - sampleMean) / 128;
        peak = Math.max(peak, sample);
        squareSum += sample * sample;
      });

      const rms = Math.sqrt(squareSum / waveformData.length);
      const measuredAmplitude = Math.min(1, Math.max(peak * 0.78, rms * 1.8));
      smoothedAmplitude += (measuredAmplitude - smoothedAmplitude) * 0.32;

      const nyquist = audioContext.sampleRate / 2;
      const frequencyBin = (hertz) => Math.max(
        1,
        Math.min(
          frequencyData.length,
          Math.round(hertz / nyquist * frequencyData.length)
        )
      );
      const bandRms = (start, end) => {
        let bandSquareSum = 0;
        const safeEnd = Math.max(start + 1, Math.min(end, frequencyData.length));
        for (let index = start; index < safeEnd; index += 1) {
          const value = frequencyData[index] / 255;
          bandSquareSum += value * value;
        }
        return Math.sqrt(bandSquareSum / (safeEnd - start));
      };
      const lowEnergy = bandRms(frequencyBin(45), frequencyBin(250));
      const midEnergy = bandRms(frequencyBin(250), frequencyBin(2500));
      const highEnergy = bandRms(frequencyBin(2500), frequencyBin(8000));
      const bodyEnergy = lowEnergy * 0.65 + midEnergy * 0.35;
      const detailEnergy = midEnergy * 0.6 + highEnergy * 0.4;
      const spectralBalance = Math.max(
        -1,
        Math.min(
          1,
          (detailEnergy - bodyEnergy) / (detailEnergy + bodyEnergy + 0.02)
        )
      );
      const upperShapeTarget = 1 + spectralBalance * HORIZONTAL_ASYMMETRY;
      const lowerShapeTarget = 1 - spectralBalance * HORIZONTAL_ASYMMETRY;
      horizontalUpperShape += (
        upperShapeTarget - horizontalUpperShape
      ) * HORIZONTAL_ASYMMETRY_SMOOTHING;
      horizontalLowerShape += (
        lowerShapeTarget - horizontalLowerShape
      ) * HORIZONTAL_ASYMMETRY_SMOOTHING;

      waveformHistory.push({
        amplitude: smoothedAmplitude,
        upperShape: horizontalUpperShape,
        lowerShape: horizontalLowerShape,
      });
      if (!horizontalScaleStartedAt) horizontalScaleStartedAt = frameTime;

      const maximumColumns = Math.ceil(window.innerWidth / horizontalColumnStep) + 2;
      if (waveformHistory.length > maximumColumns) {
        waveformHistory.splice(0, waveformHistory.length - maximumColumns);
      }
      if (
        waveformHistory.length >= 12
        && frameTime - horizontalNoiseFloorUpdatedAt >= HORIZONTAL_DEAD_ZONE_INTERVAL
      ) {
      const floorSamples = waveformHistory
        .slice(-Math.min(waveformHistory.length, 120))
        .map((column) => column.amplitude)
        .sort((left, right) => left - right);
      const floorIndex = Math.floor(
        (floorSamples.length - 1) * HORIZONTAL_DEAD_ZONE_PERCENTILE
      );
      horizontalNoiseFloorTarget = floorSamples[floorIndex] || 0;
      horizontalNoiseFloorUpdatedAt = frameTime;
      if (!horizontalNoiseFloorReady) {
        horizontalNoiseFloor = horizontalNoiseFloorTarget * 0.5;
        horizontalNoiseFloorReady = true;
      }
      }
      horizontalNoiseFloor += (
        horizontalNoiseFloorTarget - horizontalNoiseFloor
      ) * (horizontalNoiseFloorTarget < horizontalNoiseFloor ? 0.15 : 0.04);

      if (
        !horizontalScaleCalibrated
        && waveformHistory.length >= 12
        && frameTime - horizontalScaleStartedAt >= HORIZONTAL_SCALE_INTERVAL
      ) {
      const transformedHistory = waveformHistory
        .slice(-Math.min(waveformHistory.length, 120))
        .map((column) => (
          Math.pow(
            horizontalAdjustedAmplitude(column.amplitude),
            HORIZONTAL_RESPONSE_CURVE
          ) * Math.max(column.upperShape, column.lowerShape)
        ))
        .sort((left, right) => left - right);
      const referenceIndex = Math.floor((transformedHistory.length - 1) * 0.95);
      const referenceAmplitude = Math.max(
        0.01,
        transformedHistory[referenceIndex] || 0
      );
      horizontalScaleTarget = Math.max(
        0.25,
        Math.min(
          HORIZONTAL_SCALE_MAX,
          HORIZONTAL_SCALE_TARGET / referenceAmplitude
        )
      );
        horizontalScaleCalibrated = true;
      } else if (horizontalScaleCalibrated) {
      const displayedAmplitude = Math.max(
        0.01,
        Math.pow(
          horizontalAdjustedAmplitude(smoothedAmplitude),
          HORIZONTAL_RESPONSE_CURVE
        ) * Math.max(horizontalUpperShape, horizontalLowerShape)
      );
      const safeScale = Math.max(
        0.25,
        Math.min(HORIZONTAL_SCALE_MAX, HORIZONTAL_SCALE_TARGET / displayedAmplitude)
      );
      // Loud peaks may reduce the scale immediately. Quiet passages never
      // enlarge it again, so the waveform does not breathe vertically.
        horizontalScaleTarget = Math.min(horizontalScaleTarget, safeScale);
      }
      if (horizontalScaleTarget < horizontalScale) {
        horizontalScale = horizontalScaleTarget;
      } else {
        horizontalScale += (horizontalScaleTarget - horizontalScale) * 0.05;
      }
    }

    const bounds = cachedHorizontalBounds;
    const centerY = bounds.top + bounds.height / 2;
    const maximumHalfHeight = Math.max(
      1,
      bounds.height * (0.5 - HORIZONTAL_VIEWPORT_MARGIN)
    );
    const phaseOffset = lastWaveformSample
      ? Math.min(
        horizontalColumnStep,
        (frameTime - lastWaveformSample) / horizontalSampleInterval * horizontalColumnStep
      )
      : 0;
    const waveformColor = visualizationColor(frameTime);

    canvasContext.clearRect(0, 0, window.innerWidth, window.innerHeight);
    canvasContext.save();
    canvasContext.beginPath();
    canvasContext.rect(0, bounds.top, window.innerWidth, bounds.height);
    canvasContext.clip();
    canvasContext.globalAlpha = [0, 0.28, 0.48, 0.68, 0.85, 1][brightnessLevel];
    canvasContext.fillStyle = waveformColor;
    for (let index = 0; index < waveformHistory.length; index += 1) {
      const column = waveformHistory[index];
      const baseHalfHeight = Math.pow(
        horizontalAdjustedAmplitude(column.amplitude),
        HORIZONTAL_RESPONSE_CURVE
      ) * maximumHalfHeight * horizontalScale;
      const x = window.innerWidth
        - (waveformHistory.length - index) * horizontalColumnStep
        - phaseOffset;
      const upperHeight = Math.max(
        1,
        Math.min(maximumHalfHeight, baseHalfHeight * column.upperShape)
      );
      const lowerHeight = Math.max(
        1,
        Math.min(maximumHalfHeight, baseHalfHeight * column.lowerShape)
      );
      canvasContext.fillRect(
        x,
        centerY - upperHeight,
        horizontalBarWidth,
        upperHeight + lowerHeight
      );
    }
    canvasContext.restore();
  };

  const drawVerticalVisualization = () => {
    const frameTime = performance.now();
    if (frameTime - lastVerticalFrame < 33) return;
    lastVerticalFrame = frameTime;

    analyser.getByteFrequencyData(frequencyData);

    const amplitudes = verticalAmplitudes.map((current, index) => {
      const start = Math.floor(
        index * frequencyData.length / VERTICAL_BAR_COUNT
      );
      const end = Math.max(
        start + 1,
        Math.floor((index + 1) * frequencyData.length / VERTICAL_BAR_COUNT)
      );
      let peak = 0;
      for (let bin = start; bin < Math.min(end, frequencyData.length); bin += 1) {
        peak = Math.max(peak, frequencyData[bin]);
      }
      const target = peak / 255;
      const next = target >= current
        ? target
        : current + (target - current) * VERTICAL_RELEASE_RATE;
      verticalAmplitudes[index] = next;
      return next;
    });

    const bounds = verticalWaveBounds();
    const centerX = bounds.left + bounds.width / 2;
    const waveformColor = visualizationColor(frameTime);
    const slotHeight = window.innerHeight / VERTICAL_BAR_COUNT;
    const gap = Math.max(4, Math.min(12, slotHeight * 0.18));
    const barHeight = Math.max(2, slotHeight - gap);
    const maxHalfWidth = bounds.width / 2;

    canvasContext.clearRect(0, 0, window.innerWidth, window.innerHeight);
    canvasContext.save();
    canvasContext.beginPath();
    canvasContext.rect(bounds.left, 0, bounds.width, window.innerHeight);
    canvasContext.clip();
    amplitudes.forEach((amplitude, index) => {
      if (amplitude < 0.004) return;
      const halfWidth = amplitude * maxHalfWidth;
      const x = centerX - halfWidth;
      const y = (VERTICAL_BAR_COUNT - index - 1) * slotHeight + gap / 2;
      const width = halfWidth * 2;
    canvasContext.globalAlpha = [0, 0.24, 0.42, 0.62, 0.82, 1][brightnessLevel];
      canvasContext.fillStyle = waveformColor;
      canvasContext.fillRect(x, y, width, barHeight);
    });
    canvasContext.restore();
  };

  let visualizationPhase = window.VCPlayer?.current?.()?.phase || 'Idle';
  const stopVisualization = (clear = true) => {
    if (animationFrame) vcardRenderScheduler.cancel(animationFrame);
    animationFrame = 0;
    if (clear) clearVisualizationFrame();
  };
  const requestVisualizationFrame = () => vcardRenderScheduler.request(drawVisualization, {
    owner: canvas, scope: visualizationScope, priority: 20, phase: 'draw', essential: false,
  });
  const drawVisualization = (timestamp) => {
    animationFrame = 0;
    if (signal.aborted) return;
    if (
      !analyser
      || visualizationMode === MODE_OFF
      || brightnessLevel === 0
      || !['AudioPlaying', 'AudioBuffering'].includes(visualizationPhase)
    ) {
      clearVisualizationFrame();
      return;
    }
    if (audios.every((audio) => audio.paused || audio.ended)) {
      clearVisualizationFrame();
      return;
    }
    const motion = vcardMotionPolicy.snapshot();
    if (!motion.renderingActive || window.VCLife?.renderingActive === false) {
      if (!motion.motionAllowed || (motion.pageVisible && window.VCLife?.pageVisible !== false)) {
        clearVisualizationFrame();
      }
      return;
    }
    if (visualizationPhase === 'AudioBuffering') return;

    const frameTime = typeof timestamp === 'number' ? timestamp : performance.now();
    if (
      lastVisualizationFrame
      && frameTime - lastVisualizationFrame < visualizationFrameInterval
    ) {
      animationFrame = requestVisualizationFrame();
      return;
    }
    lastVisualizationFrame = frameTime;

    try {
      if (visualizationMode === MODE_VERTICAL) {
        drawVerticalVisualization();
      } else {
        drawHorizontalVisualization(frameTime);
      }
    } catch (error) {
      disableAudioAnalysis(error, 'Visualization.Draw');
      return;
    }

    animationFrame = requestVisualizationFrame();
  };

  const startVisualization = async () => {
    if (signal.aborted || analysisFailed || visualizationPhase !== 'AudioPlaying' || !vcardMotionPolicy.snapshot().renderingActive) return;
    if (visualizationMode === MODE_OFF || brightnessLevel === 0 || window.VCLife?.renderingActive === false) return;
    if (!await prepareAudioOutput()) return;
    if (signal.aborted || !audioOutputReady || analysisFailed || visualizationPhase !== 'AudioPlaying' || !vcardMotionPolicy.snapshot().renderingActive || visualizationMode === MODE_OFF || brightnessLevel === 0 || window.VCLife?.renderingActive === false
      || audios.every((audio) => audio.paused || audio.ended)) return;
    if (!animationFrame) animationFrame = requestVisualizationFrame();
  };

  let visualizationRenderingActive = true;
  document.addEventListener('vcard:vcplayer-state', (event) => {
    const active = event.detail?.renderingActive !== false;
    const phase = event.detail?.phase || 'Idle';
    if (active === visualizationRenderingActive && phase === visualizationPhase) return;
    visualizationRenderingActive = active;
    visualizationPhase = phase;
    if (!['AudioPlaying', 'AudioBuffering'].includes(phase)) {
      stopVisualization();
    } else if (!active) {
      stopVisualization(event.detail?.pageVisible !== false);
    } else if (phase !== 'AudioPlaying') {
      stopVisualization(phase !== 'AudioBuffering');
    } else if (audios.some((audio) => !audio.paused && !audio.ended)) {
      startVisualization().catch((error) => console.debug('VCard visualization resume failed', error));
    }
  }, { signal });

  document.addEventListener('vcard:motion-state', () => {
    const motion = vcardMotionPolicy.snapshot();
    if (!motion.renderingActive) {
      stopVisualization(!motion.motionAllowed || (motion.pageVisible && window.VCLife?.pageVisible !== false));
    } else startVisualization().catch((error) => console.debug('VCard visualization resume failed', error));
  }, { signal });

  const prepareAudioContextFromGesture = () => {
    if (signal.aborted) return;
    if ((visualizationMode === MODE_OFF || brightnessLevel === 0) && volumeBoost === 1) return;
    prepareAudioOutput();
  };

  document.addEventListener('vcard:prepare-audio-context', prepareAudioContextFromGesture, { signal });
  document.addEventListener('vcard:set-volume-boost', (event) => {
    volumeBoost = normalizeVolumeBoost(event.detail && event.detail.value);
    vcardStorage.local.setItem(VOLUME_BOOST_STORAGE_KEY, String(volumeBoost));
    prepareAudioOutput({ boost: true });
    document.dispatchEvent(new CustomEvent('vcard:volume-boost-state', {
      detail: { value: String(volumeBoost) }
    }));
  }, { signal });

  audios.forEach((audio) => {
    audio.addEventListener('play', () => {
      if (volumeBoost !== 1) prepareAudioOutput();
      startVisualization();
    }, { signal });
    const stopAudioFrame = () => {
      stopVisualization();
    };
    audio.addEventListener('pause', stopAudioFrame, { signal });
    audio.addEventListener('ended', stopAudioFrame, { signal });
  });
  window.addEventListener('resize', resizeCanvas, { signal });
  document.addEventListener('vcard:portal-state', scheduleHorizontalBoundsRefresh, { signal });
  document.addEventListener('vcard:portal-size', scheduleHorizontalBoundsRefresh, { signal });
  document.addEventListener('vcard:portal-mode', scheduleHorizontalBoundsRefresh, { signal });
  document.addEventListener('load', (event) => {
    if (event.target instanceof HTMLImageElement && event.target.closest('.song-portal-stage')) {
      scheduleHorizontalBoundsRefresh();
    }
  }, { capture: true, signal });

  const setVisualizationMode = (nextMode) => {
    if (signal.aborted) return;
    visualizationMode = vcardVisualizationAvailable() && [MODE_HORIZONTAL, MODE_VERTICAL].includes(nextMode) ? nextMode : MODE_OFF;
    if (animationFrame) vcardRenderScheduler.cancel(animationFrame);
    animationFrame = 0;
    lastVerticalFrame = 0;
    lastVisualizationFrame = 0;
    lastWaveformSample = 0;
    clearVisualizationFrame();
    if (brightnessLevel > 0) resetAudioAnalysis();
    vcardStorage.local.setItem(STORAGE_KEY, visualizationMode);
    canvas.classList.toggle(
      'is-enabled',
      !analysisFailed && visualizationMode !== MODE_OFF && brightnessLevel > 0
    );
    canvas.dataset.brightnessLevel = String(brightnessLevel);
    backgroundBrightness.publish();

    if (visualizationMode !== MODE_OFF && brightnessLevel > 0) {
      const playingAudio = audios.find((audio) => !audio.paused && !audio.ended);
      if (playingAudio) startVisualization();
    } else {
      if (animationFrame) vcardRenderScheduler.cancel(animationFrame);
      animationFrame = 0;
      clearVisualizationFrame();
    }
  };

  document.addEventListener('vcard:set-visualization', (event) => {
    const requestedMode = event.detail && event.detail.mode;
    const forceMode = Boolean(event.detail && event.detail.force);
    setVisualizationMode(!forceMode && requestedMode === visualizationMode ? MODE_OFF : requestedMode);
  }, { signal });

  document.addEventListener('vcard:visualization-state', (event) => {
    const nextLevel = event.detail?.brightnessLevel;
    if (nextLevel === brightnessLevel) return;
    brightnessLevel = nextLevel;
    canvas.dataset.brightnessLevel = String(brightnessLevel);
    canvas.classList.toggle(
      'is-enabled',
      !analysisFailed && visualizationMode !== MODE_OFF && brightnessLevel > 0
    );
    if (brightnessLevel === 0) {
      if (animationFrame) vcardRenderScheduler.cancel(animationFrame);
      animationFrame = 0;
      lastVisualizationFrame = 0;
      clearVisualizationFrame();
    } else {
      const playingAudio = audios.find((audio) => !audio.paused && !audio.ended);
      if (playingAudio) startVisualization();
    }
  }, { signal });

  resizeCanvas();
  setVisualizationMode(visualizationMode);
})();

const vcardDebugStylesLoaded = () => Boolean(document.querySelector(
  'link[href*="vcard-debug.css"], style[data-vcard-source$="vcard-debug.css"]'
));

const vcardDebugLayout = (() => {
  if (!vcardDebugStylesLoaded()) return null;
  const scope = new AbortController();
  const { signal } = scope;
  const refreshers = new Set();
  const observers = new Set();
  let frame = 0;
  const request = () => {
    if (signal.aborted || frame || document.documentElement.dataset.debug !== 'on') return;
    frame = vcardRenderScheduler.request(() => {
      frame = 0;
      refreshers.forEach((refresh) => refresh());
    }, { owner: document.documentElement, scope, priority: 20,
      isCurrent: () => document.documentElement.dataset.debug === 'on',
      onCancel: () => { frame = 0; } });
  };
  document.addEventListener('vcard:debug-layout-change', request, { signal });
  document.addEventListener('vcard:debug-state', request, { signal });
  window.addEventListener('resize', request, { signal });
  window.addEventListener('pagehide', (event) => { if (!event.persisted) scope.abort(); }, { signal });
  signal.addEventListener('abort', () => {
    vcardRenderScheduler.cancel(frame);
    frame = 0;
    observers.forEach((observer) => observer.disconnect());
    observers.clear();
    refreshers.clear();
  }, { once: true });
  return { signal, request,
    register: (refresh) => { refreshers.add(refresh); request(); },
    watch: (observer) => { observers.add(observer); return observer; } };
})();

(() => {
  if (!vcardDebugStylesLoaded()) return;

  const STORAGE_KEY = 'vcard-debug';
  const RAINBOW_STORAGE_KEY = 'vcard-debug-rainbow';
  const root = document.documentElement;
  const toggle = document.querySelector('[data-debug-toggle]');

  const setDebug = (enabled) => {
    root.dataset.debug = enabled ? 'on' : 'off';
    vcardStorage.local.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
    document.dispatchEvent(new CustomEvent('vcard:debug-state', {
      detail: { enabled }
    }));
  };

  const setRainbow = (enabled) => {
    root.dataset.debugRainbow = enabled ? 'on' : 'off';
    vcardStorage.local.setItem(RAINBOW_STORAGE_KEY, enabled ? 'on' : 'off');
    document.dispatchEvent(new CustomEvent('vcard:debug-rainbow-state', {
      detail: { enabled }
    }));
  };

  setDebug(vcardSettingEnabled(STORAGE_KEY, 'debug', 'off'));
  setRainbow(vcardSettingEnabled(RAINBOW_STORAGE_KEY, 'debug-rainbow', 'on'));

  document.addEventListener('vcard:set-debug-rainbow', (event) => {
    setRainbow(Boolean(event.detail?.enabled));
  }, { signal: vcardDebugLayout.signal });

  if (toggle) {
    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      setDebug(root.dataset.debug !== 'on');
    }, { signal: vcardDebugLayout.signal });
  }

  vcardKeyboard.register((event) => {
    if (vcardDebugLayout.signal.aborted) return false;
    const target = event.target;
    if (target instanceof Element
      && (target.isContentEditable || target.closest('input, textarea, select'))) return false;
    if (
      event.key !== 'F12'
      || !event.ctrlKey
      || event.altKey
      || event.metaKey
      || event.shiftKey
    ) return false;
    if (!event.repeat) setDebug(root.dataset.debug !== 'on');
    return true;
  }, 200);
})();

(() => {
  if (!vcardDebugStylesLoaded()) return;

  const blockTypes = [
    ['block-full', 'full'],
    ['block-mid', 'mid'],
    ['block-small', 'small']
  ];

  const debugElements = Array.from(document.querySelectorAll(
    'section.block-full, section.block-mid, section.block-small, [id]:not(a), [ids]:not(a)'
  ));

  const blockTypeFor = (element) => {
    const blockHost = element.closest('.block-full, .block-mid, .block-small');
    return blockHost
      ? blockTypes.find(([className]) => blockHost.classList.contains(className))
      : null;
  };

  const refreshDebugElement = (element) => {
    const blockType = blockTypeFor(element);
    const line = element.querySelector(':scope > .vc-debug-section-line');
    const marker = element.querySelector(':scope > .vc-debug-block-marker');
    if (line) {
      line.className = blockType
        ? `vc-debug-section-line vc-debug-section-line--${blockType[1]}`
        : 'vc-debug-section-line';
    }
    if (marker) {
      marker.className = blockType
        ? `vc-debug-block-marker vc-debug-block-marker--${blockType[1]}`
        : 'vc-debug-block-marker';
    }
  };

  debugElements.forEach((element) => {
      const blockType = blockTypeFor(element);
      const tagName = element.tagName.toLowerCase();
      const elementClass = Array.from(element.classList)
        .find((className) => !className.startsWith('block-'));
      const identifiers = [
        element.id ? `id=${element.id}` : '',
        element.getAttribute('ids') ? `ids=${element.getAttribute('ids')}` : ''
      ].filter(Boolean);
      const elementName = identifiers.length
        ? `${tagName} ${identifiers.join(' ')}`
        : elementClass
          ? `${tagName} class=${elementClass}`
          : tagName;

      element.classList.add('vc-debug-marker-host');

      const line = document.createElement('span');
      line.className = blockType
        ? `vc-debug-section-line vc-debug-section-line--${blockType[1]}`
        : 'vc-debug-section-line';
      line.setAttribute('aria-hidden', 'true');
      element.appendChild(line);

      const marker = document.createElement('span');
      marker.className = blockType
        ? `vc-debug-block-marker vc-debug-block-marker--${blockType[1]}`
        : 'vc-debug-block-marker';
      marker.textContent = elementName;
      marker.setAttribute('aria-hidden', 'true');
      element.appendChild(marker);
    });

  vcardDebugLayout.register(() => {
    debugElements.forEach(refreshDebugElement);
  });
})();

(() => {
  if (!vcardDebugStylesLoaded()) return;

  const label = document.querySelector('.vc-debug-label--body');
  const midLabel = document.querySelector('.vc-debug-label--mid');
  const smallLabel = document.querySelector('.vc-debug-label--small');
  if (!label && !midLabel && !smallLabel) return;

  const updateBodyDebugLabel = () => {
    if (label) {
      const width = Math.round(document.body.getBoundingClientRect().width);
      label.textContent = `BODY ${width}px / max 1200px`;
    }
    const rootStyle = getComputedStyle(document.documentElement);
    if (midLabel) {
      midLabel.textContent = `MID ${rootStyle.getPropertyValue('--block-mid-width').trim()}`;
    }
    if (smallLabel) {
      smallLabel.textContent = `SMALL ${rootStyle.getPropertyValue('--block-small-width').trim()}`;
    }
  };

  vcardDebugLayout.register(updateBodyDebugLabel);

  if ('ResizeObserver' in window) {
    const observer = vcardDebugLayout.watch(new ResizeObserver(vcardDebugLayout.request));
    observer.observe(document.body);
  }
})();

(() => {
  if (!vcardDebugStylesLoaded()) return;

  const root = document.documentElement;
  const fileName = (source) => {
    try {
      const pathName = new URL(String(source || ''), document.baseURI).pathname;
      return decodeURIComponent(pathName.split('/').filter(Boolean).pop() || '—');
    } catch (_error) {
      return String(source || '—').split(/[\\/]/).pop().split(/[?#]/, 1)[0] || '—';
    }
  };

  document.querySelectorAll('img').forEach((image) => {
    const host = image.closest(
      '.iod-frame, .image-vibeframe, .song-vibeframe'
    ) || image.parentElement;
    if (!host) return;
    host.classList.add('vc-debug-media-name-host');
    let label = host.querySelector(':scope > .vc-debug-media-name');
    if (!label) {
      label = document.createElement('span');
      label.className = 'vc-debug-media-name';
      label.setAttribute('aria-hidden', 'true');
      host.appendChild(label);
    }
    const update = () => {
      if (!image.isConnected || !label.isConnected) return;
      const name = fileName(image.currentSrc || image.getAttribute('src'));
      if (label.textContent !== name) label.textContent = name;
    };
    vcardDebugLayout.register(update);
    vcardDebugLayout.watch(new MutationObserver(vcardDebugLayout.request)).observe(image, {
      attributes: true,
      attributeFilter: ['src']
    });
    image.addEventListener('load', vcardDebugLayout.request, { signal: vcardDebugLayout.signal });
  });

  const backgroundLabel = document.createElement('span');
  backgroundLabel.className = 'vc-debug-background-name';
  backgroundLabel.setAttribute('aria-hidden', 'true');
  document.body.appendChild(backgroundLabel);
  const updateBackgroundLabel = () => {
    const name = `ФОН: ${root.dataset.pageBackgroundName || '—'}`;
    if (backgroundLabel.textContent !== name) backgroundLabel.textContent = name;
  };
  vcardDebugLayout.register(updateBackgroundLabel);
  vcardDebugLayout.watch(new MutationObserver(vcardDebugLayout.request)).observe(root, {
    attributes: true,
    attributeFilter: ['data-page-background-name', 'data-background-mode']
  });
})();

const vcardMedia = (() => {
  const debugStyles = new WeakMap();
  const debugStyleOwner = (image) => {
    const owner = image.vcardDebugStyleOwner || image.closest('.song__preview');
    if (owner) image.vcardDebugStyleOwner = owner;
    return owner;
  };
  const mediaScope = new AbortController();
  class TMediaLoader {
    constructor() {
      this.closed = false;
      this.pending = new Map();
      this.nextId = 1;
      this.lastCompletion = null;
      this.elements = new WeakMap();
      this.nextElementId = 1;
    }

    request(key, type, prepare, signal = null, identity = '') {
      if (this.closed || signal?.aborted) {
        return { id: null, cancel: () => {},
          promise: Promise.reject(new DOMException('Media consumer cancelled', 'AbortError')) };
      }
      const cacheKey = `${type}:${identity}:${key}`;
      let entry = this.pending.get(cacheKey);
      if (!entry) {
        entry = { id: this.nextId++, key, type, stage: 'loading', consumers: new Set(),
          controller: new AbortController() };
        this.pending.set(cacheKey, entry);
        entry.promise = Promise.resolve().then(() => {
          if (entry.controller.signal.aborted) throw new DOMException('Media cancelled', 'AbortError');
          return prepare(entry.controller.signal);
        }).then((value) => {
          entry.stage = 'ready';
          if (type === 'image') entry.result = {
            width: value.naturalWidth, height: value.naturalHeight,
            decoded: typeof value.decode === 'function',
          };
          if (type === 'video' || type === 'audio') entry.result = value;
          return value;
        }, (error) => {
          entry.stage = error?.name === 'AbortError' ? 'cancelled' : 'failed';
          entry.error = String(error?.message || error);
          throw error;
        }).finally(() => {
          if (this.pending.get(cacheKey) === entry) this.pending.delete(cacheKey);
          if (this.closed) return;
          this.lastCompletion = { id: entry.id, url: key, type, stage: entry.stage,
            result: entry.result || null, error: entry.error || '', time: Date.now() };
        });
      }
      let settled = false;
      let rejectTicket;
      const release = () => {
        signal?.removeEventListener('abort', cancel);
        entry.consumers.delete(ticket);
        if (!entry.consumers.size && entry.stage === 'loading') {
          if (this.pending.get(cacheKey) === entry) this.pending.delete(cacheKey);
          entry.controller.abort();
        }
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        release();
        rejectTicket(new DOMException('Media consumer cancelled', 'AbortError'));
      };
      const ticket = { id: entry.id, cancel, promise: new Promise((resolve, reject) => {
        rejectTicket = reject;
        entry.promise.then((value) => {
          if (settled) return;
          settled = true;
          release();
          resolve(value);
        }, (error) => {
          if (settled) return;
          settled = true;
          release();
          reject(error);
        });
      }) };
      entry.consumers.add(ticket);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      return ticket;
    }

    snapshot() {
      return { closed: this.closed, pending: this.pending.size,
        consumers: [...this.pending.values()].reduce((sum, entry) => sum + entry.consumers.size, 0),
        resources: [...this.pending.values()].map(({ id, key, type, stage, consumers }) => (
          { id, url: key, type, stage, consumers: consumers.size }
        )), lastCompletion: this.lastCompletion };
    }

    prepareElement(element, type, { signal = null, readyState = HTMLMediaElement.HAVE_FUTURE_DATA,
      timeoutMs = 15000 } = {}) {
      if (!this.elements.has(element)) this.elements.set(element, this.nextElementId++);
      const source = element.src || element.currentSrc;
      const identity = `${this.elements.get(element)}:${readyState}:${timeoutMs}`;
      return this.request(source, type, (loadSignal) => new Promise((resolve, reject) => {
        let settled = false;
        const events = ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'error', 'emptied'];
        const finish = (error = null) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          events.forEach((name) => element.removeEventListener(name, check));
          loadSignal.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve({ duration: Number.isFinite(element.duration) ? element.duration : null,
            readyState: element.readyState, width: element.videoWidth || null,
            height: element.videoHeight || null });
        };
        const abort = () => finish(new DOMException('Media readiness cancelled', 'AbortError'));
        const check = () => {
          if ((element.src || element.currentSrc) !== source) { abort(); return; }
          // A newly assigned src can precede selection of that resource.
          // Readiness of the previous currentSrc does not prepare the new URL.
          if (element.currentSrc && element.currentSrc !== source) return;
          if (element.error) { finish(new Error(`cannot prepare ${type}: ${source}`)); return; }
          if (element.readyState >= readyState) finish();
        };
        const timeout = window.setTimeout(() => finish(new Error(`timeout preparing ${type}: ${source}`)), timeoutMs);
        events.forEach((name) => element.addEventListener(name, check));
        loadSignal.addEventListener('abort', abort, { once: true });
        check();
        if (!settled && element.networkState === HTMLMediaElement.NETWORK_EMPTY) {
          try { element.load(); } catch (error) { finish(error); }
        }
      }), signal, identity);
    }

    cancelAll() {
      for (const entry of [...this.pending.values()]) {
        for (const ticket of [...entry.consumers]) ticket.cancel();
      }
    }

    dispose() {
      if (this.closed) return;
      this.closed = true;
      this.cancelAll();
    }
  }
  const loader = new TMediaLoader();
  const listCache = new Map();
  const showCatalogCache = new Map();
  const browserStyleCache = new Map();
  const mediaStates = new Map();
  const activeImages = new Set();
  let releasedStyleUrls = 0;
  const releaseStyleResources = (state) => {
    if (!state) return;
    state.released = true;
    state.renderAbort?.abort();
    state.pairAbort?.abort();
    state.renderVersion += 1;
    state.pairRenderVersion += 1;
    state.historyGeneration += 1;
    for (const entry of state.styleResources || []) {
      entry.owners.delete(state);
      if (entry.owners.size) continue;
      entry.controller?.abort();
      if (browserStyleCache.get(entry.key) === entry) browserStyleCache.delete(entry.key);
      if (entry.url) { URL.revokeObjectURL(entry.url); entry.url = ''; releasedStyleUrls += 1; }
    }
    state.styleResources?.clear();
  };
  const root = document.documentElement;
  const listVersions = new Map(Object.entries(window.VCardMediaManifest?.lists || {}).map(
    ([path, version]) => [new URL(path, document.baseURI).href, String(version || '')]
  ));
  const showCatalogVersions = new Map(Object.entries(window.VCardMediaManifest?.showCatalogs || {}).map(
    ([path, version]) => [new URL(path, document.baseURI).href, String(version || '')]
  ));

  const listKey = (listUrl) => {
    const resolved = new URL(String(listUrl || ''), document.baseURI);
    const unversioned = new URL(resolved.href);
    unversioned.search = '';
    unversioned.hash = '';
    const version = listVersions.get(unversioned.href);
    if (version) resolved.searchParams.set('v', version);
    return resolved.href;
  };

  const loadPublishedScript = (key, read, label) => loader.request(key, label, (signal) => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      script.onload = script.onerror = null;
      script.remove();
      if (error) reject(error);
      else {
        try {
          const value = read();
          if (value) resolve(value);
          else reject(new Error(`invalid ${label}: ${key}`));
        } catch (readError) { reject(readError); }
      }
    };
    const timeout = window.setTimeout(() => finish(new Error(`timeout loading ${label}: ${key}`)), 15000);
    const onAbort = () => finish(new DOMException('Script load cancelled', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    script.src = key;
    script.async = true;
    script.onload = () => finish();
    script.onerror = () => finish(new Error(`cannot load ${label}: ${key}`));
    document.head.appendChild(script);
  })).promise;

  const loadListScript = (listUrl) => {
    const key = listKey(listUrl);
    const lists = window.VCARD_MEDIA_LISTS ||= {};
    if (Array.isArray(lists[key])) return Promise.resolve(lists[key].slice());
    return loadPublishedScript(key, () => {
      const items = window.VCARD_MEDIA_LISTS?.[key];
      return Array.isArray(items) ? items.slice() : null;
    }, 'media list');
  };

  const loadList = async (listUrl) => {
    await vcardSelectionReady;
    const key = listKey(listUrl);
    if (!listCache.has(key)) {
      const pending = loadListScript(key);
      listCache.set(key, pending);
      pending.catch(() => { if (listCache.get(key) === pending) listCache.delete(key); });
    }
    return listCache.get(key);
  };

  const loadShowCatalog = (catalogUrl) => {
    const resolved = new URL(String(catalogUrl || ''), document.baseURI);
    const unversioned = new URL(resolved.href);
    unversioned.search = '';
    unversioned.hash = '';
    const version = showCatalogVersions.get(unversioned.href);
    if (version) resolved.searchParams.set('v', version);
    const key = resolved.href;
    if (!showCatalogCache.has(key)) {
      const catalogs = window.VCARD_SHOW_CATALOGS ||= {};
      const read = () => catalogs[key]?.format === 'aliswb-shows-1' ? catalogs[key] : null;
      const pending = read() ? Promise.resolve(read()) : loadPublishedScript(key, read, 'show catalog');
      showCatalogCache.set(key, pending);
      pending.catch(() => { if (showCatalogCache.get(key) === pending) showCatalogCache.delete(key); });
    }
    return showCatalogCache.get(key);
  };

  const listDirectory = (listUrl) => {
    const path = String(listUrl || '').split(/[?#]/, 1)[0];
    return path.slice(0, path.lastIndexOf('/') + 1);
  };

  const listItemUrl = (listUrl, item) => vcardPublishedMediaUrl(`${listDirectory(listUrl)}${item}`);

  const normalizedName = (url) => {
    const path = String(url || '').split(/[?#]/, 1)[0];
    return path.slice(path.lastIndexOf('/') + 1).toLocaleLowerCase();
  };

  const normalizedSource = (url) => {
    try {
      const resolved = new URL(String(url || ''), document.baseURI);
      resolved.search = '';
      resolved.hash = '';
      return resolved.href.toLocaleLowerCase();
    } catch (_error) {
      return String(url || '').split(/[?#]/, 1)[0].replace(/\\/g, '/').toLocaleLowerCase();
    }
  };

  const portalMaskPair = (url) => {
    const name = normalizedName(url);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const match = stem.match(/^([pm])(\d+)$/i);
    if (!match) return null;
    return { pair: String(Number(match[2])), role: match[1].toLowerCase() };
  };

  const directMediaGroup = (source) => ({ source });

  const mediaGroups = (items) => {
    const groups = [];
    const byPortalPair = new Map();
    items.forEach((source) => {
      const maskPair = portalMaskPair(source);
      if (maskPair) {
        let group = byPortalPair.get(maskPair.pair);
        if (!group) {
          group = {
            base: '',
            mask: '',
            pairedPortal: true,
            photograph: '',
          };
          byPortalPair.set(maskPair.pair, group);
          groups.push(group);
        }
        if (maskPair.role === 'p') group.photograph = source;
        else group.mask = source;
        return;
      }
      groups.push(directMediaGroup(source));
    });
    return groups.flatMap((group) => {
      if (!group.pairedPortal) return group.source ? [group] : [];
      if (!group.photograph || !group.mask) return [];
      group.base = group.photograph;
      return [group];
    });
  };

  const normalizeImageMode = (value) => ({
    color: 'duo',
    bw: 'night',
    text: 'auto',
    acc: 'auto',
    sch: 'auto',
    'sch-inv': 'auto',
    def: 'auto',
  })[String(value || '').trim().toLowerCase()]
    || (['auto', 'night', 'newspaper', 'mono', 'mono-inverse', 'duo', 'gray']
      .includes(String(value || '').trim().toLowerCase())
      ? String(value || '').trim().toLowerCase()
      : 'auto');

  const automaticImageMode = () => {
    const preset = String(root.dataset.colorPreset || '').toLowerCase();
    if (['night', 'mono', 'duo', 'newspaper'].includes(preset)) return preset;
    return vcardSettingEnabled('vcard-mono-color', 'mono-color', 'off')
      ? 'mono'
      : 'night';
  };

  const requestedImageMode = (image) => {
    const ownMode = normalizeImageMode(image.getAttribute('image-color') || 'auto');
    return ownMode;
  };

  const effectiveImageMode = (image) => {
    const managedFrame = image.closest('.image-vibeframe, .song-vibeframe');
    if (managedFrame && document.documentElement.dataset.visBri === '0') {
      // Disabling background effects keeps every portal tinted, including Hi
      // and song photos. Only fullscreen inspection shows the original.
      return Boolean(window.VCardPortalLayout?.isFullscreen(image)) ? 'original' : 'color-tint';
    }
    if (managedFrame && !Boolean(window.VCardPortalLayout?.isFullscreen(image))) {
      const requested = requestedImageMode(image);
      if (requested === 'auto' && window.VCardDecoration?.current()?.preset === 'night'
        && window.VCardDecoration?.current()?.nightTone === 'accent') return 'duo';
      if (requested === 'auto') return automaticImageMode();
      if (requested === 'mono') return 'color-tint';
      return requested;
    }
    const requested = requestedImageMode(image);
    return requested === 'auto' ? automaticImageMode() : requested;
  };

  const sourcesForMode = (group, mode, fullscreen = false) => {
    if (!group) return [];
    if (group.pairedPortal && group.base) {
      return [group.base];
    }
    return group.source ? [group.source] : [];
  };

  const sourceForMode = (group, mode, fullscreen = false) => (
    sourcesForMode(group, mode, fullscreen)[0] || ''
  );

  const currentAccentColor = () => (
    getComputedStyle(document.documentElement).getPropertyValue('--vc-acc').trim()
  );

  const applyImageEffect = (image, mode = effectiveImageMode(image)) => {
    if (Boolean(window.VCardPortalLayout?.isFullscreen(image))) {
      image.dataset.imageEffect = 'original';
      return 'original';
    }
    image.dataset.imageEffect = mode;
    return mode;
  };

  const ensurePortalMotionLayer = (image) => {
    const existing = image.closest('.vcard-portal-motion-layer');
    if (existing) return existing;
    const frame = image.closest('.song-vibeframe, .image-vibeframe');
    if (!frame) return null;
    const layer = document.createElement('div');
    layer.className = 'vcard-portal-motion-layer';
    frame.insertBefore(layer, image);
    layer.append(image);
    return layer;
  };

  const portalRenderChunkBytes = 256 * 1024;
  const yieldPortalRender = (shouldContinue = () => true, signal = null) => (
    vcardRenderScheduler.prepare(() => undefined, { isCurrent: shouldContinue, signal })
  );

  const colorizePortalPixels = async (
    basePixels,
    maskPixels,
    accent,
    shouldContinue = () => true,
    signal = null
  ) => {
    let chunkStarted = performance.now();
    const output = new ImageData(basePixels.width, basePixels.height);
    // Keep masked objects vivid even when the page accent itself is dark:
    // preserve its hue ratios and lift its strongest channel to full intensity.
    const accentPeak = Math.max(accent[0], accent[1], accent[2]);
    const targetRed = accentPeak > 0 ? accent[0] / accentPeak : 1;
    const targetGreen = accentPeak > 0 ? accent[1] / accentPeak : 1;
    const targetBlue = accentPeak > 0 ? accent[2] / accentPeak : 1;
    const targetLuminance = (
      targetRed * 0.3
      + targetGreen * 0.59
      + targetBlue * 0.11
    );
    let maskedLuminance = 0;
    let maskWeight = 0;
    for (let start = 0; start < basePixels.data.length; start += portalRenderChunkBytes) {
      if (!shouldContinue()) return null;
      const end = Math.min(basePixels.data.length, start + portalRenderChunkBytes);
      for (let index = start; index < end; index += 4) {
        const weight = (
          maskPixels.data[index] * 0.2126
          + maskPixels.data[index + 1] * 0.7152
          + maskPixels.data[index + 2] * 0.0722
        ) * (maskPixels.data[index + 3] / 255);
        if (weight <= 0) continue;
        const sourceLuminance = (
          (basePixels.data[index] / 255) * 0.3
          + (basePixels.data[index + 1] / 255) * 0.59
          + (basePixels.data[index + 2] / 255) * 0.11
        );
        maskedLuminance += sourceLuminance * weight;
        maskWeight += weight;
      }
      if (performance.now() - chunkStarted >= 4 && end < basePixels.data.length) {
        await yieldPortalRender(shouldContinue, signal);
        chunkStarted = performance.now();
      }
    }
    const sourceCenter = maskWeight > 0
      ? maskedLuminance / maskWeight
      : targetLuminance;
    for (let start = 0; start < basePixels.data.length; start += portalRenderChunkBytes) {
      if (!shouldContinue()) return null;
      const end = Math.min(basePixels.data.length, start + portalRenderChunkBytes);
      for (let index = start; index < end; index += 4) {
        const sourceRed = basePixels.data[index] / 255;
        const sourceGreen = basePixels.data[index + 1] / 255;
        const sourceBlue = basePixels.data[index + 2] / 255;
        const sourceLuminance = (
          sourceRed * 0.3
          + sourceGreen * 0.59
          + sourceBlue * 0.11
        );
        const materialLuminance = Math.max(0, Math.min(
          1,
          targetLuminance + (sourceLuminance - sourceCenter) * 0.8
        ));
        const luminanceShift = materialLuminance - targetLuminance;
        let red = targetRed + luminanceShift;
        let green = targetGreen + luminanceShift;
        let blue = targetBlue + luminanceShift;
        const minimum = Math.min(red, green, blue);
        const maximum = Math.max(red, green, blue);
        if (minimum < 0 && materialLuminance > 0) {
          red = materialLuminance + (
            (red - materialLuminance) * materialLuminance
            / (materialLuminance - minimum)
          );
          green = materialLuminance + (
            (green - materialLuminance) * materialLuminance
            / (materialLuminance - minimum)
          );
          blue = materialLuminance + (
            (blue - materialLuminance) * materialLuminance
            / (materialLuminance - minimum)
          );
        }
        if (maximum > 1 && materialLuminance < 1) {
          red = materialLuminance + (
            (red - materialLuminance) * (1 - materialLuminance)
            / (maximum - materialLuminance)
          );
          green = materialLuminance + (
            (green - materialLuminance) * (1 - materialLuminance)
            / (maximum - materialLuminance)
          );
          blue = materialLuminance + (
            (blue - materialLuminance) * (1 - materialLuminance)
            / (maximum - materialLuminance)
          );
        }
        const maskLuminance = (
          maskPixels.data[index] * 0.2126
          + maskPixels.data[index + 1] * 0.7152
          + maskPixels.data[index + 2] * 0.0722
        );
        output.data[index] = Math.round(Math.max(0, Math.min(1, red)) * 255);
        output.data[index + 1] = Math.round(Math.max(0, Math.min(1, green)) * 255);
        output.data[index + 2] = Math.round(Math.max(0, Math.min(1, blue)) * 255);
        output.data[index + 3] = Math.round(
          maskLuminance * (maskPixels.data[index + 3] / 255)
        );
      }
      if (performance.now() - chunkStarted >= 4 && end < basePixels.data.length) {
        await yieldPortalRender(shouldContinue, signal);
        chunkStarted = performance.now();
      }
    }
    return output;
  };

  const ensurePortalPairCanvas = (image) => {
    const motionLayer = ensurePortalMotionLayer(image);
    if (!motionLayer) return null;
    let canvas = motionLayer.querySelector(':scope > .vcard-portal-mask-overlay');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'vcard-portal-mask-overlay';
      canvas.setAttribute('aria-hidden', 'true');
      motionLayer.append(canvas);
    }
    return { motionLayer, canvas };
  };

  const setPortalImageGlow = (image, level = 0, timing = 0) => {
    const motionLayer = image?.closest('.vcard-portal-motion-layer');
    if (!motionLayer) return false;
    motionLayer.querySelectorAll(':scope > .vcard-portal-image-glow').forEach(
      (glow) => glow.remove()
    );
    const strength = Math.max(0, Math.min(10, Number(level) || 0));
    const source = image.currentSrc || image.getAttribute('src') || '';
    if (!strength || !source) return false;
    const glow = document.createElement('img');
    glow.className = 'vcard-portal-image-glow';
    glow.alt = '';
    glow.setAttribute('aria-hidden', 'true');
    glow.src = source;
    const opacity = strength / 10;
    glow.style.setProperty('--vc-portal-image-glow-opacity', String(opacity));
    motionLayer.insertBefore(glow, image.nextSibling);
    const pulse = timing && typeof timing === 'object' && Boolean(timing.pulse);
    const seconds = Math.max(0, Number(pulse ? timing.duration : timing) || 0);
    if (seconds > 0 && vcardMotionPolicy.snapshot().motionAllowed) {
      const pulses = pulse
        ? Math.max(1, Math.floor(Number(timing.pulses) || 1))
        : 1;
      const pulseFrames = pulse
        ? Array.from({ length: pulses * 2 + 1 }, (_item, index) => ({
          opacity: index % 2 ? opacity : 0,
          offset: index / (pulses * 2),
        }))
        : null;
      const animation = glow.animate(
        pulse ? pulseFrames : [{ opacity: 0 }, { opacity }],
        {
          duration: seconds * 1000,
          easing: 'ease-in-out',
          fill: pulse ? 'both' : 'none',
        }
      );
      if (pulse) {
        animation.currentTime = Math.max(
          0,
          Math.min(seconds, Number(timing.elapsed) || 0)
        ) * 1000;
        if (sharedSongAudio.paused) animation.pause();
      }
    }
    return true;
  };

  const portalFadeTiming = (value = vcardMagicTimeSeconds) => {
    if (value && typeof value === 'object') {
      return {
        fade: Math.max(0, Number(value.fade) || 0),
        unfade: Math.max(0, Number(value.unfade) || 0),
      };
    }
    const duration = Math.max(0, Number(value) || 0);
    return { fade: duration, unfade: duration };
  };

  const beginPortalImageCrossfade = (image, timing = vcardMagicTimeSeconds) => {
    if (!vcardMotionPolicy.snapshot().motionAllowed) return;
    if (!image.classList.contains('song__preview-image') || !image.getAttribute('src')) {
      return;
    }
    const durations = portalFadeTiming(timing);
    const motionLayer = ensurePortalMotionLayer(image);
    if (!motionLayer) return;
    motionLayer.querySelectorAll(':scope > .vcard-portal-crossfade-previous').forEach((frame) => {
      frame.remove();
    });
    const previous = document.createElement('div');
    previous.className = 'vcard-portal-crossfade-previous';
    previous.setAttribute('aria-hidden', 'true');
    const previousImage = image.cloneNode(true);
    previousImage.removeAttribute('id');
    previous.append(previousImage);
    const activeCanvas = motionLayer.querySelector(
      ':scope > .vcard-portal-mask-overlay.is-ready'
    );
    if (activeCanvas && activeCanvas.width && activeCanvas.height) {
      const previousCanvas = document.createElement('canvas');
      previousCanvas.width = activeCanvas.width;
      previousCanvas.height = activeCanvas.height;
      previousCanvas.getContext('2d').drawImage(activeCanvas, 0, 0);
      // A canvas clone contains only pixels, not the live Web Animation state.
      // Preserve the exact pulse level of the outgoing mask so the transition
      // snapshot cannot flash at default opacity/brightness before fading.
      const activeCanvasStyle = getComputedStyle(activeCanvas);
      previousCanvas.style.opacity = activeCanvasStyle.opacity;
      previousCanvas.style.filter = activeCanvasStyle.filter;
      previous.append(previousCanvas);
    }
    motionLayer.append(previous);
    const animation = previous.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      {
        duration: durations.fade * 1000,
        easing: 'ease-in-out',
        fill: 'forwards',
      }
    );
    const finished = animation.finished.then(() => {
      previous.remove();
      return true;
    }).catch(() => false);
    return { ...durations, finished };
  };

  const unfadePortalImage = (image, timing) => {
    const duration = portalFadeTiming(timing).unfade;
    if (!duration || !vcardMotionPolicy.snapshot().motionAllowed) return;
    // The paired mask canvas is published separately after its pixels are
    // ready. renderState gives a static mask the same unfade timing, while an
    // opacity pulse continues to own the canvas level itself.
    image.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: duration * 1000,
      easing: 'ease-in-out',
    });
  };

  document.addEventListener('vcard:visualization-state', (event) => {
    if (Number(event.detail && event.detail.brightnessLevel) !== 0) return;
    document.querySelectorAll('.vcard-portal-crossfade-previous').forEach((frame) => {
      frame.remove();
    });
  }, { signal: mediaScope.signal });

  const loadPortalPairImage = (source, signal = null) => loader.request(
    vcardPublishedMediaUrl(source), 'image', (loadSignal) => new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      loadSignal.removeEventListener('abort', onAbort);
      image.onload = image.onerror = null;
      if (error) { image.removeAttribute('src'); reject(error); }
      else if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve(image);
      else reject(new Error(`invalid image: ${source}`));
    };
    const timeout = window.setTimeout(() => finish(new Error(`timeout loading image: ${source}`)), 15000);
    const onAbort = () => finish(new DOMException('Image load cancelled', 'AbortError'));
    loadSignal.addEventListener('abort', onAbort, { once: true });
    image.onload = () => {
      if (typeof image.decode !== 'function') { finish(); return; }
      image.decode().then(() => finish(), (error) => finish(error));
    };
    image.onerror = () => finish(new Error(`cannot load image: ${source}`));
    image.src = vcardPublishedMediaUrl(source);
  }), signal).promise;

  const portalStyleName = (value) => {
    const normalized = String(value || '').trim().toLocaleLowerCase();
    const match = normalized.match(/s_[a-z0-9_-]+/i);
    return match ? match[0].toLocaleLowerCase() : '';
  };

  const portalCatalogItemUrl = (catalogUrl, item) => {
    if (!catalogUrl || !item) return '';
    return new URL(item, new URL(catalogUrl, document.baseURI)).href;
  };

  const portalStyleContext = (image) => {
    const catalog = image.vcardShowCatalog;
    const shows = Array.isArray(catalog?.shows) ? catalog.shows : [];
    const selectedName = image.vcardShowSelection?.name || catalog?.defaultShow;
    const show = shows.find((item) => item.name === selectedName) || {};
    return {
      params: show.styleParams || {},
      images: show.images || {},
      catalogUrl: String(image.vcardShowSelection?.catalogUrl || image.dataset.portalShows || ''),
      grayProfile: catalog?.grayProfile || null,
      grayProfileSha256: String(catalog?.grayProfileSha256 || ''),
    };
  };

  const portalSourceNumber = (source) => {
    const stem = normalizedName(source).replace(/\.[^.]*$/, '');
    const match = stem.match(/^(\d+)/);
    return match ? String(Number(match[1])) : '';
  };

  const portalSourceSeries = (source) => {
    let parts = [];
    try {
      parts = new URL(source, document.baseURI).pathname.split('/').map((part) => decodeURIComponent(part));
    } catch (_error) {
      parts = String(source || '').replace(/\\/g, '/').split('/');
    }
    for (let index = 0; index + 1 < parts.length; index += 1) {
      const series = String(parts[index] || '').toLocaleLowerCase();
      const collection = String(parts[index + 1] || '').toLocaleLowerCase();
      if (['backs', 'ghosts', 'traces', 'parts'].includes(series) && collection === 'img') {
        return series;
      }
    }
    return '';
  };

  const portalCollectionName = (source, collection) => {
    const series = portalSourceSeries(source);
    return series ? `${series}/${collection}` : collection;
  };

  const portalLevel = (value, params) => {
    const black = Number(params.black);
    const white = Number(params.white);
    const gamma = Number(params.gamma);
    const outBlack = Number(params.out_black ?? 0);
    const outWhite = Number(params.out_white ?? 255);
    if (!(white > black) || !(gamma > 0) || !(outWhite > outBlack)) return value;
    const normalized = Math.max(0, Math.min(1, (value - black) / (white - black)));
    return outBlack + (outWhite - outBlack) * normalized ** (1 / gamma);
  };

  const portalProfileGray = (red, green, blue, profile) => {
    if (
      !Array.isArray(profile?.decode)
      || profile.decode.length !== 3
      || !Array.isArray(profile?.weights)
      || !Array.isArray(profile?.grayTRC)
    ) {
      return red * 0.2126 + green * 0.7152 + blue * 0.0722;
    }
    const luminance = (
      profile.decode[0][red] * profile.weights[0]
      + profile.decode[1][green] * profile.weights[1]
      + profile.decode[2][blue] * profile.weights[2]
    );
    const trc = profile.grayTRC;
    let low = 1;
    let high = trc.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (trc[middle] < luminance) low = middle + 1;
      else high = middle;
    }
    return Math.max(0, Math.min(255, (
      low - 1 + (luminance - trc[low - 1]) / (trc[low] - trc[low - 1])
    ) * 255 / (trc.length - 1)));
  };

  const applyBurnGlow = (canvas, stage) => {
    const stageNumber = Math.max(0, Math.min(5, Math.round(Number(stage) || 0)));
    const settings = [
      [0.006, 0.36], [0.009, 0.60], [0.012, 0.88],
      [0.016, 1.24], [0.021, 1.64],
    ][stageNumber - 1];
    if (!settings) return;
    const [radiusFactor, strength] = settings;
    const blurred = document.createElement('canvas');
    blurred.width = canvas.width;
    blurred.height = canvas.height;
    const blurredContext = blurred.getContext('2d');
    blurredContext.filter = `blur(${Math.max(
      1, Math.round(Math.min(canvas.width, canvas.height) * radiusFactor)
    )}px)`;
    blurredContext.drawImage(canvas, 0, 0);
    const context = canvas.getContext('2d');
    context.save();
    context.globalCompositeOperation = 'screen';
    for (let pass = 0; pass < Math.floor(strength); pass += 1) {
      context.drawImage(blurred, 0, 0);
    }
    context.globalAlpha = strength - Math.floor(strength);
    if (context.globalAlpha) context.drawImage(blurred, 0, 0);
    context.restore();
  };

  const renderBrowserStyle = async (
    source,
    style,
    params,
    inputMode,
    grayProfile,
    profileId,
    owner
  ) => {
    if (owner.released) throw new DOMException('Style owner released', 'AbortError');
    const cacheKey = (
      `${source}\n${style}\n${inputMode}\n${profileId}\n${JSON.stringify(params || {})}`
    );
    let entry = browserStyleCache.get(cacheKey);
    if (!entry) {
      entry = { key: cacheKey, owners: new Set(), url: '', promise: null,
        controller: new AbortController() };
      browserStyleCache.set(cacheKey, entry);
      entry.promise = (async () => {
        const loader = await loadPortalPairImage(source, entry.controller.signal);
        if (!entry.owners.size) throw new DOMException('Style owner released', 'AbortError');
        const width = loader.naturalWidth;
        const height = loader.naturalHeight;
        if (!width || !height) throw new Error('Empty PortalTV style source');
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', {
          willReadFrequently: true,
          colorSpace: 'srgb',
        });
        context.drawImage(loader, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height);
        let chunkStarted = performance.now();
        for (let index = 0; index < pixels.data.length; index += 4) {
          if (index % portalRenderChunkBytes === 0) {
            if (!entry.owners.size || entry.controller.signal.aborted) {
              throw new DOMException('Style owner released', 'AbortError');
            }
            if (performance.now() - chunkStarted >= 4) {
              await yieldPortalRender(() => entry.owners.size > 0, entry.controller.signal);
              chunkStarted = performance.now();
            }
          }
          if (style === 's_alarm' || style === 's_bitmap' || style === 's_inverse') {
            const gray = inputMode === 'gray'
              ? pixels.data[index]
              : Math.round(portalProfileGray(
                pixels.data[index],
                pixels.data[index + 1],
                pixels.data[index + 2],
                grayProfile
              ));
            let value = Math.round(Math.max(0, Math.min(255, portalLevel(gray, params))));
            if (
              (style === 's_bitmap' || style === 's_inverse')
              && Number(params.apply_bitmap ?? 1) !== 0
            ) {
              const threshold = Number(params.threshold) || 128;
              const inverted = Boolean(Number(params.invert));
              value = value >= threshold ? 255 : 0;
              if (inverted) value = 255 - value;
            }
            pixels.data[index] = value;
            pixels.data[index + 1] = value;
            pixels.data[index + 2] = value;
          } else if (style === 's_burn') {
            pixels.data[index] = Math.round(Math.max(
              0, Math.min(255, portalLevel(pixels.data[index], params))
            ));
            pixels.data[index + 1] = Math.round(Math.max(
              0, Math.min(255, portalLevel(pixels.data[index + 1], params))
            ));
            pixels.data[index + 2] = Math.round(Math.max(
              0, Math.min(255, portalLevel(pixels.data[index + 2], params))
            ));
          } else if (style === 's_bright') {
            const channels = [
              pixels.data[index], pixels.data[index + 1], pixels.data[index + 2]
            ];
            const maximum = Math.max(...channels);
            const minimum = Math.min(...channels);
            if (maximum > 0) {
              const lift = Math.max(0, Number(params.lift) || 0);
              const vibrance = Math.max(0, Number(params.vibrance) || 0);
              const value = maximum / 255;
              const delta = (maximum - minimum) / 255;
              const saturation = delta / value;
              const protection = delta / (delta + 0.08) * value / (value + 0.06);
              const factor = 1 + vibrance * (1 - saturation)
                / (1 + vibrance * saturation) * protection;
              const lifted = value * (1 + lift) / (1 + lift * value);
              channels.forEach((channel, offset) => {
                pixels.data[index + offset] = Math.round(Math.max(0, Math.min(
                  255,
                  255 * lifted * (1 + factor * (channel / maximum - 1))
                )));
              });
            }
          }
        }
        context.putImageData(pixels, 0, 0);
        if (style === 's_burn') applyBurnGlow(canvas, params.glow_stage);
        const blob = await new Promise((resolve, reject) => canvas.toBlob(
          (value) => value ? resolve(value) : reject(new Error('PortalTV style encoding failed')),
          'image/webp',
          0.9
        ));
        if (!entry.owners.size) throw new DOMException('Style owner released', 'AbortError');
        entry.url = URL.createObjectURL(blob);
        entry.bytes = blob.size;
        return entry.url;
      })().catch((error) => {
        if (browserStyleCache.get(cacheKey) === entry) browserStyleCache.delete(cacheKey);
        for (const consumer of entry.owners) consumer.styleResources?.delete(entry);
        entry.owners.clear();
        throw error;
      });
    }
    entry.owners.add(owner);
    (owner.styleResources ||= new Set()).add(entry);
    return entry.promise;
  };

  const decodePortalImage = (source, signal = null) => loadPortalPairImage(source, signal);

  const portalPairCacheKey = (baseSource, maskSource, accentColor) => (
    `${baseSource}\n${maskSource}\n${accentColor}`
  );

  const runWhenIdle = (callback) => {
    if (typeof window.requestIdleCallback === 'function') {
      return window.requestIdleCallback(callback, { timeout: 1200 });
    }
    return window.setTimeout(callback, 80);
  };

  const preparePortalPairOverlay = async (
    baseSource,
    maskSource,
    accentColor,
    shouldContinue = () => true,
    signal = null
  ) => {
    const [baseLoader, maskLoader] = await Promise.all([
      loadPortalPairImage(baseSource, signal),
      loadPortalPairImage(maskSource, signal),
    ]);
    if (signal?.aborted || !shouldContinue()) throw new DOMException('Portal pair cancelled', 'AbortError');
    await yieldPortalRender(shouldContinue, signal);
    const width = baseLoader.naturalWidth;
    const height = baseLoader.naturalHeight;
    if (!width || !height) throw new Error('Empty portal pair image');
    if (maskLoader.naturalWidth !== width || maskLoader.naturalHeight !== height) {
      throw new Error('Portal base and mask dimensions differ');
    }
    const baseCanvas = document.createElement('canvas');
    baseCanvas.width = width;
    baseCanvas.height = height;
    const baseContext = baseCanvas.getContext('2d', { willReadFrequently: true });
    baseContext.drawImage(baseLoader, 0, 0, width, height);
    const basePixels = baseContext.getImageData(0, 0, width, height);
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });
    maskContext.drawImage(maskLoader, 0, 0, width, height);
    const maskPixels = maskContext.getImageData(0, 0, width, height);
    const accentCanvas = document.createElement('canvas');
    accentCanvas.width = 1;
    accentCanvas.height = 1;
    const accentContext = accentCanvas.getContext('2d', { willReadFrequently: true });
    accentContext.fillStyle = accentColor || currentAccentColor();
    accentContext.fillRect(0, 0, 1, 1);
    const accent = accentContext.getImageData(0, 0, 1, 1).data;
    const coloredPixels = await colorizePortalPixels(
      basePixels,
      maskPixels,
      accent,
      shouldContinue,
      signal
    );
    if (!coloredPixels) throw new Error('Portal render cancelled');
    return {
      width,
      height,
      coloredPixels,
    };
  };

  const publishPortalMaskState = (image, ready, startsAtMinimum = false) => {
    document.dispatchEvent(new CustomEvent('vcard:portal-mask-state', {
      detail: {
        image,
        preview: image?.closest('.song__preview') || null,
        ready: Boolean(ready),
        startsAtMinimum: Boolean(startsAtMinimum),
      }
    }));
  };

  const publishPortalFrameReady = async (image, version, status = {}) => {
    const state = mediaStates.get(image);
    if (image.dataset.portalPreviewPending === 'true' && !status.failed) {
      try { await image.decode(); } catch (_error) { }
      if (mediaStates.get(image) !== state || state?.renderVersion !== version || !state.active) return;
    }
    if (state?.renderVersion === version) delete image.dataset.portalPreviewPending;
    if (!document.hidden && document.documentElement.dataset.imagesVisible !== 'off'
      && state?.active && state.pendingRandomIndex === null
      && !status.failed
      && (state.frameMaskMode !== 'required' || status.maskReady === true)
      && state.frameReservation?.item.index === state.index) {
      state.frameReservation.commit();
      state.frameReservation = null;
      publishPortalImageState(image);
    }
    document.dispatchEvent(new CustomEvent('vcard:portal-frame-ready', {
      detail: { image, version, ...status },
    }));
  };

  const resetPortalCanvasAnimations = (canvas) => {
    canvas.getAnimations().forEach((animation) => animation.cancel());
  };

  const commitPortalPairOverlay = (image, prepared) => {
    const pairSurface = ensurePortalPairCanvas(image);
    if (!pairSurface) return false;
    const { motionLayer, canvas } = pairSurface;
    motionLayer.style.aspectRatio = `${prepared.width} / ${prepared.height}`;
    resetPortalCanvasAnimations(canvas);
    motionLayer.querySelectorAll(':scope > .vcard-portal-mask-glow').forEach((glow) => {
      glow.getAnimations().forEach((animation) => animation.cancel());
      glow.remove();
    });
    const startsAtMinimum = image.dataset.portalMaskStartsAtMinimum === 'true';
    canvas.style.setProperty('--vc-pulse-mask-opacity', startsAtMinimum ? '0' : '1');
    canvas.style.setProperty('--vc-pulse-mask-brightness', '1');
    canvas.width = prepared.width;
    canvas.height = prepared.height;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, prepared.width, prepared.height);
    context.putImageData(prepared.coloredPixels, 0, 0);
    canvas.classList.add('is-ready');
    motionLayer.classList.remove('is-pair-pending');
    // The canvas is reused between frames. A configured opacity pulse starts
    // at its minimum; without one the colored object is immediately visible.
    publishPortalMaskState(image, true, startsAtMinimum);
    return true;
  };

  const clearPortalPairOverlay = (image) => {
    const motionLayer = image.closest('.vcard-portal-motion-layer');
    const canvas = motionLayer?.querySelector(':scope > .vcard-portal-mask-overlay');
    if (canvas) {
      resetPortalCanvasAnimations(canvas);
      canvas.remove();
    }
    motionLayer?.classList.remove('is-pair-pending');
    publishPortalMaskState(image, false);
  };

  const transitionPortalPairOverlay = (
    image,
    prepared,
    timing,
    shouldContinue = () => true
  ) => {
    const pairSurface = ensurePortalPairCanvas(image);
    if (!pairSurface) return;
    const { canvas } = pairSurface;
    resetPortalCanvasAnimations(canvas);
    const duration = vcardMotionPolicy.snapshot().motionAllowed ? portalFadeTiming(timing).unfade : 0;
    if (prepared) {
      commitPortalPairOverlay(image, prepared);
      if (duration > 0) {
        canvas.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: duration * 1000,
          easing: 'ease-in-out',
        });
      }
      return;
    }
    if (!canvas.classList.contains('is-ready')) {
      clearPortalPairOverlay(image);
      return;
    }
    if (duration <= 0) {
      clearPortalPairOverlay(image);
      return;
    }
    const animation = canvas.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: duration * 1000,
      easing: 'ease-in-out',
    });
    animation.addEventListener('finish', () => {
      if (shouldContinue()) clearPortalPairOverlay(image);
    }, { once: true, signal: mediaScope.signal });
  };

  const releasePortalPairOverlay = (image) => {
    const motionLayer = image.closest('.vcard-portal-motion-layer');
    if (!motionLayer) return;
    const canvas = motionLayer && motionLayer.querySelector(
      ':scope > .vcard-portal-mask-overlay'
    );
    if (canvas) {
      resetPortalCanvasAnimations(canvas);
      canvas.remove();
    }
    motionLayer.querySelectorAll(':scope > .vcard-portal-crossfade-previous').forEach(
      (frame) => frame.remove()
    );
    motionLayer.classList.remove('is-pair-pending');
    publishPortalMaskState(image, false);
  };

  const setActive = (image, active = true) => {
    if (!image) return;
    const state = mediaStates.get(image);
    if (active) {
      const wasActive = activeImages.has(image) && (!state || state.active);
      activeImages.add(image);
      if (state) {
        state.active = true;
        if (!wasActive) renderState(image);
      }
      return;
    }
    activeImages.delete(image);
    if (!state) return;
    state.active = false;
    state.renderVersion = (state.renderVersion || 0) + 1;
    state.renderAbort?.abort();
    state.pairAbort?.abort();
    state.pairRenderVersion = (state.pairRenderVersion || 0) + 1;
    releasePortalPairOverlay(image);
  };

  const syncPortalPairOverlay = (image, baseSource = '', maskSource = '', hideUntilReady = false) => {
    const state = mediaStates.get(image);
    if (vcardFileMode) {
      releasePortalPairOverlay(image);
      return Promise.resolve({ maskReady: false, maskFailed: true });
    }
    if (!baseSource || !maskSource) {
      if (state) {
        state.activePairBase = '';
        state.activePairMask = '';
      }
      const existingCanvas = image.closest('.vcard-portal-motion-layer')?.querySelector(
        ':scope > .vcard-portal-mask-overlay'
      );
      if (existingCanvas) clearPortalPairOverlay(image);
      return Promise.resolve({ maskReady: false, maskFailed: false });
    }
    const pairSurface = ensurePortalPairCanvas(image);
    if (!pairSurface) return Promise.resolve({ maskReady: false, maskFailed: true });
    const accentColor = (state && state.portalAccentColor) || currentAccentColor();
    const renderVersion = state?.renderVersion;
    const pendingKey = `${portalPairCacheKey(baseSource, maskSource, accentColor)}\n${renderVersion ?? ''}`;
    if (state?.pairPendingKey === pendingKey && state.pairPendingPromise
      && state.pairPendingSignal === state.pairAbort?.signal && !state.pairPendingSignal?.aborted) {
      return state.pairPendingPromise;
    }
    if (state) {
      state.pairAbort?.abort();
      state.pairAbort = new AbortController();
      state.pairRenderVersion = (state.pairRenderVersion || 0) + 1;
    }
    const version = state ? state.pairRenderVersion : 0;
    const signal = state?.pairAbort?.signal;
    const isCurrent = () => !mediaScope.signal.aborted && !signal?.aborted
      && (!state || (!state.released && state.active && mediaStates.get(image) === state
        && renderVersion === state.renderVersion && version === state.pairRenderVersion));
    if (hideUntilReady) pairSurface.motionLayer.classList.add('is-pair-pending');
    const pending = preparePortalPairOverlay(
      baseSource,
      maskSource,
      accentColor,
      isCurrent,
      signal
    ).then((prepared) => {
      if (!isCurrent()) {
        return { maskReady: false, maskFailed: false };
      }
      const maskReady = commitPortalPairOverlay(image, prepared);
      if (state && maskReady) {
        state.activePairBase = baseSource;
        state.activePairMask = maskSource;
      }
      return {
        maskReady,
        maskFailed: false,
      };
    }).catch((error) => {
      if (!isCurrent()) {
        return { maskReady: false, maskFailed: false };
      }
      const cancelled = error?.name === 'AbortError' || error?.message === 'Portal render cancelled';
      if (!cancelled) {
        console.warn('VCard portal: cannot prepare mask overlay', error);
      }
      if ((!state || version === state.pairRenderVersion) && state?.frameMaskMode !== 'required') {
        clearPortalPairOverlay(image);
      }
      return {
        maskReady: false,
        maskFailed: !cancelled,
      };
    });
    if (!state) return pending;
    state.pairPendingKey = pendingKey;
    const ownedPending = pending.finally(() => {
      if (state.pairPendingPromise !== ownedPending) return;
      state.pairPendingKey = '';
      state.pairPendingPromise = null;
      state.pairPendingSignal = null;
    });
    state.pairPendingPromise = ownedPending;
    state.pairPendingSignal = signal;
    return state.pairPendingPromise;
  };

  const portalStyleSpec = (state, source, fullscreen) => {
    const style = fullscreen ? '' : String(state?.frameStyle || '');
    const number = portalSourceNumber(source);
    const maskCollection = portalCollectionName(source, 's_mask');
    const maskItem = !fullscreen && state?.frameUsesMask && number
      ? state?.showImages?.[maskCollection]?.[number]
      : '';
    const mask = portalCatalogItemUrl(state?.showCatalogUrl, maskItem);
    if (!style) {
      return {
        style: '',
        params: null,
        inputMode: 'color',
        mask,
      };
    }
    const styleCollection = portalCollectionName(source, style);
    const entry = number && state?.showStyleParams?.[styleCollection]?.[number];
    const params = entry?.parameters || entry;
    if (!params || !['s_alarm', 's_bitmap', 's_inverse', 's_bright', 's_burn'].includes(style)) {
      return { style: '', params: null, inputMode: 'color', mask };
    }
    return {
      style,
      params,
      inputMode: entry?.inputMode || 'color',
      mask,
    };
  };

  const portalFrameSource = (state, source) => {
    const collection = state?.frameStyle === 's_mask'
      ? 's_mask'
      : String(state?.frameSource || 'img');
    if (collection === 'img') return source;
    const number = portalSourceNumber(source);
    const catalogCollection = portalCollectionName(source, collection);
    const item = number && state?.showImages?.[catalogCollection]?.[number];
    return portalCatalogItemUrl(state?.showCatalogUrl, item) || source;
  };

  const portalImageMode = (image, state = mediaStates.get(image)) => {
    if (Boolean(window.VCardPortalLayout?.isFullscreen(image))) return effectiveImageMode(image);
    if (state?.frameTone === 'original') return 'original';
    // VCPlayer style `vc` means VCard tinting in every color preset. The generic
    // image mode `duo` intentionally preserves a color source, so it cannot be
    // reused here: the portal must first become grayscale and then receive the
    // current VCard text color through #vc-text-tint.
    if (state?.frameTone === 'vc') return 'vc-tint';
    if (state?.frameTone === 'vc_grey') return 'gray';
    return effectiveImageMode(image);
  };

  const portalImageStats = (image) => {
    const state = mediaStates.get(image);
    if (!state || !state.groups.length) {
      return { name: '-', current: 0, setTotal: 0, showTotal: 0 };
    }
    const group = state.groups[state.index] || state.groups[0];
    const item = sourceForMode(
      group,
      portalImageMode(image, state),
      Boolean(window.VCardPortalLayout?.isFullscreen(image))
    );
    const path = String(item || '').split(/[?#]/, 1)[0];
    let name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1) || '-';
    try { name = decodeURIComponent(name); } catch (_error) { }
    const showImages = Object.fromEntries(
      Object.entries(state.showImages || {}).filter(([name]) => name.endsWith('/img'))
    );
    return {
      name,
      current: state.index + 1,
      setTotal: state.groups.length,
      showTotal: Object.values(showImages).reduce(
        (total, collection) => total + Object.keys(collection || {}).length,
        0
      ) || state.groups.length,
    };
  };

  const portalMaskState = (image) => {
    const state = mediaStates.get(image);
    if (!state) return { uses: false, available: false, ready: false };
    const source = state.sourceKey || image.getAttribute('src') || '';
    const canvas = image.closest('.vcard-portal-motion-layer')?.querySelector(
      ':scope > .vcard-portal-mask-overlay.is-ready'
    );
    return {
      uses: Boolean(state.frameUsesMask),
      available: Boolean(state.frameUsesMask
        && (state.groups[state.index]?.mask || portalStyleSpec(state, source, false).mask)),
      ready: Boolean(canvas),
    };
  };

  const publishPortalImageState = (image) => {
    const bag = mediaStates.get(image)?.frameBag;
    if (bag) {
      image.dataset.frameBagTotal = String(bag.items.length);
      image.dataset.frameBagRemaining = String(bag.remaining.length);
      image.dataset.frameBagReserved = String(Boolean(bag.reservation));
      image.dataset.frameBagLast = String(bag.last || '');
    }
    document.dispatchEvent(new CustomEvent('vcard:portal-image-state', {
      detail: {
        image,
        preview: image?.closest('.song__preview') || null,
        ...portalImageStats(image),
      }
    }));
  };

  const renderPortalStyleSource = (source, styleSpec, state, signal = null) => (
    styleSpec.style
      ? renderBrowserStyle(
        source,
        styleSpec.style,
        styleSpec.params,
        styleSpec.inputMode,
        state.grayProfile,
        state.grayProfileSha256,
        state
      ).catch((error) => {
        if (signal?.aborted || mediaScope.signal.aborted || state.released
          || error?.name === 'AbortError') throw error;
        // A style is optional even when the physical mask is required.
        // The caller still decodes the source and prepares the complete mask.
        console.warn('VCard portal: cannot prepare optional style; using source', error);
        return vcardPublishedMediaUrl(source);
      })
      : Promise.resolve(vcardPublishedMediaUrl(source))
  );

  const renderState = (
    image,
    preload = true,
    accentColor = '',
    crossfade = true,
    crossfadeTiming = vcardMagicTimeSeconds,
    maskTransition = false
  ) => {
    const state = mediaStates.get(image);
    if (state && !state.active) return;
    // The first preview has no published outgoing frame to crossfade from.
    // In particular, never retain its unprocessed HTML source as an overlay.
    if (image.dataset.portalPreviewPending === 'true') crossfade = false;
    const mode = portalImageMode(image, state);
    if (!state || !state.groups.length) {
      applyImageEffect(image, mode);
      return;
    }
    const group = state.groups[state.index] || state.groups[0];
    // A photograph/mask portal is composed from two independent color layers:
    // the photograph follows the bright page text color, while the masked
    // object is painted by the canvas overlay with --vc-acc.
    const isImageOfDay = image.classList.contains('iod-image')
      || image.hasAttribute('image-day');
    const baseMode = mode === 'duo'
      ? ((group.pairedPortal || isImageOfDay) ? 'color-tint' : 'duo')
      : mode;
    const fullscreen = Boolean(window.VCardPortalLayout?.isFullscreen(image));
    const items = sourcesForMode(group, mode, fullscreen);
    if (!items.length) return;
    const candidates = items.map((item) => portalFrameSource(
      state,
      state.listUrl ? listItemUrl(state.listUrl, item) : item
    ));
    const nextSource = candidates[0];
    const nextStyle = portalStyleSpec(state, nextSource, fullscreen);
    if (group.pairedPortal || nextStyle.mask) {
      state.portalAccentColor = String(accentColor || '').trim() || currentAccentColor();
    }
    const imageEffectFor = (styleSpec) => (
      styleSpec.style
        ? (state.frameTone === 'vc'
          ? 'vc-tint'
          : (state.frameTone === 'vc_grey' ? 'gray' : 'original'))
        : baseMode
    );
    const nextDisplayKey = [
      normalizedSource(nextSource),
      nextStyle.style,
      nextStyle.inputMode || '',
      nextStyle.mask,
      JSON.stringify(nextStyle.params || {}),
    ].join('\n');
    const pairedTone = (mode === 'duo' || mode === 'color-tint' || mode === 'vc-tint')
      && !fullscreen;
    const pairBase = pairedTone && group.pairedPortal && group.base
      ? (state.listUrl ? listItemUrl(state.listUrl, group.base) : group.base)
      : '';
    const pairMask = pairedTone && group.pairedPortal && group.mask
      ? (state.listUrl ? listItemUrl(state.listUrl, group.mask) : group.mask)
      : '';
    state.renderVersion = (state.renderVersion || 0) + 1;
    state.renderAbort?.abort();
    state.renderAbort = new AbortController();
    const renderSignal = state.renderAbort.signal;
    const version = state.renderVersion;
    const isCurrent = () => !mediaScope.signal.aborted && !renderSignal.aborted
      && !state.released && state.active && version === state.renderVersion
      && mediaStates.get(image) === state;
    if (state.frameMaskMode === 'required' && !(nextStyle.mask || pairMask)) {
      publishPortalFrameReady(image, version, { failed: true, maskFailed: true });
      return;
    }
    if (state.displayKey === nextDisplayKey) {
      applyImageEffect(image, imageEffectFor(nextStyle));
      const activePairBase = nextStyle.mask ? state.renderedSource : pairBase;
      const activePairMask = nextStyle.mask || pairMask;
      const pairSurface = ensurePortalPairCanvas(image);
      const hideUntilReady = Boolean(
        activePairBase
        && activePairMask
        && pairSurface
        && !pairSurface.canvas.classList.contains('is-ready')
      );
      syncPortalPairOverlay(image, activePairBase, activePairMask, hideUntilReady)
        .then((status) => {
          if (isCurrent()) publishPortalFrameReady(image, version, status);
        });
      return;
    }
    if (!preload) {
      const displaySource = renderPortalStyleSource(nextSource, nextStyle, state, renderSignal);
      displaySource.then((resolvedSource) => {
        if (!isCurrent()) return;
        image.setAttribute('src', resolvedSource);
        applyImageEffect(image, imageEffectFor(nextStyle));
        state.sourceKey = normalizedSource(nextSource);
        state.renderedSource = resolvedSource;
        state.displayKey = nextDisplayKey;
        syncPortalPairOverlay(
          image,
          nextStyle.mask ? resolvedSource : pairBase,
          nextStyle.mask || pairMask
        ).then((status) => {
          if (isCurrent()) publishPortalFrameReady(image, version, status);
        });
      }).catch((error) => {
        if (!isCurrent() || error?.name === 'AbortError'
          || error?.message === 'Portal render cancelled') return;
        if (state.frameMaskMode === 'required') {
          publishPortalFrameReady(image, version, { failed: true, maskFailed: true });
          return;
        }
        image.setAttribute('src', nextSource);
        applyImageEffect(image, imageEffectFor(nextStyle));
        state.sourceKey = normalizedSource(nextSource);
        state.renderedSource = nextSource;
        state.displayKey = nextDisplayKey;
        clearPortalPairOverlay(image);
        publishPortalFrameReady(image, version, { maskFailed: Boolean(nextStyle.mask) });
      });
      return;
    }
    const tryCandidate = (index) => {
      if (!isCurrent()) return;
      if (index >= candidates.length) {
        publishPortalFrameReady(image, version, { failed: true, maskFailed: state.frameMaskMode === 'required' });
        return;
      }
      const candidate = candidates[index];
      const candidateStyle = portalStyleSpec(state, candidate, fullscreen);
      const candidateDisplayKey = [
        normalizedSource(candidate),
        candidateStyle.style,
        candidateStyle.inputMode || '',
        candidateStyle.mask,
        JSON.stringify(candidateStyle.params || {}),
      ].join('\n');
      const accentColor = state.portalAccentColor || currentAccentColor();
      const displaySource = renderPortalStyleSource(candidate, candidateStyle, state, renderSignal);
      displaySource.then(async (resolvedSource) => {
        await loadPortalPairImage(resolvedSource, renderSignal);
        return resolvedSource;
      }).then(async (resolvedSource) => {
        if (!isCurrent()) return;
        const activePairBase = candidateStyle.mask ? resolvedSource : pairBase;
        const activePairMask = candidateStyle.mask || pairMask;
        const hasActivePair = Boolean(activePairBase && activePairMask);
        const existingPairCanvas = image.closest('.vcard-portal-motion-layer')?.querySelector(
          ':scope > .vcard-portal-mask-overlay.is-ready'
        );
        let preparedPair = null;
        if (hasActivePair) {
          // Build the complete base/mask pair before publishing either layer.
          // This prevents a new physical frame from spending a paint cycle
          // under the previous frame's mask or temporary style.
          preparedPair = await preparePortalPairOverlay(
            activePairBase,
            activePairMask,
            accentColor,
            isCurrent,
            renderSignal
          );
          if (!isCurrent()) return;
          state.activePairBase = activePairBase;
          state.activePairMask = activePairMask;
        } else {
          state.activePairBase = '';
          state.activePairMask = '';
        }
        const baseCrossfade = crossfade && !maskTransition
          ? beginPortalImageCrossfade(image, crossfadeTiming)
          : null;
        if (hasActivePair || existingPairCanvas) clearPortalPairOverlay(image);
        image.setAttribute('src', resolvedSource);
        applyImageEffect(image, imageEffectFor(candidateStyle));
        state.sourceKey = normalizedSource(candidate);
        state.renderedSource = resolvedSource;
        state.displayKey = candidateDisplayKey;
        if (crossfade && !maskTransition) {
          unfadePortalImage(image, crossfadeTiming);
        }
        if (!preparedPair) {
          publishPortalFrameReady(image, version, { maskReady: false });
          return;
        }
        const staticMaskCrossfade = (
          crossfade
          && image.dataset.portalMaskStartsAtMinimum !== 'true'
        );
        if (maskTransition || staticMaskCrossfade) {
          transitionPortalPairOverlay(
            image,
            preparedPair,
            crossfadeTiming,
            isCurrent
          );
        } else {
          commitPortalPairOverlay(image, preparedPair);
        }
        publishPortalFrameReady(image, version, { maskReady: true });
      }).catch((error) => {
        if (!isCurrent() || error?.name === 'AbortError' || error?.message === 'Portal render cancelled') return;
        console.warn('VCard portal: cannot publish styled frame with mask', error);
        if (state.frameMaskMode === 'required') {
          tryCandidate(index + 1);
          return;
        }
        loadPortalPairImage(candidate, renderSignal).then(() => {
          if (!isCurrent()) return;
          image.setAttribute('src', candidate);
          applyImageEffect(image, imageEffectFor(candidateStyle));
          state.sourceKey = normalizedSource(candidate);
          state.renderedSource = candidate;
          state.displayKey = candidateDisplayKey;
          const existingPairCanvas = image.closest('.vcard-portal-motion-layer')?.querySelector(
            ':scope > .vcard-portal-mask-overlay'
          );
          if (existingPairCanvas) clearPortalPairOverlay(image);
          publishPortalFrameReady(image, version, {
            maskFailed: Boolean(candidateStyle.mask),
          });
        }).catch(() => tryCandidate(index + 1));
      });
    };
    tryCandidate(0);
  };

  const register = (image, listUrl, groups, index = 0) => {
    if (mediaScope.signal.aborted) return;
    clearPreload(image);
    releaseStyleResources(mediaStates.get(image));
    const initialIndex = Math.max(0, Math.min(index, Math.max(0, groups.length - 1)));
    const styleContext = portalStyleContext(image);
    const state = {
      listUrl,
      groups,
      primaryListUrl: listUrl,
      primaryGroups: groups,
      historyListUrls: [],
      historyExpanded: false,
      historyPromise: null,
      historyGeneration: 0,
      index: initialIndex,
      frameReservation: null,
      preloadGeneration: 0,
      renderVersion: 0,
      pairRenderVersion: 0,
      pairPendingKey: '',
      pairPendingPromise: null,
      portalAccentColor: '',
      activePairBase: '',
      activePairMask: '',
      showStyleParams: styleContext.params,
      showImages: styleContext.images,
      showCatalogUrl: styleContext.catalogUrl,
      grayProfile: styleContext.grayProfile,
      grayProfileSha256: styleContext.grayProfileSha256,
      frameSource: 'img',
      frameStyle: '',
      frameTone: 'vc',
      frameUsesMask: false,
      frameMaskMode: 'off',
      framePick: 'shuffle-bag',
      frameMaskOnly: false,
      frameBrightness: 0,
      frameContrast: 0,
      sourceKey: normalizedSource(image.getAttribute('src')),
      renderedSource: '',
      displayKey: '',
      pendingRandomIndex: null,
      active: activeImages.has(image) || !image.closest('.song__preview'),
    };
    mediaStates.set(image, state);
    setPortalFrame(
      image,
      image.vcardPendingPortalFrame || vcardPortalPlan.frame(image.closest('.song__preview')),
      false
    );
    delete image.vcardPendingPortalFrame;
    if (state.active && image.dataset.portalRandomStartPending !== 'true') {
      activeImages.add(image);
      renderState(image);
    }
  };

  const setPortalFrame = (image, step, render = true) => {
    const state = mediaStates.get(image);
    if (!step) return '';
    if (!state) {
      image.vcardPendingPortalFrame = { ...step };
      return '';
    }
    state.debugBaseFrame = { ...step };
    const debugStyle = debugStyles.get(debugStyleOwner(image));
    if (debugStyle) step = { ...step, style: debugStyle, maskMode: 'off', keepPhysicalIndex: true };
    if (document.documentElement.dataset.showGray === 'on') step = { ...step, maskMode: 'off' };
    const source = String(step.source || 'img').toLocaleLowerCase();
    const requestedStyle = step.style === undefined || step.style === null
      ? 'vc'
      : (String(step.style).trim().toLocaleLowerCase() || '0');
    const styleNames = requestedStyle.split(/\s+/).filter(Boolean);
    const tone = styleNames.includes('vc')
      ? 'vc'
      : (styleNames.includes('vc_grey') ? 'vc_grey' : 'original');
    const style = portalStyleName(requestedStyle);
    const configuredMaskMode = String(step.maskMode || '').toLowerCase();
    const maskMode = ['off', 'optional', 'required'].includes(configuredMaskMode)
      ? configuredMaskMode
      : (styleNames.includes('vc_mask') ? 'required' : 'off');
    const usesMask = maskMode !== 'off';
    const maskOnly = Boolean(step.maskOnly);
    const previousMaskOnly = state.frameMaskOnly;
    const brightness = Number(step.brightness) || 0;
    const contrast = Number(step.contrast) || 0;
    const pick = String(step.pick || 'shuffle-bag').toLowerCase();
    const basePipelineChanged = source !== state.frameSource
      || style !== state.frameStyle
      || tone !== state.frameTone;
    const maskChanged = usesMask !== state.frameUsesMask
      || maskMode !== state.frameMaskMode;
    const pipelineChanged = basePipelineChanged || maskChanged;
    const levelsChanged = brightness !== state.frameBrightness
      || contrast !== state.frameContrast;
    state.frameSource = source;
    state.frameStyle = style;
    state.frameTone = tone;
    state.frameUsesMask = usesMask;
    state.frameMaskMode = maskMode;
    state.framePick = pick;
    state.frameMaskOnly = maskOnly;
    state.frameBrightness = brightness;
    state.frameContrast = contrast;
    if (usesMask && !step.keepPhysicalIndex && image.dataset.portalClone !== 'true') {
      const maskCandidates = maskCapableCandidates(image, state, [state.index]);
      if (maskCandidates.length && !maskCandidates.includes(state.index)) {
        clearPreload(image);
        const reservation = reserveFrame(image, maskCandidates);
        if (reservation) {
          state.index = reservation.item.index;
          state.frameReservation = reservation;
        }
      }
    }
    const motionLayer = ensurePortalMotionLayer(image);
    if (motionLayer && (pipelineChanged || levelsChanged)) {
      const brightnessFactor = Math.max(0.1, Math.min(3, 1 + brightness * 0.1));
      const contrastFactor = Math.max(0.1, Math.min(3, 1 + contrast * 0.1));
      motionLayer.style.setProperty('--vc-director-brightness', String(brightnessFactor));
      motionLayer.style.setProperty('--vc-director-contrast', String(contrastFactor));
    }
    if (pipelineChanged && render) {
      const preview = image.closest('.song__preview');
      const transitionDuration = Math.max(0, step.transitionDuration !== undefined
        ? (Number(step.transitionDuration) || 0)
        : (Number(vcardPortalPlan.settings(preview).FrameTransitionTime) || 0));
      const maskTransition = maskChanged
        && !basePipelineChanged
        && (maskOnly || previousMaskOnly);
      renderState(image, true, '', transitionDuration > 0, {
        fade: transitionDuration,
        unfade: transitionDuration,
      }, maskTransition);
    }
    return requestedStyle;
  };

  const reservePortalFrame = async (image, frame, signal = null, excluded = new Set(), origin = null) => {
    const state = mediaStates.get(image);
    if (!state || !frame || !state.groups.length || signal?.aborted) return null;
    if (Number.isInteger(state.pendingRandomIndex)
      && (excluded.has(state.pendingRandomIndex)
        || !maskCapableCandidates(image, state, [state.pendingRandomIndex], frame.maskMode, false).length)) {
      clearPreload(image);
    }
    const generation = state.preloadGeneration;
    const prepared = await prepareNext(image, frame.pick, frame.maskMode, excluded, signal, origin);
    if (state.preloadGeneration !== generation || mediaStates.get(image) !== state) return null;
    if (signal?.aborted || !prepared) {
      clearPreload(image);
      return null;
    }
    const pending = Number.isInteger(state.pendingRandomIndex)
      ? state.pendingRandomIndex
      : state.index;
    if (signal?.aborted || state.preloadGeneration !== generation) return null;
    return {
      index: pending,
      consumesBag: Boolean(state.frameReservation),
      generation,
      owner: state,
    };
  };

  const cancelPortalFrame = (image, reservation) => {
    const state = mediaStates.get(image);
    if (!state || !reservation || reservation.owner !== state) return;
    if (state.preloadGeneration === reservation.generation
      && state.pendingRandomIndex === reservation.index) clearPreload(image);
  };

  const commitPortalFrame = (image, reservation) => {
    const state = mediaStates.get(image);
    if (!state || !reservation || window.VCLife?.renderingActive === false) return false;
    if (reservation.owner !== state) return false;
    if (state.preloadGeneration !== reservation.generation) return false;
    const index = Number(reservation.index);
    if (!Number.isInteger(index) || index < 0 || index >= state.groups.length) return false;
    if (reservation.consumesBag && state.pendingRandomIndex !== index) return false;
    if (reservation.consumesBag && !state.frameReservation?.commit()) return false;
    state.pendingRandomIndex = null;
    state.index = index;
    state.frameReservation = null;
    const showReservation = image.vcardShowReservation;
    showReservation?.commit();
    const showOwner = image.vcardShowReservationOwner;
    if (showOwner?.vcardShowReservation === showReservation) showOwner.vcardShowReservation = null;
    image.vcardShowReservation = null;
    // Notify observers after the scene and logical publication have finished
    // their synchronous commit; no observer sees a half-published slide.
    queueMicrotask(() => publishPortalImageState(image));
    return true;
  };

  const registerPortalClone = (source, target, index = 0) => {
    const sourceState = mediaStates.get(source);
    if (!sourceState || !target) return false;
    target.vcardDebugStyleOwner = debugStyleOwner(source);
    target.vcardShowCatalog = source.vcardShowCatalog;
    target.vcardShowSelection = source.vcardShowSelection;
    // The first visible clone confirms the show reserved by the source image.
    target.vcardShowReservation = source.vcardShowReservation;
    target.vcardShowReservationOwner = source;
    target.dataset.portalClone = 'true';
    ['frameBagTotal', 'frameBagRemaining', 'frameBagReserved', 'frameBagLast'].forEach((key) => delete target.dataset[key]);
    register(
      target,
      sourceState.primaryListUrl,
      sourceState.primaryGroups,
      index
    );
    setHistoryLists(target, sourceState.historyListUrls);
    return true;
  };

  const renderPortalFrameAt = (image, index, frame, isCurrent = () => true, signal = null) => {
    const state = mediaStates.get(image);
    if (mediaScope.signal.aborted || !state || !frame || !Number.isInteger(index) || signal?.aborted) return Promise.resolve(false);
    state.pendingRandomIndex = null;
    state.index = ((index % state.groups.length) + state.groups.length) % state.groups.length;
    setPortalFrame(image, frame, false);
    setActive(image, true);
    const beforeVersion = Number(state.renderVersion) || 0;
    let targetVersion = null;
    let seenVersion = null;
    let seenReady = false;
    let settled = false;
    let resolveReady;
    let renderOwner = null;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('vcard:portal-frame-ready', onReady);
      signal?.removeEventListener('abort', onAbort);
      mediaScope.signal.removeEventListener('abort', onAbort);
      renderOwner?.signal.removeEventListener('abort', onRenderAbort);
      resolveReady(Boolean(value));
    };
    const onRenderAbort = () => finish(false);
    const onAbort = () => {
      renderOwner?.abort();
      finish(false);
    };
    const onReady = (event) => {
      if (event.detail?.image !== image) return;
      seenVersion = Number(event.detail?.version);
      seenReady = !event.detail.failed
        && (state.frameMaskMode !== 'required' || event.detail.maskReady === true);
      if (targetVersion !== null && seenVersion === targetVersion) finish(seenReady && isCurrent());
    };
    document.addEventListener('vcard:portal-frame-ready', onReady);
    signal?.addEventListener('abort', onAbort, { once: true });
    mediaScope.signal.addEventListener('abort', onAbort, { once: true });
    renderState(image, true, '', false);
    renderOwner = state.renderAbort;
    if (!settled) renderOwner?.signal.addEventListener('abort', onRenderAbort, { once: true });
    targetVersion = Number(state.renderVersion) || 0;
    if (mediaScope.signal.aborted || signal?.aborted) onAbort();
    else if (renderOwner?.signal.aborted) finish(false);
    else if (!isCurrent()) finish(false);
    else if (seenVersion === targetVersion) finish(seenReady && isCurrent());
    else if (targetVersion === beforeVersion) finish(state.frameMaskMode !== 'required');
    return ready;
  };

  const recolorPortalPairOverlay = (image, state, color) => {
    const motionLayer = image.closest('.vcard-portal-motion-layer');
    const canvas = motionLayer?.querySelector(':scope > .vcard-portal-mask-overlay.is-ready');
    if (!canvas || !state.activePairBase || !state.activePairMask) return false;
    state.pairAbort?.abort();
    state.pairAbort = new AbortController();
    state.pairRenderVersion = (state.pairRenderVersion || 0) + 1;
    const version = state.pairRenderVersion;
    const renderVersion = state.renderVersion;
    const signal = state.pairAbort.signal;
    const isCurrent = () => !mediaScope.signal.aborted && !signal.aborted
      && !state.released && state.active && mediaStates.get(image) === state
      && renderVersion === state.renderVersion && version === state.pairRenderVersion;
    preparePortalPairOverlay(
      state.activePairBase,
      state.activePairMask,
      color,
      isCurrent,
      signal
    ).then((prepared) => {
      if (!isCurrent()) return;
      if (!vcardMotionPolicy.snapshot().motionAllowed
        || canvas.width !== prepared.width || canvas.height !== prepared.height) {
        commitPortalPairOverlay(image, prepared);
        return;
      }
      const previous = document.createElement('canvas');
      previous.className = 'vcard-portal-mask-recolor-previous';
      previous.setAttribute('aria-hidden', 'true');
      previous.width = canvas.width;
      previous.height = canvas.height;
      previous.getContext('2d').drawImage(canvas, 0, 0);
      const currentStyle = getComputedStyle(canvas);
      previous.style.opacity = currentStyle.opacity;
      previous.style.filter = currentStyle.filter;
      motionLayer.append(previous);
      canvas.getContext('2d').putImageData(prepared.coloredPixels, 0, 0);
      motionLayer.querySelectorAll(':scope > .vcard-portal-mask-glow').forEach((glow) => {
        if (glow.width === prepared.width && glow.height === prepared.height) {
          glow.getContext('2d').putImageData(prepared.coloredPixels, 0, 0);
        }
      });
      const animation = previous.animate(
        [{ opacity: Number.parseFloat(currentStyle.opacity) || 0 }, { opacity: 0 }],
        { duration: 1400, easing: 'ease-in-out' }
      );
      if (image.dataset.portalClone === 'true'
        && !vcardMotionPolicy.snapshot().playbackMotion) animation.pause();
      animation.finished.then(() => previous.remove()).catch(() => previous.remove());
    }).catch((error) => {
      if (isCurrent() && error?.name !== 'AbortError' && error?.message !== 'Portal render cancelled') {
        console.warn('VCard portal: cannot recolor active mask', error);
      }
    });
    return true;
  };

  document.addEventListener('vcardacccolorchange', (event) => {
    const color = String(event.detail && event.detail.color || '').trim()
      || currentAccentColor();
    activeImages.forEach((image) => {
      const state = mediaStates.get(image);
      if (!state) return;
      if (
        !state.activePairMask
        && !state.groups.some((group) => group.pairedPortal)
        && !portalStyleSpec(state, state.sourceKey || image.getAttribute('src') || '', false).mask
      ) return;
      state.portalAccentColor = color;
      if (!recolorPortalPairOverlay(image, state, color)) {
        renderState(image, false, color);
      }
    });
  }, { signal: mediaScope.signal });

  const setIndex = (
    image,
    index,
    preload = true,
    crossfade = true,
    crossfadeTiming = vcardMagicTimeSeconds
  ) => {
    const state = mediaStates.get(image);
    if (!state || !state.groups.length) return;
    clearPreload(image);
    state.index = ((index % state.groups.length) + state.groups.length) % state.groups.length;
    renderState(image, preload, '', crossfade, crossfadeTiming);
    publishPortalImageState(image);
  };

  const preloadIndex = (image, index, signal = null) => {
    const state = mediaStates.get(image);
    if (signal?.aborted || !state || !Number.isInteger(index) || index < 0 || index >= state.groups.length) {
      return Promise.resolve(false);
    }
    const targetIndex = ((index % state.groups.length) + state.groups.length) % state.groups.length;
    const group = state.groups[targetIndex];
    const mode = portalImageMode(image, state);
    const fullscreen = Boolean(window.VCardPortalLayout?.isFullscreen(image));
    const item = sourceForMode(group, mode, fullscreen);
    const source = item && portalFrameSource(
      state,
      state.listUrl ? listItemUrl(state.listUrl, item) : item
    );
    if (!source) return Promise.resolve(false);
    const pairedTone = (mode === 'duo' || mode === 'color-tint' || mode === 'vc-tint')
      && !fullscreen;
    const base = pairedTone && group.pairedPortal && group.base
      ? (state.listUrl ? listItemUrl(state.listUrl, group.base) : group.base)
      : '';
    const mask = pairedTone && group.pairedPortal && group.mask
      ? (state.listUrl ? listItemUrl(state.listUrl, group.mask) : group.mask)
      : '';
    const styleSpec = source ? portalStyleSpec(state, source, fullscreen) : null;
    const preparation = new AbortController();
    const onAbort = () => preparation.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const preparationSignal = preparation.signal;
    const renderedSource = source
      ? renderPortalStyleSource(source, styleSpec, state, preparationSignal)
      : Promise.resolve('');
    const loads = source ? [renderedSource.then((preparedSource) => decodePortalImage(preparedSource, preparationSignal))] : [];
    if (base && base !== source) loads.push(decodePortalImage(base, preparationSignal));
    if (mask) loads.push(decodePortalImage(mask, preparationSignal));
    // Only decode the physical assets. The expensive recolored mask canvas is
    // built after this frame becomes current, while its mask is still hidden.
    return Promise.all(loads).then(() => true).catch(() => false).finally(() => {
      signal?.removeEventListener('abort', onAbort);
      preparation.abort();
    });
  };

  const clearPreload = (image) => {
    const state = mediaStates.get(image);
    if (state) {
      state.frameReservation?.cancel();
      state.frameReservation = null;
      state.pendingRandomIndex = null;
      state.preloadGeneration += 1;
    }
  };

  const maskCapableCandidates = (
    image,
    state,
    candidates,
    maskMode = state?.frameMaskMode,
    reuse = true
  ) => {
    if (maskMode !== 'required' || !candidates.length) return candidates;
    const supportsMask = (index) => {
      const group = state.groups[index];
      if (group?.pairedPortal && group.mask) return true;
      const item = sourceForMode(group, portalImageMode(image, state), false);
      const source = item && (state.listUrl ? listItemUrl(state.listUrl, item) : item);
      return Boolean(source && portalStyleSpec({ ...state, frameUsesMask: true }, source, false).mask);
    };
    const allMasked = state.groups.map((_, index) => index).filter(supportsMask);
    if (!allMasked.length) return [];
    const masked = candidates.filter(supportsMask);
    if (masked.length) return masked;
    if (!reuse) return [];
    const otherMasked = allMasked.filter((index) => index !== state.index);
    return otherMasked.length ? otherMasked : allMasked;
  };

  const hasPortalFrames = (image, frame) => {
    const state = mediaStates.get(image);
    if (!state || !frame || (vcardFileMode && frame.maskMode === 'required')) return false;
    return maskCapableCandidates(image, state,
      state.groups.map((_, index) => index), frame.maskMode, false).length > 0;
  };

  const next = (image) => {
    const state = mediaStates.get(image);
    if (!state || state.groups.length < 2) return false;
    setIndex(image, state.index + 1);
    return true;
  };

  const previous = (image) => {
    const state = mediaStates.get(image);
    if (!state || state.groups.length < 2) return false;
    setIndex(image, state.index - 1);
    return true;
  };

  const setHistoryLists = (image, listUrls) => {
    const state = mediaStates.get(image);
    if (!state) return;
    clearPreload(image);
    state.historyListUrls = [...new Set(
      (listUrls || []).map((url) => String(url || '').trim()).filter(Boolean)
    )];
    state.historyExpanded = false;
    state.historyPromise = null;
    state.historyGeneration += 1;
  };

  const absoluteGroup = (group, listUrl) => {
    const absolute = {};
    if (group.pairedPortal && group.base && group.mask) {
      absolute.base = listUrl ? listItemUrl(listUrl, group.base) : group.base;
      absolute.mask = listUrl ? listItemUrl(listUrl, group.mask) : group.mask;
      absolute.pairedPortal = true;
      return absolute;
    }
    if (group.source) absolute.source = listUrl ? listItemUrl(listUrl, group.source) : group.source;
    return absolute;
  };

  const expandHistory = (image) => {
    const state = mediaStates.get(image);
    if (!state || state.historyExpanded || !state.historyListUrls.length) {
      return Promise.resolve(false);
    }
    if (state.historyPromise) return state.historyPromise;
    const generation = state.historyGeneration;
    state.historyPromise = Promise.all(state.historyListUrls.map(async (listUrl) => {
      try {
        const items = await loadList(listUrl);
        return mediaGroups(items.map((item) => listItemUrl(listUrl, item)));
      } catch (error) {
        if (mediaScope.signal.aborted || state.released
          || generation !== state.historyGeneration || error?.name === 'AbortError') return [];
        console.warn(`VCard portal history: cannot load ${listUrl}`, error);
        return [];
      }
    })).then((historyParts) => {
      if (generation !== state.historyGeneration) return false;
      const currentSource = state.sourceKey || normalizedSource(image.getAttribute('src'));
      const primaryGroups = state.primaryGroups.map(
        (group) => absoluteGroup(group, state.primaryListUrl)
      );
      const historyGroups = historyParts.flat();
      state.groups = [...primaryGroups, ...historyGroups];
      state.listUrl = '';
      state.historyExpanded = true;
      state.historyPromise = null;
      state.index = Math.max(0, state.groups.findIndex((group) => (
        sourcesForMode(group, portalImageMode(image, state)).some(
          (source) => normalizedSource(source) === currentSource
        )
      )));
      publishPortalImageState(image);
      return historyGroups.length > 0;
    });
    return state.historyPromise;
  };

  const frameBags = new WeakMap();
  const frameBag = (image) => {
    const state = mediaStates.get(image);
    const profile = image.vcardShowSelection?.profile || 'page';
    const collection = state.primaryListUrl || image.dataset.txtList || 'inline';
    const items = state.groups.map((group, index) => ({
      index,
      key: normalizedSource(state.listUrl
        ? listItemUrl(state.listUrl, group.base || group.source)
        : group.base || group.source),
    }));
    let bags = frameBags.get(image);
    if (!bags) { bags = new Map(); frameBags.set(image, bags); }
    const name = `frames.${profile}.${collection}`;
    let bag = bags.get(name);
    if (!bag) {
      bag = new window.VCLifeCore.TShuffleBag(items, (item) => item.key,
        window.VCPlayer.randomStream(name));
      bags.set(name, bag);
    } else bag.update(items);
    state.frameBag = bag;
    return bag;
  };

  const reserveFrame = (image, candidates, refill = true, origin = null) => {
    const state = mediaStates.get(image);
    const bag = frameBag(image);
    const allowed = new Set(candidates);
    return bag.reserve({ allow: (item) => allowed.has(item.index),
      prefer: (item) => item.index !== state.index, refill, origin });
  };

  const prepareRandomNext = (image, maskMode, excluded = new Set(), signal = null, origin = null) => {
    origin ||= vcardDecisionOrigin('Frame.Prepare');
    const state = mediaStates.get(image);
    if (!state || !state.groups.length || signal?.aborted) return Promise.resolve(false);
    if (Number.isInteger(state.pendingRandomIndex)) {
      return preloadIndex(image, state.pendingRandomIndex, signal);
    }
    state.frameReservation?.cancel();
    state.frameReservation = null;
    const candidates = maskCapableCandidates(image, state,
      state.groups.map((_, index) => index), maskMode, false).filter((index) => !excluded.has(index));
    let reservation = reserveFrame(image, candidates, false, origin);
    if (!reservation && !state.historyExpanded && state.historyListUrls.length) {
      const generation = state.preloadGeneration;
      return expandHistory(image).then(() => (
        state.preloadGeneration === generation && mediaStates.get(image) === state
          ? prepareRandomNext(image, maskMode, excluded, signal, origin) : false
      ));
    }
    if (!reservation) reservation = reserveFrame(image, candidates, true, origin);
    if (!reservation) return Promise.resolve(false);
    state.frameReservation = reservation;
    state.pendingRandomIndex = reservation.item.index;
    publishPortalImageState(image);
    return preloadIndex(image, state.pendingRandomIndex, signal).then((ready) => {
      if (!ready && !signal?.aborted && maskMode !== 'required'
        && mediaStates.get(image) === state && state.frameReservation === reservation) {
        state.frameBag.invalidate(reservation.item);
        clearPreload(image);
      }
      return ready;
    });
  };

  const prepareNext = (
    image,
    strategy = 'shuffle-bag',
    maskMode,
    excluded = new Set(),
    signal = null,
    origin = null
  ) => {
    origin ||= vcardDecisionOrigin('Frame.Prepare');
    const state = mediaStates.get(image);
    if (!state || !state.groups.length || signal?.aborted) return Promise.resolve(false);
    const generation = state.preloadGeneration;
    const finishPreparation = (preparation) => preparation.then((ready) => {
      if (signal?.aborted) return false;
      if (ready || maskMode !== 'required') return ready;
      if (mediaStates.get(image) !== state || state.preloadGeneration !== generation) return false;
      const failedIndex = state.pendingRandomIndex;
      if (!Number.isInteger(failedIndex) || excluded.has(failedIndex)) return false;
      state.frameReservation?.cancel();
      state.frameReservation = null;
      state.pendingRandomIndex = null;
      // A retry belongs to the same preparation, so its generation is unchanged.
      return prepareNext(image, strategy, maskMode, new Set([...excluded, failedIndex]), signal, origin);
    });
    if (Number.isInteger(state.pendingRandomIndex)) {
      return finishPreparation(preloadIndex(image, state.pendingRandomIndex, signal));
    }
    const normalized = String(strategy || 'shuffle-bag').toLowerCase();
    if (normalized === 'shuffle-bag' || normalized === 'random') {
      return finishPreparation(prepareRandomNext(image, maskMode, excluded, signal, origin));
    }
    let candidates = maskCapableCandidates(
      image,
      state,
      state.groups.map((_, index) => index),
      maskMode
    ).filter((index) => !excluded.has(index));
    if (!candidates.length) return Promise.resolve(false);
    let index = state.index;
    if (normalized === 'sequential') {
      index = candidates.find((candidate) => candidate > state.index);
      if (!Number.isInteger(index)) index = candidates[0];
    } else if (normalized !== 'keep') {
      return Promise.resolve(false);
    }
    if (!candidates.includes(index)) index = candidates[0];
    if (normalized === 'keep' && !state.frameReservation) {
      const bag = frameBag(image);
      const current = bag.items.find((item) => item.index === index);
      if (current && bag.last !== current.key) state.frameReservation = reserveFrame(image, [index], false, origin);
    }
    state.pendingRandomIndex = index;
    return finishPreparation(preloadIndex(image, index, signal));
  };


  const randomNext = (image, crossfade = true, crossfadeTiming = vcardMagicTimeSeconds) => {
    const state = mediaStates.get(image);
    if (!state || !state.groups.length) return false;
    clearPreload(image);
    const generation = state.preloadGeneration;
    prepareRandomNext(image).then((ready) => {
      if (mediaStates.get(image) !== state || state.preloadGeneration !== generation) return;
      if (!ready) { clearPreload(image); return; }
      state.index = state.pendingRandomIndex;
      state.pendingRandomIndex = null;
      renderState(image, true, '', crossfade, crossfadeTiming);
      publishPortalImageState(image);
    });
    return true;
  };

  const freeze = (image) => {
    const state = mediaStates.get(image);
    if (!state) return false;
    state.renderVersion = (state.renderVersion || 0) + 1;
    state.pairRenderVersion = (state.pairRenderVersion || 0) + 1;
    state.historyGeneration += 1;
    state.historyPromise = null;
    // A prepared next frame belongs to the current VerseRun queue. Pausing is
    // observational and must neither discard it nor choose a replacement.

    const motionLayer = image.closest('.vcard-portal-motion-layer');
    const previousFrames = Array.from(
      motionLayer?.querySelectorAll(':scope > .vcard-portal-crossfade-previous') || []
    );
    const canvas = motionLayer?.querySelector(':scope > .vcard-portal-mask-overlay');
    const glow = motionLayer?.querySelector(':scope > .vcard-portal-image-glow');
    // Pause is observational: it must not seek a transition, replace a frame,
    // or recompute mask brightness. Freeze every live layer exactly where it is.
    [...previousFrames, image, canvas, glow].filter(Boolean).forEach((element) => {
      element.getAnimations().forEach((animation) => animation.pause());
    });
    return true;
  };

  const resume = (image) => {
    const state = mediaStates.get(image);
    if (mediaScope.signal.aborted || !state || state.released || !state.active) return;
    const motionLayer = image?.closest('.vcard-portal-motion-layer');
    const canvas = motionLayer?.querySelector(':scope > .vcard-portal-mask-overlay');
    const glow = motionLayer?.querySelector(':scope > .vcard-portal-image-glow');
    const previousFrames = Array.from(
      motionLayer?.querySelectorAll(':scope > .vcard-portal-crossfade-previous') || []
    );
    [...previousFrames, image, canvas, glow].filter(Boolean).forEach((element) => {
      element.getAnimations().forEach((animation) => {
        if (animation.playState === 'paused') animation.play();
      });
    });
    // Pause invalidates unfinished mask work. Rebuild only the mask belonging
    // to the currently visible base; no phase or pending frame is restored.
    // If an outgoing snapshot is still fading, wait for it to disappear so a
    // newly rendered mask can never be shown over the previous photograph.
    if (state?.displayKey && !canvas?.classList.contains('is-ready')) {
      const transitionAnimations = previousFrames.flatMap((frame) => frame.getAnimations());
      if (transitionAnimations.length) {
        const displayKey = state.displayKey;
        const renderVersion = state.renderVersion;
        Promise.all(transitionAnimations.map((animation) => (
          animation.finished.then(() => true).catch(() => false)
        ))).then((completed) => {
          if (
            completed.every(Boolean)
            && !mediaScope.signal.aborted
            && mediaStates.get(image) === state
            && !state.released && state.active
            && state.renderVersion === renderVersion
            && !sharedSongAudio.paused
            && state.displayKey === displayKey
            && !canvas?.classList.contains('is-ready')
          ) renderState(image);
        });
      } else {
        renderState(image);
      }
    }
    prepareNext(image, state.framePick);
  };

  const randomStart = (image) => {
    const state = mediaStates.get(image);
    if (!state || !state.groups.length) return false;
    clearPreload(image);
    const candidates = maskCapableCandidates(image, state, state.groups.map((_, index) => index));
    const reservation = reserveFrame(image, candidates);
    if (!reservation) return false;
    state.index = reservation.item.index;
    state.frameReservation = reservation;
    // The opening frame is consumed only when its rendering is ready.
    if (state.active) renderState(image);
    publishPortalImageState(image);
    return true;
  };

  const refresh = (options = {}) => {
    if (mediaScope.signal.aborted) return;
    const skipPaired = Boolean(options && options.skipPaired);
    activeImages.forEach((image) => {
      const state = mediaStates.get(image);
      const hasPair = Boolean(
        state && state.groups.some((group) => group.pairedPortal)
      );
      if (hasPair && skipPaired) return;
      renderState(image);
    });
  };

  document.addEventListener('vcard:preset-state', refresh, { signal: mediaScope.signal });
  document.addEventListener('vcardcolorschemechange', refresh, { signal: mediaScope.signal });
  document.addEventListener('vcardtextcolorchange', () => refresh({ skipPaired: true }),
    { signal: mediaScope.signal });
  document.addEventListener('vcard:mono-color-state', refresh, { signal: mediaScope.signal });
  document.addEventListener('vcard:motion-state', (event) => {
    if (event.detail?.motionAllowed) return;
    document.querySelectorAll('.vcard-portal-motion-layer').forEach((layer) => {
      layer.getAnimations({ subtree: true }).forEach((animation) => {
        try { animation.finish(); } catch (_error) { animation.cancel(); }
      });
      layer.querySelectorAll('.vcard-portal-image-glow').forEach((glow) => {
        glow.getAnimations().forEach((animation) => animation.cancel());
        glow.style.opacity = '0';
      });
      layer.querySelectorAll('.vcard-portal-crossfade-previous, .vcard-portal-mask-recolor-previous')
        .forEach((previous) => previous.remove());
    });
  }, { signal: mediaScope.signal });
  let portalEffectsAllowed = document.documentElement.dataset.visBri !== '0';
  document.addEventListener('vcard:visualization-state', () => {
    const allowed = document.documentElement.dataset.visBri !== '0';
    if (allowed === portalEffectsAllowed) return;
    portalEffectsAllowed = allowed;
    refresh();
  }, { signal: mediaScope.signal });
  const portraitMedia = vcardEnvironment.media('(orientation: portrait)');
  let portraitMatches = portraitMedia.matches;
  document.addEventListener('vcard:environment-state', () => {
    if (portraitMatches === portraitMedia.matches) return;
    portraitMatches = portraitMedia.matches;
    refresh();
  }, { signal: mediaScope.signal });

  const isDebug = () => document.documentElement.dataset.debug === 'on';
  const release = (image) => {
    clearPreload(image);
    setActive(image, false);
    releaseStyleResources(mediaStates.get(image));
    mediaStates.delete(image);
    activeImages.delete(image);
  };
  const resourceSnapshot = () => ({
    loader: loader.snapshot(),
    images: mediaStates.size,
    activeImages: activeImages.size,
    stylePending: [...browserStyleCache.values()].filter((entry) => !entry.url).length,
    styleReady: [...browserStyleCache.values()].filter((entry) => entry.url).length,
    styleOwners: [...browserStyleCache.values()].reduce((sum, entry) => sum + entry.owners.size, 0),
    styleBytes: [...browserStyleCache.values()].reduce((sum, entry) => sum + (entry.bytes || 0), 0),
    releasedStyleUrls,
  });
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    mediaScope.abort();
    loader.dispose();
    mediaStates.forEach(releaseStyleResources);
    mediaStates.clear();
    activeImages.clear();
  }, { signal: mediaScope.signal });

  return {
    applyImageEffect,
    ensurePortalMotionLayer,
    effectiveImageMode,
    freeze,
    isDebug,
    listDirectory,
    listItemUrl,
    loadList,
    loadShowCatalog,
    prepareImage: (source, { signal = null } = {}) => loadPortalPairImage(source, signal),
    prepareVideo: (video, options = {}) => loader.prepareElement(video, 'video', options).promise,
    prepareAudio: (audio, options = {}) => loader.prepareElement(audio, 'audio', {
      readyState: HTMLMediaElement.HAVE_METADATA, ...options,
    }).promise,
    mediaStates,
    hasPortalFrames,
    next,
    previous,
    portalImageStats,
    portalMaskState,
    randomNext,
    randomStart,
    resume,
    setHistoryLists,
    setActive,
    normalizedName,
    refresh,
    register,
    release,
    resourceSnapshot,
    renderState,
    setIndex,
    setPortalFrame,
    refreshPortalFrames: () => {
      mediaStates.forEach((state, image) => {
        if (state.debugBaseFrame) setPortalFrame(image,
          { ...state.debugBaseFrame, keepPhysicalIndex: true }, state.active);
      });
    },
    debugStyleInfo: (image) => {
      const state = mediaStates.get(image);
      const available = new Set(['0', 'vc', 'vc_grey']);
      for (const collection of Object.keys(state?.showStyleParams || {})) {
        const style = collection.split('/').at(-1);
        if (['s_alarm', 's_bitmap', 's_inverse', 's_bright', 's_burn'].includes(style)) available.add(style);
      }
      return { available: [...available], selected: debugStyles.get(debugStyleOwner(image)) || 'auto',
        active: [state?.frameTone, state?.frameStyle].filter(Boolean).join(' ') || '—' };
    },
    setDebugStyle: (image, style) => {
      const owner = debugStyleOwner(image);
      if (!owner || !mediaStates.has(image)) return false;
      if (style === 'auto') debugStyles.delete(owner);
      else debugStyles.set(owner, style);
      mediaStates.forEach((state, target) => {
        if (debugStyleOwner(target) === owner && state.debugBaseFrame) {
          setPortalFrame(target, state.debugBaseFrame, state.active);
        }
      });
      return true;
    },
    selectPlaybackShow: async (image, { profile, sourceScope, releaseId, releaseKey, signal, isCurrent, origin = null }) => {
      if (!image) return null;
      image.vcardShowReservation?.cancel();
      image.vcardShowReservation = null;
      await vcardMedia.initializePortalImage(image);
      if (!isCurrent()) return null;
      const globalCatalog = 'usr/shows_glob/shows.js';
      const catalogUrl = sourceScope === 'global'
        ? (showCatalogVersions.has(new URL(globalCatalog, document.baseURI).href) ? globalCatalog : '')
        : String(image.dataset.portalShows || '');
      let catalog = null;
      try {
        if (catalogUrl) catalog = await loadShowCatalog(catalogUrl);
      } catch (error) {
        if (!isCurrent() || error?.name === 'AbortError') return null;
        console.warn(`VCard PortalTV: cannot load ${catalogUrl}`, error);
      }
      if (!isCurrent()) return null;
      const release = catalog?.selections?.[sourceScope === 'global' ? '' : releaseId];
      const candidates = (catalog?.shows || []).filter((show) => {
        const selection = release?.shows?.[show.name]
          || (show.name === catalog.defaultShow ? release : null);
        return selection?.list && selection?.ids?.length;
      });
      const bag = vcardSelectionBag(`shows.${profile}.${catalogUrl}.${releaseKey || releaseId}`,
        candidates, (show) => show.name);
      const reservation = bag.reserve({ origin,
        allow: (show) => origin?.event !== 'Show.Next' || candidates.length < 2
          || show.name !== image.vcardShowSelection?.name });
      const show = reservation?.item || null;
      image.vcardShowBag = bag;
      image.vcardShowReservation = reservation;
      signal?.addEventListener('abort', () => {
        reservation?.cancel();
        if (image.vcardShowReservation === reservation) image.vcardShowReservation = null;
      }, { once: true });
      const selection = show && (release.shows?.[show.name] || release);
      let items = [];
      try {
        if (selection) items = await loadList(selection.list);
      } catch (error) {
        if (!isCurrent() || error?.name === 'AbortError') {
          reservation?.cancel();
          if (image.vcardShowReservation === reservation) image.vcardShowReservation = null;
          return null;
        }
        console.warn(`VCard PortalTV: cannot load ${selection.list}`, error);
      }
      if (!isCurrent()) { reservation?.cancel(); return null; }
      image.vcardShowCatalog = catalog;
      image.vcardShowSelection = { name: show?.name || '', catalogUrl, profile };
      if (!items.length) {
        if (show) bag.invalidate(show);
        image.vcardShowReservation = null;
      }
      register(image, selection?.list || '', mediaGroups(items), 0);
      setActive(image, false);
      clearPreload(image);
      const frame = image.closest('.song-vibeframe');
      if (frame) {
        frame.dataset.showName = items.length ? show.name : '';
        frame.dataset.showProfile = profile;
      }
      return items.length ? { name: show.name, catalogUrl, list: selection.list,
        scope: catalog.scope, count: items.length } : null;
    },
    reservePortalFrame,
    cancelPortalFrame,
    commitPortalFrame,
    registerPortalClone,
    renderPortalFrameAt,
    setPortalImageGlow,
    preloadIndex,
    prepareRandomNext,
    prepareNext,
    clearPreload,
    directMediaGroup,
    sourceForMode,
    sourcesForMode,
    mediaGroups,
  };
})();
window.VCardMediaLoader = Object.freeze({
  prepareAudio: vcardMedia.prepareAudio,
  prepareVideo: vcardMedia.prepareVideo,
});

(() => {
  const imageInitializationScope = new AbortController();
  const { signal } = imageInitializationScope;
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) imageInitializationScope.abort();
  }, { signal });
  document.querySelectorAll('.page-image, img[image-color]').forEach(async (image) => {
    if (
      image.classList.contains('iod-image')
      || image.hasAttribute('image-day')
      || image.classList.contains('song__preview-image')
      || image.hasAttribute('slideshow')
    ) return;
    const source = (image.getAttribute('src') || '').trim();
    const current = () => !signal.aborted && image.isConnected
      && (image.getAttribute('src') || '').trim() === source;
    if (source.split(/[?#]/, 1)[0].toLowerCase().endsWith('.txt')) {
      await vcardSelectionReady;
      if (!current()) return;
      const life = window.VCLife;
      const operation = life && window.VCLifeCore?.TOperation
        ? new window.VCLifeCore.TOperation(life, 'page-image-initialize') : null;
      if (operation) signal.addEventListener('abort', () => operation.cancel('page-disposed'),
        { once: true, signal: operation.scope.signal });
      const post = (type, apply) => {
        const run = () => current() && (!operation || operation.status === 'Running') ? apply() : false;
        return life ? life.queue.post(run, { type, owner: life, scope: imageInitializationScope }) : Promise.resolve(run());
      };
      try {
        const groups = vcardMedia.mediaGroups(await vcardMedia.loadList(source));
        if (!current()) return;
        if (!groups.length) throw new Error('empty list');
        await post('Operation.Complete', () => {
          try {
            vcardMedia.register(image, source, groups, 0);
            operation?.complete({ listUrl: source, count: groups.length });
            return true;
          } catch (error) {
            operation?.fail(error);
            vcardMedia.release(image);
            image.setAttribute('src', source);
            if (life) life.reportFault(error, { type: 'Operation.Fail', owner: operation || life }, 'ComponentFailure');
            else console.warn(`VCard image: cannot publish ${source}`, error);
            return false;
          }
        });
      } catch (error) {
        if (!current() || error?.name === 'AbortError') return;
        await post('Operation.Fail', () => {
          operation?.fail(error);
          if (life) life.reportFault(error, { type: 'Operation.Fail', owner: operation || life }, 'ResourceFailure');
          else console.warn(`VCard image: cannot load ${source}`, error);
          return false;
        });
      } finally {
        operation?.cancel('page-image-initialization-finished');
      }
      return;
    }
    vcardMedia.register(image, '', [vcardMedia.directMediaGroup(source)], 0);
  });
})();

// The local date belongs to this page life; midnight does not change its media.
const vcardCalendarDay = new Date().getDate();

(() => {
  const images = Array.from(document.querySelectorAll('img.iod-image, img[image-day]'));
  const videos = Array.from(document.querySelectorAll('video.iod-video[data-iod-list]'));
  if (!images.length && !videos.length) return;
  const dayPreparationScope = new AbortController();
  const { signal } = dayPreparationScope;
  const beginDayPreparation = (element, kind) => {
    const life = window.VCLife;
    const task = life && window.VCLifeCore?.TOperation
      ? new window.VCLifeCore.TOperation(life, `day-${kind}-prepare`) : null;
    const publish = () => {
      if (!signal.aborted && element.isConnected && task) {
        element.dataset.dayMediaOperation = JSON.stringify(task.snapshot());
      }
    };
    signal.addEventListener('abort', () => task?.cancel('page-disposed'),
      { once: true, ...(task ? { signal: task.scope.signal } : {}) });
    publish();
    return {
      task,
      signal: task?.scope.signal || signal,
      cancel() { task?.cancel('day-preparation-finished'); publish(); },
      finish(type, apply, result = null, error = null) {
        const run = () => {
          if (signal.aborted || !element.isConnected || (task && task.status !== 'Running')) return false;
          try {
            if (error) {
              task?.fail(error);
              life?.reportFault(error, { type, owner: task || life }, 'ResourceFailure');
              publish();
              return false;
            }
            apply();
            task?.complete(result);
            publish();
            return true;
          } catch (failure) {
            task?.fail(failure);
            life?.reportFault(failure, { type: 'Operation.Fail', owner: task || life }, 'ComponentFailure');
            if (!life) console.warn('VCard day media: publication failed', failure);
            publish();
            return false;
          }
        };
        return life ? life.queue.post(run, { type, owner: life, scope: dayPreparationScope }) : run();
      },
    };
  };
  const traceDayMedia = async (kind, listUrl, index, count, source, origin) => {
    await vcardSelectionReady;
    if (signal.aborted) return null;
    const stream = window.VCPlayer?.randomStream?.(`day.${kind}`);
    const decision = stream?.decision?.({
      type: 'day-media', selected: source, listUrl,
      reason: 'calendar-day', day: vcardCalendarDay, index, count,
      draw: null, result: 'Reserve', origin,
    });
    if (decision) {
      decision.context = { ...decision.context, commandId: null, event: 'DayMedia.Init',
        runId: null, profile: null, entryKey: null };
    }
    return (result) => stream?.finishDecision?.(decision, result);
  };
  let dayPageCoveredBySong = Boolean(window.VCardSongControls?.currentPreview?.() || null);
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    dayPreparationScope.abort();
    images.forEach((image) => vcardMedia.mediaStates.get(image)?.renderAbort?.abort());
    videos.forEach((video) => video.pause());
  }, { signal });

  images.forEach(async (image) => {
    const origin = vcardDecisionOrigin('DayMedia.Init', true);
    const listUrl = (image.dataset.iodList || image.getAttribute('src') || '').trim();
    if (!listUrl) return;
    let finishDecision = null;
    let result = 'Cancel';
    let preparation = null;
    try {
      const items = await vcardMedia.loadList(listUrl);
      if (signal.aborted || !image.isConnected) return;
      const groups = vcardMedia.mediaGroups(items.filter((item) => (
        /\.(?:jpe?g|png|webp|gif|avif|svg)(?:[?#].*)?$/i.test(item)
      )));
      if (!groups.length) {
        console.warn(`VCard image of day: empty image list: ${listUrl}`, image);
        return;
      }

      const index = (vcardCalendarDay - 1) % groups.length;
      const group = groups[index];
      const sources = [vcardMedia.sourceForMode(group), group.mask].filter(Boolean);
      finishDecision = await traceDayMedia('images', listUrl, index, groups.length, sources[0], origin);
      if (signal.aborted || !image.isConnected) return;
      preparation = beginDayPreparation(image, 'image');
      await Promise.all(sources.map((source) => vcardMedia.prepareImage(
        vcardMedia.listItemUrl(listUrl, source), { signal: preparation.signal }
      )));
      const committed = await preparation.finish('Operation.Complete', () => {
        vcardMedia.register(image, listUrl, groups, index);
        image.dataset.iodIndex = String(index + 1);
      }, { index, source: sources[0] });
      result = committed ? 'Commit' : preparation.task?.status === 'Failed' ? 'Failure' : 'Cancel';
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError') return;
      result = 'Failure';
      if (preparation) await preparation.finish('Operation.Fail', null, null, error);
      else console.warn(`VCard image of day: cannot load ${listUrl}`, error);
    } finally {
      preparation?.cancel();
      finishDecision?.(result);
    }
  });
  const syncDayAnimations = () => {
    if (signal.aborted) return;
    const dayMotionAllowed = vcardMotionPolicy.snapshot().renderingActive
      && document.documentElement.dataset.imagesVisible !== 'off' && !dayPageCoveredBySong;
    videos.forEach((video) => {
      if (!video.currentSrc && !video.getAttribute('src')) return;
      if (dayMotionAllowed) {
        playVCardAnimation(video);
      }
      else video.pause();
    });
  };

  videos.forEach(async (video) => {
    const origin = vcardDecisionOrigin('DayMedia.Init', true);
    const listUrl = (video.dataset.iodList || '').trim();
    if (!listUrl) return;
    let finishDecision = null;
    let result = 'Cancel';
    let preparation = null;
    try {
      const items = await vcardMedia.loadList(listUrl);
      if (signal.aborted || !video.isConnected) return;
      const sources = items.filter((item) => /\.(?:webm|mp4|ogv)(?:[?#].*)?$/i.test(item));
      if (!sources.length) {
        console.warn(`VCard animation of day: empty video list: ${listUrl}`, video);
        return;
      }
      const index = (vcardCalendarDay - 1) % sources.length;
      finishDecision = await traceDayMedia('videos', listUrl, index, sources.length, sources[index], origin);
      if (signal.aborted || !video.isConnected) return;
      preparation = beginDayPreparation(video, 'video');
      const preparedVideo = document.createElement('video');
      preparedVideo.muted = true;
      preparedVideo.preload = 'auto';
      preparedVideo.src = vcardMedia.listItemUrl(listUrl, sources[index]);
      try {
        await vcardMedia.prepareVideo(preparedVideo, { signal: preparation.signal,
          readyState: HTMLMediaElement.HAVE_CURRENT_DATA });
        const committed = await preparation.finish('Operation.Complete', () => {
          video.muted = true;
          video.loop = true;
          video.src = preparedVideo.src;
          video.dataset.iodIndex = String(index + 1);
          video.load();
          syncDayAnimations();
        }, { index, source: sources[index] });
        result = committed ? 'Commit' : preparation.task?.status === 'Failed' ? 'Failure' : 'Cancel';
      } finally {
        preparedVideo.pause();
        preparedVideo.removeAttribute('src');
        preparedVideo.load();
      }
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError') return;
      result = 'Failure';
      if (preparation) await preparation.finish('Operation.Fail', null, null, error);
      else console.warn(`VCard animation of day: cannot load ${listUrl}`, error);
    } finally {
      preparation?.cancel();
      finishDecision?.(result);
    }
  });

  document.addEventListener('vcard:motion-state', syncDayAnimations, { signal });
  document.addEventListener('vcard:images-visible-state', syncDayAnimations, { signal });
  document.addEventListener('vcard:song-open', () => {
    dayPageCoveredBySong = true;
    syncDayAnimations();
  }, { signal });
  document.addEventListener('vcard:song-close', () => {
    dayPageCoveredBySong = false;
    syncDayAnimations();
  }, { signal });
  syncDayAnimations();
})();

(() => {
  const initializationPromises = new WeakMap();
  const frameListUrl = (folder) => {
    const value = String(folder || '').trim();
    if (!value) return '';
    if (/\.js(?:[?#].*)?$/i.test(value)) return value;
    const match = value.match(/^([^?#]*)([?#].*)?$/);
    const path = (match && match[1]) || value;
    const suffix = (match && match[2]) || '';
    return `${path.replace(/\/?$/, '/') }list.js${suffix}`;
  };
  const frameScope = new AbortController();
  const { signal } = frameScope;
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) frameScope.abort();
  }, { signal });

  const initializeFrame = (host) => {
    if (signal.aborted || !host?.isConnected) return Promise.resolve(false);
    if (!host || initializationPromises.has(host)) {
      return initializationPromises.get(host) || Promise.resolve(false);
    }
    const origin = vcardDecisionOrigin('Frame.Initialize', true);
    const initialization = (async () => {
    const folder = host.getAttribute('frame');
    const listUrl = frameListUrl(folder);
    if (!listUrl) return false;
    const current = () => !signal.aborted && host.isConnected && host.getAttribute('frame') === folder;
    let bag = null;
    let reservation = null;
    let operation = null;
    let life = null;
    let resourceFailed = false;
    try {
      const items = await vcardMedia.loadList(listUrl);
      if (!current()) return false;
      if (!items.length) throw new Error('empty list');
      if (host.querySelector(':scope > .vcard-frame-overlay')) return true;
      const owners = [...document.querySelectorAll('[frame]')];
      bag = vcardSelectionBag(`frame.overlay.${listUrl}.${owners.indexOf(host)}`, items);
      reservation = bag.reserve({ origin });
      if (!reservation) return false;
      const source = vcardMedia.listItemUrl(listUrl, reservation.item);
      life = window.VCLife;
      operation = life && window.VCLifeCore?.TOperation
        ? new window.VCLifeCore.TOperation(life, 'frame-overlay-prepare') : null;
      if (operation) signal.addEventListener('abort', () => operation.cancel('page-disposed'),
        { once: true, signal: operation.scope.signal });
      let prepared;
      try {
        prepared = await vcardMedia.prepareImage(source, { signal: operation?.scope.signal || signal });
      } catch (error) {
        resourceFailed = error?.name !== 'AbortError';
        throw error;
      }
      const publish = () => {
        if (!current() || operation?.scope.signal.aborted) return false;
        let overlay = null;
        try {
          if (!host.querySelector(':scope > .vcard-frame-overlay')) {
            overlay = prepared.cloneNode(false);
            overlay.className = 'vcard-frame-overlay';
            overlay.alt = '';
            overlay.setAttribute('aria-hidden', 'true');
            host.appendChild(overlay);
            reservation.commit();
          }
          operation?.complete({ source });
          return true;
        } catch (error) {
          overlay?.remove();
          reservation.cancel();
          operation?.fail(error);
          life?.reportFault(error, { type: 'Operation.Fail', owner: operation || life }, 'ComponentFailure');
          if (!life) console.warn(`VCard frame: cannot publish ${listUrl}`, error);
          return false;
        }
      };
      return life ? await life.queue.post(publish, { type: 'Operation.Complete', owner: life, scope: frameScope }) : publish();
    } catch (error) {
      if (error?.name === 'AbortError' || !current()) return false;
      const fail = () => {
        if (!current() || operation?.scope.signal.aborted) return false;
        if (resourceFailed) bag?.invalidate(reservation?.item);
        reservation?.cancel();
        operation?.fail(error);
        if (life) life.reportFault(error, { type: 'Operation.Fail', owner: operation || life },
          resourceFailed ? 'ResourceFailure' : 'ComponentFailure');
        else console.warn(`VCard frame: cannot load ${listUrl}`, error);
        return false;
      };
      if (life) await life.queue.post(fail, { type: 'Operation.Fail', owner: life, scope: frameScope });
      else fail();
      return false;
    } finally {
      operation?.cancel('frame-preparation-finished');
      reservation?.cancel();
    }
    })();
    initializationPromises.set(host, initialization);
    return initialization;
  };

  document.querySelectorAll('.image-vibeframe[frame]').forEach(initializeFrame);
  document.addEventListener('vcard:activate-portal-image', (event) => {
    initializeFrame(event.detail?.image?.closest('.song-vibeframe[frame]'));
  }, { signal });
})();

  (() => {
    const controllers = [];
    const initializationPromises = new WeakMap();
    const slideshowScope = new AbortController();
    const { signal } = slideshowScope;
    let visibilityFrame = 0;
    signal.addEventListener('abort', () => {
      vcardRenderScheduler.cancel(visibilityFrame);
      visibilityFrame = 0;
      controllers.forEach((controller) => controller.stop());
      controllers.length = 0;
    }, { once: true });

    const nonNegativeNumber = (value, fallback) => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };

    const cssTimeSeconds = (value, fallback) => {
      const text = String(value || '').trim().toLowerCase();
      if (text.endsWith('ms')) {
        return nonNegativeNumber(text.slice(0, -2), fallback * 1000) / 1000;
      }
      if (text.endsWith('s')) {
        return nonNegativeNumber(text.slice(0, -1), fallback);
      }
      return nonNegativeNumber(text, fallback);
    };

    const positiveCssTimeSeconds = (value, fallback) => {
      const seconds = cssTimeSeconds(value, fallback);
      return seconds > 0 ? seconds : fallback;
    };

    const DEFAULT_DELAY_SECONDS = 3;
    const DEFAULT_CROSSFADE_SECONDS = 0.4;

    const loadFrameList = (listUrl) => vcardMedia.loadList(listUrl);

    const listDirectory = (listUrl) => {
      const path = String(listUrl || '').split(/[?#]/, 1)[0];
      return path.slice(0, path.lastIndexOf('/') + 1);
    };

    const initializeSlideshow = (image) => {
      if (signal.aborted || !image?.isConnected) return Promise.resolve(false);
      if (!image || initializationPromises.has(image)) {
        return initializationPromises.get(image) || Promise.resolve(false);
      }
      const initialization = (async () => {
      const songPreview = image.closest('.song__preview');
      image.removeAttribute('onerror');
      image.onerror = null;

      const hasSlideshow = image.hasAttribute('slideshow');
      const baseList = (image.getAttribute('src') || '').trim();
      if (!baseList) {
        console.warn('VCard slideshow: missing list URL', image);
        return false;
      }
      await vcardSelectionReady;
      const current = () => !signal.aborted && !window.VCLife?.dead && image.isConnected
        && (image.getAttribute('src') || '').trim() === baseList;
      if (!current()) return false;
      const life = window.VCLife;
      const operation = life && window.VCLifeCore?.TOperation
        ? new window.VCLifeCore.TOperation(life, 'page-slideshow-list') : null;
      if (operation) signal.addEventListener('abort', () => operation.cancel('page-disposed'),
        { once: true, signal: operation.scope.signal });
      const postList = (type, apply) => {
        const run = () => {
          if (!current() || (operation && operation.status !== 'Running')) return false;
          try { return apply(); }
          catch (error) {
            operation?.fail(error);
            if (life) life.reportFault(error, { type: 'Operation.Fail', owner: operation || life }, 'ComponentFailure');
            else console.warn('VCard slideshow: cannot apply list', error);
            return false;
          }
        };
        return life ? life.queue.post(run, { type, owner: life, scope: slideshowScope }) : Promise.resolve(run());
      };
      let baseFrames = null;
      try {
        const items = await loadFrameList(baseList);
        baseFrames = await postList('Operation.Complete', () => {
          const groups = vcardMedia.mediaGroups(items);
          operation?.complete({ listUrl: baseList, count: groups.length });
          return groups;
        });
      } catch (error) {
        if (error?.name !== 'AbortError') await postList('Operation.Fail', () => {
          operation?.fail(error);
          if (life) life.reportFault(error, { type: 'Operation.Fail', owner: operation || life }, 'ResourceFailure');
          else console.warn(`VCard slideshow: cannot load ${baseList}`, error);
          return false;
        });
      } finally {
        operation?.cancel('slideshow-list-finished');
      }
      if (!current() || operation?.status === 'Cancelled' || operation?.status === 'Failed') return false;
      if (!baseFrames?.length) {
        console.warn(`VCard slideshow: empty frame list: ${baseList}`);
        return false;
      }

      const delaySeconds = positiveCssTimeSeconds(
        image.getAttribute('slideshow'),
        DEFAULT_DELAY_SECONDS
      );
      const transitionSeconds = DEFAULT_CROSSFADE_SECONDS;

      let currentFrame = 0;
      let direction = 1;
      let timer = 0;
      let stopped = false;
      let sourceVersion = 0;
      let crossfadeLayer = null;
      let preparation = null;
      let crossfadeTimer = 0;
      let crossfadeFrame = 0;
      const unavailableFrames = new Set();

      const postSlideshow = (type, apply) => {
        const current = () => !signal.aborted && !stopped && image.isConnected;
        if (!current()) return Promise.resolve(false);
        const run = () => current() ? apply() : false;
        return window.VCLife
          ? window.VCLife.queue.post(run, { type, owner: window.VCLife, scope: slideshowScope })
          : Promise.resolve(run());
      };
      const waitSlideshow = (seconds, apply) => {
        // Keep the timer identity until its queued completion is applied. A
        // cancelled timer cannot change the next frame even if it has fired.
        const id = window.setTimeout(() => {
          postSlideshow('Operation.Complete', () => {
            if (timer !== id) return false;
            timer = 0;
            return apply();
          });
        }, seconds * 1000);
        timer = id;
      };

      const isInactive = () => (
        signal.aborted || !image.isConnected
        || !vcardMotionPolicy.snapshot().pageVisible
        || document.documentElement.dataset.imagesVisible === 'off'
        || window.VCLife?.pageSuspended
        || (songPreview && songPreview !== window.VCardSongControls?.currentPreview?.())
      );

      const effectiveFrames = () => baseFrames;
      const frameSource = (frame) => {
        const frames = effectiveFrames();
        const item = vcardMedia.sourceForMode(
          frames[frame],
          vcardMedia.effectiveImageMode(image),
          Boolean(window.VCardPortalLayout?.isFullscreen(image))
        );
        return item ? vcardPublishedMediaUrl(`${listDirectory(baseList)}${item}`) : '';
      };
      const clearTimer = () => {
        if (!timer) return;
        window.clearTimeout(timer);
        timer = 0;
      };
      const clearCrossfade = () => {
        window.clearTimeout(crossfadeTimer);
        crossfadeTimer = 0;
        if (crossfadeFrame) vcardRenderScheduler.cancel(crossfadeFrame);
        crossfadeFrame = 0;
        crossfadeLayer?.remove();
        crossfadeLayer = null;
      };

      const crossFadeTo = (
        nextSource,
        durationSeconds = DEFAULT_CROSSFADE_SECONDS,
        enabled = true
      ) => {
        clearCrossfade();
        if (!enabled || !durationSeconds) {
          image.setAttribute('src', nextSource);
          return;
        }

        const rect = image.getBoundingClientRect();
        const localHost = image.closest(
          '.vcard-portal-motion-layer, .image-vibeframe, .song-vibeframe'
        );
        const useLocalLayer = localHost && !Boolean(window.VCardPortalLayout?.isFullscreen(image));
        const imageStyle = getComputedStyle(image);
        const layer = image.cloneNode(false);
        crossfadeLayer = layer;
        layer.removeAttribute('id');
        layer.removeAttribute('slideshow');
        layer.removeAttribute('active');
        layer.removeAttribute('act');
        layer.classList.remove('is-slideshow-changing');
        layer.classList.add('slideshow-crossfade-layer');
        layer.classList.add(useLocalLayer ? 'is-local' : 'is-fixed');
        layer.style.animation = 'none';
        layer.style.animationComposition = 'replace';
        layer.style.filter = imageStyle.filter;
        layer.style.setProperty('--crossfade-duration', `${durationSeconds}s`);
        if (useLocalLayer) {
          const hostRect = localHost.getBoundingClientRect();
          layer.style.left = `${rect.left - hostRect.left - localHost.clientLeft}px`;
          layer.style.top = `${rect.top - hostRect.top - localHost.clientTop}px`;
        } else {
          layer.style.left = `${rect.left}px`;
          layer.style.top = `${rect.top}px`;
        }
        layer.style.width = `${rect.width}px`;
        layer.style.height = `${rect.height}px`;
        (useLocalLayer ? localHost : document.body).appendChild(layer);
        void layer.offsetWidth;

        image.setAttribute('src', nextSource);
        crossfadeFrame = vcardRenderScheduler.request(() => {
          crossfadeFrame = 0;
          if (crossfadeLayer === layer) layer.classList.add('is-leaving');
        }, { owner: image, scope: slideshowScope,
          isCurrent: () => !stopped && !isInactive() && crossfadeLayer === layer });
        crossfadeTimer = window.setTimeout(() => postSlideshow('Operation.Complete', () => {
          if (crossfadeLayer === layer) clearCrossfade();
        }), durationSeconds * 1000);
      };

      const schedule = () => {
        clearTimer();
        if (!hasSlideshow || stopped || preparation || isInactive() || baseFrames.length - unavailableFrames.size < 2) return;
        waitSlideshow(delaySeconds, showNextFrame);
      };

      const beginSwap = (
        nextFrame,
        nextSource = frameSource(nextFrame),
        version = sourceVersion
      ) => {
        if (version !== sourceVersion || stopped || isInactive()) {
          schedule();
          return;
        }
        const animated = vcardMotionPolicy.snapshot().motionAllowed;
        crossFadeTo(nextSource, transitionSeconds, animated);
        currentFrame = nextFrame;
        const mediaState = vcardMedia.mediaStates.get(image);
        if (mediaState) mediaState.index = nextFrame;
        waitSlideshow(animated ? transitionSeconds : 0, schedule);
      };

      const prepareFrame = (nextFrame) => {
        if (stopped || isInactive()) return;
        preparation?.abort();
        const scope = new AbortController();
        preparation = scope;
        const nextSource = frameSource(nextFrame);
        const version = sourceVersion;
        const life = window.VCLife;
        const operation = life && window.VCLifeCore?.TOperation
          ? new window.VCLifeCore.TOperation(life, 'page-slideshow-prepare') : null;
        scope.signal.addEventListener('abort', () => operation?.cancel('slideshow-preparation-cancelled'),
          { once: true });
        operation?.scope.signal.addEventListener('abort', () => {
          if (operation.status !== 'Completed') scope.abort();
        }, { once: true, signal: scope.signal });
        vcardMedia.prepareImage(nextSource, { signal: scope.signal }).then(() => postSlideshow('Operation.Complete', () => {
          if (scope.signal.aborted || stopped || version !== sourceVersion || isInactive()) return;
          const previousSource = image.getAttribute('src');
          const previousFrame = currentFrame;
          try {
            beginSwap(nextFrame, nextSource, version);
            operation?.complete({ frame: nextFrame, source: nextSource });
          } catch (error) {
            operation?.fail(error);
            clearTimer();
            clearCrossfade();
            if (previousSource !== null) image.setAttribute('src', previousSource);
            currentFrame = previousFrame;
            const mediaState = vcardMedia.mediaStates.get(image);
            if (mediaState) mediaState.index = previousFrame;
            life?.reportFault(error, { type: 'Operation.Fail', owner: operation || life }, 'ComponentFailure');
            if (!life) console.warn('VCard slideshow: publication failed', error);
          }
        })).catch((error) => postSlideshow('Operation.Fail', () => {
          if (error?.name === 'AbortError' || scope.signal.aborted || stopped || version !== sourceVersion) return;
          unavailableFrames.add(nextFrame);
          operation?.fail(error);
          if (life) life.reportFault(error, { type: 'Operation.Fail', owner: operation || life }, 'ResourceFailure');
          else console.warn(`VCard slideshow: skipping unavailable frame: ${nextSource}`, error);
        })).finally(() => {
          scope.abort();
          return postSlideshow('Slideshow.Settle', () => {
            if (preparation !== scope) return;
            preparation = null;
            if (!timer) schedule();
          });
        });
      };

      function showNextFrame() {
        if (!hasSlideshow || stopped || isInactive()) return;

        const frames = effectiveFrames();
        const firstFrame = 0;
        if (frames.length - firstFrame < 2) {
          schedule();
          return;
        }
        let nextFrame = currentFrame + direction;
        for (let attempts = 0; attempts < frames.length * 2; attempts += 1) {
          if (nextFrame >= frames.length) {
            direction = -1;
            nextFrame = Math.max(firstFrame, frames.length - 2);
          } else if (nextFrame < firstFrame) {
            direction = 1;
            nextFrame = Math.min(frames.length - 1, firstFrame + 1);
          }
          if (!unavailableFrames.has(nextFrame)) break;
          nextFrame += direction;
        }
        if (unavailableFrames.has(nextFrame) || nextFrame === currentFrame) { schedule(); return; }
        prepareFrame(nextFrame);
      }

      const resetToFirstFrame = () => {
        clearTimer();
        preparation?.abort();
        preparation = null;
        clearCrossfade();
        sourceVersion += 1;
        direction = 1;
        currentFrame = 0;
        image.classList.remove('is-slideshow-changing');
        if (!vcardMedia.mediaStates.has(image)) {
          vcardMedia.register(image, baseList, baseFrames, 0);
        } else {
          vcardMedia.setIndex(image, 0, false);
        }
        schedule();
      };

      resetToFirstFrame();
      if (songPreview) {
        songPreview.addEventListener('vcard:song-open', resetToFirstFrame, { signal });
        songPreview.addEventListener('vcard:song-close', () => {
          clearTimer();
          sourceVersion += 1;
          preparation?.abort();
          preparation = null;
          clearCrossfade();
          image.classList.remove('is-slideshow-changing');
        }, { signal });
      }

      controllers.push({
        stop() {
          stopped = true;
          this.pause();
        },
        pause() {
          clearTimer();
          sourceVersion += 1;
          preparation?.abort();
          preparation = null;
          clearCrossfade();
          image.classList.remove('is-slideshow-changing');
        },
        finishMotion() {
          if (!crossfadeLayer) return;
          clearCrossfade();
          clearTimer();
          schedule();
        },
        resume() {
          if (stopped || preparation || timer || isInactive()) return;
          schedule();
        }
      });
      return true;
      })();
      initializationPromises.set(image, initialization);
      return initialization;
    };

    document.querySelectorAll('img[slideshow]:not(.song__preview-image)')
      .forEach(initializeSlideshow);
    document.addEventListener('vcard:activate-portal-image', (event) => {
      const image = event.detail?.image;
      if (image?.hasAttribute('slideshow')) initializeSlideshow(image);
    }, { signal });

    const syncSlideshowVisibility = () => {
      controllers.forEach((controller) => {
        if (!vcardMotionPolicy.snapshot().pageVisible || document.documentElement.dataset.imagesVisible === 'off'
          || window.VCLife?.pageSuspended) controller.pause();
        else {
          if (!vcardMotionPolicy.snapshot().motionAllowed) controller.finishMotion();
          controller.resume();
        }
      });
    };
    document.addEventListener('visibilitychange', syncSlideshowVisibility, { signal });
    document.addEventListener('vcard:motion-state', syncSlideshowVisibility, { signal });
    document.addEventListener('vcard:images-visible-state', syncSlideshowVisibility, { signal });
    window.addEventListener('pagehide', (event) => {
      if (event.persisted) controllers.forEach((controller) => controller.pause());
      else slideshowScope.abort();
    }, { signal });
    window.addEventListener('pageshow', () => {
      if (signal.aborted || visibilityFrame) return;
      visibilityFrame = vcardRenderScheduler.request(() => {
        visibilityFrame = 0;
        syncSlideshowVisibility();
      }, { owner: document.documentElement, scope: slideshowScope,
        onCancel: () => { visibilityFrame = 0; } });
    }, { signal });
  })();

  (() => {
    const initializationPromises = new WeakMap();

    const portalImagesScope = new AbortController();
    const { signal } = portalImagesScope;
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) portalImagesScope.abort();
    }, { signal });
    const initializePortalImage = (image) => {
      // The compositor detaches its source layer but retains this image as
      // the current portal's owned source until the next card is selected.
      const connected = () => Boolean(image && (image.isConnected
        || window.VCardPortal?.imageFor?.() === image));
      if (signal.aborted || !connected()) return Promise.resolve(false);
      if (vcardMedia.mediaStates.has(image)) return Promise.resolve(true);
      if (initializationPromises.has(image)) return initializationPromises.get(image);
      const life = window.VCLife;
      const operation = life && window.VCLifeCore?.TOperation
        ? new window.VCLifeCore.TOperation(life, 'portal-image-initialize') : null;
      if (operation) image.dataset.portalInitialization = JSON.stringify(operation.snapshot());
      if (operation) signal.addEventListener('abort', () => operation.cancel('page-disposed'),
        { once: true, signal: operation.scope.signal });
      const current = () => !signal.aborted && connected()
        && (!operation || operation.status === 'Running');
      const post = (type, apply) => {
        const run = () => current() ? apply() : false;
        return life ? life.queue.post(run, { type, owner: life, scope: portalImagesScope }) : Promise.resolve(run());
      };
      let resourceFailure = false;
      const initialization = (async () => {
      vcardMedia.ensurePortalMotionLayer(image);
      if (window.VCardPortalLayout?.isFullscreen(image)) image.classList.add('is-fullscreen');
      const showCatalogUrl = String(image.dataset.portalShows || '').trim();
      if (showCatalogUrl) {
        try {
          const catalog = await vcardMedia.loadShowCatalog(showCatalogUrl);
          if (!current()) return false;
          await post('Portal.Catalog.Ready', () => { image.vcardShowCatalog = catalog; });
        } catch (error) {
          if (!current() || error?.name === 'AbortError') return false;
          await post('Portal.Catalog.Fail', () => {
            if (life) life.reportFault(error, { type: 'Portal.Catalog.Fail', owner: operation || life }, 'ResourceFailure');
            else console.warn(`VCard PortalTV: cannot load ${showCatalogUrl}`, error);
          });
        }
      }
      image.addEventListener('vcard:image-fullscreen', () => vcardMedia.renderState(image), { signal });
      const baseSrc = image.getAttribute('src') || '';
      const cleanSrc = baseSrc.split(/[?#]/, 1)[0];
      const explicitList = String(image.dataset.portalList || '').trim();
      const listUrl = explicitList || (cleanSrc.toLowerCase().endsWith('.js')
        ? baseSrc
        : `${vcardMedia.listDirectory(baseSrc)}list.js`);
      let items = [];
      try {
        items = await vcardMedia.loadList(listUrl);
      } catch (error) {
        if (!current() || error?.name === 'AbortError') return false;
        if (cleanSrc.toLowerCase().endsWith('.js')) {
          resourceFailure = true;
          throw error;
        }
      }
      if (!current()) return false;
      const groups = items.length
        ? vcardMedia.mediaGroups(items)
        : [vcardMedia.directMediaGroup(baseSrc)];
      const initialIndex = Math.max(
        0,
        groups.findIndex((group) => vcardMedia.sourcesForMode(
          group, vcardMedia.effectiveImageMode(image)
        ).some(
          (source) => vcardMedia.normalizedName(source) === vcardMedia.normalizedName(baseSrc)
        ))
      );
      return post('Operation.Complete', () => {
        if ((image.getAttribute('src') || '') !== baseSrc) return false;
        try {
          vcardMedia.register(image, items.length ? listUrl : '', groups, initialIndex);
          vcardMedia.setHistoryLists(
            image,
            String(image.dataset.portalHistoryLists || '')
              .split(',')
              .map((url) => url.trim())
              .filter(Boolean)
          );
          if (image.dataset.portalRandomStartPending === 'true') {
            delete image.dataset.portalRandomStartPending;
            vcardMedia.randomStart(image);
          }
          document.dispatchEvent(new CustomEvent('vcard:portal-items-change', {
            detail: {
              preview: image.closest('.song__preview'),
              count: groups.length
            }
          }));
          operation?.complete({ listUrl: items.length ? listUrl : '', count: groups.length });
          return true;
        } catch (error) {
          operation?.fail(error);
          vcardMedia.release(image);
          image.setAttribute('src', baseSrc);
          if (life) life.reportFault(error, { type: 'Operation.Fail', owner: operation || life }, 'ComponentFailure');
          else console.warn('VCard portal: cannot publish visible image', error);
          return false;
        }
      });
      })().catch((error) => {
        if (!current() || error?.name === 'AbortError') return false;
        return post('Operation.Fail', () => {
          operation?.fail(error);
          if (life) life.reportFault(error, { type: 'Operation.Fail', owner: operation || life },
            resourceFailure ? 'ResourceFailure' : 'ComponentFailure');
          else console.warn('VCard portal: cannot initialize visible image', error);
          return false;
        });
      }).finally(() => {
        operation?.cancel('portal-initialization-finished');
        if (!vcardMedia.mediaStates.has(image)) delete image.dataset.portalPreviewPending;
        if (operation && !signal.aborted && image.isConnected) {
          image.dataset.portalInitialization = JSON.stringify(operation.snapshot());
        }
        initializationPromises.delete(image);
      });
      initializationPromises.set(image, initialization);
      return initialization;
    };

    // Scene slots clone the song image and therefore need its media list to
    // be registered first. Reuse the activation promise so opening and
    // immediately playing a song cannot publish an empty slot.
    vcardMedia.initializePortalImage = initializePortalImage;

    document.addEventListener('vcard:activate-portal-image', (event) => {
      initializePortalImage(event.detail && event.detail.image);
    }, { signal });
  })();

  (() => {
    const IMAGES_VISIBLE_STORAGE_KEY = 'vcard-images-visible';
    const PORTAL_SIZE_STORAGE_KEY = 'vcard-portal-size';
    const NAVIGATION_HISTORY_KEY = 'vcardNavigation';
    const root = document.documentElement;
    let activeImage = null;
    let activeFrame = null;
    const portalStates = new Map();
    const portalEntryKey = (frame) => window.VCardCatalogView?.forPreview(frame?.closest('.song__preview'))?.entryKey || '';
    const portalStateFor = (frame) => {
      const key = portalEntryKey(frame);
      if (!portalStates.has(key)) portalStates.set(key, { size: rememberedPortalSize, returnSize: null });
      return portalStates.get(key);
    };
    let fullscreenEntryKey = '';
    const openedPortalPreview = () => window.VCardSongControls?.currentPreview?.() || null;
    const storedPortalSize = vcardStorage.local.getItem(PORTAL_SIZE_STORAGE_KEY);
    let rememberedPortalSize = ['small', 'mid'].includes(storedPortalSize)
      ? storedPortalSize
      : 'mid';
    const navigationState = () => history.state?.[NAVIGATION_HISTORY_KEY];
    const replaceNavigationState = (context = null) => {
      const state = { ...(history.state || {}) };
      delete state.vcardPortalFullscreen;
      if (context) state[NAVIGATION_HISTORY_KEY] = context;
      else delete state[NAVIGATION_HISTORY_KEY];
      history.replaceState(state, '', window.location.href);
    };
    if (navigationState() || history.state?.vcardPortalFullscreen) replaceNavigationState();
    // Fullscreen is a temporary browser context, never a saved preference.
    const navigationScope = new AbortController();
    let portalLayoutFrame = 0;
    navigationScope.signal.addEventListener('abort', () => {
      vcardRenderScheduler.cancel(portalLayoutFrame);
      portalLayoutFrame = 0;
    }, { once: true });
    const requestPortalLayoutPublication = () => {
      if (navigationScope.signal.aborted || portalLayoutFrame) return;
      portalLayoutFrame = vcardRenderScheduler.request(() => {
        portalLayoutFrame = 0;
        document.dispatchEvent(new CustomEvent('vcard:debug-layout-change'));
      }, { owner: root, scope: navigationScope, priority: 1,
        onCancel: () => { portalLayoutFrame = 0; } });
    };
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) navigationScope.abort();
    }, { signal: navigationScope.signal });
    let fullscreenHistoryActive = false;
    const browserNavigation = Object.freeze({
      open: (context) => {
        if (navigationScope.signal.aborted) return;
        if (fullscreenHistoryActive) replaceNavigationState(context);
        else history.pushState({ ...(history.state || {}), [NAVIGATION_HISTORY_KEY]: context }, '');
        fullscreenHistoryActive = true;
      },
      close: () => {
        if (navigationScope.signal.aborted) return;
        if (!fullscreenHistoryActive || navigationState()?.type !== 'portal-fullscreen') return;
        fullscreenHistoryActive = false;
        history.back();
      },
      reset: () => {
        if (navigationScope.signal.aborted) return;
        fullscreenHistoryActive = false;
        replaceNavigationState();
      },
    });
    window.VCardBrowserNavigation = browserNavigation;
    const canOpenFullscreen = (image) => image.matches('.song__preview-image, .song-vibeframe');

    const consumeFullscreenHistory = () => {
      browserNavigation.close();
    };

    const closeImage = () => {
      if (!activeImage) return;
      const image = activeImage;
      const frame = activeFrame || image.closest('.image-vibeframe, .song-vibeframe');
      image.classList.remove('is-fullscreen');
      if (frame) {
        frame.classList.remove('has-fullscreen-image', 'is-fullscreen');
        frame.querySelectorAll('.song__preview-image.is-fullscreen').forEach((item) => item.classList.remove('is-fullscreen'));
      }
      activeImage = null;
      activeFrame = null;
      fullscreenEntryKey = '';
      document.documentElement.classList.remove('page-image-open');
      image.dispatchEvent(new CustomEvent('vcard:image-fullscreen', {
        detail: { open: false }
      }));
    };

    const openImage = (image) => {
      closeImage();
      activeImage = image;
      const frame = image.closest('.image-vibeframe, .song-vibeframe');
      activeFrame = frame;
      fullscreenEntryKey = portalEntryKey(frame);
      if (frame) frame.classList.add('has-fullscreen-image');
      image.classList.add('is-fullscreen');
      document.documentElement.classList.add('page-image-open');
      image.dispatchEvent(new CustomEvent('vcard:image-fullscreen', {
        detail: { open: true }
      }));
      browserNavigation.open({ type: 'portal-fullscreen',
        entryKey: window.VCardCatalogView?.forPreview(image.closest('.song__preview'))?.entryKey || '',
        returnSize: frame ? portalStateFor(frame).returnSize || rememberedPortalSize : rememberedPortalSize });
    };

    const setPortalSize = (target, key, remember = true) => {
      const frame = target?.classList?.contains('song-vibeframe')
        ? target
        : target?.closest?.('.song-vibeframe');
      if (!frame) return;
      const full = key === 'f';
      const medium = key === 'm';
      const size = full ? 'full' : (medium ? 'mid' : 'small');
      portalStateFor(frame).size = size;
      frame.dataset.portalSize = size;
      if (remember) {
        rememberedPortalSize = size === 'small' ? 'small' : 'mid';
        vcardStorage.local.setItem(PORTAL_SIZE_STORAGE_KEY, rememberedPortalSize);
      }
      frame.classList.toggle('block-small', !medium && !full);
      frame.classList.toggle('block-mid', medium);
      frame.classList.toggle('block-full', full);
      document.dispatchEvent(new CustomEvent('vcard:portal-size', {
        detail: {
          preview: frame.closest('.song__preview'),
          size
        }
      }));
      vcardMedia.refresh();
      requestPortalLayoutPublication();
    };

    const portalMode = (preview) => {
      return fullscreenEntryKey && window.VCardCatalogView?.forPreview(preview)?.entryKey === fullscreenEntryKey ? 'full' : 'mono';
    };
    let imagesVisible = vcardSettingEnabled(IMAGES_VISIBLE_STORAGE_KEY, 'images');
    window.VCardPortalLayout = Object.freeze({
      isFullscreen: (target) => Boolean(fullscreenEntryKey
        && portalEntryKey(target?.closest?.('.song-vibeframe')) === fullscreenEntryKey),
      current: (preview) => {
        const frame = preview?.querySelector('.song-vibeframe');
        return Object.freeze({
          entryKey: window.VCardCatalogView?.forPreview(preview)?.entryKey || '',
          visible: imagesVisible,
          size: frame && portalEntryKey(frame) === fullscreenEntryKey
            ? 'full' : (portalStateFor(frame).size || rememberedPortalSize),
          returnSize: frame ? portalStateFor(frame).returnSize : null,
          fullscreenEntryKey,
        });
      },
    });

    const publishPortalMode = (preview, mode) => {
      document.dispatchEvent(new CustomEvent('vcard:portal-state', {
        detail: { preview, mode, visible: imagesVisible }
      }));
    };

    const applyImagesVisibility = () => {
      root.dataset.imagesVisible = imagesVisible ? 'on' : 'off';
      const visiblePreview = window.VCardSongControls?.currentPreview?.() || null;
      const visibleFrame = visiblePreview && visiblePreview.querySelector('.song-vibeframe');
      if (visibleFrame) visibleFrame.hidden = !imagesVisible;
      if (!imagesVisible && activeImage) {
        closeImage();
        consumeFullscreenHistory();
      }
      document.dispatchEvent(new CustomEvent('vcard:portal-state', {
        detail: {
          preview: visiblePreview,
          mode: portalMode(visiblePreview),
          visible: imagesVisible
        }
      }));
      document.dispatchEvent(new CustomEvent('vcard:images-visible-state', {
        detail: { visible: imagesVisible }
      }));
    };

    const setImagesVisible = (visible) => {
      imagesVisible = Boolean(visible);
      vcardStorage.local.setItem(IMAGES_VISIBLE_STORAGE_KEY, imagesVisible ? 'on' : 'off');
      applyImagesVisibility();
    };

    const setPortalMode = (preview, requestedMode, remember = true) => {
      const mode = requestedMode === 'full' ? 'full' : 'mono';
      const frame = preview && preview.querySelector('.song-vibeframe');
      const image = frame && (frame.querySelector('.song__preview-image') || frame);

      if (!frame) return;
      frame.dataset.portalMode = mode;
      frame.hidden = !imagesVisible;
      if (!imagesVisible) {
        if (activeFrame === frame) { closeImage(); consumeFullscreenHistory(); }
        publishPortalMode(preview, mode);
        return;
      }

      if (mode === 'full') {
        if (!['small', 'mid'].includes(portalStateFor(frame).returnSize)) {
          portalStateFor(frame).returnSize = ['small', 'mid'].includes(portalStateFor(frame).size)
            ? portalStateFor(frame).size : rememberedPortalSize;
        }
        if (!image) {
          publishPortalMode(preview, 'mono');
          return;
        }
        openImage(image);
      } else {
        if (activeFrame === frame) {
          closeImage();
          consumeFullscreenHistory();
        }
        const returnSize = portalStateFor(frame).returnSize;
        portalStateFor(frame).returnSize = null;
        const targetSize = ['small', 'mid'].includes(returnSize)
          ? returnSize
          : rememberedPortalSize;
        setPortalSize(frame, targetSize === 'small' ? 's' : 'm', remember);
      }
      publishPortalMode(preview, mode);
    };

    const restorePortalState = (preview) => {
      const frame = preview && preview.querySelector('.song-vibeframe');
      if (!frame) return;
      const portrait = vcardEnvironment.media('(orientation: portrait)').matches;
      const restoredSize = portrait ? 'small' : rememberedPortalSize;
      setPortalSize(frame, restoredSize === 'small' ? 's' : 'm', false);
      // Fullscreen belongs to the image the user explicitly opened.  Restoring
      // it for the next track briefly promoted the cassette/poster to the full
      // viewport during automatic track changes on iPad.
      setPortalMode(preview, 'mono', false);
    };

    const exitPortalFullscreenToMid = () => {
      const image = activeImage;
      const frame = activeFrame || image?.closest('.song-vibeframe');
      const preview = frame?.closest('.song__preview');
      if (!image || !preview || !frame) return;
      const portrait = vcardEnvironment.media('(orientation: portrait)').matches;
      if (!['small', 'mid'].includes(portalStateFor(frame).returnSize)) {
        portalStateFor(frame).returnSize = portrait ? 'small' : 'mid';
      }
      setPortalMode(preview, 'mono');
    };

    window.addEventListener('popstate', (event) => {
      const context = event.state?.[NAVIGATION_HISTORY_KEY];
      const nextHistoryActive = context?.type === 'portal-fullscreen';
      // Forward can revisit a consumed context after its portal was closed.
      // Keep the current view and clear only our obsolete history field.
      if (nextHistoryActive && !activeImage) {
        browserNavigation.reset();
        return;
      }
      const closesFullscreen = fullscreenHistoryActive && !nextHistoryActive;
      fullscreenHistoryActive = nextHistoryActive;
      if (!closesFullscreen || !activeImage) return;
      exitPortalFullscreenToMid();
    }, { signal: navigationScope.signal });

    document.addEventListener('vcard:set-portal-mode', (event) => {
      const detail = event.detail || {};
      const preview = detail.preview || window.VCardSongControls?.currentPreview?.() || null;
      setPortalMode(preview, detail.mode);
    }, { signal: navigationScope.signal });

    document.addEventListener('vcard:set-portal-size', (event) => {
      const detail = event.detail || {};
      const preview = detail.preview || window.VCardSongControls?.currentPreview?.() || null;
      const frame = preview && preview.querySelector('.song-vibeframe');
      const image = frame && frame.querySelector('.song__preview-image');
      if (!frame) {
        if (['small', 'mid'].includes(detail.size)) {
          rememberedPortalSize = detail.size;
          vcardStorage.local.setItem(PORTAL_SIZE_STORAGE_KEY, rememberedPortalSize);
        }
        return;
      }
      if (portalEntryKey(frame) === fullscreenEntryKey) return;
      const sizeKey = detail.size === 'small'
        ? 's'
        : (detail.size === 'full' ? 'f' : 'm');
      setPortalSize(frame, sizeKey);
      publishPortalMode(preview, 'mono');
    }, { signal: navigationScope.signal });

    document.addEventListener('vcard:set-images-visible', (event) => {
      const detail = event.detail || {};
      setImagesVisible(detail.visible);
    }, { signal: navigationScope.signal });

    document.addEventListener('vcard:request-portal-state', (event) => {
      const detail = event.detail || {};
      const preview = detail.preview || window.VCardSongControls?.currentPreview?.() || null;
      if (!preview) {
        document.dispatchEvent(new CustomEvent('vcard:portal-state', {
          detail: {
            preview: null,
            mode: 'mono',
            visible: imagesVisible
          }
        }));
        return;
      }
      restorePortalState(preview);
    }, { signal: navigationScope.signal });

    document.addEventListener('vcard:song-open', (event) => {
      const preview = event.target && event.target.closest('.song__preview');
      if (preview) restorePortalState(preview);
    }, { signal: navigationScope.signal });
    document.addEventListener('vcard:song-close', (event) => {
      const preview = event.target?.closest('.song__preview');
      if (preview && activeFrame?.closest('.song__preview') === preview) setPortalMode(preview, 'mono');
    }, { signal: navigationScope.signal });

    document.addEventListener('contextmenu', (event) => {
      const frame = event.target?.closest?.('.song-vibeframe');
      if (!frame) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const input = { type: 'Portal.StepSize', source: 'Portal', target: frame,
        trusted: event.isTrusted };
      if (!window.VCCommands) stepPortalSize(input);
      else window.VCCommands.dispatch(input);
    }, { capture: true, signal: navigationScope.signal });

    document.addEventListener('vcard:page-image-fullscreen', (event) => {
      const image = event.detail && event.detail.image;
      if (!image) return;
      if (event.detail.open) {
        if (!canOpenFullscreen(image)) return;
        setPortalMode(image.closest('.song__preview'), 'full');
      } else if (activeImage === image || (image.closest('.song-vibeframe')
        && activeFrame === image.closest('.song-vibeframe'))) {
        if (image.matches('.song__preview-image, .song-vibeframe')) {
          setPortalMode(image.closest('.song__preview'), 'mono');
        } else {
          closeImage();
        }
      } else {
        image.classList.remove('is-fullscreen');
        const frame = image.closest('.image-vibeframe, .song-vibeframe');
        if (frame) frame.classList.remove('has-fullscreen-image');
      }
    }, { signal: navigationScope.signal });

    document.addEventListener('dblclick', (event) => {
      if (event.button !== 0) return;
      const frame = event.target.closest('.song-vibeframe');
      const image = frame && (frame.querySelector('.song__preview-image') || frame);
      const preview = frame && frame.closest('.song__preview');
      if (!image || !preview) return;
      if (!imagesVisible) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      document.dispatchEvent(new CustomEvent('vcard:portal-double-click', {
        detail: { preview }
      }));
      const input = { type: 'Portal.Expand', source: 'Portal', target: frame,
        trusted: event.isTrusted };
      if (!window.VCCommands) expandPortal(input);
      else window.VCCommands.dispatch(input);
    }, { signal: navigationScope.signal });

    const portalResizeAvailable = ({ target } = {}) => Boolean(
      !navigationScope.signal.aborted && imagesVisible
      && !window.VCardSettingsContext?.isOpen?.()
      && target?.isConnected && target.matches('.song-vibeframe') && !target.hidden
      && target.closest('.song__preview') === openedPortalPreview()
      && portalEntryKey(target) !== fullscreenEntryKey
    );
    const stepPortalSize = (input) => {
      if (!portalResizeAvailable(input)) return false;
      const frame = input.target;
      setPortalSize(frame, portalStateFor(frame).size === 'small' ? 'm' : 's');
      publishPortalMode(frame.closest('.song__preview'), 'mono');
      return true;
    };
    const expandPortal = (input) => {
      if (!portalResizeAvailable(input)) return false;
      const frame = input.target;
      const preview = frame.closest('.song__preview');
      const portrait = vcardEnvironment.media('(orientation: portrait)').matches;
      if (!portrait && portalStateFor(frame).size === 'small') {
        portalStateFor(frame).returnSize = 'small';
        setPortalSize(frame, 'm');
        return true;
      }
      if (!portalStateFor(frame).returnSize) {
        portalStateFor(frame).returnSize = portalStateFor(frame).size === 'small'
          ? 'small'
          : 'mid';
      }
      setPortalMode(preview, 'full');
      return true;
    };

    const portalCloseAvailable = () => {
      if (navigationScope.signal.aborted) return false;
      if (activeImage) return true;
      const frame = openedPortalPreview()?.querySelector('.song-vibeframe');
      return Boolean(frame && portalStateFor(frame).returnSize === 'small');
    };
    const closePortalContext = () => {
      if (!portalCloseAvailable()) return false;
      if (!activeImage) {
        const preview = window.VCardSongControls?.currentPreview?.() || null;
        const frame = preview && preview.querySelector('.song-vibeframe');
        portalStateFor(frame).returnSize = null;
        setPortalSize(frame, 's');
        publishPortalMode(preview, 'mono');
        return true;
      }
      if (activeImage.matches('.song__preview-image, .song-vibeframe')) {
        exitPortalFullscreenToMid();
        return true;
      }
      closeImage();
      consumeFullscreenHistory();
      return true;
    };
    window.VCardPortalContext = Object.freeze({ available: portalCloseAvailable, close: closePortalContext,
      canResize: portalResizeAvailable, stepSize: stepPortalSize, expand: expandPortal });
    vcardKeyboard.register((event) => {
      if (event.key !== 'Escape' || !portalCloseAvailable()) return false;
      if (event.repeat) return true;
      if (!window.VCCommands) return closePortalContext();
      return window.VCCommands.dispatch({ type: 'Portal.Close', source: 'Keyboard', trusted: event.isTrusted });
    }, 50);

    applyImagesVisibility();
  })();

  (() => {
    const indexButtons = Array.from(document.querySelectorAll('.tabs__item'));
    const listSections = Array.from(document.querySelectorAll('.list'));
    const buttons = Array.from(document.querySelectorAll('.song__item'));
    const previews = Array.from(document.querySelectorAll('.song__preview'));
    const portalOrigins = new WeakMap();
    previews.forEach((preview) => {
      const portal = preview.querySelector('.song-portal-stage, .song-vibeframe');
      if (!portal) return;
      const origin = document.createElement('div');
      origin.className = 'song-portal-origin';
      origin.setAttribute('aria-hidden', 'true');
      portal.before(origin);
      portalOrigins.set(portal, origin);
    });
    const previewsByButton = new Map();
    const buttonsByPreview = new Map();
    const buttonsByAddress = new Map();
    const entriesByButton = new Map();
    const catalogEntryKeys = new Set();
    const addressKey = (listId, localId) => JSON.stringify([String(listId || '').toLowerCase(), String(localId || '').toLowerCase()]);
    const catalogEntries = Object.freeze(buttons.map((button) => {
      const anchor = button.closest('.song__title') || button;
      let preview = anchor.nextElementSibling;
      while (preview && !preview.classList.contains('song__preview')) {
        preview = preview.nextElementSibling;
      }
      previewsByButton.set(button, preview);
      if (preview) buttonsByPreview.set(preview, button);
      const listId = String(button.dataset.list || '');
      const localId = String(button.dataset.song || '');
      const songId = String(button.dataset.songId || '');
      const releaseId = String(button.dataset.releaseId || '');
      const releaseKey = songId && releaseId
        ? JSON.stringify([songId.toLowerCase(), releaseId.toLowerCase()]) : '';
      const image = preview?.querySelector('.song__preview-image');
      const audioSrc = String(preview?.querySelector('[ids="audio"][data-audio-src]')?.dataset.audioSrc || preview?.dataset.src || '').trim();
      const entry = Object.freeze({
        listId, localId, songId, releaseId, releaseKey,
        entryKey: releaseKey ? JSON.stringify([listId.toLowerCase(), songId.toLowerCase(), releaseId.toLowerCase()]) : '',
        title: (button.querySelector('.song__player-title')?.textContent || button.querySelector('.song__item-text')?.textContent || button.textContent || '').replace(/\s+/g, ' ').trim(),
        author: String(preview?.dataset.mp3Author || '').trim(),
        audioSrc,
        playable: Boolean(audioSrc && !audioSrc.endsWith('/')),
        hasTrackBand: Boolean(preview?.querySelector('[data-track-band]')?.dataset.trackBand?.trim()),
        hasImages: Boolean(image),
        hasShow: Boolean(image?.dataset.portalShows),
      });
      entriesByButton.set(button, entry);
      if (entry.entryKey) {
        if (catalogEntryKeys.has(entry.entryKey)) console.warn('VCard duplicate EntryKey', entry.entryKey);
        catalogEntryKeys.add(entry.entryKey);
      }
      const key = addressKey(listId, localId);
      if (buttonsByAddress.has(key)) console.warn('VCard duplicate song address', listId, localId);
      else buttonsByAddress.set(key, button);
      return entry;
    }));
    const buttonPreview = (button) => previewsByButton.get(button) || null;
    const previewButton = (preview) => buttonsByPreview.get(preview) || null;
    const findSongButton = (listId, localId) => window.VCardCatalogView.buttonFor(window.VCardCatalog.find(listId, localId));
    const existingListIds = new Set(listSections.map((section) => section.id));
    const catalogListIds = Object.freeze([...new Set([
      ...indexButtons.map((button) => button.getAttribute('list')),
      ...existingListIds,
    ])].filter((id) => id && existingListIds.has(id)));
    const entriesByKey = new Map(catalogEntries.map((entry) => [entry.entryKey, entry]));
    const entriesByAddress = new Map();
    for (const entry of catalogEntries) {
      const key = addressKey(entry.listId, entry.localId);
      if (!entriesByAddress.has(key)) entriesByAddress.set(key, entry);
    }
    const entriesByList = new Map(catalogListIds.map((listId) => [listId,
      Object.freeze(catalogEntries.filter((entry) => entry.listId === listId))]));
    const buttonsByEntryKey = new Map(buttons.map((button) => [entriesByButton.get(button).entryKey, button]));
    window.VCardCatalog = Object.freeze({
      entries: catalogEntries,
      listIds: catalogListIds,
      get: (entryKey) => entriesByKey.get(entryKey) || null,
      find: (listId, localId) => entriesByAddress.get(addressKey(listId, localId)) || null,
      forList: (listId) => entriesByList.get(listId) || Object.freeze([]),
    });
    // The catalog has no DOM handles. Resolve them only at the view boundary.
    window.VCardCatalogView = Object.freeze({
      forButton: (button) => entriesByButton.get(button) || null,
      forPreview: (preview) => entriesByButton.get(previewButton(preview)) || null,
      buttonFor: (entry) => buttonsByEntryKey.get(entry?.entryKey) || null,
      previewFor: (entry) => buttonPreview(buttonsByEntryKey.get(entry?.entryKey)) || null,
    });
    const audios = () => sharedSongAudio ? [sharedSongAudio] : [];
    const players = new WeakMap();

    const playerDock = document.createElement('div');
    playerDock.className = 'vcard-player-dock block-mid has-player is-audio-unavailable';
    const playbackStatus = document.createElement('span');
    playbackStatus.className = 'vcard-playback-status';
    playbackStatus.setAttribute('role', 'status');
    playbackStatus.setAttribute('aria-live', 'polite');
    playbackStatus.setAttribute('aria-atomic', 'true');
    playerDock.append(playbackStatus);
    let announcedPlaybackState = '';
    let projectPlaybackControls = null;
    const projectPlaybackStatus = (snapshot) => {
      const phase = snapshot?.phase;
      const state = phase === 'NextPending' || snapshot?.playbackChain?.autoReadyPending
        ? 'waiting' : ({ AudioPlaying: 'playing', AudioPaused: 'paused',
          ReadyPaused: 'paused', FinishedStopped: 'stopped', Idle: 'stopped' })[phase];
      if (!state || state === announcedPlaybackState) return;
      if (phase === 'ReadyPaused' && state === 'paused' && announcedPlaybackState === 'stopped') return;
      const first = !announcedPlaybackState;
      announcedPlaybackState = state;
      if (first && state !== 'playing' && state !== 'waiting') return;
      const text = { waiting: 'Ожидание следующей песни',
        playing: 'Воспроизведение', paused: 'Пауза', stopped: 'Воспроизведение остановлено' }[state];
      if (playbackStatus.textContent !== text) playbackStatus.textContent = text;
    };
    const playerTopline = document.createElement('div');
    playerTopline.className = 'vcard-player-topline';
    const playerSecondline = document.createElement('div');
    playerSecondline.className = 'vcard-player-secondline';
    const playerTitle = document.createElement('div');
    playerTitle.className = 'vcard-player-title';
    playerTitle.setAttribute('aria-live', 'off');
    playerTitle.setAttribute('role', 'button');
    playerTitle.setAttribute('tabindex', '0');
    const playerTitleHint = vcardHints.playerTitle || 'Toggle image size';
    playerTitle.setAttribute('aria-label', playerTitleHint);
    playerTitle.setAttribute('title', playerTitleHint);
    playerTitle.dataset.vcardHint = 'true';
    const playerTitleTemplate = String(
      vcardUiConfig.playerTitleTemplate || '%TIT%'
    );
    const playerTitlePlainText = (html) => {
      const template = document.createElement('template');
      template.innerHTML = String(html || '').replace(/<br\s*\/?>/gi, ' ');
      return String(template.content.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
    };
    const startupPlayerTitle = playerTitlePlainText(vcardUiConfig.playerStartUpTitleTemplate || 'VCARD');
    playerTitle.textContent = startupPlayerTitle;
    playerTitle.classList.add('is-startup');
    playerTitle.dataset.fullTitle = startupPlayerTitle;
    playerTitle.setAttribute('aria-disabled', 'true');
    playerTitle.tabIndex = -1;
    playerTopline.append(playerTitle);
    playerDock.append(playerTopline, playerSecondline);
    const sitemapTarget = document.getElementById('sitemap');
    const sitemapButton = document.createElement('button');
    sitemapButton.type = 'button';
    sitemapButton.className = 'plyr__control plyr__controls__item vcard-player-sitemap';
    sitemapButton.setAttribute('aria-label', 'Карта сайта');
    sitemapButton.title = 'Карта сайта — свернуть песни и перейти к обновлениям';
    sitemapButton.disabled = !sitemapTarget;
    sitemapButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 7v5M4 16v-4h16v4" fill="none" stroke="currentColor" stroke-width="2"/><g fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="2" width="6" height="5"/><rect x="1" y="16" width="6" height="6"/><rect x="9" y="16" width="6" height="6"/><rect x="17" y="16" width="6" height="6"/></g><path d="M12 12v4" stroke="currentColor" stroke-width="2"/></svg>';
    playerDock.append(sitemapButton);
    const playerControlsScope = new AbortController();
    const secretTarget = (target) => target.closest?.('.plyr__time--current, button[data-plyr="mute"]');
    const secretAction = (target) => {
      if (target.matches('.plyr__time--current')) window.VCPlayer?.nextShow?.(true);
      else window.VCPlayer?.grayShow?.();
    };
    document.addEventListener('contextmenu', (event) => {
      const target = secretTarget(event.target);
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      secretAction(target);
    }, { capture: true, signal: playerControlsScope.signal });
    document.addEventListener('click', (event) => {
      if (!event.target.closest?.('.plyr__time--current')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.VCPlayer?.nextShow?.();
    }, { capture: true, signal: playerControlsScope.signal });
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) playerControlsScope.abort();
    }, { signal: playerControlsScope.signal });
    const playerDebug = document.createElement('div');
    playerDebug.className = 'vcard-player-debug';
    playerDebug.setAttribute('aria-label', 'VCard and VCPlayer debug information');
    const selectionMemoryDiagnostics = (memory) => {
      if (!memory) return null;
      const observedAt = Date.now();
      const expiresAt = memory.lastPlayedAt ? memory.lastPlayedAt + memory.ttlSeconds * 1000 : null;
      return {
        ...memory,
        observedAt,
        expiresAt,
        remainingSeconds: expiresAt === null ? null : Math.max(0, Math.ceil((expiresAt - observedAt) / 1000)),
        recent: memory.recent.map((entry) => ({ ...entry,
          ageSeconds: Math.max(0, Math.floor((observedAt - entry.startedAt) / 1000)),
        })),
      };
    };
    playerDebug.innerHTML = [
      '<span class="vcard-player-debug__heading">Counters</span>',
      '<span data-debug-value="pageReloadTime">PageReloadTime=0</span>',
      '<span data-debug-value="globalVerseCount">GlobVerseCount=0</span>',
      '<span data-debug-value="globalSlideCount">GlobSlideCount=0</span>',
      '<span data-debug-value="showProfile">ShowProfile=—</span>',
      '<span data-debug-value="showSource">ShowSource=—</span>',
      '<span data-debug-value="pageReload">Page.Reload=—</span>',
      '<span data-debug-value="decision">Decision=—</span>',
      '<span data-debug-value="randomSeed">RandomSeed=—</span>',
      '<span data-debug-value="mediaLoader">MediaLoader=—</span>',
      '<span data-debug-value="renderScheduler">RenderScheduler=—</span>',
      '<span data-debug-value="lastFault">LastFault=—</span>',
      '<span data-debug-value="manualSelection">MANSelection=—</span>',
      '<span data-debug-value="selectionMemory">SelectionMemory=—</span>',
      '<span data-debug-value="playbackHistory">PlaybackHistory=—</span>',
      '<button type="button" data-debug-export-decisions>Сохранить решения</button>',
      '<details data-debug-decisions><summary>Журнал решений</summary><pre></pre></details>',
      '<span class="vcard-player-debug__heading">VCDecor</span>',
      '<span data-debug-value="COLOR_CHANGE_PERIOD">COLOR_CHANGE_PERIOD=— rem=—</span>',
      '<span data-debug-value="BACK_CHANGE_PERIOD">BACK_CHANGE_PERIOD=— rem=—</span>',
      '<span class="vcard-player-debug__heading">VCPlayer</span>',
      '<span data-debug-value="STATIC_CASS_DELAY">STATIC_CASS_DELAY=—</span>',
      '<span class="vcard-player-debug__heading">SHOW</span>',
      '<span data-debug-value="scenarioVersion">Ver=—</span>',
      '<span data-debug-value="scenarioSource">Src=—</span>',
      '<span data-debug-value="scenarioName">Name=—</span>',
      '<span data-debug-styles><span data-debug-style-buttons></span> <span data-debug-style-active></span></span>',
    ].join(' ');
    const debugStyleImage = () => {
      const preview = window.VCLife?.openedSong?.preview;
      return preview && (window.VCardPortal?.imageFor?.(preview) || preview.querySelector('.song__preview-image'));
    };
    const refreshDebugStyles = () => {
      const image = debugStyleImage();
      const info = image && vcardMedia.mediaStates.has(image) ? vcardMedia.debugStyleInfo(image) : null;
      const container = playerDebug.querySelector('[data-debug-style-buttons]');
      const keys = info ? ['auto', ...info.available] : [];
      const signature = keys.join(' ');
      if (container.dataset.styles !== signature) {
        container.dataset.styles = signature;
        container.replaceChildren(...keys.map((key) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.debugStyle = key;
          button.textContent = key === '0' ? 'original' : key;
          return button;
        }));
      }
      container.querySelectorAll('button').forEach((button) => {
        const selected = button.dataset.debugStyle === info?.selected;
        button.setAttribute('aria-pressed', String(selected));
        const label = button.dataset.debugStyle === '0' ? 'original' : button.dataset.debugStyle;
        button.textContent = `${selected ? '● ' : ''}${label}`;
      });
      playerDebug.querySelector('[data-debug-style-active]').textContent = info ? `Active=${info.active}` : '—';
    };
    playerDebug.querySelector('[data-debug-styles]').addEventListener('click', (event) => {
      const button = event.target.closest('[data-debug-style]');
      const image = debugStyleImage();
      if (!button || !image || !vcardMedia.debugStyleInfo(image).available.concat('auto').includes(button.dataset.debugStyle)) return;
      vcardMedia.setDebugStyle(image, button.dataset.debugStyle);
      refreshDebugStyles();
    }, { signal: playerControlsScope.signal });
    const decisionPayload = () => {
      const snapshot = window.VCPlayer?.current?.();
      const { loader: mediaLoader, ...mediaResources } = vcardMedia.resourceSnapshot();
      return { build: window.VCardBuild?.BuildID || window.VCardUI?.vcardDatetime || window.VCardMediaManifest?.generatedAt || '',
        buildIdentity: window.VCardBuild || null,
        seed: snapshot?.random?.seed,
        seedSource: snapshot?.random?.seedSource,
        randomStreams: snapshot?.random?.streams || [],
        traceErrors: snapshot?.random?.traceErrors || 0,
        configuration: { ui: window.VCardUI, scenario: snapshot?.scenario,
          decoration: snapshot?.decoration?.constants },
        selectionMemory: selectionMemoryDiagnostics(snapshot?.selectionMemory),
        manualSelection: snapshot?.manualSelection,
        autopilotSelection: snapshot?.autopilotSelection,
        playbackHistory: snapshot?.playbackHistory,
        playbackContext: { revision: snapshot?.revision, phase: snapshot?.phase,
          selectionMode: snapshot?.selectionMode, chain: snapshot?.playbackChain,
          showProfile: snapshot?.showProfile,
          counters: { verses: snapshot?.globalVerseNumber, slides: snapshot?.globalSlideNumber },
          openedSong: snapshot?.openedSong, playingSong: snapshot?.playingSong },
        commandQueue: snapshot?.commandQueue || null,
        lastFault: snapshot?.commandQueue?.lastError || null,
        mediaLoader,
        mediaResources,
        renderScheduler: vcardRenderScheduler.snapshot(),
        mediaVersions: { lists: window.VCardMediaManifest?.lists,
          shows: window.VCardMediaManifest?.showCatalogs },
        decisions: window.VCPlayer?.decisionTrace?.() || [] };
    };
    const decisionDetails = playerDebug.querySelector('[data-debug-decisions]');
    const decisionExports = new Map();
    playerControlsScope.signal.addEventListener('abort', () => {
      decisionExports.forEach((timer, url) => {
        window.clearTimeout(timer);
        URL.revokeObjectURL(url);
      });
      decisionExports.clear();
    }, { once: true });
    decisionDetails.addEventListener('toggle', () => {
      if (decisionDetails.open) decisionDetails.querySelector('pre').textContent = JSON.stringify(decisionPayload(), null, 2);
    }, { signal: playerControlsScope.signal });
    playerDebug.querySelector('[data-debug-export-decisions]').addEventListener('click', () => {
      const payload = decisionPayload();
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'vcard-decisions.json';
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      decisionExports.set(url, window.setTimeout(() => {
        decisionExports.delete(url);
        URL.revokeObjectURL(url);
      }, 1000));
    }, { signal: playerControlsScope.signal });
    playerDock.prepend(playerDebug);
    document.body.prepend(playerDock);
    vcardSetBootstrapState('PlayerShellReady');
    // This zero-size marker stays in normal flow when the dock sticks.
    const stickyOrigin = document.createElement('div');
    stickyOrigin.style.cssText = 'height:0;width:0;flex:none;margin:0;padding:0;border:0;';
    stickyOrigin.setAttribute('aria-hidden', 'true');
    playerDock.before(stickyOrigin);
    const stickyBackdrop = document.createElement('div');
    stickyBackdrop.className = 'vcard-player-sticky-backdrop';
    stickyBackdrop.setAttribute('aria-hidden', 'true');
    stickyBackdrop.hidden = true;
    const stickyTexture = document.createElement('div');
    stickyTexture.className = 'vcard-player-sticky-texture';
    stickyBackdrop.append(stickyTexture);
    const stickySideFade = document.createElement('div');
    stickySideFade.className = 'vc-page-side-fade vcard-player-sticky-side-fade';
    stickyBackdrop.append(stickySideFade);
    document.body.append(stickyBackdrop);
    const widePlayerScreen = vcardEnvironment.media('(orientation: landscape) and (min-width: 901px)');
    let stickyBackdropFrame = 0;
    let stickyBackdropDirty = false;
    const syncStickyBackdrop = () => {
      const rect = playerDock.getBoundingClientRect();
      const style = getComputedStyle(playerDock);
      const stickyTop = Number.parseFloat(style.top) || 0;
      const stuck = widePlayerScreen.matches
        && style.position === 'sticky'
        && rect.height > 0
        && rect.bottom > stickyTop
        && Math.abs(rect.top - stickyTop) < 1
        && stickyOrigin.getBoundingClientRect().top < stickyTop - 0.5;
      const viewportHeight = window.innerHeight;
      stickyBackdropFrame = vcardRenderScheduler.request(() => {
        stickyBackdropFrame = 0;
        stickyBackdrop.hidden = !stuck;
        if (stuck) {
          stickyBackdrop.style.top = `${rect.top}px`;
          stickyBackdrop.style.height = `${rect.height}px`;
          stickyTexture.style.top = `${-rect.top}px`;
          stickyTexture.style.height = `${viewportHeight}px`;
        }
        if (stickyBackdropDirty) {
          stickyBackdropDirty = false;
          scheduleStickyBackdrop();
        }
      }, { owner: playerDock, scope: playerControlsScope, phase: 'write', priority: 0 });
    };
    const scheduleStickyBackdrop = () => {
      if (playerControlsScope.signal.aborted) return;
      if (stickyBackdropFrame) { stickyBackdropDirty = true; return; }
      stickyBackdropFrame = vcardRenderScheduler.request(syncStickyBackdrop, {
        owner: playerDock, scope: playerControlsScope, phase: 'measure', priority: 0,
      });
    };
    window.addEventListener('scroll', scheduleStickyBackdrop, { passive: true, signal: playerControlsScope.signal });
    document.addEventListener('vcard:environment-state', scheduleStickyBackdrop, { signal: playerControlsScope.signal });
    const stickyBackdropObserver = new ResizeObserver(scheduleStickyBackdrop);
    stickyBackdropObserver.observe(playerDock);
    stickyBackdropObserver.observe(document.body);
    playerControlsScope.signal.addEventListener('abort', () => {
      stickyBackdropObserver.disconnect();
      vcardRenderScheduler.cancel(stickyBackdropFrame);
      stickyBackdropFrame = 0;
      stickyBackdropDirty = false;
    }, { once: true });
    scheduleStickyBackdrop();
    let portalStickyHeight = 0;

    const setDebugValue = (name, label, value) => {
      const output = playerDebug.querySelector(`[data-debug-value="${name}"]`);
      const text = `${label}=${value ?? '—'}`;
      if (output && output.textContent !== text) output.textContent = text;
    };
    const formatDebugTime = (timestamp) => {
      const value = Number(timestamp);
      if (!Number.isFinite(value)) return '—';
      return new Date(value).toLocaleTimeString('ru-RU', { hour12: false });
    };
    let debugRevision = -1;
    const refreshPlayerDebug = (snapshot = window.VCPlayer?.diagnostics?.current?.() || null) => {
      if (playerControlsScope.signal.aborted || (snapshot && snapshot.revision < debugRevision)) return;
      if (snapshot) debugRevision = snapshot.revision;
      const profilePlayback = (snapshot?.playingSong || snapshot?.openedSong)?.playback;
      const showProfile = profilePlayback
        ? snapshot?.scenario?.profiles?.find((profile) => profile.name === profilePlayback.profile)
          || (snapshot?.showProfile?.name === profilePlayback.profile ? snapshot.showProfile : null)
        : snapshot?.showProfile;
      playerDebug.dataset.revision = String(snapshot?.revision || 0);
      playerDebug.dataset.commandId = String(snapshot?.commandId || 0);
      playerDebug.dataset.phase = String(snapshot?.phase || 'Idle');
      playerDebug.dataset.renderingActive = String(Boolean(snapshot?.renderingActive));
      playerDebug.dataset.pageVisible = String(Boolean(snapshot?.pageVisible));
      playerDebug.dataset.imagesVisible = String(Boolean(snapshot?.imagesVisible));
      playerDebug.dataset.audioMetadata = JSON.stringify(snapshot?.audio?.metadata || { stage: 'idle' });
      const fault = snapshot?.commandQueue?.lastError || null;
      playerDebug.dataset.lastFault = JSON.stringify(fault);
      setDebugValue('lastFault', 'LastFault', fault
        ? `${fault.kind} ${fault.type} x${fault.count}: ${fault.message}` : '—');
      const renderScheduler = vcardRenderScheduler.snapshot();
      playerDebug.dataset.renderScheduler = JSON.stringify(renderScheduler);
      setDebugValue('renderScheduler', 'RenderScheduler', `${renderScheduler.lastFrameMs.toFixed(1)}ms / ${renderScheduler.pending} pending / ${renderScheduler.deferred} deferred`);
      // Resource preparation can finish without a new player revision.
      // Read the same live owner as the decision export on every refresh.
      const mediaResources = vcardMedia.resourceSnapshot();
      const mediaLoader = mediaResources.loader;
      playerDebug.dataset.mediaLoader = JSON.stringify(mediaLoader);
      setDebugValue('mediaLoader', 'MediaLoader', `${mediaLoader.pending} pending / ${mediaLoader.consumers} consumers / ${mediaLoader.lastCompletion?.stage || '—'}`);
      playerDebug.dataset.mediaImages = String(mediaResources.images);
      playerDebug.dataset.styleResources = String(mediaResources.styleReady);
      playerDebug.dataset.styleResourceBytes = String(mediaResources.styleBytes);
      playerDebug.dataset.styleReleased = String(mediaResources.releasedStyleUrls);
      refreshDebugStyles();
      playerDebug.dataset.serviceWorker = snapshot?.serviceWorker?.state || '';
      playerDebug.dataset.workerControlled = String(Boolean(snapshot?.serviceWorker?.controlled));
      playerDebug.dataset.operation = String(snapshot?.operation || '');
      playerDebug.dataset.historyCount = String(snapshot?.playbackHistory?.count || 0);
      const playbackHistory = snapshot?.playbackHistory;
      setDebugValue('playbackHistory', 'PlaybackHistory', playbackHistory
        ? `${playbackHistory.count} starts / cursor=${playbackHistory.cursor} / previous=${playbackHistory.previous?.entryKey || '—'}` : '—');
      playerDebug.dataset.autoCandidates = String(snapshot?.autopilotSelection?.candidates || 0);
      playerDebug.dataset.autoRemaining = String(snapshot?.autopilotSelection?.remaining || 0);
      const manualBags = snapshot?.manualSelection?.bags || null;
      playerDebug.dataset.manualSelection = JSON.stringify(manualBags);
      const manualRemaining = manualBags?.songs.reduce((sum, bag) => sum + bag.remaining, 0) || 0;
      setDebugValue('manualSelection', 'MANSelection', manualBags
        ? `${manualBags.songs.length} bags / ${manualRemaining} songs / ${manualBags.playlist?.remaining ?? 0} lists / ${manualBags.pending?.entryKey || '—'}` : '—');
      playerDebug.dataset.selectionRecent = String(snapshot?.selectionMemory?.recent?.length || 0);
      const selectionMemory = selectionMemoryDiagnostics(snapshot?.selectionMemory);
      playerDebug.dataset.selectionMemory = JSON.stringify(selectionMemory);
      setDebugValue('selectionMemory', 'SelectionMemory', selectionMemory
        ? `${selectionMemory.recent.length} / ttl=${selectionMemory.remainingSeconds ?? '—'}s / ${selectionMemory.resetReason || '—'}` : '—');
      playerDebug.dataset.selectionEpoch = snapshot?.selectionMemory?.epoch || '';
      playerDebug.dataset.selectionSession = snapshot?.selectionMemory?.pageSessionId || '';
      playerDebug.dataset.selectionRemote = String(snapshot?.selectionMemory?.recent?.filter((entry) => entry.source === 'remote').length || 0);
      playerDebug.dataset.selectionReset = snapshot?.selectionMemory?.resetReason || '';
      playerDebug.dataset.invalidReleases = String(snapshot?.invalidReleaseKeys?.length || 0);
      playerDebug.dataset.randomSeed = String(snapshot?.random?.seed ?? '');
      playerDebug.dataset.randomSeedSource = snapshot?.random?.seedSource || '';
      setDebugValue('randomSeed', 'RandomSeed', snapshot?.random
        ? `${snapshot.random.seed} (${snapshot.random.seedSource})` : '—');
      playerDebug.dataset.showProfile = showProfile?.name || '';
      playerDebug.dataset.showRuleSource = showProfile?.ruleSource || '';
      playerDebug.dataset.showSourceRun = JSON.stringify(showProfile?.sourceRun || null);
      const playbackEnvironment = snapshot?.playingSong?.playback?.environment;
      playerDebug.dataset.showName = playbackEnvironment?.showSource?.name || '';
      playerDebug.dataset.showScope = playbackEnvironment?.showSource?.scope || '';
      playerDebug.dataset.showCassGap = String(showProfile?.cassSlidePolicy?.nonCassSlidesSinceCass ?? 0);
      const showSelection = playbackEnvironment?.showSelection;
      const publishedFrame = showSelection?.published;
      const sourcePath = publishedFrame?.source ? new URL(publishedFrame.source).pathname.split('/') : [];
      const imageFolder = sourcePath.lastIndexOf('img');
      const series = imageFolder > 0 && /^show(?:_|$)/.test(sourcePath[imageFolder - 2] || '')
        ? decodeURIComponent(sourcePath[imageFolder - 1]) : '—';
      setDebugValue('showSource', 'ShowSource', snapshot?.playingSong
        ? `Show=${playbackEnvironment?.showSource?.name || '—'} Surface=${publishedFrame?.kind || '—'} Series=${series} Frame=${publishedFrame?.source ? decodeURIComponent(sourcePath.at(-1)) : '—'} Fallback=${publishedFrame?.fallback || '—'}`
        : '—');
      playerDebug.dataset.frameBagTotal = String(showSelection?.frame?.total ?? 0);
      playerDebug.dataset.frameBagRemaining = String(showSelection?.frame?.remaining ?? 0);
      playerDebug.dataset.frameBagReserved = String(Boolean(showSelection?.frame?.reserved));
      playerDebug.dataset.frameBagLast = String(showSelection?.frame?.last || '');
      playerDebug.dataset.showBagRemaining = String(showSelection?.show?.remaining ?? 0);
      playerDebug.dataset.showBagReserved = String(Boolean(showSelection?.show?.reserved));
      playerDebug.dataset.colorMonoRemaining = String(snapshot?.decoration?.colorBags?.mono?.remaining ?? 0);
      playerDebug.dataset.colorDuoRemaining = String(snapshot?.decoration?.colorBags?.duo?.remaining ?? 0);
      playerDebug.dataset.colorChanges = String(snapshot?.stats?.session?.counters?.decorationColorChanges ?? 0);
      playerDebug.dataset.backgroundChanges = String(snapshot?.stats?.session?.counters?.decorationBackgroundChanges ?? 0);
      playerDebug.dataset.decorationSchedule = JSON.stringify({
        pending: snapshot?.decoration?.pendingChange || null,
        completed: snapshot?.decoration?.lastCompletedChange || null,
      });
      const lastDecision = [...(snapshot?.random?.lastDecisions || [])].sort((a, b) => b.id - a.id)[0];
      playerDebug.dataset.decisionCount = String(snapshot?.random?.decisionCount || 0);
      playerDebug.dataset.decisionResult = lastDecision?.result || '';
      setDebugValue('decision', 'Decision', lastDecision
        ? `${lastDecision.id} ${lastDecision.owner}: ${lastDecision.result} ${lastDecision.selected}` : '—');
      const handsBags = showProfile?.handsBags || [];
      playerDebug.dataset.handsRemaining = String(handsBags.reduce((sum, bag) => sum + bag.remaining, 0));
      playerDebug.dataset.handsReserved = String(handsBags.filter((bag) => bag.reserved).length);
      playerDebug.dataset.handsInvalid = String(handsBags.reduce((sum, bag) => sum + bag.invalid, 0));
      playerDebug.dataset.historyCursor = String(snapshot?.playbackHistory?.cursor ?? -1);
      setDebugValue('scenarioVersion', 'Ver', snapshot?.scenario?.version || '—');
      const showSong = snapshot?.openedSong || snapshot?.playingSong;
      const showEnvironment = showSong?.playback?.alive
        && !['ended', 'failed'].includes(showSong.playback.state)
        ? showSong.playback.environment : showSong?.environment;
      const showScope = showEnvironment?.sourceScope || showEnvironment?.showSource?.scope;
      setDebugValue('scenarioSource', 'Src', showScope === 'global' ? 'Glob' : showScope === 'song' ? 'Song' : '—');
      setDebugValue('scenarioName', 'Name', showEnvironment?.showSource?.name || '—');
      const playerConstants = snapshot?.scenario?.playerConstants || {};
      const decorConstants = snapshot?.decoration?.constants || {};
      const pageReload = [...(snapshot?.stats?.recentEvents || [])]
        .reverse()
        .find((event) => event?.type === 'Page.Reload') || null;
      setDebugValue(
        'pageReloadTime',
        'PageReloadTime',
        Math.floor(Number(snapshot?.pageReloadTime) || 0),
      );
      setDebugValue('globalVerseCount', 'GlobVerseCount', Number(snapshot?.globalVerseNumber) || 0);
      setDebugValue('globalSlideCount', 'GlobSlideCount', Number(snapshot?.globalSlideNumber) || 0);
      const cassPolicy = showProfile?.cassSlidePolicy;
      setDebugValue('showProfile', 'ShowProfile', showProfile
        ? `${showProfile.name} (${showProfile.ruleSource}) Launch=${profilePlayback?.launch ?? '—'} RunId=${profilePlayback?.runId ?? '—'} CassGap=${cassPolicy?.nonCassSlidesSinceCass ?? '—'} LastCassReason=${cassPolicy?.lastDecision?.reason || '—'}` : '—');
      setDebugValue('pageReload', 'Page.Reload', formatDebugTime(pageReload?.at));
      ['COLOR_CHANGE_PERIOD', 'BACK_CHANGE_PERIOD'].forEach((name) => {
        const period = Number(decorConstants[name]);
        const elapsed = Number(snapshot?.pageReloadTime);
        const remaining = Number.isFinite(period) && period > 0 && Number.isFinite(elapsed)
          ? Math.ceil(period - (elapsed % period))
          : null;
        const remainingText = remaining === null
          ? '—'
          : `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
        setDebugValue(name, name, `${decorConstants[name] ?? '—'} rem=${remainingText}`);
      });
      ['STATIC_CASS_DELAY'].forEach((name) => {
        setDebugValue(name, name, playerConstants[name]);
      });

    };
    let debugProjectionFrame = 0;
    let pendingDebugSnapshot = null;
    const requestDebugProjection = (snapshot = null) => {
      if (playerControlsScope.signal.aborted) return;
      if (snapshot && (!pendingDebugSnapshot || snapshot.revision >= pendingDebugSnapshot.revision)) pendingDebugSnapshot = snapshot;
      if (debugProjectionFrame) return;
      debugProjectionFrame = vcardRenderScheduler.request(() => {
        debugProjectionFrame = 0;
        const current = pendingDebugSnapshot;
        pendingDebugSnapshot = null;
        refreshPlayerDebug(current || undefined);
      }, { owner: playerDebug, scope: playerControlsScope, priority: 0 });
    };
    new TViewProjection(playerControlsScope, requestDebugProjection);
    document.addEventListener('vcard:debug-state', () => requestDebugProjection(),
      { signal: playerControlsScope.signal });
    const debugClockTimer = window.setInterval(() => {
      if (document.documentElement.dataset.debug === 'on') requestDebugProjection();
    }, 1000);
    playerControlsScope.signal.addEventListener('abort', () => {
      window.clearInterval(debugClockTimer);
      vcardRenderScheduler.cancel(debugProjectionFrame);
      debugProjectionFrame = 0;
      pendingDebugSnapshot = null;
    }, { once: true });
    refreshPlayerDebug();

    const playerDockHeight = () => {
      const player = playerDock.querySelector('.plyr');
      if (
        !player
        || player.hidden
        || getComputedStyle(player).display === 'none'
      ) return 0;
      return playerDock.getBoundingClientRect().height;
    };

    const syncPortalStickyHeight = (height) => {
      portalStickyHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
      const value = `${portalStickyHeight}px`;
      if (document.documentElement.style.getPropertyValue('--song-sticky-audio-height') !== value) {
        document.documentElement.style.setProperty('--song-sticky-audio-height', value);
      }
      return portalStickyHeight;
    };

    let portalHeightFrame = 0;
    let portalHeightDirty = false;
    const requestPortalStickyHeight = () => {
      if (playerControlsScope.signal.aborted) return;
      if (portalHeightFrame) { portalHeightDirty = true; return; }
      portalHeightFrame = vcardRenderScheduler.request(() => {
        const height = playerDockHeight();
        portalHeightFrame = vcardRenderScheduler.request(() => {
          portalHeightFrame = 0;
          syncPortalStickyHeight(height);
          if (portalHeightDirty) {
            portalHeightDirty = false;
            requestPortalStickyHeight();
          }
        }, { owner: playerDock, scope: playerControlsScope, phase: 'write', priority: 0 });
      }, { owner: playerDock, scope: playerControlsScope, phase: 'measure', priority: 0 });
    };
    playerControlsScope.signal.addEventListener('abort', () => {
      vcardRenderScheduler.cancel(portalHeightFrame);
      portalHeightFrame = 0;
      portalHeightDirty = false;
    }, { once: true });

    let projectedPlayerMode = null;
    const projectPlayerModeLayout = (snapshot) => {
      const mode = snapshot.selectionMode;
      if (!['AUTO', 'MAN'].includes(mode) || mode === projectedPlayerMode) return;
      projectedPlayerMode = mode;
      playerDock.classList.toggle('is-autopilot', mode === 'AUTO');
      requestPortalStickyHeight();
    };
    projectPlayerModeLayout({ selectionMode: vcardAutopilotEnabled() ? 'AUTO' : 'MAN' });

    let autoPlayFromEnded = false;
    const currentOpenedPreview = () => window.VCLife?.openedSong?.preview || null;
    const setOpenedPreview = (preview) => {
      const current = currentOpenedPreview();
      if (current === preview) return;
      if (preview) window.VCPlayer?.open(preview);
      else if (current) window.VCPlayer?.close(current);
    };
    let playingPreview = null;
    let activeTrackBandVerse = null;
    let reportedTrackBandVerse = null;
    let initialTrackLayoutPreview = null;
    let firstTrackVerseAlignedPreview = null;
    let trackLayoutSuspendedByUser = false;
    let trackVerseRepositionRequested = false;
    let trackScrollGestureStart = null;
    let portalSizeButtons = [];
    let refreshDynamicPlayerHints = () => {};
    let projectedBackgroundBrightness = null;
    let playerImagesVisible = vcardSettingEnabled(
      'vcard-images-visible',
      'images'
    );
    let playerBackgroundMode = vcardStorage.local.getItem('vcard-background-mode') || ({
      h: 'graph1',
      v: 'graph2',
    })[vcardStorage.local.getItem('vcard-visualization')] || 'smoke';
    if (playerBackgroundMode === 'off' || playerBackgroundMode === 'light') {
      playerBackgroundMode = 'wallpaper';
    }
    if (!vcardVisualizationAvailable() && ['graph1', 'graph2'].includes(playerBackgroundMode)) {
      playerBackgroundMode = 'wallpaper';
    }

    const activatePreviewPortal = (preview, active, randomize = false) => {
      const controlledImage = portalController?.imageFor(preview) || null;
      const image = controlledImage
        || preview?.querySelector('.song__preview-image');
      if (!image) return;
      if (!active) {
        if (randomize) image.dataset.portalRandomStartPending = 'true';
        vcardMedia.setActive(image, false);
        return;
      }
      // Generic image-visibility events must not override the controller's
      // exclusive cassette surface. Only PortalController publishes a photo.
      if (controlledImage && window.VCardPortal?.current().surface !== 'photo') return;
      if (vcardMedia.mediaStates.has(image)) {
        if (randomize) vcardMedia.randomStart(image);
        vcardMedia.setActive(image, true);
        return;
      }
      if (randomize) image.dataset.portalRandomStartPending = 'true';
      vcardMedia.setActive(image, true);
      document.dispatchEvent(new CustomEvent('vcard:activate-portal-image', {
        detail: { image }
      }));
    };

    const preparePreviewPortal = (preview, randomize = false) => {
      const image = preview?.querySelector('.song__preview-image');
      if (!image) return;
      if (
        sharedSongAudio?.vcardPlayingPreview === preview
        && window.VCPlayer?.current?.()?.trackRunId
      ) return;
      if (randomize) image.dataset.portalRandomStartPending = 'true';
      // Opening a song prepares its photo catalog but never makes the photo a
      // visible surface. VCPlayer is the sole authority that may publish the
      // photo after it has resolved the verse style and effects.
      vcardMedia.setActive(image, false);
      if (!vcardMedia.mediaStates.has(image)) {
        document.dispatchEvent(new CustomEvent('vcard:activate-portal-image', {
          detail: { image }
        }));
      }
    };
    const TRACKPLAY_STORAGE_KEY = 'vcard-trackplay';
    let trackPlayEnabled = vcardSettingEnabled(TRACKPLAY_STORAGE_KEY, 'trackplay');
    window.VCardTrackPlay = Object.freeze({ current: () => trackPlayEnabled ? 'on' : 'off' });
    const PLAYLIST_ALTERNATION_STORAGE_KEY = 'vcard-playlist-alternation';
    const SONG_ALTERNATION_STORAGE_KEY = 'vcard-song-alternation';
    const normalizePlaylistAlternation = (value) => (
      ['none', 'previous', 'next', 'repeat', 'random'].includes(String(value || '').toLowerCase())
        ? String(value).toLowerCase()
        : 'random'
    );
    const normalizeSongAlternation = (value) => (
      ['none', 'sequential', 'repeat', 'random'].includes(String(value || '').toLowerCase())
        ? String(value).toLowerCase()
        : 'random'
    );
    let playlistAlternation = normalizePlaylistAlternation(
      vcardStorage.local.getItem(PLAYLIST_ALTERNATION_STORAGE_KEY)
    );
    let songAlternation = normalizeSongAlternation(
      vcardStorage.local.getItem(SONG_ALTERNATION_STORAGE_KEY)
    );
    const randomSongBags = new Map();
    let randomPlaylistBag = null;
    let pendingManualSelection = null;
    const manualBagSnapshot = (bag) => bag ? {
      total: bag.items.length,
      remaining: bag.remaining.length,
      reserved: bag.reservation ? bag.key(bag.reservation.item) : null,
      last: bag.last,
    } : null;
    window.VCardManualSelection = Object.freeze({ current: () => Object.freeze({
      songAlternation, playlistAlternation,
      bags: {
        songs: [...randomSongBags].map(([listId, bag]) => ({ listId, ...manualBagSnapshot(bag) })),
        playlist: manualBagSnapshot(randomPlaylistBag),
        pending: pendingManualSelection ? {
          entryKey: pendingManualSelection.entryKey,
          song: manualBagSnapshot(pendingManualSelection.songBag),
          playlist: manualBagSnapshot(pendingManualSelection.playlistBag),
        } : null,
      },
    }) });
    const publishManualSelection = () => document.dispatchEvent(new CustomEvent('vcard:manual-selection-state'));
    let manualResumeEntry = null;
    let alternationStatusNode = null;
    let songAlternationNode = null;
    let playlistAlternationNode = null;
    const SONG_ALTERNATION_MARKS = Object.freeze({
      none: 'X', sequential: 'N', repeat: 'R', random: 'S',
    });
    const PLAYLIST_ALTERNATION_MARKS = Object.freeze({
      none: 'X', previous: 'B', next: 'N', repeat: 'R', random: 'S',
    });
    const SONG_ALTERNATION_ORDER = Object.freeze(Object.keys(SONG_ALTERNATION_MARKS));
    const PLAYLIST_ALTERNATION_ORDER = Object.freeze(Object.keys(PLAYLIST_ALTERNATION_MARKS));
    const nextAlternation = (order, current) => {
      const index = order.indexOf(current);
      return order[(index + 1 + order.length) % order.length];
    };
    const projectAlternationStatus = (snapshot) => {
      if (!alternationStatusNode) return;
      if (!['AUTO', 'MAN'].includes(snapshot.selectionMode) || !snapshot.manualSelection) return;
      const autopilot = snapshot.selectionMode === 'AUTO';
      const updateLabel = (node, text, title) => {
        if (node.textContent !== text) node.textContent = text;
        if (node.title !== title) node.title = title;
        if (node.getAttribute('aria-label') !== title) node.setAttribute('aria-label', title);
      };
      if (songAlternationNode) songAlternationNode.hidden = autopilot;
      if (playlistAlternationNode) playlistAlternationNode.hidden = autopilot;
      if (autopilot) {
        updateLabel(alternationStatusNode, 'AP', 'Автопилот — переключить в ручной режим');
        if (alternationStatusNode.getAttribute('aria-pressed') !== 'true') alternationStatusNode.setAttribute('aria-pressed', 'true');
        return;
      }
      const songMark = SONG_ALTERNATION_MARKS[snapshot.manualSelection.songAlternation] || 'X';
      const playlistMark = PLAYLIST_ALTERNATION_MARKS[snapshot.manualSelection.playlistAlternation] || 'X';
      if (songAlternationNode) {
        updateLabel(songAlternationNode, songMark, `Смена песен: ${songMark} — следующий режим`);
      }
      if (playlistAlternationNode) {
        updateLabel(playlistAlternationNode, playlistMark, `Смена плейлистов: ${playlistMark} — следующий режим`);
      }
      updateLabel(alternationStatusNode, 'MAN', 'Ручной режим — переключить в автопилот');
      if (alternationStatusNode.getAttribute('aria-pressed') !== 'false') alternationStatusNode.setAttribute('aria-pressed', 'false');
    };
    const clearSelectionBags = () => { randomSongBags.clear(); randomPlaylistBag = null; manualResumeEntry = null; };
    document.addEventListener('vcard:autopilot-state', clearSelectionBags, { signal: playerControlsScope.signal });
    document.addEventListener('vcard:selection-memory-reset', clearSelectionBags, { signal: playerControlsScope.signal });

    const stopSilentPhase = ({ restore = true } = {}) => {
      delete playerDock.dataset.silentPhase;
      if (restore && sharedSongAudio) {
        sharedSongAudio.dispatchEvent(new Event('timeupdate'));
      }
    };

    const cancelAutoAdvance = () => {
      stopSilentPhase();
      autoPlayFromEnded = false;
      window.VCPlayer?.cancelContinuation?.('ui-navigation');
    };

    const currentPortalPreview = () => currentOpenedPreview();

    const projectPortalControls = (snapshot) => {
      const layout = snapshot.portalLayout;
      if (!layout) return;
      const currentSize = layout.size;

      portalSizeButtons.forEach((button) => {
        const size = button.dataset.portalSize;
        const off = size === 'off';
        const active = off
          ? !layout.visible
          : (layout.visible && currentSize === size);
        const disabled = !playerPortalSizeAvailable({ target: button, size, preview: currentPortalPreview() });
        if (button.disabled !== disabled) button.disabled = disabled;
        const ariaDisabled = String(disabled);
        const ariaPressed = String(active);
        if (button.getAttribute('aria-disabled') !== ariaDisabled) button.setAttribute('aria-disabled', ariaDisabled);
        if (button.getAttribute('aria-pressed') !== ariaPressed) button.setAttribute('aria-pressed', ariaPressed);
        button.classList.toggle('is-active', active);
      });
      document.querySelectorAll('[data-portal-toggle="image"]').forEach((button) => {
        const pressed = String(layout.visible);
        const label = layout.visible ? 'Images: ON' : 'Images: OFF';
        if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
        button.classList.toggle('is-active', layout.visible);
        if (button.hasAttribute('title')) button.removeAttribute('title');
        if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
      });
    };

    let portalSizeLayoutFrame = 0;
    playerControlsScope.signal.addEventListener('abort', () => {
      vcardRenderScheduler.cancel(portalSizeLayoutFrame);
      portalSizeLayoutFrame = 0;
    }, { once: true });
    const setPlayerPortalSize = (size) => {
      if (playerControlsScope.signal.aborted || !['off', 'small', 'mid', 'full'].includes(size)) return false;
      const preview = currentPortalPreview();

      const settleLayout = () => {
        vcardRenderScheduler.cancel(portalSizeLayoutFrame);
        portalSizeLayoutFrame = 0;
        if (!preview) return;
        const options = { owner: preview, scope: playerControlsScope, priority: 1,
          isCurrent: () => currentOpenedPreview() === preview && preview.isConnected && !preview.hidden
            && currentPortalPreview() === preview,
          onCancel: () => { portalSizeLayoutFrame = 0; } };
        portalSizeLayoutFrame = vcardRenderScheduler.request(() => {
          portalSizeLayoutFrame = vcardRenderScheduler.request(() => {
            portalSizeLayoutFrame = 0;
            const playingThisPreview = Boolean(
              trackPlayEnabled
              && playingPreview === preview
              && ['AudioPlaying', 'AudioBuffering'].includes(window.VCPlayer?.current?.()?.phase)
            );
            if (playingThisPreview) {
              centerPreviewTrackVerse(preview, 'auto', () => playingPreview === preview
                && ['AudioPlaying', 'AudioBuffering'].includes(window.VCPlayer?.current?.()?.phase));
            } else {
              scrollPreviewPortalToTop(preview, 'auto');
            }
          }, options);
        }, options);
      };

      if (size === 'off') {
        document.dispatchEvent(new CustomEvent('vcard:set-images-visible', {
          detail: { visible: false }
        }));
        settleLayout();
        return true;
      }

      document.dispatchEvent(new CustomEvent('vcard:set-images-visible', {
        detail: { visible: true }
      }));

      if (size === 'full') {
        document.dispatchEvent(new CustomEvent('vcard:set-portal-mode', {
          detail: { preview, mode: 'full' }
        }));
      } else {
        document.dispatchEvent(new CustomEvent('vcard:set-portal-mode', {
          detail: { preview, mode: 'mono' }
        }));
        document.dispatchEvent(new CustomEvent('vcard:set-portal-size', {
          detail: { preview, size }
        }));
      }
      settleLayout();
      return true;
    };

    const playerPortalInputAvailable = ({ target, preview } = {}) => Boolean(
      !playerControlsScope.signal.aborted && target?.isConnected && preview === currentPortalPreview()
    );
    const playerPortalSizeAvailable = (input = {}) => Boolean(
      playerPortalInputAvailable(input) && ['off', 'small', 'mid', 'full'].includes(input.size)
      && (portalSizeButtons.includes(input.target) && input.target.dataset.portalSize === input.size
        || input.target === playerTitle && playerTitle.getAttribute('aria-disabled') !== 'true')
    );
    const playerPortalVisibilityAvailable = (input = {}) => Boolean(
      playerPortalInputAvailable(input) && input.target === playerTitle
      && playerTitle.getAttribute('aria-disabled') !== 'true'
    );
    const playerSettingBindings = new WeakMap();
    const soundControlBindings = new WeakMap();
    const soundInputAvailable = ({ target, kind, value } = {}) => {
      const binding = soundControlBindings.get(target);
      return Boolean(!playerControlsScope.signal.aborted && binding?.kind === kind
        && target?.isConnected && playerDock.contains(target) && !target.disabled
        && target.getAttribute('aria-disabled') !== 'true' && !target.closest('[inert]')
        && target.getClientRects().length
        && (kind === 'mute' && typeof value === 'boolean'
          || kind === 'volume' && Number.isFinite(value) && value >= 0 && value <= 1));
    };
    const setPlayerSound = (input) => {
      if (!soundInputAvailable(input)) return false;
      const { player } = soundControlBindings.get(input.target);
      if (input.kind === 'mute') player.muted = input.value;
      else player.volume = input.value;
      return true;
    };
    const requestPlayerSound = (player, kind, event) => {
      let value = kind === 'mute' ? !player.muted : Number(event.target.value);
      if (kind === 'volume' && event.type === 'wheel') {
        const inverted = event.webkitDirectionInvertedFromDevice;
        const [horizontal, vertical] = [event.deltaX, -event.deltaY].map((delta) => inverted ? -delta : delta);
        const direction = Math.sign(Math.abs(horizontal) > Math.abs(vertical) ? horizontal : vertical);
        value = Math.min(1, Math.max(0, player.volume + direction / 50));
        if (direction === 1 && value < 1 || direction === -1 && value > 0) event.preventDefault();
      }
      const input = { type: 'Player.Sound', source: 'Player', target: event.currentTarget, kind,
        value, trusted: event.isTrusted };
      if (!window.VCCommands) setPlayerSound(input);
      else window.VCCommands.dispatch(input);
      return false; // Plyr must not apply the same input a second time.
    };
    const seekControlBindings = new WeakMap();
    const playerSeekAvailable = ({ target, preview, mediaSource, trackRunId, phase, position } = {}) => {
      const player = seekControlBindings.get(target);
      const snapshot = window.VCPlayer?.current?.();
      return Boolean(!playerControlsScope.signal.aborted && player && target?.isConnected
        && playerDock.contains(target) && !target.disabled && !target.closest('[inert]')
        && target.getAttribute('aria-disabled') !== 'true' && target.getClientRects().length
        && preview === sharedSongAudio.vcardPlayingPreview && preview?.isConnected
        && mediaSource === sharedSongAudio.getAttribute('src') && trackRunId === snapshot?.trackRunId
        && phase === snapshot?.phase && ['ReadyPaused', 'AudioPlaying', 'AudioPaused'].includes(phase)
        && Number.isFinite(player.duration) && player.duration > 0
        && Number.isFinite(position) && position >= 0 && position <= player.duration);
    };
    const seekPlayer = (input) => {
      if (!playerSeekAvailable(input)) return false;
      seekControlBindings.get(input.target).currentTime = input.position;
      return true;
    };
    const dispatchPlayerSeek = (player, target, position, event, source = 'Player') => {
      const snapshot = window.VCPlayer?.current?.();
      const input = { type: 'Player.Seek', source, target,
        preview: sharedSongAudio.vcardPlayingPreview, mediaSource: sharedSongAudio.getAttribute('src'),
        trackRunId: snapshot?.trackRunId, phase: snapshot?.phase,
        position: Math.min(player.duration, Math.max(0, position)),
        trusted: event.isTrusted };
      if (!window.VCCommands) seekPlayer(input);
      else window.VCCommands.dispatch(input);
    };
    const requestPlayerSeek = (player, event) => {
      const target = event.currentTarget;
      const percent = target.getAttribute('seek-value');
      const value = percent === null || percent.trim() === '' ? Number(target.value) : Number(percent);
      target.removeAttribute('seek-value');
      dispatchPlayerSeek(player, target, value / Number(target.max) * player.duration, event);
      return false;
    };
    let playbackControl = null;
    let applyPlayerPlayback = null;
    const playerPlaybackPreview = () => currentPortalPreview() || playingPreview;
    const playerPlaybackAvailable = ({ target, preview, phase } = {}) => Boolean(
      !playerControlsScope.signal.aborted && applyPlayerPlayback && target === playbackControl
      && target?.isConnected && playerDock.contains(target) && !target.disabled
      && !target.closest('[inert]') && target.getClientRects().length
      && preview === playerPlaybackPreview() && phase === window.VCPlayer?.current?.()?.phase
      && (['AudioPlaying', 'AudioBuffering', 'OutroRunning', 'NextPending', 'FinishedStopped'].includes(phase)
        || window.VCardCatalogView?.forPreview(preview)?.playable)
    );
    const togglePlayerPlayback = (input) => {
      if (!playerPlaybackAvailable(input)) return false;
      applyPlayerPlayback();
      return true;
    };
    const trackControlDirections = new WeakMap();
    const currentTrackButton = () => previewButton(playingPreview) || previewButton(currentOpenedPreview())
      || null;
    const trackNavigationAvailable = ({ source, target, current, direction, trackRunId, selectionMode } = {}) => {
      const snapshot = window.VCPlayer?.current?.();
      if (playerControlsScope.signal.aborted || window.VCardBootstrap.state !== 'Interactive'
        || !snapshot || trackRunId !== snapshot.trackRunId || selectionMode !== snapshot.selectionMode
        || ![-1, 1].includes(direction)
        || !current?.isConnected || current !== currentTrackButton() || !entriesByButton.has(current)) return false;
      if (source === 'MediaSession') return true;
      return Boolean(source === 'Player' && trackControlDirections.get(target) === direction
        && target?.isConnected && playerDock.contains(target) && !target.disabled
        && !target.closest('[inert]') && target.getClientRects().length);
    };
    const navigateTrack = (input) => {
      if (!trackNavigationAvailable(input)) return false;
      return openRelativeSong(input.direction, { play: true });
    };
    const requestTrackNavigation = (direction, source, event) => {
      const snapshot = window.VCPlayer?.current?.();
      const input = { type: 'Track.Navigate', source, direction, current: currentTrackButton(),
        trackRunId: snapshot?.trackRunId, selectionMode: snapshot?.selectionMode,
        target: event?.currentTarget, trusted: event?.isTrusted === true };
      return window.VCCommands ? window.VCCommands.dispatch(input) : navigateTrack(input);
    };
    const playerSettingAvailable = ({ target, key, value } = {}) => {
      const binding = playerSettingBindings.get(target);
      return Boolean(!playerControlsScope.signal.aborted && target?.isConnected
        && playerDock.contains(target) && !target.closest('[inert]')
        && !target.disabled && target.getAttribute('aria-disabled') !== 'true'
        && target.getClientRects().length && binding && binding.key === key && binding.value === value
        && !(vcardFileMode && key === 'volumeBoost' && value !== '1')
        && !(!vcardVisualizationAvailable() && key === 'background' && ['graph1', 'graph2'].includes(value)));
    };
    const setPlayerSetting = (input) => {
      if (!playerSettingAvailable(input)) return false;
      playerSettingBindings.get(input.target).apply();
      return true;
    };
    const bindPlayerSetting = (target, key, value, apply, eventType = 'click') => {
      playerSettingBindings.set(target, Object.freeze({ key, value, apply }));
      target.addEventListener(eventType, (event) => {
        if (eventType === 'contextmenu') event.preventDefault();
        const input = { type: 'Player.Set', source: 'Player', target, key, value, trusted: event.isTrusted };
        if (!window.VCCommands) setPlayerSetting(input);
        else window.VCCommands.dispatch(input);
      }, { signal: playerControlsScope.signal });
    };
    window.VCardPlayerControls = Object.freeze({
      canSetSound: soundInputAvailable,
      setSound: setPlayerSound,
      canSeek: playerSeekAvailable,
      seek: seekPlayer,
      canTogglePlayback: playerPlaybackAvailable,
      togglePlayback: togglePlayerPlayback,
      canNavigate: trackNavigationAvailable,
      navigate: navigateTrack,
      requestNavigation: (direction, source) => requestTrackNavigation(direction, source),
      canSet: playerSettingAvailable,
      set: setPlayerSetting,
      canSetSize: playerPortalSizeAvailable,
      setSize: (input) => playerPortalSizeAvailable(input) ? setPlayerPortalSize(input.size) : false,
      canToggleVisibility: playerPortalVisibilityAvailable,
      toggleVisibility: (input) => {
        if (!playerPortalVisibilityAvailable(input)) return false;
        document.dispatchEvent(new CustomEvent('vcard:set-images-visible', {
          detail: { visible: !playerImagesVisible }
        }));
        return true;
      },
    });
    const requestPlayerPortalSize = (size, event, target = event.currentTarget) => {
      const input = { type: 'Portal.SetSize', source: 'Player', target, size,
        preview: currentPortalPreview(), trusted: event.isTrusted };
      if (!window.VCCommands) return window.VCardPlayerControls.setSize(input);
      return window.VCCommands.dispatch(input);
    };

    document.addEventListener('vcard:portal-state', (event) => {
      const detail = event.detail || {};
      playerImagesVisible = detail.visible !== false;
      if (detail.preview) {
        activatePreviewPortal(
          detail.preview,
          playerImagesVisible && !detail.preview.hidden
        );
      }
    });

    const portalOrientationMedia = vcardEnvironment.media('(orientation: portrait)');
    let portalPortrait = portalOrientationMedia.matches;
    document.addEventListener('vcard:environment-state', () => {
      if (portalPortrait === portalOrientationMedia.matches) return;
      portalPortrait = portalOrientationMedia.matches;
      if (portalOrientationMedia.matches && playerImagesVisible) {
        const preview = currentPortalPreview();
        const frame = preview && preview.querySelector('.song-vibeframe');
        const image = frame && frame.querySelector('.song__preview-image');
        if (
          image
          && window.VCardPortalLayout.current(preview).size === 'mid'
          && !Boolean(window.VCardPortalLayout?.isFullscreen(image))
        ) {
          setPlayerPortalSize('small');
          return;
        }
      }
    }, { signal: playerControlsScope.signal });

    const decodeHtmlLine = (() => {
      const textarea = document.createElement('textarea');
      return (html) => {
        textarea.innerHTML = String(html || '').replace(/<[^>]*>/g, '');
        return textarea.value;
      };
    })();

    const parseTrackBand = (value) => String(value || '')
      .match(/-?\d+:\d{2}/g)
      ?.map((time) => {
        const clean = time.replace(/^-/, '');
        const [minutes, seconds] = clean.split(':').map(Number);
        return Number.isFinite(minutes) && Number.isFinite(seconds)
          ? minutes * 60 + seconds
          : NaN;
      })
      .filter((seconds) => Number.isFinite(seconds))
      .sort((left, right) => left - right) || [];

    const lineFragment = (html) => {
      const template = document.createElement('template');
      template.innerHTML = html;
      return template.content;
    };

    const prepareTrackBandText = (text) => {
      if (!text || text.dataset.trackBandPrepared === 'true') return;
      text.dataset.trackBandPrepared = 'true';
      // Layout diagnostics are siblings of the song content, not verses.
      const debugMarkers = [...text.querySelectorAll(
        ':scope > .vc-debug-section-line, :scope > .vc-debug-block-marker'
      )];
      debugMarkers.forEach((marker) => marker.remove());
      const lines = text.innerHTML.split(/<br\s*\/?>/i);
      const fragment = document.createDocumentFragment();
      let verse = null;
      let verseIndex = 0;

      lines.forEach((line, index) => {
        const plain = decodeHtmlLine(line).trim();
        const isMarker = /^\*\s*\*\s*\*$/.test(plain);
        const isYear = /^\d{4}(?:\s*[-–—]\s*(?:\d{4}|\d{2}))?$/.test(plain);
        const isBlank = plain === '';
        const isBoundary = isMarker || isYear || isBlank;
        if (index > 0) {
          (verse && !isBoundary ? verse : fragment).append(document.createElement('br'));
        }
        if (isBoundary) {
          verse = null;
          fragment.append(lineFragment(line));
          return;
        }
        if (!verse) {
          verse = document.createElement('span');
          verse.className = 'song__track-verse';
          verse.dataset.trackVerse = String(verseIndex);
          if (Number.isFinite(parseTrackBand(text.dataset.trackBand)[verseIndex])) {
            verse.setAttribute('role', 'button');
            verse.tabIndex = 0;
            verse.setAttribute('aria-description', 'Начать воспроизведение с этого куплета: Enter или пробел.');
          }
          verse.dataset.trackGlow = plain;
          verseIndex += 1;
          fragment.append(verse);
        } else {
          verse.dataset.trackGlow += `\n${plain}`;
        }
        verse.append(lineFragment(line));
      });

      text.textContent = '';
      text.append(fragment, ...debugMarkers);
    };

    const clearTrackBandHighlight = () => {
      if (!activeTrackBandVerse) return;
      activeTrackBandVerse.classList.remove('is-active', 'is-pulsing');
      activeTrackBandVerse = null;
      reportedTrackBandVerse = null;
    };

    const trackLayoutCanFollow = () => Boolean(
      trackPlayEnabled
      && playingPreview
      && (playingPreview === currentOpenedPreview())
      && sharedSongAudio
      && ['AudioPlaying', 'AudioBuffering'].includes(window.VCPlayer?.current?.()?.phase)
    );

    const suspendTrackLayoutForUser = () => {
      if (!trackLayoutCanFollow() || trackLayoutSuspendedByUser) return;
      trackLayoutSuspendedByUser = true;
      // Cancel an in-flight smooth centering animation at the point where the
      // reader takes control. The next natural verse boundary resumes follow.
      window.scrollTo({ top: window.scrollY, behavior: 'auto' });
    };

    window.addEventListener('touchstart', (event) => {
      if (!trackLayoutCanFollow() || event.touches.length !== 1) {
        trackScrollGestureStart = null;
        return;
      }
      const touch = event.touches[0];
      trackScrollGestureStart = { x: touch.clientX, y: touch.clientY };
    }, { passive: true, capture: true, signal: playerControlsScope.signal });
    window.addEventListener('touchmove', (event) => {
      if (!trackScrollGestureStart || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const deltaX = Math.abs(touch.clientX - trackScrollGestureStart.x);
      const deltaY = Math.abs(touch.clientY - trackScrollGestureStart.y);
      if (deltaY < 6 || deltaY <= deltaX) return;
      trackScrollGestureStart = null;
      suspendTrackLayoutForUser();
    }, { passive: true, capture: true, signal: playerControlsScope.signal });
    const clearTrackScrollGesture = () => { trackScrollGestureStart = null; };
    playerControlsScope.signal.addEventListener('abort', clearTrackScrollGesture, { once: true });
    window.addEventListener('touchend', clearTrackScrollGesture, { passive: true, capture: true, signal: playerControlsScope.signal });
    window.addEventListener('touchcancel', clearTrackScrollGesture, { passive: true, capture: true, signal: playerControlsScope.signal });
    window.addEventListener('wheel', (event) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) suspendTrackLayoutForUser();
    }, { passive: true, capture: true, signal: playerControlsScope.signal });

    const updateTrackCenterPadding = (preview) => {
      const text = preview && preview.querySelector('.song__preview-text[data-track-band]');
      if (!text) return;
      prepareTrackBandText(text);
      // Verse centering is handled by scrolling the whole document.  A top
      // padding derived from viewport coordinates grows after every scroll:
      // the first verse moves above the viewport, the next recalculation sees
      // that negative position and pushes the complete text block farther
      // down.  Keep the portal and all verses in their natural document flow.
      text.style.paddingTop = '0px';
    };

    const portalPinScrollTop = (preview) => {
      const portal = preview && preview.querySelector('.song-portal-stage, .song-vibeframe');
      if (!portal || portal.hidden || getComputedStyle(portal).display === 'none') return 0;
      const portalStyle = getComputedStyle(portal);
      const stickyTop = Number.parseFloat(portalStyle.top) || 0;
      const stickyThresholdStep = Math.max(
        1,
        Number.parseFloat(portalStyle.borderTopWidth) || 0
      );
      const origin = portalOrigins.get(portal);
      if (!origin?.isConnected) return 0;
      const portalDocumentTop = window.scrollY + origin.getBoundingClientRect().top;
      // Use the portal's real sticky inset rather than the raw player height.
      // Cross the sticky threshold by at least one CSS pixel: landing exactly
      // on a fractional layout boundary can leave the portal in normal flow
      // until the user's next scroll. Sticky positioning still clamps the
      // visible portal to stickyTop, so this step creates no visual offset.
      return Math.max(0, portalDocumentTop - stickyTop + stickyThresholdStep);
    };

    const trackVerseViewportBounds = (preview) => {
      const viewportBottom = window.innerHeight;
      let top = Math.max(0, Math.min(viewportBottom, portalStickyHeight));
      const portal = preview && preview.querySelector(
        '.song-portal-stage, .song-vibeframe'
      );
      const portalImage = portal && portal.querySelector('.song__preview-image');

      if (portalImage && window.VCardPortalLayout?.isFullscreen(portalImage)) return null;
      if (
        portal
        && !portal.hidden
        && getComputedStyle(portal).display !== 'none'
      ) {
        const portalRect = portal.getBoundingClientRect();
        if (
          portalRect.height > 0
          && portalRect.bottom > 0
          && portalRect.top < viewportBottom
        ) {
          top = Math.max(
            top,
            Math.min(viewportBottom, portalStickyHeight + portalRect.height)
          );
        }
      }

      const height = viewportBottom - top;
      return height > 1
        ? { top, bottom: viewportBottom, height }
        : null;
    };

    let trackVerseScrollFrame = 0;
    playerControlsScope.signal.addEventListener('abort', () => {
      vcardRenderScheduler.cancel(trackVerseScrollFrame);
      trackVerseScrollFrame = 0;
    }, { once: true });
    const centerTrackBandVerse = (verse, behavior = 'smooth', guard = () => true) => {
      vcardRenderScheduler.cancel(trackVerseScrollFrame);
      trackVerseScrollFrame = 0;
      if (!verse || trackLayoutSuspendedByUser || playerControlsScope.signal.aborted) return;
      const preview = verse.closest('.song__preview');
      trackVerseScrollFrame = vcardRenderScheduler.request(() => {
        trackVerseScrollFrame = 0;
        const rect = verse.getBoundingClientRect();
        if (!rect.height) return;
        // Read the live layout here, immediately before calculating scroll.
        // Portal visibility and dimensions may change while the song is playing.
        const bounds = trackVerseViewportBounds(preview);
        if (!bounds) return;
        const targetCenter = bounds.top + bounds.height / 2;
        const centeredTarget = window.scrollY + rect.top + rect.height / 2 - targetCenter;
        const target = Math.max(centeredTarget, portalPinScrollTop(preview));
        const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        const clampedTarget = Math.max(0, Math.min(maxScroll, target));
        // Timed verse following is forward-only.  If vertical centering would
        // reduce scrollY and move the page back down, leave the current reading
        // position intact; a later verse may advance the document again.
        if (!trackVerseRepositionRequested && clampedTarget < window.scrollY - 1) return;
        writeViewportScroll(clampedTarget, behavior, preview, () => guard() && !trackLayoutSuspendedByUser
          && trackPlayEnabled && verse === (preview.querySelector('.song__track-verse.is-active')
            || preview.querySelector('.song__track-verse')),
          () => { trackVerseRepositionRequested = false; });
      }, { owner: verse, scope: playerControlsScope, priority: 1, phase: 'measure',
        isCurrent: () => guard() && !trackLayoutSuspendedByUser && trackPlayEnabled
          && currentOpenedPreview() === preview && preview?.isConnected && !preview.hidden && verse.isConnected
          && verse === (preview.querySelector('.song__track-verse.is-active')
            || preview.querySelector('.song__track-verse')),
        onCancel: () => { trackVerseScrollFrame = 0; } });
    };

    const centerPreviewTrackVerse = (preview, behavior = 'auto', guard = () => true) => {
      if (!preview) return;
      const text = preview.querySelector('.song__preview-text[data-track-band]');
      if (!text) return;
      updateTrackCenterPadding(preview);
      centerTrackBandVerse(
        text.querySelector('.song__track-verse.is-active')
          || text.querySelector('.song__track-verse'),
        behavior,
        guard
      );
    };

    const alignTrackVerseBelowAudioPortal = (preview, behavior = 'auto') => {
      vcardRenderScheduler.cancel(trackVerseScrollFrame);
      trackVerseScrollFrame = 0;
      if (!preview || playerControlsScope.signal.aborted) return;
      const text = preview.querySelector('.song__preview-text[data-track-band]');
      if (!text) return;
      prepareTrackBandText(text);
      const verse = text.querySelector('.song__track-verse.is-active')
        || text.querySelector('.song__track-verse');
      if (!verse) return;

      const current = () => currentOpenedPreview() === preview && preview.isConnected && !preview.hidden
        && verse.isConnected && trackPlayEnabled && !trackLayoutSuspendedByUser
        && playingPreview === preview && window.VCPlayer?.current?.()?.phase === 'AudioPlaying'
        && verse === (text.querySelector('.song__track-verse.is-active')
          || text.querySelector('.song__track-verse'));
      trackVerseScrollFrame = vcardRenderScheduler.request(() => {
        trackVerseScrollFrame = 0;
        const portal = preview.querySelector('.song-portal-stage, .song-vibeframe');
        const portalRect = portal && portal.getBoundingClientRect();
        const portalHeight = (
          portalRect
          && portalRect.height > 0
          && getComputedStyle(portal).display !== 'none'
        ) ? portalRect.height : 0;
        const verseRect = verse.getBoundingClientRect();
        const verseStyle = getComputedStyle(verse);
        const gap = Number.parseFloat(verseStyle.lineHeight)
          || Number.parseFloat(verseStyle.fontSize)
          || 0;
        const target = window.scrollY + verseRect.top
          - portalStickyHeight - portalHeight - gap;
        const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        writeViewportScroll(Math.max(0, Math.min(maxScroll, target)), behavior, preview, current,
          () => { firstTrackVerseAlignedPreview = preview; });
      }, { owner: verse, scope: playerControlsScope, priority: 1, phase: 'measure',
        isCurrent: current, onCancel: () => { trackVerseScrollFrame = 0; } });
    };

    let trackVerseLayoutFrame = 0;
    const scheduleTrackVerseLayout = (preferredPreview = null, behavior = 'auto') => {
      if (playerControlsScope.signal.aborted) return;
      if (trackVerseLayoutFrame) vcardRenderScheduler.cancel(trackVerseLayoutFrame);
      trackVerseLayoutFrame = vcardRenderScheduler.request(() => {
        trackVerseLayoutFrame = vcardRenderScheduler.request(() => {
          trackVerseLayoutFrame = 0;
          const preview = (
            preferredPreview && (preferredPreview === currentOpenedPreview())
              ? preferredPreview
              : playingPreview
          );
          if (
            !preview
            || preview !== currentOpenedPreview()
            || trackLayoutSuspendedByUser
            || !trackPlayEnabled
            || window.VCPlayer?.current?.()?.phase !== 'AudioPlaying'
          ) return;
          // The first timed verse starts one full line below the pinned portal.
          // Later verses retain the normal forward-only centering.
          const verses = Array.from(preview.querySelectorAll('.song__track-verse'));
          if (!trackVerseRepositionRequested && initialTrackLayoutPreview === preview && verses.indexOf(activeTrackBandVerse) === 0) {
            if (firstTrackVerseAlignedPreview === preview) return;
            alignTrackVerseBelowAudioPortal(preview, behavior);
            return;
          }
          centerPreviewTrackVerse(preview, behavior,
            () => playingPreview === preview && window.VCPlayer?.current?.()?.phase === 'AudioPlaying');
        }, { owner: playerDock, scope: playerControlsScope, priority: 1 });
      }, { owner: playerDock, scope: playerControlsScope, priority: 1 });
    };

    const scheduleTrackVerseFromPortalEvent = (event) => {
      scheduleTrackVerseLayout(event.detail && event.detail.preview);
    };

    document.addEventListener('vcard:portal-size', scheduleTrackVerseFromPortalEvent, { signal: playerControlsScope.signal });
    document.addEventListener('vcard:portal-state', scheduleTrackVerseFromPortalEvent, { signal: playerControlsScope.signal });
    document.addEventListener('vcard:portal-mode', scheduleTrackVerseFromPortalEvent, { signal: playerControlsScope.signal });
    document.addEventListener('vcard:portal-items-change', scheduleTrackVerseFromPortalEvent, { signal: playerControlsScope.signal });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleTrackVerseLayout();
    }, { signal: playerControlsScope.signal });
    document.addEventListener('load', (event) => {
      if (
        event.target instanceof HTMLImageElement
        && (event.target.closest('.song__preview') === currentOpenedPreview())
      ) scheduleTrackVerseLayout();
    }, { capture: true, signal: playerControlsScope.signal });
    window.addEventListener('focus', () => scheduleTrackVerseLayout(), { signal: playerControlsScope.signal });
    window.addEventListener('pageshow', () => scheduleTrackVerseLayout(), { signal: playerControlsScope.signal });
    window.addEventListener('resize', () => scheduleTrackVerseLayout(), { passive: true, signal: playerControlsScope.signal });

    let fontScaleRefreshFrame = 0;
    document.addEventListener('vcard:font-scale-state', () => {
      if (fontScaleRefreshFrame) vcardRenderScheduler.cancel(fontScaleRefreshFrame);
      // Let the new root font size settle before measuring the sticky player,
      // portal and current verse.  Two frames also cover Plyr's control wrap.
      fontScaleRefreshFrame = vcardRenderScheduler.request(() => {
        fontScaleRefreshFrame = vcardRenderScheduler.request(() => {
          fontScaleRefreshFrame = 0;
          const player = sharedSongAudio && players.get(sharedSongAudio);
          if (player && typeof player.update === 'function') player.update();
          const preview = (
            currentOpenedPreview() || playingPreview
          );
          scheduleTrackVerseLayout(preview, 'auto');
        }, { owner: playerDock, scope: playerControlsScope, priority: 0 });
      }, { owner: playerDock, scope: playerControlsScope, priority: 0 });
    }, { signal: playerControlsScope.signal });
    playerControlsScope.signal.addEventListener('abort', () => {
      vcardRenderScheduler.cancel(trackVerseLayoutFrame);
      vcardRenderScheduler.cancel(fontScaleRefreshFrame);
      trackVerseLayoutFrame = 0;
      fontScaleRefreshFrame = 0;
    }, { once: true });

    if ('ResizeObserver' in window) {
      const trackLayoutObserver = new ResizeObserver((entries) => {
        if (entries.some((entry) => entry.target === playerDock)) {
          requestPortalStickyHeight();
        }
        scheduleTrackVerseLayout();
      });
      trackLayoutObserver.observe(playerDock);
      playerControlsScope.signal.addEventListener('abort', () => trackLayoutObserver.disconnect(), { once: true });
      previews.forEach((preview) => {
        const portal = preview.querySelector('.song-portal-stage, .song-vibeframe');
        if (portal) trackLayoutObserver.observe(portal);
      });
    }

    const updateTrackBandHighlight = ({
      scroll = true,
      allowPaused = false,
      force = false,
      seeked = false,
      projectOnly = false,
      phase = window.VCPlayer?.current?.()?.phase,
    } = {}) => {
      if (playerControlsScope.signal.aborted) return;
      const audio = sharedSongAudio;
      const previewIsOpen = Boolean(
        playingPreview && (playingPreview === currentOpenedPreview())
      );
      if (
        !audio
        || !playingPreview
        || !trackPlayEnabled
        || !['AudioPlaying', 'AudioBuffering', ...(allowPaused ? ['AudioPaused'] : [])].includes(phase)
      ) {
        clearTrackBandHighlight();
        return;
      }
      const text = playingPreview.querySelector('.song__preview-text[data-track-band]');
      if (!text) {
        clearTrackBandHighlight();
        return;
      }
      const thresholds = parseTrackBand(text.dataset.trackBand);
      if (!thresholds.length) {
        clearTrackBandHighlight();
        return;
      }
      prepareTrackBandText(text);
      const verses = Array.from(text.querySelectorAll('.song__track-verse'));
      if (!verses.length) {
        clearTrackBandHighlight();
        return;
      }
      if (seeked && !projectOnly) {
        trackVerseRepositionRequested = Number(audio.currentTime) > 0.05;
        trackLayoutSuspendedByUser = false;
      }
      const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      const nextIndex = thresholds.filter((threshold) => current >= threshold).length - 1;
      if (nextIndex < 0) {
        clearTrackBandHighlight();
        return;
      }
      const verseEndsAt = thresholds[nextIndex + 1];
      const portalEndsAt = Number.isFinite(verseEndsAt)
        ? verseEndsAt
        : Number(audio.duration);
      const nextVerse = verses[Math.min(nextIndex, verses.length - 1)] || null;
      const shouldPulse = phase === 'AudioPlaying';
      const startsPulsing = shouldPulse && nextVerse && !nextVerse.classList.contains('is-pulsing');
      if (nextVerse) nextVerse.classList.toggle('is-pulsing', shouldPulse);
      if (!projectOnly && scroll && previewIsOpen && startsPulsing && nextIndex === 0) {
        scheduleTrackVerseLayout(playingPreview, 'smooth');
      }
      const previousVerse = activeTrackBandVerse;
      const verseChanged = previousVerse !== nextVerse;
      if (verseChanged) clearTrackBandHighlight();
      const notifyRuntime = !projectOnly && nextVerse && (reportedTrackBandVerse !== nextVerse || force);
      if (nextVerse && (verseChanged || force || notifyRuntime)) {
        nextVerse.classList.add('is-active');
        activeTrackBandVerse = nextVerse;
        if (!notifyRuntime) return;
        if (reportedTrackBandVerse !== nextVerse) {
          if (trackLayoutSuspendedByUser) trackVerseRepositionRequested = true;
          trackLayoutSuspendedByUser = false;
        }
        // A projection may show a verse before its audio event. Mark delivery
        // before dispatch, so the resulting snapshot cannot report it again.
        reportedTrackBandVerse = nextVerse;
        const verseDetail = {
          preview: playingPreview,
          index: nextIndex,
          verse: nextVerse,
          seeked,
          startsAt: thresholds[nextIndex],
          endsAt: portalEndsAt,
          isLastVerse: nextIndex >= thresholds.length - 1,
        };
        window.VCPlayer?.verse?.(verseDetail);
        if (scroll && previewIsOpen) scheduleTrackVerseLayout(playingPreview, 'smooth');
      }
      if (!verseChanged && !force) return;
    };

    let projectedTrackPhase = null;
    new TViewProjection(playerControlsScope, (snapshot) => {
      if (projectedTrackPhase === snapshot.phase) return;
      projectedTrackPhase = snapshot.phase;
      updateTrackBandHighlight({ scroll: false, allowPaused: true, projectOnly: true, phase: snapshot.phase });
      if (snapshot.phase === 'AudioPlaying') scheduleTrackVerseLayout(playingPreview, 'smooth');
    });

    const alignInitialTrackLayout = (preview) => {
      if (!preview || preview !== currentOpenedPreview()) return;
      const text = preview.querySelector('.song__preview-text[data-track-band]');
      if (!text || !parseTrackBand(text.dataset.trackBand).length) return;
      prepareTrackBandText(text);
      updateTrackCenterPadding(preview);
      // Prepare tracking without moving the page away from the opened title.
    };

    const publishTrackPlayState = () => {
      document.dispatchEvent(new CustomEvent('vcard:trackplay-state', {
        detail: { enabled: trackPlayEnabled }
      }));
    };

    document.addEventListener('vcard:set-trackplay', (event) => {
      trackPlayEnabled = Boolean(event.detail && event.detail.enabled);
      vcardStorage.local.setItem(TRACKPLAY_STORAGE_KEY, trackPlayEnabled ? 'on' : 'off');
      if (!trackPlayEnabled) {
        clearTrackBandHighlight();
      } else {
        updateTrackBandHighlight();
      }
      publishTrackPlayState();
    }, { signal: playerControlsScope.signal });

    document.addEventListener('vcard:request-trackplay-state', publishTrackPlayState, { signal: playerControlsScope.signal });
    document.addEventListener('vcard:song-close', () => clearTrackBandHighlight(), { signal: playerControlsScope.signal });
    let trackOpenFrame = 0;
    playerControlsScope.signal.addEventListener('abort', () => {
      vcardRenderScheduler.cancel(trackOpenFrame);
      trackOpenFrame = 0;
    }, { once: true });
    document.addEventListener('vcard:song-open', (event) => {
      const preview = event.target;
      vcardRenderScheduler.cancel(trackOpenFrame);
      trackOpenFrame = vcardRenderScheduler.request(() => {
        trackOpenFrame = 0;
        updateTrackBandHighlight();
      }, { owner: preview, scope: playerControlsScope, priority: 1,
        isCurrent: () => currentOpenedPreview() === preview && preview.isConnected && !preview.hidden,
        onCancel: () => { trackOpenFrame = 0; } });
    }, { signal: playerControlsScope.signal });

    const projectAudioAvailability = (snapshot) => {
      const audio = sharedSongAudio;
      if (!audio) return;
      const available = window.VCardBootstrap.state === 'Interactive'
        && isPlayableSource(snapshot.audio?.source) && !snapshot.audio?.error;
      audio.hidden = false;
      playerTitle.hidden = false;
      playerDock.classList.add('has-player');
      playerDock.classList.toggle('is-audio-unavailable', !available);
      const container = audio.closest('.plyr');
      if (container) {
        container.hidden = false;
        container.querySelectorAll(
          '[data-plyr="play"], [data-plyr="seek"], [data-plyr="mute"], [data-plyr="volume"]'
        ).forEach((control) => {
          if (control.disabled !== !available) control.disabled = !available;
          const value = available ? 'false' : 'true';
          if (control.getAttribute('aria-disabled') !== value) control.setAttribute('aria-disabled', value);
        });
      }
    };

    let playerTitleScope = null;
    playerControlsScope.signal.addEventListener('abort', () => playerTitleScope?.abort(), { once: true });
    const renderPlayerTitle = (title, marquee = false, marking = '') => {
      playerTitleScope?.abort();
      playerTitleScope = null;
      if (playerControlsScope.signal.aborted) return;
      const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim();
      playerTitle.replaceChildren();
      playerTitle.classList.remove('is-startup');
      playerTitle.classList.toggle('is-marquee', Boolean(cleanTitle && marquee));
      playerTitle.classList.toggle('is-preparing-marquee', Boolean(cleanTitle && marquee));
      playerTitle.classList.toggle(
        'is-paused',
        Boolean(sharedSongAudio && sharedSongAudio.paused)
      );
      if (cleanTitle) {
        const track = document.createElement('span');
        track.className = 'vcard-player-title-track';
        const text = document.createElement('span');
        text.className = 'vcard-player-title-text';
        text.textContent = cleanTitle;
        const markIndex = marking ? cleanTitle.indexOf(marking) : -1;
        if (markIndex >= 0) {
          text.replaceChildren(document.createTextNode(cleanTitle.slice(0, markIndex)));
          const mark = document.createElement('span');
          mark.dataset.songMark = marking;
          for (const part of marking.split(/([*★☆]+)/u)) {
            if (/^[*★☆]+$/u.test(part)) {
              const stars = document.createElement('span');
              stars.className = 'song__mark-stars';
              stars.textContent = part;
              mark.append(stars);
            } else {
              mark.append(document.createTextNode(part));
            }
          }
          text.append(mark);
          text.append(document.createTextNode(cleanTitle.slice(markIndex + marking.length)));
        }
        if (marquee) {
          const cycle = document.createElement('span');
          cycle.className = 'vcard-player-title-cycle';
          cycle.append(text);
          const nextCycle = cycle.cloneNode(true);
          nextCycle.setAttribute('aria-hidden', 'true');
          track.append(cycle, nextCycle);
        } else {
          track.append(text);
        }
        playerTitle.append(track);
        if (marquee) {
          const scope = new AbortController();
          playerTitleScope = scope;
          let frame = 0;
          let layoutDirty = false;
          let startAnimation = true;
          scope.signal.addEventListener('abort', () => {
            vcardRenderScheduler.cancel(frame);
            frame = 0;
          }, { once: true });
          const speed = 25;
          const [cycle, nextCycle] = track.children;
          const current = () => playerTitleScope === scope && track.isConnected;
          const requestPhase = (callback, phase) => {
            frame = vcardRenderScheduler.request(callback, {
              owner: track, scope, priority: 1, phase, isCurrent: current,
              onCancel: () => { frame = 0; },
            });
          };
          const requestMarqueeLayout = () => {
            if (scope.signal.aborted) return;
            if (frame) { layoutDirty = true; return; }
            requestPhase(() => {
              const phraseWidth = text.getBoundingClientRect().width;
              const viewportWidth = playerTitle.clientWidth;
              if (!phraseWidth || !viewportWidth) {
                frame = 0;
                layoutDirty = false;
                return;
              }
              // Each identical half must cover the viewport while sliding out.
              const repeats = Math.max(1, Math.ceil((viewportWidth + 1) / phraseWidth));
              const measureDuration = () => {
                requestPhase(() => {
                  const distance = cycle.getBoundingClientRect().width;
                  requestPhase(() => {
                    track.style.setProperty('--vc-player-marquee-duration',
                      `${Math.max(1, distance / speed)}s`);
                    if (startAnimation) {
                      startAnimation = false;
                      track.style.removeProperty('animation');
                      playerTitle.classList.remove('is-preparing-marquee');
                    }
                    frame = 0;
                    if (layoutDirty) {
                      layoutDirty = false;
                      requestMarqueeLayout();
                    }
                  }, 'write');
                }, 'measure');
              };
              if (cycle.children.length === repeats && !startAnimation) {
                measureDuration();
                return;
              }
              requestPhase(() => {
                if (cycle.children.length !== repeats) {
                  cycle.replaceChildren(text);
                  for (let index = 1; index < repeats; index += 1) {
                    const copy = text.cloneNode(true);
                    copy.setAttribute('aria-hidden', 'true');
                    cycle.append(copy);
                  }
                  nextCycle.replaceChildren(...Array.from(cycle.children, (item) => item.cloneNode(true)));
                }
                // Restart across frames, without forcing a synchronous layout.
                // Later resizing preserves the animation's current position.
                if (startAnimation) track.style.animation = 'none';
                measureDuration();
              }, 'write');
            }, 'measure');
          };
          requestMarqueeLayout();
          if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(requestMarqueeLayout).catch(() => {});
          }
          if ('ResizeObserver' in window) {
            const observer = new ResizeObserver(requestMarqueeLayout);
            observer.observe(playerTitle);
            observer.observe(text);
            scope.signal.addEventListener('abort', () => observer.disconnect(), { once: true });
          } else {
            window.addEventListener('resize', requestMarqueeLayout, { signal: scope.signal });
          }
        }
      }
      playerTitle.dataset.fullTitle = cleanTitle;
      Array.from(playerTitle.children).forEach((item) => item.setAttribute('aria-hidden', 'true'));
      playerTitle.hidden = false;
      playerTitle.setAttribute('aria-disabled', cleanTitle ? 'false' : 'true');
      playerTitle.tabIndex = cleanTitle ? 0 : -1;
    };

    const setPlayerTitle = (button, preview, {
      marquee = Boolean(sharedSongAudio && !sharedSongAudio.paused && !sharedSongAudio.ended),
    } = {}) => {
      const entry = entriesByButton.get(button);
      const songTitle = entry?.title || '';
      const fileName = String((preview && preview.dataset.downloadName) || '').trim();
      const fullInfo = String((preview && preview.dataset.downloadTitle) || '').trim();
      const mp3Info = fileName && fullInfo.startsWith(fileName)
        ? fullInfo.slice(fileName.length).trim()
        : fullInfo;
      const author = entry?.author || '';
      const title = playerTitlePlainText(
        playerTitleTemplate
          .replaceAll('%AUTHOR%', author)
          .replaceAll('%TIT%', songTitle)
          .replaceAll('%SOUND%', fileName)
          .replaceAll('%MP3INFO%', mp3Info)
      );
      const marking = button?.querySelector('[data-song-mark]')?.dataset.songMark || '';
      const renderedTitle = marquee ? title : [author, songTitle].filter(Boolean).join(' — ');
      const alreadyRendered = (
        playerTitle.dataset.fullTitle === renderedTitle
        && playerTitle.classList.contains('is-marquee') === Boolean(marquee)
      );
      const accessibleTitle = [author, songTitle, playerTitleHint].filter(Boolean).join('. ');
      if (playerTitle.getAttribute('aria-label') !== accessibleTitle) playerTitle.setAttribute('aria-label', accessibleTitle);
      if (!alreadyRendered) renderPlayerTitle(renderedTitle, marquee, marking);
      playerTitle.setAttribute('title', playerTitleHint);
    };

    const setPreparedPlayerTitle = (button, preview) => {
      setPlayerTitle(button, preview, { marquee: false });
    };

    const showStoppedPlayerTitle = () => {
      if (!playingPreview) return; // Keep the build stamp until a song is opened.
      if (playingPreview && (playingPreview === currentOpenedPreview())) {
        setPreparedPlayerTitle(previewButton(playingPreview), playingPreview);
      } else {
        renderPlayerTitle('');
      }
    };

    const activatePlayerTitle = (event) => {
      if (playerTitle.getAttribute('aria-disabled') === 'true') return;
      const landscape = vcardEnvironment.media('(orientation: landscape)').matches;
      if (landscape) {
        const preview = (
          currentOpenedPreview()
        );
        const portal = preview && preview.querySelector('.song-vibeframe:not([hidden])');
        if (portal && !window.VCardPortalLayout?.isFullscreen(portal)) {
          const currentSize = window.VCardPortalLayout.current(preview).size === 'small'
            ? 'small'
            : 'mid';
          const nextSize = currentSize === 'small'
            ? 'mid'
            : 'small';
          requestPlayerPortalSize(nextSize, event, playerTitle);
        }
      }
    };

    playerTitle.addEventListener('click', activatePlayerTitle, { signal: playerControlsScope.signal });
    playerTitle.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const input = { type: 'Portal.ToggleVisibility', source: 'Player', target: playerTitle,
        preview: currentPortalPreview(), trusted: event.isTrusted };
      if (!window.VCCommands) window.VCardPlayerControls.toggleVisibility(input);
      else window.VCCommands.dispatch(input);
    }, { signal: playerControlsScope.signal });
    playerTitle.addEventListener('keydown', (event) => {
      if (event.isComposing || event.defaultPrevented || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      if (!event.repeat) activatePlayerTitle(event);
    }, { signal: playerControlsScope.signal });

    const moveSharedPlayer = (audio) => {
      if (!audio) return;
      const player = players.get(audio);
      const element = player && player.elements ? player.elements.container : audio;
      if (element.parentElement !== playerDock) playerDock.append(element);
    };

    const enhanceAudio = (audio) => {
      if (!audio || players.has(audio) || typeof window.Plyr !== 'function') return null;
      audio.removeAttribute('onerror');
      ensurePlyrIconSprite();
      const player = new window.Plyr(audio, {
        keyboard: { focused: true, global: false },
        controls: ['play', 'progress', 'current-time', 'mute', 'volume'],
        invertTime: false,
        displayDuration: false,
        iconUrl: '',
        loadSprite: false,
        listeners: {
          mute(event) { return requestPlayerSound(this, 'mute', event); },
          volume(event) { return requestPlayerSound(this, 'volume', event); },
          seek(event) { return requestPlayerSeek(this, event); },
        },
        i18n: {
          play: playerText.play,
          pause: playerText.pause,
          mute: playerText.mute,
          unmute: playerText.unmute,
          volume: playerText.volume,
          seek: playerText.seek,
          seekLabel: String(playerText.seekLabel).replaceAll('{seek}', playerText.seek)
        }
      });
      const soundControls = player.elements.controls;
      const muteControl = soundControls.querySelector('[data-plyr="mute"]');
      const volumeControl = soundControls.querySelector('[data-plyr="volume"]');
      const seekControl = soundControls.querySelector('[data-plyr="seek"]');
      if (muteControl) soundControlBindings.set(muteControl, { player, kind: 'mute' });
      if (volumeControl) soundControlBindings.set(volumeControl, { player, kind: 'volume' });
      if (seekControl) seekControlBindings.set(seekControl, player);
      // Preserve Plyr's focused shortcuts, but route transport and sound through
      // the same commands as the controls. Hidden vendor actions are unavailable.
      player.elements.container.addEventListener('keydown', (event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const target = event.target;
        if (!(target instanceof Element) || target !== seekControl
          && target.closest(player.config.selectors.editable)) return;
        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
        if (key === ' ' && target.matches('button, [role^="menuitem"]')) return;
        if (![' ', 'k', 'm', 'f', 'c', 'l', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)
          && !/^[0-9]$/.test(key)) return;
        if (event.defaultPrevented || event.isComposing) {
          // Do not let the vendor handler turn cancelled input or IME into transport.
          event.stopImmediatePropagation();
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        // Audio has no visible fullscreen, caption or loop control.
        if (['f', 'c', 'l'].includes(key)) return;
        if (event.repeat && !key.startsWith('Arrow')) return;
        let input;
        if (key === ' ' || key === 'k') {
          input = { type: 'Player.TogglePlayback', source: 'Keyboard', target: playbackControl,
            preview: playerPlaybackPreview(), phase: window.VCPlayer?.current?.()?.phase,
            trusted: event.isTrusted };
          if (!window.VCCommands) togglePlayerPlayback(input);
          else window.VCCommands.dispatch(input);
        } else if (key === 'm' || key === 'ArrowUp' || key === 'ArrowDown') {
          const kind = key === 'm' ? 'mute' : 'volume';
          input = { type: 'Player.Sound', source: 'Keyboard',
            target: kind === 'mute' ? muteControl : volumeControl, kind,
            value: kind === 'mute' ? !player.muted
              : Math.min(1, Math.max(0, player.volume + (key === 'ArrowUp' ? 0.1 : -0.1))),
            trusted: event.isTrusted };
          if (!window.VCCommands) setPlayerSound(input);
          else window.VCCommands.dispatch(input);
        } else {
          const position = /^[0-9]$/.test(key) ? player.duration / 10 * Number(key)
            : player.currentTime + (key === 'ArrowRight' ? 1 : -1) * player.config.seekTime;
          dispatchPlayerSeek(player, seekControl, position, event, 'Keyboard');
        }
      }, { capture: true, signal: playerControlsScope.signal });
      const dynamicHintRefreshers = [];
      const currentHintTrackButton = () => (
        previewButton(playingPreview)
        || previewButton(currentOpenedPreview())
        || null
      );
      const currentHintTrackNumbers = () => {
        const currentButton = currentHintTrackButton();
        const listId = String((currentButton && currentButton.dataset.list) || '');
        const visibleList = listSections.find((section) => section.style.display !== 'none');
        const listButtons = listId
          ? buttons.filter((button) => button.dataset.list === listId)
          : buttons.filter((button) => visibleList && visibleList.contains(button));
        const currentIndex = listButtons.indexOf(currentButton);
        return {
          current: currentIndex < 0 ? 0 : currentIndex + 1,
          total: listButtons.length
        };
      };
      const expandPlayerHint = (template) => {
        const trackNumbers = currentHintTrackNumbers();
        const storedBrightness = Number.parseInt(
          document.documentElement.dataset.visBri,
          10
        );
        const currentBrightness = Number.isInteger(storedBrightness)
          ? Math.max(0, Math.min(5, storedBrightness))
          : 0;
        return String(template || '')
          .replaceAll('%CUR_TRACK_NO%', String(trackNumbers.current))
          .replaceAll('%TOTAL_TRACKS_IN_LIST%', String(trackNumbers.total))
          .replaceAll('%CUR_BRIGHT%', String(currentBrightness));
      };
      const keepPlayerHint = (button, hint) => {
        const applyHint = () => {
          const resolvedHint = String(typeof hint === 'function' ? hint() : hint || '');
          if (button.getAttribute('title') !== resolvedHint) button.setAttribute('title', resolvedHint);
          if (button.getAttribute('aria-label') !== resolvedHint) button.setAttribute('aria-label', resolvedHint);
        };
        applyHint();
        button.dataset.vcardHint = 'true';
        const observer = new MutationObserver(applyHint);
        observer.observe(button, {
          attributes: true,
          attributeFilter: ['title', 'aria-label']
        });
        playerControlsScope.signal.addEventListener('abort', () => observer.disconnect(), { once: true });
        return applyHint;
      };
      const keepDynamicPlayerHint = (button, template) => {
        const applyHint = keepPlayerHint(button, () => expandPlayerHint(template));
        dynamicHintRefreshers.push(applyHint);
      };
      const makeTrackButton = (direction, hint, icon) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'plyr__control plyr__controls__item';
        button.dataset.vcardTrackDirection = String(direction);
        keepDynamicPlayerHint(button, hint);
        button.disabled = buttons.length < 2;
        button.innerHTML = `<svg aria-hidden="true" focusable="false"><use href="#plyr-${icon}"></use></svg>`;
        trackControlDirections.set(button, direction);
        button.addEventListener('click', (event) => {
          requestTrackNavigation(direction, 'Player', event);
        }, { signal: playerControlsScope.signal });
        return button;
      };
      const playButton = player.elements.controls.querySelector('[data-plyr="play"]');
      if (playButton) {
        const playHint = vcardHints.playerPlay || playerText.play;
        keepDynamicPlayerHint(playButton, playHint);
        playbackControl = playButton;
        applyPlayerPlayback = () => {
          if (playerDock.dataset.silentPhase) {
            cancelAutoAdvance();
          }
          const snapshot = window.VCPlayer?.current?.();
          const chainPhase = snapshot?.phase || '';
          const chainState = snapshot?.playbackChain || {};
          if (
            ['AudioPlaying', 'AudioBuffering', 'OutroRunning', 'NextPending'].includes(chainPhase)
            || (chainPhase === 'ReadyPaused' && chainState.autoReadyPending)
          ) {
            window.VCPlayer?.pause?.();
            return;
          }
          if (chainPhase === 'FinishedStopped') {
            document.dispatchEvent(new CustomEvent('vcard:prepare-audio-context'));
            window.VCPlayer?.resume?.();
            return;
          }
          const preview = (
            currentOpenedPreview() || (window.VCardSongControls?.currentPreview?.() || playingPreview)
          );
          if (!preview || !isPlayableSource(resolveSource(preview))) {
            return;
          }
          document.dispatchEvent(new CustomEvent('vcard:prepare-audio-context'));
          // Resuming an already started track remains immediate. The silent
          // five-second lead-in belongs only to an automatic list transition.
          if (preview === playingPreview && chainPhase === 'AudioPaused') {
            window.VCPlayer?.resume?.();
            return;
          }
          const button = previewButton(preview);
          if (!button) return;
          // Starting or replaying uses the visible portal frame.
          playSong(preview, button);
        };
        playButton.addEventListener('click', (event) => {
          // Capture the moved Plyr control before its native toggle can handle the same gesture.
          event.preventDefault();
          event.stopImmediatePropagation();
          const input = { type: 'Player.TogglePlayback', source: 'Player', target: playButton,
            preview: playerPlaybackPreview(), phase: window.VCPlayer?.current?.()?.phase,
            trusted: event.isTrusted };
          if (!window.VCCommands) togglePlayerPlayback(input);
          else window.VCCommands.dispatch(input);
        }, { capture: true, signal: playerControlsScope.signal });
        projectPlaybackControls = (snapshot) => {
          const phase = String(snapshot.phase || 'Idle');
          const moving = ['AudioPlaying', 'OutroRunning'].includes(phase);
          const pressed = ['AudioPlaying', 'AudioBuffering', 'OutroRunning', 'NextPending'].includes(phase);
          playButton.classList.toggle('plyr__control--pressed', pressed);
          const pressedValue = pressed ? 'true' : 'false';
          if (playButton.getAttribute('aria-pressed') !== pressedValue) {
            playButton.setAttribute('aria-pressed', pressedValue);
          }
          const song = snapshot.playingSong;
          const button = song ? findSongButton(song.listId, song.songId) : null;
          const preview = buttonPreview(button);
          if (preview) {
            if (moving) {
              setPlayerTitle(button, preview, { marquee: true });
              playerTitle.classList.remove('is-paused');
            } else if (playerTitle.classList.contains('is-marquee')) {
              playerTitle.classList.add('is-paused');
            }
          }
        };
        bindPlayerSetting(playButton, 'trackPlay', 'toggle', () => {
          document.dispatchEvent(new CustomEvent('vcard:set-trackplay', {
            detail: { enabled: !trackPlayEnabled }
          }));
        }, 'contextmenu');

        const controls = player.elements.controls;
        const previousButton = makeTrackButton(
          -1,
          vcardHints.playerPrevious || playerText.previousTrack,
          'previous-track'
        );
        const nextButton = makeTrackButton(
          1,
          vcardHints.playerNext || playerText.nextTrack,
          'next-track'
        );
        const makeAlternationButton = (kind) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = [
            'plyr__control',
            'plyr__controls__item',
            'vcard-player-status-glyph',
            'vcard-player-alternation-step',
          ].join(' ');
          button.dataset.vcardAlternation = kind;
          bindPlayerSetting(button, `${kind}AlternationStep`, 'next', () => {
            if (kind === 'song') {
              songAlternation = nextAlternation(SONG_ALTERNATION_ORDER, songAlternation);
              vcardStorage.local.setItem(SONG_ALTERNATION_STORAGE_KEY, songAlternation);
              randomSongBags.clear();
            } else {
              playlistAlternation = nextAlternation(
                PLAYLIST_ALTERNATION_ORDER,
                playlistAlternation
              );
              vcardStorage.local.setItem(PLAYLIST_ALTERNATION_STORAGE_KEY, playlistAlternation);
            }
            cancelAutoAdvance();
            publishManualSelection();
          });
          return button;
        };
        songAlternationNode = makeAlternationButton('song');
        playlistAlternationNode = makeAlternationButton('playlist');
        alternationStatusNode = document.createElement('button');
        alternationStatusNode.type = 'button';
        alternationStatusNode.className = [
          'plyr__control',
          'plyr__controls__item',
          'vcard-player-status-glyph',
          'vcard-player-alternation-status',
        ].join(' ');
        bindPlayerSetting(alternationStatusNode, 'autopilot', 'toggle', () => {
          vcardSetAutopilotEnabled(!vcardAutopilotEnabled());
        });
        projectAlternationStatus(window.VCPlayer?.current?.() || {
          selectionMode: vcardAutopilotEnabled() ? 'AUTO' : 'MAN',
          manualSelection: window.VCardManualSelection.current(),
        });
        bindPlayerSetting(previousButton, 'brightnessStep', '-1', () => {
          document.dispatchEvent(new CustomEvent('vcard:step-visualization-brightness', {
            detail: { delta: -1 }
          }));
        }, 'contextmenu');
        bindPlayerSetting(nextButton, 'brightnessStep', '1', () => {
          document.dispatchEvent(new CustomEvent('vcard:step-visualization-brightness', {
            detail: { delta: 1 }
          }));
        }, 'contextmenu');
        const presetButtons = [
          {
            key: 'night',
            hint: vcardHints.playerNight || 'Go NIGHT colors',
            icon: '<path fill="currentColor" d="M15.7 2.6A9.5 9.5 0 1 0 21.4 14 7.4 7.4 0 0 1 15.7 2.6Z"/>'
          },
          {
            key: 'mono',
            hint: vcardHints.playerMono || 'Go MONO colors',
            icon: '<path fill="currentColor" d="M12 3a9 9 0 0 0 0 18h1.35a2.65 2.65 0 0 0 0-5.3h-.9a1.45 1.45 0 0 1 0-2.9H15A6 6 0 0 0 15 3h-3Zm-4.5 8.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Zm2.25-3.5a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Zm4.25-.5a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Zm3 3a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z"/>'
          },
          {
            key: 'duo',
            hint: vcardHints.playerDuo || 'Go DUO colors',
            icon: '<circle cx="9" cy="12" r="6" fill="currentColor"/><circle cx="15" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="2"/>'
          },
          {
            key: 'newspaper',
            hint: vcardHints.playerNews || 'Go NEWSPAPER colors',
            icon: '<path fill="currentColor" d="M4 3h14a2 2 0 0 1 2 2v15H6a2 2 0 0 1-2-2V3Zm3 4v4h4V7H7Zm6 0v2h4V7h-4Zm0 4v2h4v-2h-4Zm-6 2v2h10v-2H7Zm0 4v1h10v-1H7Z"/>'
          }
        ].map((preset) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'plyr__control plyr__controls__item vcard-player-preset vcard-player-preset--' + preset.key;
          button.dataset.vcardPreset = preset.key;
          button.setAttribute('aria-label', preset.hint);
          button.setAttribute('title', preset.hint);
          button.setAttribute('aria-pressed', 'false');
          button.dataset.vcardHint = 'true';
          button.innerHTML = '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">' + preset.icon + '</svg>';
          button.addEventListener('click', (event) => {
            const input = { type: 'Color.Preset', source: 'Player', target: button,
              preset: preset.key, trusted: event.isTrusted };
            if (!window.VCCommands) window.VCardDecoration?.applyPreset(input);
            else window.VCCommands.dispatch(input);
          });
          return button;
        });
        const presetGroup = document.createElement('div');
        presetGroup.className = 'vcard-player-button-group vcard-player-preset-group';
        presetGroup.setAttribute('aria-label', 'Цветовая схема');
        presetGroup.append(...presetButtons);

        const backgroundButtons = [
          {
            key: 'wallpaper',
            hint: vcardHints.playerBackgroundWallpaper || 'Background: wallpaper',
            icon: '<path d="M3.5 5.5h17v13h-17zM5.5 16l4.2-4.4 3.1 3 2.4-2.2 3.3 3.6M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'
          },
          {
            key: 'graph1',
            hint: vcardHints.playerBackgroundGraph1 || 'Background: graph 1',
            icon: '<path d="M2 12h3l2-5 3 10 3-7 2 4 2-2h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
          },
          {
            key: 'graph2',
            hint: vcardHints.playerBackgroundGraph2 || 'Background: graph 2',
            icon: '<path d="M3 4h18M6 8h12M9 12h6M6 16h12M3 20h18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
          },
          {
            key: 'smoke',
            hint: vcardHints.playerBackgroundSmoke || 'Background: smoke',
            icon: '<path d="M5 17c-2.8-2.1-2.2-6.2.7-7.3C6.4 6.3 10.5 5.3 12 8c1.4-3.3 6.2-2.4 6.7.8 3.7-.2 5.3 4.6 2.4 6.8.8 3.7-4.2 5.7-6.7 3.1-2.7 3.1-7.6 1.5-7.2-2.2-1.1.6-1.8.8-2.2.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
          }
        ].map((background) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'plyr__control plyr__controls__item vcard-player-background vcard-player-background--' + background.key;
          button.dataset.backgroundMode = background.key;
          button.setAttribute('aria-label', background.hint);
          button.setAttribute('title', background.hint);
          button.setAttribute('aria-pressed', background.key === playerBackgroundMode ? 'true' : 'false');
          button.dataset.vcardHint = 'true';
          button.innerHTML = '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">' + background.icon + '</svg>';
          button.classList.toggle('is-active', background.key === playerBackgroundMode);
          if (!vcardVisualizationAvailable() && ['graph1', 'graph2'].includes(background.key)) {
            const unavailableHint = 'Аудиовизуализация недоступна';
            button.disabled = true;
            button.setAttribute('aria-disabled', 'true');
            button.setAttribute('aria-label', unavailableHint);
            button.setAttribute('title', unavailableHint);
          }
          bindPlayerSetting(button, 'background', background.key, () => {
            if (background.key === 'wallpaper') {
              document.dispatchEvent(new CustomEvent('vcard:randomize-wallpaper'));
            } else {
              document.dispatchEvent(new CustomEvent('vcard:set-background', {
                detail: { mode: background.key, force: true }
              }));
            }
          });
          return button;
        });
        const backgroundGroup = document.createElement('div');
        backgroundGroup.className = 'vcard-player-button-group vcard-player-background-group';
        backgroundGroup.setAttribute('aria-label', 'Фон');
        document.addEventListener('vcard:visualization-availability', () => {
          backgroundButtons.forEach((button) => {
            if (!['graph1', 'graph2'].includes(button.dataset.backgroundMode)) return;
            button.disabled = !vcardVisualizationAvailable();
            button.setAttribute('aria-disabled', String(button.disabled));
            if (button.disabled) {
              button.setAttribute('aria-label', 'Аудиовизуализация недоступна');
              button.setAttribute('title', 'Аудиовизуализация недоступна');
            }
          });
        }, { signal: playerControlsScope.signal });
        const brightnessZeroButton = document.createElement('button');
        brightnessZeroButton.type = 'button';
        brightnessZeroButton.className = [
          'plyr__control',
          'plyr__controls__item',
          'vcard-player-background',
          'vcard-player-status-glyph',
          'vcard-player-brightness-zero',
        ].join(' ');
        brightnessZeroButton.dataset.vcardBrightnessZero = 'true';
        brightnessZeroButton.textContent = '0';
        const brightnessZeroHint = vcardHints.playerBrightnessZero || 'Фон: яркость 0';
        brightnessZeroButton.setAttribute('aria-label', brightnessZeroHint);
        brightnessZeroButton.setAttribute('title', brightnessZeroHint);
        brightnessZeroButton.dataset.vcardHint = 'true';
        brightnessZeroButton.setAttribute('aria-pressed', 'false');
        bindPlayerSetting(brightnessZeroButton, 'brightness', '0', () => {
          document.dispatchEvent(new CustomEvent('vcard:set-visualization-brightness', {
            detail: { level: 0 }
          }));
        });
        backgroundGroup.append(brightnessZeroButton, ...backgroundButtons);

        const settingsButton = document.createElement('button');
        settingsButton.type = 'button';
        settingsButton.className = 'plyr__control plyr__controls__item vcard-player-settings';
        settingsButton.setAttribute('settings-link', '');
        settingsButton.setAttribute('aria-expanded', 'false');
        const settingsHint = vcardHints.playerSettings || 'Settings';
        settingsButton.setAttribute('aria-label', settingsHint);
        settingsButton.setAttribute('title', settingsHint);
        settingsButton.dataset.vcardHint = 'true';
        settingsButton.innerHTML = [
          '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">',
          '<path fill="currentColor" d="M19.14 12.94c.04-.31.05-.62.05-.94s-.01-.63-.05-.94l2.03-1.58-1.92-3.32-2.39.96a7.3 7.3 0 0 0-1.62-.94L14.88 3h-3.84l-.36 3.18a7.3 7.3 0 0 0-1.62.94l-2.39-.96-1.92 3.32 2.03 1.58c-.04.31-.05.62-.05.94s.01.63.05.94l-2.03 1.58 1.92 3.32 2.39-.96c.5.39 1.04.7 1.62.94l.36 3.18h3.84l.36-3.18a7.3 7.3 0 0 0 1.62-.94l2.39.96 1.92-3.32-2.03-1.58ZM12.96 15.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4Z"/>',
          '</svg>'
        ].join('');
        portalSizeButtons = [
          ['off', '0'],
          ['small', '1'],
          ['mid', '2'],
          ['full', '3']
        ].map(([size, label]) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'plyr__control plyr__controls__item vcard-portal-control vcard-portal-size';
          button.dataset.portalSize = size;
          button.textContent = label;
          const sizeHint = vcardHints[`player${label}`]
            || (size === 'off' ? 'Portal off' : `Portal size ${label}`);
          button.setAttribute('aria-label', sizeHint);
          button.setAttribute('aria-pressed', 'false');
          button.addEventListener('click', (event) => {
            requestPlayerPortalSize(size, event, button);
          }, { signal: playerControlsScope.signal });
          return button;
        });
        const portalGroup = document.createElement('div');
        portalGroup.className = 'vcard-player-button-group vcard-player-portal-group';
        const portalSizeHint = vcardHints.playerPortalSize || 'Размер и видимость картинок';
        keepPlayerHint(portalGroup, portalSizeHint);
        portalGroup.append(...portalSizeButtons);

        const fontScaleButtons = [
          ['xs', 'z'],
          ['s', 'z'],
          ['m', 'z'],
          ['l', 'Z'],
          ['xl', 'Z']
        ].map(([key, label], index) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'plyr__control plyr__controls__item vcard-font-scale';
          button.dataset.vcardFontScale = key;
          const labelNode = document.createElement('span');
          labelNode.className = 'vcard-font-scale__label';
          labelNode.textContent = label;
          labelNode.setAttribute('aria-hidden', 'true');
          button.append(labelNode);
          button.setAttribute('aria-label', `Размер текста x${index + 1}`);
          button.setAttribute('aria-pressed', 'false');
          bindPlayerSetting(button, 'fontScale', key, () => {
            document.dispatchEvent(new CustomEvent('vcard:set-font-scale', {
              detail: { key }
            }));
          });
          return button;
        });
        const fontScaleGroup = document.createElement('div');
        fontScaleGroup.className = 'vcard-player-button-group vcard-player-font-scale-group';
        fontScaleGroup.setAttribute('role', 'group');
        const fontScaleHint = vcardHints.playerFontScale || 'Размер шрифта';
        keepPlayerHint(fontScaleGroup, fontScaleHint);
        fontScaleGroup.append(...fontScaleButtons);

        const brightnessRow = document.createElement('div');
        brightnessRow.className = 'plyr__controls__item vcard-player-brightness-row';
        const brightnessHint = vcardHints.playerBrightness
          || 'Яркость фона: %CUR_BRIGHT%, 0=всё выкл';
        keepDynamicPlayerHint(brightnessRow, brightnessHint);
        Array.from({ length: 6 }, (_item, level) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'plyr__control vcard-player-brightness-level';
          button.dataset.vcardBrightnessLevel = String(level);
          button.textContent = String(level);
          button.setAttribute('aria-label', `Яркость фона ${level}`);
          button.setAttribute('aria-pressed', 'false');
          bindPlayerSetting(button, 'brightness', String(level), () => {
            document.dispatchEvent(new CustomEvent('vcard:set-visualization-brightness', {
              detail: { level }
            }));
          });
          brightnessRow.append(button);
        });
        const volumeBoostGroup = document.createElement('div');
        volumeBoostGroup.className = [
          'vcard-player-button-group',
          'vcard-player-volume-boost-group',
        ].join(' ');
        volumeBoostGroup.setAttribute('aria-label', 'Усиление громкости');
        const volumeBoostButtons = ['1', '1.5', '2', '3'].map((value) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'plyr__control vcard-player-volume-boost';
          button.dataset.vcardVolumeBoost = value;
          button.textContent = value === '1' ? 'x1' : value;
          button.setAttribute('aria-label', `Усиление громкости x${value}`);
          if (vcardFileMode && value !== '1') {
            button.disabled = true;
            button.setAttribute('aria-disabled', 'true');
          }
          bindPlayerSetting(button, 'volumeBoost', value, () => {
            document.dispatchEvent(new CustomEvent('vcard:set-volume-boost', {
              detail: { value }
            }));
          });
          volumeBoostGroup.append(button);
          return button;
        });
        const syncVolumeBoostButtons = (value = null) => {
          const selected = ['1', '1.5', '2', '3'].includes(String(value))
            ? String(value)
            : (
              ['1', '1.5', '2', '3'].includes(vcardStorage.local.getItem('vcard-volume-boost'))
                ? vcardStorage.local.getItem('vcard-volume-boost')
                : '1'
            );
          volumeBoostButtons.forEach((button) => {
            const active = button.dataset.vcardVolumeBoost === selected;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
          });
        };
        syncVolumeBoostButtons();
        playerTopline.replaceChildren(
          playButton,
          previousButton,
          playerTitle,
          nextButton,
          settingsButton
        );
        playerSecondline.replaceChildren(
          portalGroup,
          presetGroup,
          fontScaleGroup,
          backgroundGroup,
          brightnessRow,
          volumeBoostGroup
        );
        controls.prepend(sitemapButton);
        controls.append(
          songAlternationNode,
          playlistAlternationNode,
          alternationStatusNode
        );
        projectColorControls(window.VCPlayer?.current?.() || {
          colorSettings: window.VCardDecoration?.current?.(),
          colorScheme: window.VCardColorScheme?.current(),
        });
        const soundButton = controls.querySelector('[data-plyr="mute"]');
        if (soundButton) {
          const soundHint = vcardHints.playerSound || playerText.mute;
          keepPlayerHint(soundButton, soundHint);
        }
        if (!window.VCPlayer) {
          projectPortalControls({ portalLayout: window.VCardPortalLayout.current(currentOpenedPreview()) });
        }
        refreshDynamicPlayerHints = () => {
          dynamicHintRefreshers.forEach((refreshHint) => refreshHint());
        };
        projectBackgroundControls({ background: window.VCPlayer?.current?.()?.background || {
          mode: window.VCardBackgroundControl?.current() || playerBackgroundMode,
          brightness: window.VCardBrightness?.current() || null,
        } });
        refreshDynamicPlayerHints();
        requestPortalStickyHeight();
      }
      document.dispatchEvent(new CustomEvent('vcard:request-portal-state', {
        detail: { preview: currentOpenedPreview() }
      }));
      player.elements.controls.querySelectorAll('button, input, a').forEach((element) => {
        if (element.dataset.vcardHint === 'true') return;
        element.removeAttribute('title');
      });
      publishPlayerMp3Info(currentOpenedPreview());
      document.dispatchEvent(new CustomEvent('vcard:request-visualization-state'));
      document.dispatchEvent(new CustomEvent('vcard:request-background-state'));
      players.set(audio, player);
      return player;
    };

    function projectBackgroundControls(snapshot) {
      const background = snapshot.background;
      if (!background) return;
      const { mode: selectedMode, brightness: value } = background;
      document.querySelectorAll('[data-background-mode], [data-settings-background-mode]').forEach((button) => {
        const mode = button.dataset.backgroundMode || button.dataset.settingsBackgroundMode;
        const active = value !== '0' && mode === selectedMode;
        const pressed = String(active);
        if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
        button.classList.toggle('is-active', active);
      });
      if (value === null || value === undefined) return;
      document.querySelectorAll('[data-vcard-brightness-value]').forEach((element) => {
        if (element.textContent !== value) element.textContent = value;
      });
      document.querySelectorAll('[data-vcard-brightness-level]').forEach((button) => {
        const active = button.dataset.vcardBrightnessLevel === value;
        const pressed = String(active);
        if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
        button.classList.toggle('is-active', active);
      });
      document.querySelectorAll('[data-vcard-brightness-zero]').forEach((button) => {
        const active = value === '0';
        const pressed = String(active);
        if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
        button.classList.toggle('is-active', active);
      });
      if (projectedBackgroundBrightness !== value) {
        projectedBackgroundBrightness = value;
        refreshDynamicPlayerHints();
      }
    }
    document.addEventListener('vcard:song-open', () => refreshDynamicPlayerHints(), { signal: playerControlsScope.signal });

    function projectTrackPlayControls(snapshot) {
      const mode = snapshot.trackPlay;
      if (mode !== 'on' && mode !== 'off') return;
      document.querySelectorAll('[data-settings-track-play]').forEach((button) => {
        const active = button.dataset.settingsTrackPlay === mode;
        const pressed = String(active);
        if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
        button.classList.toggle('is-active', active);
      });
    }

    function projectColorControls(snapshot) {
      const update = (button, active) => {
        const pressed = String(active);
        if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
        button.classList.toggle('is-active', active);
      };
      if (snapshot.colorSettings) {
        document.querySelectorAll('[data-vcard-preset]').forEach((button) => {
          update(button, button.dataset.vcardPreset === snapshot.colorSettings.preset);
        });
      }
      if (snapshot.colorScheme) {
        document.querySelectorAll('[data-settings-color-scheme]').forEach((button) => {
          update(button, button.dataset.settingsColorScheme === snapshot.colorScheme);
        });
      }
    }

    const projectTextScale = (snapshot) => {
      const key = snapshot.textScale;
      if (!key) return;
      document.querySelectorAll('[data-settings-font-scale], [data-vcard-font-scale]').forEach((button) => {
        const buttonKey = button.dataset.settingsFontScale || button.dataset.vcardFontScale;
        const active = buttonKey === key;
        const pressed = String(active);
        if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
        button.classList.toggle('is-active', active);
      });
    };
    const projectVolumeBoost = (snapshot) => {
      if (!snapshot.volumeBoost) return;
      document.querySelectorAll('[data-vcard-volume-boost]').forEach((button) => {
        const active = button.dataset.vcardVolumeBoost === snapshot.volumeBoost;
        const pressed = String(active);
        if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
        button.classList.toggle('is-active', active);
      });
    };

    const playlistLabels = new Map(indexButtons.map((button) => [button.getAttribute('list'), {
      name: button.querySelector('.tabs__label')?.textContent || '',
      count: button.querySelector('sup')?.textContent || '',
    }]));
    const playlistNameNodes = [...document.querySelectorAll('[data-current-playlist-name]')];
    const playlistCountNodes = [...document.querySelectorAll('[data-current-playlist-count]')];
    let playlistState = Object.freeze({ listId: '' });
    let projectedListId = '';
    const projectPlaylist = (snapshot) => {
      const activeListId = snapshot.playlist?.listId;
      if (!activeListId || activeListId === projectedListId) return;
      projectedListId = activeListId;
      indexButtons.forEach((button) => {
        const active = (
          Boolean(activeListId)
          && button.getAttribute('list') === activeListId
        );
        button.classList.toggle('is-active', active);
        if (active && button.getAttribute('aria-current') !== 'page') {
          button.setAttribute('aria-current', 'page');
        } else if (!active && button.hasAttribute('aria-current')) {
          button.removeAttribute('aria-current');
        }
      });
      const label = playlistLabels.get(activeListId);
      playlistNameNodes.forEach((heading) => {
        if (heading.textContent !== label?.name) heading.textContent = label?.name || '';
      });
      playlistCountNodes.forEach((counter) => {
        if (counter.textContent !== label?.count) counter.textContent = label?.count || '';
      });
      listSections.forEach((section) => {
        const display = section.id === activeListId ? '' : 'none';
        if (section.style.display !== display) section.style.display = display;
      });
    };
    window.VCardPlaylist = Object.freeze({ current: () => playlistState });
    new TViewProjection(playerControlsScope, projectPlaylist);

    const ACTIVE_PLAYLIST_STORAGE_KEY = 'vcard-active-playlist';
    const currentListId = () => playlistState.listId;

    let catalogScrollFrame = 0;
    let cardScrollScope = null;
    const writeViewportScroll = (top, behavior, preview = null, guard = () => true, onApplied = () => {}) => {
      const listId = currentListId();
      vcardRenderScheduler.request(() => {
        window.scrollTo({ top, behavior });
        onApplied();
      }, {
        owner: preview || playerDock, scope: preview && cardScrollScope && !cardScrollScope.signal.aborted
          ? cardScrollScope : playerControlsScope,
        priority: 0, phase: 'write',
        isCurrent: () => guard() && currentListId() === listId && (!preview || (currentOpenedPreview() === preview && preview.isConnected)),
      });
    };
    const requestCatalogScroll = (apply, isCurrent) => {
      vcardRenderScheduler.cancel(catalogScrollFrame);
      catalogScrollFrame = 0;
      if (playerControlsScope.signal.aborted) return;
      catalogScrollFrame = vcardRenderScheduler.request(() => {
        catalogScrollFrame = 0;
        apply();
      }, { owner: playerDock, scope: playerControlsScope, priority: 0, phase: 'measure', isCurrent,
        onCancel: () => { catalogScrollFrame = 0; } });
    };
    playerControlsScope.signal.addEventListener('abort', () => {
      vcardRenderScheduler.cancel(catalogScrollFrame);
      catalogScrollFrame = 0;
    }, { once: true });

    const activateList = (targetListId, { collapseOpenSong = false } = {}) => {
      if (playerControlsScope.signal.aborted || !catalogListIds.includes(targetListId)) return;
      const previousListId = currentListId();
      let collapsedButton = null;
      if (collapseOpenSong && currentOpenedPreview()) {
        const openedPreview = currentOpenedPreview();
        collapsedButton = previewButton(openedPreview);
        hidePreview(openedPreview, { immediate: true });
        if (initialTrackLayoutPreview === openedPreview) {
          initialTrackLayoutPreview = null;
        }
        setOpenedPreview(null);
        autoPlayFromEnded = false;
      }
      if (targetListId !== previousListId) {
        playlistState = Object.freeze({ listId: targetListId });
        if (!window.VCPlayer) projectPlaylist({ playlist: playlistState });
        document.dispatchEvent(new CustomEvent('vcard:playlist-selection'));
      }
      try {
        vcardStorage.local.setItem(ACTIVE_PLAYLIST_STORAGE_KEY, targetListId);
      } catch (_error) {
        // A blocked or full storage must not prevent cassette selection.
      }
      document.dispatchEvent(new CustomEvent('vcard:playlist-change', {
        detail: {
          listId: targetListId,
          previousListId,
          changed: Boolean(previousListId && previousListId !== targetListId)
        }
      }));
      if (collapsedButton) {
        requestCatalogScroll(() => {
          const list = collapsedButton.closest('.list');
          if (!list || list.id !== targetListId) return;
          const title = collapsedButton.closest('.song__title') || collapsedButton;
          const titleDocumentTop = window.scrollY + title.getBoundingClientRect().top;
          writeViewportScroll(Math.max(0, titleDocumentTop - playerDockHeight()), 'auto');
        }, () => !currentOpenedPreview() && currentListId() === targetListId && collapsedButton.isConnected);
      }
    };

    // Restore the chosen cassette before writing any startup selection. Without
    // a valid saved choice, skip blank cassettes to reach the newest song list.
    const initialListId = (() => {
      let savedListId = '';
      try {
        savedListId = vcardStorage.local.getItem(ACTIVE_PLAYLIST_STORAGE_KEY) || '';
      } catch (_error) { }
      if (catalogListIds.includes(savedListId)) return savedListId;
      return catalogListIds.find((id) => catalogEntries.some((entry) => entry.listId === id))
        || catalogListIds[0]
        || '';
    })();
    if (initialListId) activateList(initialListId);

    const catalogInputAvailable = ({ target, current, listId } = {}) => Boolean(
      !playerControlsScope.signal.aborted && window.VCardBootstrap.state === 'Interactive'
      && target?.isConnected && !target.disabled && target.getAttribute('aria-disabled') !== 'true'
      && !target.closest('[inert]') && target.getClientRects().length
      && !window.VCardSettingsContext?.isOpen?.()
      && current === currentOpenedPreview() && listId === currentListId()
    );
    const playlistInputAvailable = (input = {}) => Boolean(catalogInputAvailable(input)
      && indexButtons.includes(input.target) && input.target.getAttribute('list') === input.nextListId
      && catalogListIds.includes(input.nextListId));
    const selectPlaylist = (input) => {
      if (!playlistInputAvailable(input)) return false;
      activateList(input.nextListId, { collapseOpenSong: true });
      return true;
    };
    indexButtons.forEach((button) => {
      button.addEventListener('click', (event) => {
        const targetListId = button.getAttribute('list');
        if (targetListId) {
          event.preventDefault();
          const input = { type: 'Playlist.Select', source: 'Catalog', target: button,
            nextListId: targetListId, listId: currentListId(), current: currentOpenedPreview(), trusted: event.isTrusted };
          if (!window.VCCommands) selectPlaylist(input);
          else window.VCCommands.dispatch(input);
          return;
        }

        // Fallback: if button has data-page, navigate as before
        if (button.dataset.page) {
          window.location.href = button.dataset.page;
        }
      }, { signal: playerControlsScope.signal });
    });

    const resolveSource = (preview) => {
      const host = preview ? preview.querySelector('[ids="audio"]') : null;
      const hostSrc = host ? (host.dataset.audioSrc || '').trim() : '';
      const previewSrc = preview ? (preview.dataset.src || '').trim() : '';
      return hostSrc || previewSrc || '';
    };

    const isPlayableSource = (src) => {
      const value = (src || '').trim();
      return !!value && !value.endsWith('/');
    };

    let audioPositionRequest = null;
    const cancelAudioPosition = (preview) => {
      if (preview && audioPositionRequest?.preview !== preview) return;
      audioPositionRequest?.scope.abort();
      audioPositionRequest = null;
    };
    playerControlsScope.signal.addEventListener('abort', () => cancelAudioPosition(), { once: true });
    const requestAudioPosition = (preview, position) => {
      cancelAudioPosition();
      const audioEl = sharedSongAudio;
      const source = audioEl.getAttribute('src');
      const request = { preview, scope: new AbortController() };
      audioPositionRequest = request;
      const current = () => !playerControlsScope.signal.aborted && !request.scope.signal.aborted
        && audioPositionRequest === request && preview.isConnected
        && audioEl.vcardPlayingPreview === preview && audioEl.getAttribute('src') === source;
      const apply = () => {
        if (!current()) return;
        try { audioEl.currentTime = position; }
        catch (error) { console.warn(`VCard audio: cannot seek to ${position}`, error); }
      };
      if (audioEl.readyState >= 1) apply();
      else audioEl.addEventListener('loadedmetadata', apply, { once: true, signal: request.scope.signal });
      return current;
    };

    const ensureAudioSource = (preview, audioEl) => {
      if (!preview || !audioEl) return '';
      const src = resolveSource(preview);
      if (!isPlayableSource(src)) {
        cancelAudioPosition();
        clearTrackBandHighlight();
        audioEl.pause();
        audioEl.removeAttribute('src');
        audioEl.load && audioEl.load();
        publishPlayerMp3Info(preview);
        document.dispatchEvent(new CustomEvent('vcard:request-portal-state', {
          detail: { preview }
        }));
        return '';
      }
      preview.dataset.src = src;
      if (audioEl.getAttribute('src') !== src) {
        cancelAudioPosition();
        clearTrackBandHighlight();
        const retainedVolume = audioEl.volume;
        const retainedMuted = audioEl.muted;
        audioEl.setAttribute('src', src);
        audioEl.load && audioEl.load();
        audioEl.volume = retainedVolume;
        audioEl.muted = retainedMuted;
      }
      const player = players.get(audioEl);
      if (player) publishPlayerMp3Info(preview);
      document.dispatchEvent(new CustomEvent('vcard:request-portal-state', {
        detail: { preview }
      }));
      return src;
    };

    const previewTransitions = new Map();
    const cancelPreviewTransition = (preview) => {
      const transition = previewTransitions.get(preview);
      if (!transition) return;
      previewTransitions.delete(preview);
      vcardRenderScheduler.cancel(transition.frame);
      if (transition.onEnd) preview.removeEventListener('transitionend', transition.onEnd);
    };
    playerControlsScope.signal.addEventListener('abort', () => {
      [...previewTransitions.keys()].forEach(cancelPreviewTransition);
    }, { once: true });

    const showPreview = (preview) => {
      if (!preview || playerControlsScope.signal.aborted) return;
      cancelPreviewTransition(preview);
      preview.hidden = false;
      preparePreviewPortal(preview, true);
      const transition = { frame: 0, onEnd: null };
      previewTransitions.set(preview, transition);
      transition.frame = vcardRenderScheduler.request(() => {
        previewTransitions.delete(preview);
        preview.classList.add('is-visible');
        preview.dispatchEvent(new CustomEvent('vcard:song-open', { bubbles: true }));
      }, { owner: preview, scope: playerControlsScope, priority: 0,
        isCurrent: () => previewTransitions.get(preview) === transition
          && currentOpenedPreview() === preview && preview.isConnected && !preview.hidden,
        onCancel: () => {
          if (previewTransitions.get(preview) === transition) previewTransitions.delete(preview);
        } });
    };

    const hidePreview = (preview, { immediate = false } = {}) => {
      if (!preview) return;
      cancelPreviewTransition(preview);
      cancelAudioPosition(preview);
      window.VCPlayer?.close?.(preview);
      if (!(
        sharedSongAudio?.vcardPlayingPreview === preview
        && window.VCPlayer?.current?.()?.trackRunId
      )) activatePreviewPortal(preview, false);
      preview.dispatchEvent(new CustomEvent('vcard:song-close', { bubbles: true }));
      preview.classList.remove('is-visible');
      if (preview === playingPreview && (!sharedSongAudio || sharedSongAudio.paused || sharedSongAudio.ended)) {
        renderPlayerTitle('');
      }
      if (immediate) {
        try { preview.hidden = true; } catch (err) { }
        return;
      }
      const transitionMs = getComputedStyle(preview).transitionDuration
        .split(',')
        .some((duration) => parseFloat(duration) > 0);
      if (!transitionMs) {
        try { preview.hidden = true; } catch (err) { }
        return;
      }
      const onEnd = (e) => {
        if (e && e.target !== preview) return;
        if (previewTransitions.get(preview) !== transition) return;
        if (preview === currentOpenedPreview()) {
          cancelPreviewTransition(preview);
          return;
        }
        try { preview.hidden = true; } catch (err) { }
        cancelPreviewTransition(preview);
      };
      const transition = { frame: 0, onEnd };
      previewTransitions.set(preview, transition);
      preview.addEventListener('transitionend', onEnd, { signal: playerControlsScope.signal });
    };

    const hideAllPreviews = (options = {}) => {
      if (currentOpenedPreview()) hidePreview(currentOpenedPreview(), options);
    };

    const sitemapInputAvailable = (input = {}) => Boolean(catalogInputAvailable(input)
      && input.target === sitemapButton && sitemapTarget?.isConnected);
    const showSitemap = (input) => {
      if (!sitemapInputAvailable(input)) return false;
      cancelAutoAdvance();
      autoPlayFromEnded = false;
      hideAllPreviews({ immediate: true });
      setOpenedPreview(null);
      initialTrackLayoutPreview = null;
      firstTrackVerseAlignedPreview = null;
      trackLayoutSuspendedByUser = true;
      clearTrackBandHighlight();
      requestCatalogScroll(() => {
        // Measure after closing portals; the destination must remain below
        // the sticky player in both full and compact layouts.
        const dockStyle = getComputedStyle(playerDock);
        const inset = Number.parseFloat(dockStyle.top) || 0;
        const height = playerDockHeight();
        requestPortalStickyHeight();
        const gap = Number.parseFloat(getComputedStyle(sitemapTarget).fontSize) * 0.25;
        writeViewportScroll(Math.max(0, window.scrollY + sitemapTarget.getBoundingClientRect().top - height - inset - gap), 'auto');
      }, () => !currentOpenedPreview() && currentListId() === input.listId && sitemapTarget.isConnected);
      return true;
    };
    sitemapButton.addEventListener('click', (event) => {
      const input = { type: 'Catalog.ShowMap', source: 'Player', target: sitemapButton,
        current: currentOpenedPreview(), listId: currentListId(), trusted: event.isTrusted };
      if (!window.VCCommands) showSitemap(input);
      else window.VCCommands.dispatch(input);
    }, { signal: playerControlsScope.signal });

    const prepareManualResume = () => {
      if (!vcardAutopilotEnabled()) {
        const recent = window.VCPlayer?.current?.()?.selectionMemory?.recent || [];
        const lastEntry = catalogEntries.find((entry) => entry.entryKey === recent.at(-1)?.entryKey);
        manualResumeEntry = lastEntry || null;
      }
    };

    const openRelativeSong = (direction, options = {}) => {
      window.VCPlayer?.cancelContinuation?.(direction > 0 ? 'explicit-next-navigation' : 'explicit-track-navigation');
      if (direction > 0) {
        const current = previewButton(playingPreview) || previewButton(currentOpenedPreview())
          || null;
        return openAutoNextSong(current, { automatic: false, explicit: true });
      }
      if (direction < 0 && vcardAutopilotEnabled()) {
        const previous = window.VCPlayer?.previousHistory?.();
        const button = previous && findSongButton(previous.listId, previous.songId);
        if (!button) return false;
        activateList(previous.listId);
        openSongButton(button, { forceOpen: true, play: true,
          reason: 'history', historyIndex: previous.index });
        return true;
      }
      const snapshot = window.VCPlayer?.current?.();
      const currentEntry = window.VCardCatalog.get(snapshot?.playingSong?.entryKey || snapshot?.openedSong?.entryKey);
      const currentIdx = catalogEntries.indexOf(currentEntry);
      if (currentIdx < 0 || !catalogEntries.length) return false;
      const nextEntry = Array.from({ length: catalogEntries.length }, (_value, offset) =>
        catalogEntries[(currentIdx + direction * (offset + 1) + catalogEntries.length) % catalogEntries.length])
        .find((entry) => entry.playable && window.VCPlayer?.releaseAvailable?.(entry.releaseKey) !== false);
      const nextButton = window.VCardCatalogView.buttonFor(nextEntry);
      if (!nextButton) return false;
      const nextListId = nextEntry.listId;
      if (nextListId) activateList(nextListId);
      openSongButton(nextButton, {
        forceOpen: true,
        play: options.play !== false,
        fromEnded: options.fromEnded === true,
      });
      return true;
    };

    const playableEntriesForList = (listId) => window.VCardCatalog.forList(listId).filter((entry) => {
      return entry.listId === String(listId || '') && entry.playable
        && window.VCPlayer?.releaseAvailable?.(entry.releaseKey) !== false;
    });

    const playableListIds = () => catalogListIds.filter((listId) => playableEntriesForList(listId).length);

    const resetRandomSongBag = (listId) => {
      const bag = new window.VCLifeCore.TShuffleBag(window.VCardCatalog.forList(listId).filter((entry) => entry.playable),
        (entry) => entry.entryKey, window.VCPlayer?.randomStream?.(`songs.manual.${listId}`));
      randomSongBags.set(listId, bag);
      return bag;
    };

    const takeRandomSong = (listId, currentEntry = null) => {
      const bag = randomSongBags.has(listId)
        ? randomSongBags.get(listId)
        : resetRandomSongBag(listId, currentEntry);
      const candidates = playableEntriesForList(listId);
      return bag.reserve({ refill: false, cancelToFront: true,
        allow: (entry) => candidates.includes(entry) && (candidates.length === 1 || entry !== currentEntry),
        prefer: (entry) => !window.VCPlayer?.recentSong?.(entry.songId) });
    };

    const nextPlaylistId = (currentListId) => {
      if (playlistAlternation === 'none') return '';
      if (playlistAlternation === 'repeat') return currentListId;
      const listIds = playableListIds();
      if (!listIds.length) return '';
      const currentIndex = listIds.indexOf(currentListId);
      if (playlistAlternation === 'random') {
        randomPlaylistBag ||= new window.VCLifeCore.TShuffleBag(catalogListIds, (listId) => listId,
          window.VCPlayer?.randomStream?.('playlists.manual'));
        return randomPlaylistBag.reserve({
          allow: (listId) => listIds.includes(listId) && (listIds.length === 1 || listId !== currentListId),
          prefer: (listId) => !window.VCPlayer?.recentPlaylist?.(listId),
        });
      }
      const direction = playlistAlternation === 'previous' ? -1 : 1;
      const baseIndex = currentIndex < 0 ? 0 : currentIndex;
      return listIds[(baseIndex + direction + listIds.length) % listIds.length] || '';
    };

    const reserveManualNextEntry = (currentEntry, { explicit = false } = {}) => {
      const songMode = explicit && songAlternation === 'none' ? 'next' : songAlternation;
      currentEntry = manualResumeEntry || currentEntry;
      if (!currentEntry || songMode === 'none') return null;
      const currentListId = currentEntry.listId;
      const currentListEntries = playableEntriesForList(currentListId);
      let nextEntry = null;
      let songReservation = null;
      let playlistReservation = null;
      let songBag = null;
      let playlistBag = null;
      const cancelReservations = () => {
        for (const reservation of [songReservation, playlistReservation]) {
          window.VCLife.playbackChain.cancelPlan(reservation);
        }
      };

      try {
        if (songMode === 'repeat') {
          if (currentListEntries.includes(currentEntry)) nextEntry = currentEntry;
        } else if (songMode === 'random') {
          songReservation = takeRandomSong(currentListId, currentEntry);
          songBag = randomSongBags.get(currentListId);
          nextEntry = songReservation?.item || null;
        } else {
          const listEntries = window.VCardCatalog.forList(currentListId);
          const currentIndex = listEntries.indexOf(currentEntry);
          nextEntry = listEntries.slice(currentIndex + 1).find((entry) => currentListEntries.includes(entry)) || null;
        }

        if (!nextEntry) {
          const target = nextPlaylistId(currentListId);
          playlistReservation = typeof target === 'object' ? target : null;
          playlistBag = playlistReservation ? randomPlaylistBag : null;
          const targetListId = playlistReservation?.item || target;
          if (!targetListId) return false;
          const targetEntries = playableEntriesForList(targetListId);
          if (songMode === 'random') {
            const bag = randomSongBags.get(targetListId) || resetRandomSongBag(targetListId);
            songBag = bag;
            songReservation = bag.reserve({
              cancelToFront: true,
              allow: (entry) => targetEntries.includes(entry) && (targetEntries.length === 1 || entry !== currentEntry),
              prefer: (entry) => !window.VCPlayer?.recentSong?.(entry.songId),
            });
            nextEntry = songReservation?.item || null;
          } else {
            nextEntry = targetEntries[0] || null;
          }
        }
      } catch (error) {
        cancelReservations();
        throw error;
      }

      if (!nextEntry) {
        cancelReservations();
        return null;
      }
      let active = true;
      const selection = { entryKey: nextEntry.entryKey, songBag, playlistBag };
      pendingManualSelection = selection;
      const releaseSelection = () => {
        if (pendingManualSelection === selection) pendingManualSelection = null;
      };
      const cancel = () => {
        if (!active) return;
        active = false;
        releaseSelection();
        cancelReservations();
      };
      const title = nextEntry.title;
      return {
        entry: nextEntry,
        title,
        songId: nextEntry.localId,
        commit() {
          if (!active) return false;
          const nextListId = nextEntry.listId;
          // Validate both bags before consuming either half of the selection.
          if (!playableEntriesForList(nextListId).includes(nextEntry)
              || (songReservation && songBag?.reservation !== songReservation)
              || (playlistReservation && playlistBag?.reservation !== playlistReservation)) {
            cancel();
            return false;
          }
          active = false;
          releaseSelection();
          let committed = false;
          try {
            if (songReservation && !songReservation.commit()) return false;
            if (playlistReservation && !playlistReservation.commit()) return false;
            committed = true;
          } finally {
            if (!committed) cancelReservations();
          }
          return true;
        },
        cancel,
      };
    };

    const reserveAutoNextSong = (currentButton, { explicit = false } = {}) => {
      window.VCPlayer?.recentSong?.('');
      if (window.VCPlayer?.current?.()?.trackRunId) manualResumeEntry = null;
      if (vcardAutopilotEnabled()) {
        const reservation = window.VCPlayer?.reserveAutoNext?.(entriesByButton.get(currentButton)?.releaseKey);
        if (!reservation) return null;
        const entry = reservation.entry;
        const nextButton = findSongButton(entry.listId, entry.localId);
        if (!nextButton) {
          reservation.cancel();
          return null;
        }
        return {
          title: entry.title,
          songId: entry.localId,
          commit({ automatic = true } = {}) {
            if (!reservation.commit()) return false;
            activateList(entry.listId);
            autoPlayFromEnded = Boolean(automatic);
            openSongButton(nextButton, { forceOpen: true, play: true, fromEnded: true,
              reason: automatic ? 'auto' : 'next' });
            return true;
          },
          cancel: () => reservation.cancel(),
        };
      }
      const reservation = reserveManualNextEntry(entriesByButton.get(currentButton), { explicit });
      if (!reservation) return null;
      const entry = reservation.entry;
      return {
        title: entry.title, songId: entry.localId,
        commit({ automatic = true } = {}) {
          const button = window.VCardCatalogView.buttonFor(entry);
          if (!button?.isConnected || !buttonPreview(button)?.isConnected) {
            reservation.cancel();
            return false;
          }
          if (!reservation.commit()) return false;
          activateList(entry.listId);
          autoPlayFromEnded = Boolean(automatic);
          openSongButton(button, { forceOpen: true, play: true, fromEnded: true,
            reason: automatic ? 'auto' : 'next' });
          return true;
        },
        cancel: () => reservation.cancel(),
      };
    };

    const openAutoNextSong = (currentButton, { automatic = true, explicit = false } = {}) => {
      const reservation = reserveAutoNextSong(currentButton, { explicit });
      return reservation ? reservation.commit({ automatic }) : false;
    };

    const bindAutoAdvance = (audioEl, currentButton) => {
      if (!audioEl || !currentButton) return;
      audioEl.onended = null;
      window.VCPlayer?.setCompleteHandler?.(({ preview }) => {
        if (playingPreview !== preview || previewButton(preview) !== currentButton) return null;
        stopSilentPhase({ restore: false });
        playerTitle.classList.add('is-paused');
        return reserveAutoNextSong(currentButton);
      });
    };

    const playSong = (preview, button, reason = 'click', historyIndex = -1, surface = 'player') => {
      if (window.VCardBootstrap.state !== 'Interactive') return;
      manualResumeEntry = null;
      const audioEl = sharedSongAudio;
      if (!preview || !button || !audioEl) return;
      cancelAudioPosition();
      if (preview === playingPreview && audioEl.ended && reason === 'click') {
        restartFinishedSong(preview, surface);
        return;
      }
      playingPreview = preview;
      const newSongSelected = audioEl.vcardPlayingPreview !== preview;
      audioEl.vcardPlayingPreview = preview;
      if (newSongSelected) {
        clearTrackBandHighlight();
        document.dispatchEvent(new CustomEvent('vcard:song-start', {
          detail: { preview }
        }));
      }
      setPlayerTitle(button, preview);
      const audioSrc = ensureAudioSource(preview, audioEl);
      if (!audioSrc) return;
      bindAutoAdvance(audioEl, button);

      const startFromBeginning = () => {
        if (
          playingPreview !== preview
          || audioEl.getAttribute('src') !== audioSrc
        ) return;
        try {
          audioEl.currentTime = 0;
        } catch (error) {
          console.warn(`VCard audio: cannot rewind ${audioSrc}`, error);
        }
        alignInitialTrackLayout(preview);
        document.dispatchEvent(new CustomEvent('vcard:prepare-audio-context'));
        const startRequest = window.VCPlayer?.start?.(preview, {
          reason, historyIndex, surface: ['auto', 'next', 'history'].includes(reason) ? null : surface,
        });
        updateTrackBandHighlight({ scroll: false, force: true });
        startRequest?.then?.(() => updateTrackBandHighlight({ scroll: false, force: true }));
      };

      // Unlock Web Audio in the click handler, not after the silent timeout.
      document.dispatchEvent(new CustomEvent('vcard:prepare-audio-context'));
      if (!audioEl.paused && !audioEl.ended && reason === 'click') return;
      stopSilentPhase({ restore: false });
      startFromBeginning();
    };

    document.addEventListener('vcard:portal-idle-play', (event) => {
      const preview = event.detail?.preview;
      const button = previewButton(preview);
      if (preview && button) playSong(preview, button, 'click', -1, 'portal');
    });

    const prepareSongPlayer = (preview, button) => {
      const audioEl = sharedSongAudio;
      if (!preview || !button || !audioEl) return '';
      playingPreview = preview;
      const newSongSelected = audioEl.vcardPlayingPreview !== preview;
      audioEl.vcardPlayingPreview = preview;
      if (newSongSelected) {
        clearTrackBandHighlight();
        document.dispatchEvent(new CustomEvent('vcard:song-start', {
          detail: { preview }
        }));
      }
      setPreparedPlayerTitle(button, preview);
      const audioSrc = ensureAudioSource(preview, audioEl);
      if (!audioSrc) return '';
      requestAudioPosition(preview, 0);
      bindAutoAdvance(audioEl, button);
      updateTrackBandHighlight();
      return audioSrc;
    };

    const trackBandVerseContext = (verse) => {
      const text = verse?.closest('.song__preview-text[data-track-band]');
      const preview = text && text.closest('.song__preview');
      const button = previewButton(preview);
      const index = Number(verse?.dataset.trackVerse);
      const thresholds = parseTrackBand(text && text.dataset.trackBand);
      const startTime = thresholds[index];
      return { preview, button, startTime, index };
    };
    const trackBandVerseAvailable = ({ target, preview, button, startTime } = {}) => {
      const context = trackBandVerseContext(target);
      return Boolean(!playerControlsScope.signal.aborted && window.VCardBootstrap.state === 'Interactive'
        && target?.isConnected && target.matches('.song__track-verse') && target.getClientRects().length
        && !target.closest('[inert]') && !window.VCardSettingsContext?.isOpen?.()
        && preview?.isConnected && preview === currentOpenedPreview()
        && context.preview === preview && context.button === button && entriesByButton.has(button)
        && Number.isInteger(context.index) && Number.isFinite(startTime) && startTime >= 0
        && context.startTime === startTime && window.VCardCatalogView?.forPreview(preview)?.playable);
    };
    const playTrackBandVerse = (input) => {
      if (!trackBandVerseAvailable(input)) return false;
      const { preview, button, startTime } = input;
      initialTrackLayoutPreview = null;
      cancelAutoAdvance();
      if (!prepareSongPlayer(preview, button)) return;

      setOpenedPreview(preview);

      const positionCurrent = requestAudioPosition(preview, startTime);

      document.dispatchEvent(new CustomEvent('vcard:prepare-audio-context'));
      const startRequest = window.VCPlayer?.start?.(preview, { reason: 'click', surface: 'player' });
      updateTrackBandHighlight({ scroll: false, force: true, seeked: true });
      startRequest?.then?.(() => positionCurrent() && updateTrackBandHighlight({
        scroll: false,
        force: true,
        seeked: true,
      }));
      return true;
    };
    const requestTrackBandVerse = (verse, event) => {
      const input = { type: 'Verse.Play', source: 'SongText', target: verse,
        ...trackBandVerseContext(verse), trusted: event.isTrusted };
      return window.VCCommands ? window.VCCommands.dispatch(input) : playTrackBandVerse(input);
    };

    // Stanza separators also occur in songs without timed verse tracking.
    document.querySelectorAll('.song__preview-text').forEach((text) => {
      text.innerHTML = text.innerHTML.split(/(<br\s*\/?>)/i).map((line) => (
        /^\*\s*\*\s*\*$/.test(decodeHtmlLine(line).trim())
          ? `<span class="song__stanza-separator">${line}</span>`
          : line
      )).join('');
    });

    document.querySelectorAll('.song__preview-text[data-track-band]').forEach((text) => {
      if (!parseTrackBand(text.dataset.trackBand).length) return;
      prepareTrackBandText(text);

      let lastTouchTap = null;
      let suppressNativeDoubleClickUntil = 0;
      const doubleTapDelay = 360;
      const doubleTapDistance = 24;
      text.addEventListener('keydown', (event) => {
        const verse = event.target.closest('.song__track-verse[role="button"]');
        if (!verse || !['Enter', ' '].includes(event.key) || event.isComposing || event.defaultPrevented) return;
        event.preventDefault();
        if (!event.repeat) requestTrackBandVerse(verse, event);
      }, { signal: playerControlsScope.signal });
      text.addEventListener('pointerup', (event) => {
        if (event.pointerType !== 'touch') return;
        const verse = event.target.closest('.song__track-verse');
        if (!verse) return;
        const now = performance.now();
        const previousTap = lastTouchTap;
        lastTouchTap = null;
        if (
          previousTap
          && previousTap.verse === verse
          && now - previousTap.at <= doubleTapDelay
          && Math.abs(event.clientX - previousTap.x) <= doubleTapDistance
          && Math.abs(event.clientY - previousTap.y) <= doubleTapDistance
        ) {
          suppressNativeDoubleClickUntil = now + doubleTapDelay;
          event.preventDefault();
          requestTrackBandVerse(verse, event);
          return;
        }
        lastTouchTap = { verse, at: now, x: event.clientX, y: event.clientY };
      }, { signal: playerControlsScope.signal });
      text.addEventListener('pointercancel', () => {
        lastTouchTap = null;
      }, { signal: playerControlsScope.signal });
      text.addEventListener('contextmenu', (event) => {
        if (!event.target.closest('.song__track-verse')) return;
        event.preventDefault();
      }, { signal: playerControlsScope.signal });
      text.addEventListener('dblclick', (event) => {
        const verse = event.target.closest('.song__track-verse');
        if (!verse) return;
        if (performance.now() < suppressNativeDoubleClickUntil) return;
        event.preventDefault();
        requestTrackBandVerse(verse, event);
      }, { signal: playerControlsScope.signal });
    });

    hideAllPreviews();

    if (sharedSongAudio) {
      enhanceAudio(sharedSongAudio);
      moveSharedPlayer(sharedSongAudio);
      sharedSongAudio.preload = 'none';
      const publishUnownedAudioState = () => {
        const life = window.VCLife;
        const channel = life?.audioChannel;
        if (!life || life.dead || playerControlsScope.signal.aborted) return;
        if (channel?.owner && !channel.owner.dead && channel.source === sharedSongAudio.src) return;
        const source = sharedSongAudio.getAttribute('src');
        life.queue.run(() => {
          if (!playerControlsScope.signal.aborted && source === sharedSongAudio.getAttribute('src')) life.publish();
        }, { type: 'Audio.Availability', owner: life, scope: life.scope });
      };
      ['error', 'emptied', 'loadedmetadata'].forEach((name) => {
        sharedSongAudio.addEventListener(name, publishUnownedAudioState, { signal: playerControlsScope.signal });
      });
      sharedSongAudio.addEventListener('timeupdate', updateTrackBandHighlight, { signal: playerControlsScope.signal });
      sharedSongAudio.addEventListener('playing', () => {
        updateTrackBandHighlight();
        scheduleTrackVerseLayout(playingPreview, 'smooth');
      }, { signal: playerControlsScope.signal });
      sharedSongAudio.addEventListener('seeked', () => {
        if (Number(sharedSongAudio.currentTime) <= 0.05) {
          if (playingPreview) {
            const button = previewButton(playingPreview);
            if (button) {
              if (sharedSongAudio.paused && !playerTitle.classList.contains('is-marquee')) {
                showStoppedPlayerTitle();
              }
              else setPlayerTitle(button, playingPreview);
            }
          }
          if (sharedSongAudio.paused) {
            // Programmatic start and verse selection also seek to zero while
            // the media element may still report paused.  Clearing the
            // completion callback here races with play() and leaves the
            // finished cassette without an automatic next-song transition.
            playerTitle.classList.add('is-paused');
          }
        }
        updateTrackBandHighlight({
          allowPaused: true,
          force: true,
          seeked: true,
        });
      }, { signal: playerControlsScope.signal });
      sharedSongAudio.addEventListener('loadedmetadata', updateTrackBandHighlight, { signal: playerControlsScope.signal });
      sharedSongAudio.addEventListener('play', () => {
        if (!playingPreview) return;
        alignInitialTrackLayout(playingPreview);
        updateTrackBandHighlight({ scroll: false });
      }, { signal: playerControlsScope.signal });
      sharedSongAudio.addEventListener('pause', () => {
        if (sharedSongAudio.ended) return;
        // A deliberate pause freezes the reading position; keep its verse
        // highlighted without triggering another automatic scroll.
        updateTrackBandHighlight({ scroll: false, allowPaused: true });
      }, { signal: playerControlsScope.signal });
      // A short network/audio-buffer underrun must not make tracking appear
      // disabled.  Keep the last timed verse active until playback resumes;
      // the next timeupdate/seeked event will advance it normally.
      sharedSongAudio.addEventListener('emptied', clearTrackBandHighlight, { signal: playerControlsScope.signal });
      sharedSongAudio.addEventListener('ended', () => {
        // Keep the marquee moving during the end-rewind cassette phase.
        clearTrackBandHighlight();
      }, { signal: playerControlsScope.signal });
    }

    if (!window.VCPlayer) projectAudioAvailability({});
    new TViewProjection(playerControlsScope, (snapshot) => {
      projectAudioAvailability(snapshot);
      projectPlaybackStatus(snapshot);
      projectPlaybackControls?.(snapshot);
      projectPortalControls(snapshot);
      projectTextScale(snapshot);
      projectVolumeBoost(snapshot);
      projectBackgroundControls(snapshot);
      projectColorControls(snapshot);
      projectTrackPlayControls(snapshot);
      projectPlayerModeLayout(snapshot);
      projectAlternationStatus(snapshot);
    });


    const visiblePreviewVideoLinks = (preview) => {
      const links = preview && preview.querySelector('.song-video-links');
      return links
        && links.getBoundingClientRect().height > 0
        && getComputedStyle(links).display !== 'none'
        ? links
        : null;
    };

    const scrollPreviewPortalToTop = (preview, behavior = 'auto') => {
      const height = playerDockHeight();

      const videoLinks = visiblePreviewVideoLinks(preview);
      if (videoLinks) {
        const videoStyle = getComputedStyle(videoLinks);
        const linkGap = Number.parseFloat(videoStyle.marginTop) || 0;
        const portal = preview.querySelector('.song-portal-stage, .song-vibeframe');
        const portalRect = portal && portal.getBoundingClientRect();
        const portalHeight = (
          portalRect
          && portalRect.height > 0
          && getComputedStyle(portal).display !== 'none'
        ) ? portalRect.height : 0;
        const videoDocumentTop = window.scrollY + videoLinks.getBoundingClientRect().top;
        // The audio portal is sticky below the player.  Leave its full height
        // above the video instead of scrolling the video underneath it.
        const videoTop = Math.max(
          0,
          videoDocumentTop - height - portalHeight - linkGap
        );
        // The video-row alignment must not stop before the portal's own sticky
        // threshold. Its older full-dock calculation leaves the two shared
        // borders (four CSS pixels) between the portal and the player until
        // the user's first downward scroll.
        const top = Math.max(videoTop, portalPinScrollTop(preview));
        writeViewportScroll(top, behavior, preview);
        return top;
      }

      const frame = preview && preview.querySelector('.song-portal-stage, .song-vibeframe');
      const text = preview && preview.querySelector('.song__preview-text');
      if (!frame || frame.hidden || getComputedStyle(frame).display === 'none') {
        if (!text) return;
        const firstVerse = text.querySelector('.song__track-verse') || text;
        const firstVerseDocumentTop = window.scrollY + firstVerse.getBoundingClientRect().top;
        const verseStyle = getComputedStyle(firstVerse);
        const lineGap = Number.parseFloat(verseStyle.lineHeight)
          || Number.parseFloat(verseStyle.fontSize)
          || 0;
        const top = Math.max(0, firstVerseDocumentTop - height - lineGap);
        writeViewportScroll(top, behavior, preview);
        return top;
      }

      const top = portalPinScrollTop(preview);
      writeViewportScroll(top, behavior, preview);
      return top;
    };

    const previewIsPlaying = (preview) => Boolean(
      preview
      && playingPreview === preview
      && ['AudioPlaying', 'AudioBuffering'].includes(window.VCPlayer?.current?.()?.phase)
    );

    const scrollSongTitleToTop = (preview, behavior = 'auto') => {
      const title = preview && preview.previousElementSibling;
      if (!title || !title.classList.contains('song__title')) return null;
      const titleDocumentTop = window.scrollY + title.getBoundingClientRect().top;
      const height = playerDockHeight();
      requestPortalStickyHeight();
      const top = Math.max(0, titleDocumentTop - height);
      writeViewportScroll(top, behavior, preview);
      return top;
    };

    const scheduleCardScroll = (preview, behavior, portal = false) => {
      cardScrollScope?.abort();
      // Next/AUTO can request the card while VCPlayer.open is still queued.
      // Validate ownership when the task runs, after that command is applied.
      if (playerControlsScope.signal.aborted || !preview?.isConnected) return;
      const scope = new AbortController();
      cardScrollScope = scope;
      const frames = new Set();
      const current = () => !scope.signal.aborted && currentOpenedPreview() === preview && preview.isConnected;
      playerControlsScope.signal.addEventListener('abort', () => scope.abort(),
        { once: true, signal: scope.signal });
      scope.signal.addEventListener('abort', () => {
        frames.forEach((id) => vcardRenderScheduler.cancel(id));
        frames.clear();
      }, { once: true });
      const request = (apply) => {
        // The initial request can precede the queued Song.Open command.
        // Ownership is checked by the scheduler when the frame actually runs.
        if (scope.signal.aborted || !preview.isConnected) return;
        const id = vcardRenderScheduler.request(() => {
          frames.delete(id);
          apply();
        }, { owner: preview, scope, priority: 0, phase: 'measure', isCurrent: current,
          onCancel: () => frames.delete(id) });
        frames.add(id);
      };
      const align = (scrollBehavior = behavior) => {
        if (portal) {
          requestPortalStickyHeight();
          scrollPreviewPortalToTop(preview, scrollBehavior);
        } else scrollSongTitleToTop(preview, scrollBehavior);
      };
      request(() => {
        align();
        // Revealing a card can settle its geometry only after the first frame.
        request(() => align());
      });
      const image = portal && preview.querySelector('.song__preview-image');
      if (image && !image.complete) {
        image.addEventListener('load', () => {
          request(() => {
            if (!previewIsPlaying(preview)) align('auto');
          });
        }, { once: true, signal: scope.signal });
      }
    };
    const scheduleSongTitleScroll = (preview, behavior = 'auto') => scheduleCardScroll(preview, behavior);
    const schedulePortalScroll = (preview, behavior = 'auto') => scheduleCardScroll(preview, behavior, true);

    const restartFinishedSong = (preview, surface = 'player') => {
      cancelAudioPosition();
      cancelAutoAdvance();
      initialTrackLayoutPreview = preview;
      firstTrackVerseAlignedPreview = null;
      trackLayoutSuspendedByUser = false;
      trackScrollGestureStart = null;
      clearTrackBandHighlight();
      setOpenedPreview(preview);
      try {
        sharedSongAudio.currentTime = 0;
      } catch (error) {
        console.warn('VCard audio: cannot rewind finished song', error);
      }
      requestPortalStickyHeight();
      scrollPreviewPortalToTop(preview, 'auto');
      schedulePortalScroll(preview, 'auto');
      document.dispatchEvent(new CustomEvent('vcard:prepare-audio-context'));
      const startRequest = window.VCPlayer?.start?.(preview, { reason: 'restart', surface });
      updateTrackBandHighlight({ scroll: false, force: true });
      startRequest?.then?.(() => updateTrackBandHighlight({ scroll: false, force: true }));
    };

    const openSongButton = (button, options = {}) => {
      if (window.VCardBootstrap.state !== 'Interactive') return;
      if (!options.restore) manualResumeEntry = null;
      const preview = buttonPreview(button);
      if (!preview || !preview.classList.contains('song__preview')) return;
      if (!options.fromEnded) {
        cancelAutoAdvance();
      }

      // Toggle behavior: clicking an already open item closes its preview
      if (!options.forceOpen && currentOpenedPreview() === preview) {
        hidePreview(preview);
        if (initialTrackLayoutPreview === preview) initialTrackLayoutPreview = null;
        setOpenedPreview(null);
        autoPlayFromEnded = false;
        return;
      }

      const shouldAutoPlay = autoPlayFromEnded;
      autoPlayFromEnded = false;
      trackLayoutSuspendedByUser = false;
      trackScrollGestureStart = null;
      trackVerseRepositionRequested = false;

      hideAllPreviews({ immediate: Boolean(options.fromEnded) });
      showPreview(preview);
      setOpenedPreview(preview);
      initialTrackLayoutPreview = preview;
      firstTrackVerseAlignedPreview = null;

      const startsAutomatically = Boolean(shouldAutoPlay || options.play);
      if (
        !startsAutomatically
        && window.VCPlayer?.current?.()?.trackRunId
        && sharedSongAudio?.vcardPlayingPreview === preview
      ) {
        updateTrackBandHighlight({ scroll: false, allowPaused: true });
        if (sharedSongAudio.paused && !playerTitle.dataset.fullTitle) {
          setPreparedPlayerTitle(button, preview);
        }
      }

      if (startsAutomatically) {
        playSong(preview, button, shouldAutoPlay ? 'auto' : (options.reason || 'click'), options.historyIndex);
      } else if (
        !sharedSongAudio?.vcardPlayingPreview
        || (
          sharedSongAudio.vcardPlayingPreview === preview
          && !window.VCPlayer?.current?.()?.trackRunId
        )
      ) {
        prepareSongPlayer(preview, button);
      }
      refreshDynamicPlayerHints();

      try {
        // Automatic playback reveals the portal. A later title alignment
        // would overwrite the first verse scroll requested by AudioPlaying.
        // Cards opened for reading still reveal their title.
        if (startsAutomatically) schedulePortalScroll(preview, 'auto');
        else scheduleSongTitleScroll(preview, 'auto');
      } catch (e) { }
    };

    const songInputButtons = new WeakMap();
    const songCardAvailable = ({ target, button, current } = {}) => Boolean(
      !playerControlsScope.signal.aborted && window.VCardBootstrap.state === 'Interactive'
      && songInputButtons.get(target) === button && entriesByButton.has(button)
      && target?.isConnected && button?.isConnected && buttonPreview(button)?.isConnected
      && !target.disabled && target.getAttribute('aria-disabled') !== 'true'
      && !target.closest('[inert]') && target.getClientRects().length
      && !window.VCardSettingsContext?.isOpen?.()
      && current === currentOpenedPreview()
    );
    const toggleSongCard = (input) => {
      if (!songCardAvailable(input)) return false;
      const fromNews = input.target.matches('.news-link');
      if (fromNews) activateList(String(input.button.dataset.list || ''));
      openSongButton(input.button, { forceOpen: fromNews });
      return true;
    };
    window.VCardSongControls = Object.freeze({ canToggleCard: songCardAvailable, toggleCard: toggleSongCard,
      currentPreview: () => currentOpenedPreview(),
      canPlayVerse: trackBandVerseAvailable, playVerse: playTrackBandVerse,
      canSelectPlaylist: playlistInputAvailable, selectPlaylist,
      canShowMap: sitemapInputAvailable, showMap: showSitemap });
    const requestSongCard = (event) => {
      const target = event.currentTarget;
      const input = { type: 'Song.ToggleCard', source: 'SongCard', target,
        button: songInputButtons.get(target), current: currentOpenedPreview(), trusted: event.isTrusted };
      return window.VCCommands ? window.VCCommands.dispatch(input) : toggleSongCard(input);
    };

    buttons.forEach((button, index) => {
      const preview = buttonPreview(button);
      if (preview) {
        if (!preview.id) preview.id = `vcard-song-preview-${index}`;
        button.setAttribute('aria-controls', preview.id);
        button.setAttribute('aria-expanded', 'false');
      }
      songInputButtons.set(button, button);
      button.addEventListener('click', requestSongCard, { signal: playerControlsScope.signal });
      button.addEventListener('keydown', (event) => {
        if (button.tagName === 'BUTTON') return;
        if (event.isComposing || event.defaultPrevented || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        if (!event.repeat) requestSongCard(event);
      }, { signal: playerControlsScope.signal });
    });

    let projectedSongButton = null;
    new TViewProjection(playerControlsScope, (snapshot) => {
      const song = snapshot.openedSong;
      const nextButton = song?.opened ? findSongButton(song.listId, song.songId) : null;
      if (nextButton === projectedSongButton) return;
      if (projectedSongButton) {
        projectedSongButton.classList.remove('is-active');
        projectedSongButton.setAttribute('aria-expanded', 'false');
      }
      projectedSongButton = nextButton;
      if (nextButton) {
        nextButton.classList.add('is-active');
        nextButton.setAttribute('aria-expanded', 'true');
      }
    });

    document.querySelectorAll('.song__text-year').forEach((year) => {
      songInputButtons.set(year, previewButton(year.closest('.song__preview')));
      year.addEventListener('click', requestSongCard, { signal: playerControlsScope.signal });
      year.addEventListener('keydown', (event) => {
        if (event.isComposing || event.defaultPrevented || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        if (!event.repeat) requestSongCard(event);
      }, { signal: playerControlsScope.signal });
    });

    const restoreLinkedSong = () => {
      const params = new URLSearchParams(window.location.search);
      const listId = String(params.get('list') || '');
      const songId = String(params.get('song') || '');
      if (!listId || !songId) return false;
      const button = findSongButton(listId, songId);
      if (!button) return false;
      activateList(String(button.dataset.list || ''));
      openSongButton(button, { forceOpen: true, restore: true });
      return true;
    };

    // Apply the explicit song link once the public runtime exists.
    const restoreInitialSong = () => {
      if (!restoreLinkedSong()) {
        prepareManualResume();
        requestCatalogScroll(() => writeViewportScroll(0, 'auto'), () => !currentOpenedPreview());
      }
    };
    const onRuntimeReady = (event) => {
      if (event.detail.state === 'Failed') {
        projectAudioAvailability(window.VCPlayer?.current?.() || {});
        return;
      }
      if (event.detail.state !== 'Interactive') return;
      document.removeEventListener('vcard:bootstrap-state', onRuntimeReady);
      restoreInitialSong();
    };
    if (window.VCardBootstrap.state === 'Interactive') {
      onRuntimeReady({ detail: { state: 'Interactive' } });
    } else document.addEventListener('vcard:bootstrap-state', onRuntimeReady, {
      signal: playerControlsScope.signal
    });

    (() => {
      const triggers = Array.from(document.querySelectorAll(
        '[settings-link]'
      ));
      if (!triggers.length) return;

      const dialog = document.createElement('div');
      dialog.className = 'vcard-settings-dialog';
      let dialogOpen = false;
      dialog.hidden = true;
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.id = 'vcard-settings-dialog';
      const backgroundInert = new Map();
      triggers.forEach((trigger) => trigger.setAttribute('aria-controls', dialog.id));

      const panel = document.createElement('div');
      panel.className = 'vcard-settings-dialog__panel';
      const header = document.createElement('header');
      header.className = 'vcard-settings-dialog__header';
      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'vcard-settings-dialog__command is-primary';
      closeButton.textContent = playerText.close;
      const settingsTitle = document.createElement('div');
      settingsTitle.className = 'vcard-settings-dialog__settings-title';
      const formatVcardDatetime = (value, pattern) => {
        const pad = (number) => String(number).padStart(2, '0');
        const source = String(pattern || '');
        const upperSource = source.toUpperCase();
        const monthsRu = [
          'ЯНВ', 'ФЕВ', 'МАР', 'АПР', 'МАЙ', 'ИЮН',
          'ИЮЛ', 'АВГ', 'СЕН', 'ОКТ', 'НОЯ', 'ДЕК'
        ];
        return source.replace(/YYYY|MMM|YY|DD|HH|MM|SS/gi, (token, offset) => {
          const key = token.toUpperCase();
          if (key === 'YYYY') return String(value.getFullYear());
          if (key === 'YY') return pad(value.getFullYear() % 100);
          if (key === 'MMM') return monthsRu[value.getMonth()];
          if (key === 'DD') return pad(value.getDate());
          if (key === 'HH') return pad(value.getHours());
          if (key === 'SS') return pad(value.getSeconds());
          const prefix = upperSource.slice(0, offset);
          const lastHour = prefix.lastIndexOf('HH');
          const lastDate = Math.max(
            prefix.lastIndexOf('DD'),
            prefix.lastIndexOf('YY')
          );
          return pad(lastHour > lastDate ? value.getMinutes() : value.getMonth() + 1);
        });
      };
      const expandVcardDatetime = (html) => {
        const configured = new Date(String(window.VCardBuild?.BuildID || vcardUiConfig.vcardDatetime || ''));
        const modified = new Date(document.lastModified);
        const value = Number.isNaN(configured.getTime()) ? modified : configured;
        if (Number.isNaN(value.getTime())) return html;
        return html.replace(
          /%VCARDDT\(\s*["'“„«](.*?)["'”„“»]\s*\)%/gi,
          (macro, pattern) => formatVcardDatetime(value, pattern)
        );
      };
      const settingsTitleTemplate = expandVcardDatetime(String(
        vcardUiConfig.settingsTitleHtml || vcardUiConfig.settingsTitle || ''
      ))
        .trim()
        .replace(/(<(?:div|p|section)\b[^>]*>)[ \t]*\r?\n/gi, '$1')
        .replace(/\r?\n[ \t]*(<\/(?:div|p|section)>)/gi, '$1')
        .replace(/(<br\s*\/?>)[ \t]*\r?\n/gi, '$1');
      const withUnknownSettingsTrackValues = (html) => String(html || '')
        .replace(/%(?:AUTHOR|TIT|SOUND|NOHASH_SOUND|MP3INFO)%/g, '?');
      settingsTitle.innerHTML = withUnknownSettingsTrackValues(settingsTitleTemplate);
      settingsTitle.hidden = !settingsTitle.textContent.trim();
      dialog.setAttribute(
        'aria-label',
        settingsTitle.textContent.trim() || 'Settings'
      );
      header.append(closeButton, settingsTitle);
      const content = document.createElement('div');
      content.className = 'vcard-settings-dialog__content';
      const settingsHtmlTemplate = String(
        vcardUiConfig.settingsHtml || vcardUiConfig.helpHtml || ''
      );
      content.innerHTML = settingsHtmlTemplate;
      const normalizeSettingsControls = () => {
        content.querySelectorAll('a:is([sd-opt], [dd-preset], [dd-action]):not([sd-opt="save-mp3"]):not([data-dialog-download])')
          .forEach((link) => {
            const button = document.createElement('button');
            for (const attribute of link.attributes) {
              if (attribute.name !== 'href') button.setAttribute(attribute.name, attribute.value);
            }
            button.type = 'button';
            button.append(...link.childNodes);
            link.replaceWith(button);
          });
        content.querySelectorAll('.vcard-settings-values').forEach((group) => {
          group.setAttribute('role', 'group');
          let heading = group.previousSibling;
          while (heading && !heading.textContent.trim()) heading = heading.previousSibling;
          const label = heading?.textContent.trim().split(/\n/).map((line) => line.trim()).filter(Boolean).pop();
          if (label) group.setAttribute('aria-label', label);
        });
      };
      normalizeSettingsControls();
      const formatMediaBytes = (value) => {
        const bytes = Math.max(0, Number(value) || 0);
        if (bytes < 1024) return `${bytes} B`;
        const units = ['КБ', 'МБ', 'ГБ'];
        let amount = bytes / 1024;
        let unit = 0;
        while (amount >= 1024 && unit < units.length - 1) {
          amount /= 1024;
          unit += 1;
        }
        return `${amount.toFixed(amount >= 100 ? 0 : 1)} ${units[unit]}`;
      };
      let cacheSummaryRevision = 0;
      const updateMediaCacheSummary = async () => {
        const requestRevision = ++cacheSummaryRevision;
        const windowRevision = dialogRevision;
        const summary = content.querySelector('[data-media-cache-summary]');
        const isCurrent = () => !playerControlsScope.signal.aborted && requestRevision === cacheSummaryRevision
          && windowRevision === dialogRevision && dialogOpen
          && (!summary || content.contains(summary));
        const replaceMediaMacros = (values) => {
          const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
          const nodes = [];
          while (walker.nextNode()) nodes.push(walker.currentNode);
          nodes.forEach((node) => {
            let value = node.nodeValue;
            Object.entries(values).forEach(([macro, replacement]) => {
              value = value.replaceAll(macro, String(replacement));
            });
            node.nodeValue = value;
          });
        };
        const setSessionStat = (name, value) => {
          const item = content.querySelector(`[data-media-stat="${name}"]`);
          if (item) item.textContent = String(value);
        };
        const setManifestStat = (name, value) => {
          const item = content.querySelector(`[data-media-cache-total-${name}]`);
          if (item) item.textContent = String(value);
        };
        if (summary) summary.textContent = 'считаем…';
        const manifest = vcardMediaCache.manifestStats();
        setManifestStat('files', manifest.files);
        setManifestStat('size', formatMediaBytes(manifest.bytes));
        content.querySelectorAll('[data-media-stat]').forEach((item) => {
          if (/%FILES_(?:REQ|CACHED|DL)%/.test(item.textContent)) item.textContent = '…';
        });
        try {
          const stats = await vcardMediaCache.getStats();
          if (!isCurrent()) return;
          if (summary) {
            summary.textContent = `${stats.cache.files} файлов = ${formatMediaBytes(stats.cache.bytes)}`;
          }
          replaceMediaMacros({
            '%FILES_REQ%': stats.session.files,
            '%FILES_CACHED%': stats.session.cached,
            '%FILES_DL%': stats.session.downloaded,
          });
          setSessionStat('files-req', stats.session.files);
          setSessionStat('files-cached', stats.session.cached);
          setSessionStat('files-dl', stats.session.downloaded);
        } catch (_error) {
          if (!isCurrent()) return;
          if (summary) summary.textContent = 'данные недоступны';
          replaceMediaMacros({
            '%FILES_REQ%': '?',
            '%FILES_CACHED%': '?',
            '%FILES_DL%': '?',
          });
          setSessionStat('files-req', '?');
          setSessionStat('files-cached', '?');
          setSessionStat('files-dl', '?');
        }
      };
      panel.append(header, content);
      dialog.append(panel);
      document.body.append(dialog);

      let activeTrigger = null;
      let state = null;
      let dialogRevision = 0;
      let copyPending = false;
      const downloadKey = (preview = currentSettingsPreview()) => {
        const source = preview ? resolveSource(preview) : '';
        return isPlayableSource(source) ? new URL(source, document.baseURI).href : '';
      };
      const currentSettingsOperations = () => {
        const source = downloadKey();
        const preload = cacheOperations.get('preload');
        return Object.freeze({ open: dialogOpen, revision: dialogRevision,
          copyPending, resetPending, resetError, download: Object.freeze({
          source, submitted: Boolean(source) && submittedDownloads.has(source),
        }), cache: Object.freeze({
          supported: 'caches' in window,
          clearing: cacheOperations.has('clear'),
          preload: preload ? Object.freeze({
            completed: preload.progress?.completed || 0, total: preload.progress?.total || 0,
          }) : null,
        }) });
      };
      let resetPending = false;
      let resetError = '';
      const resetMarkup = content.querySelector('[sd-opt="full-reset"]')?.innerHTML;
      const submittedDownloads = new Set();
      const cacheOperations = new Map();
      const cacheActionMarkup = new Map([...content.querySelectorAll('[sd-opt="mediaCache"][sd-val]')]
        .map((control) => [control.getAttribute('sd-val'), control.innerHTML]));

      let settingsLayoutFrame = 0;
      let settingsLayoutDirty = false;
      let settingsFocusPending = false;
      let settingsTitleProbe = null;
      const cancelSettingsLayout = () => {
        const frame = settingsLayoutFrame;
        settingsLayoutFrame = 0;
        settingsLayoutDirty = false;
        settingsFocusPending = false;
        settingsTitleProbe?.remove();
        settingsTitleProbe = null;
        vcardRenderScheduler.cancel(frame);
      };
      const scheduleSettingsLayout = ({ focus = false } = {}) => {
        if (playerControlsScope.signal.aborted || !dialogOpen) return;
        settingsFocusPending ||= focus;
        if (settingsLayoutFrame) { settingsLayoutDirty = true; return; }
        const revision = dialogRevision;
        const current = () => dialogOpen && dialog.isConnected && revision === dialogRevision;
        const request = (phase, callback) => {
          settingsLayoutFrame = vcardRenderScheduler.request(() => {
            try { callback(); }
            catch (error) { cancelSettingsLayout(); throw error; }
          }, {
            owner: dialog, scope: playerControlsScope, phase, priority: 0,
            isCurrent: current, onCancel: cancelSettingsLayout,
          });
        };
        const finish = (fontSize = null) => {
          request('write', () => {
            if (fontSize !== null) settingsTitle.style.fontSize = `${fontSize}px`;
            else settingsTitle.style.removeProperty('font-size');
            settingsTitleProbe?.remove();
            settingsTitleProbe = null;
            settingsLayoutFrame = 0;
            if (settingsFocusPending) {
              settingsFocusPending = false;
              if (!dialog.contains(document.activeElement)) closeButton.focus({ preventScroll: true });
            }
            if (settingsLayoutDirty) {
              settingsLayoutDirty = false;
              scheduleSettingsLayout();
            }
          });
        };
        const fitTitle = () => {
          // Only the invisible probe changes during the half-pixel search.
          // Each candidate is written before a separate layout measurement.
          request('measure', () => {
            if (settingsTitle.hidden) { finish(); return; }
            const initialSize = Number.parseFloat(getComputedStyle(settingsTitleProbe).fontSize);
            const width = settingsTitle.getBoundingClientRect().width;
            if (!Number.isFinite(initialSize) || initialSize <= 10 || width <= 0) { finish(); return; }
            let low = 0;
            let high = Math.ceil((initialSize - 10) / 0.5);
            const sizeAt = (index) => Math.max(10, initialSize - index * 0.5);
            const check = (index) => {
              request('write', () => {
                settingsTitleProbe.style.width = `${width}px`;
                settingsTitleProbe.style.fontSize = `${sizeAt(index)}px`;
                request('measure', () => {
                  const overflow = settingsTitleProbe.scrollHeight > settingsTitleProbe.clientHeight + 1;
                  if (index === 0 && !overflow) { finish(); return; }
                  if (overflow) low = index + 1;
                  else high = index;
                  if (low >= high) { finish(sizeAt(high)); return; }
                  check(Math.floor((low + high) / 2));
                });
              });
            };
            check(0);
          });
        };
        request('measure', () => {
          const rect = playerDock.getBoundingClientRect();
          const top = Math.max(0, Math.min(window.innerHeight, rect.bottom));
          const width = Math.round(rect.width);
          const titleWidth = settingsTitle.getBoundingClientRect().width;
          request('write', () => {
            const topValue = `${top}px`;
            const widthValue = `${width}px`;
            if (dialog.style.getPropertyValue('--vcard-settings-top') !== topValue) {
              dialog.style.setProperty('--vcard-settings-top', topValue);
            }
            if (width > 0 && dialog.style.getPropertyValue('--vcard-settings-width') !== widthValue) {
              dialog.style.setProperty('--vcard-settings-width', widthValue);
            }
            settingsTitleProbe = settingsTitle.cloneNode(true);
            settingsTitleProbe.removeAttribute('id');
            settingsTitleProbe.setAttribute('aria-hidden', 'true');
            settingsTitleProbe.style.removeProperty('font-size');
            Object.assign(settingsTitleProbe.style, {
              position: 'absolute', visibility: 'hidden', pointerEvents: 'none',
              width: `${titleWidth}px`, top: '0', left: '0',
            });
            settingsTitle.after(settingsTitleProbe);
            fitTitle();
          });
        });
      };
      window.addEventListener('resize', scheduleSettingsLayout, { signal: playerControlsScope.signal });
      const settingsLayoutObserver = new ResizeObserver(scheduleSettingsLayout);
      settingsLayoutObserver.observe(playerDock);
      playerControlsScope.signal.addEventListener('abort', () => {
        settingsLayoutObserver.disconnect();
        cancelSettingsLayout();
      }, { once: true });

      const normalizeBackground = (value) => {
        const migrated = ({
          off: 'wallpaper',
          light: 'wallpaper',
          h: 'graph1',
          horizontal: 'graph1',
          v: 'graph2',
          vertical: 'graph2'
        })[value] || value;
        return ['wallpaper', 'graph1', 'graph2', 'smoke'].includes(migrated)
          ? migrated
          : 'smoke';
      };
      const normalizePortalView = (value) => {
        const migrated = ({ auto: 'duo', color: 'duo' })[value] || value;
        return ['auto', 'night', 'newspaper', 'mono', 'mono-inverse', 'duo', 'gray'].includes(migrated)
          ? migrated
          : 'auto';
      };
      const normalizeScale = (value) => ({
        '75%': 's',
        '100%': 'm',
        '125%': 'l',
        xs: 'xs',
        s: 's',
        m: 'm',
        l: 'l',
        xl: 'xl',
      })[String(value || '').toLowerCase()] || 'm';
      const normalizeVolumeBoost = (value) => (
        ['1', '1.5', '2', '3'].includes(String(value)) ? String(value) : '1'
      );

      const readState = () => {
        const brightnessDefault = Number.parseInt(
          vcardCssDefault('visualization-brightness', '3'),
          10
        );
        const storedBrightness = Number.parseInt(
          vcardStorage.local.getItem('vcard-visualization-brightness'),
          10
        );
        const brightness = Number.isInteger(storedBrightness)
          ? Math.max(0, Math.min(5, storedBrightness))
          : Math.max(0, Math.min(5, brightnessDefault));
        const portalLayout = window.VCPlayer?.current?.()?.portalLayout
          || window.VCardPortalLayout.current(currentSettingsPreview());
        const portalSize = portalLayout.visible ? portalLayout.size : 'off';
        const colorSettings = window.VCardDecoration?.current?.();
        return {
          operations: currentSettingsOperations(),
          autopilot: (window.VCPlayer?.current?.()?.selectionMode
            || (vcardAutopilotEnabled() ? 'AUTO' : 'MAN')) === 'AUTO' ? 'on' : 'off',
          background: normalizeBackground(
            window.VCardBackgroundControl?.current()
            || vcardStorage.local.getItem('vcard-background-mode')
            || vcardStorage.local.getItem('vcard-visualization')
            || 'smoke'
          ),
          brightness: window.VCardBrightness?.current() || String(brightness),
          ...window.VCardManualSelection.current(),
          trackPlay: window.VCardTrackPlay.current(),
          accent: colorSettings?.accent || (vcardSettingEnabled('vcard-accent', 'accent') ? 'on' : 'off'),
          colorScheme: (window.VCardColorScheme?.current()
            || vcardStoredSetting('vcard-color-scheme', 'color-scheme', 'black')) === 'white'
            ? 'white'
            : 'black',
          monoColor: colorSettings?.monoColor || (vcardSettingEnabled('vcard-mono-color', 'mono-color', 'off') ? 'on' : 'off'),
          randomColor: colorSettings?.randomColor || (vcardSettingEnabled(
            'vcard-random-color',
            'random-color',
            'on'
          ) ? 'on' : 'off'),
          portalSize,
          volumeBoost: vcardFileMode
            ? '1'
            : normalizeVolumeBoost(window.VCardVolumeBoost?.current() || vcardStorage.local.getItem('vcard-volume-boost')),
          fontScale: window.VCardTextScale?.current() || normalizeScale(vcardStoredSetting('vcard-song-scale', 'font-size', '100%')),
          preset: colorSettings ? colorSettings.preset : vcardPlaylistStyleLocked()
            ? ''
            : (vcardStorage.local.getItem('vcard-preset') || ''),
        };
      };

      window.VCardWheelSettings = Object.freeze({
        current: () => Object.freeze({ ...readState() }),
      });

      const settingValues = Object.freeze({
        autopilot: ['on', 'off'],
        background: ['wallpaper', 'graph1', 'graph2', 'smoke'],
        brightness: ['0', '1', '2', '3', '4', '5'],
        trackPlay: ['on', 'off'],
        playlistAlternation: ['none', 'previous', 'next', 'repeat', 'random'],
        songAlternation: ['none', 'sequential', 'repeat', 'random'],
        randomColor: ['on', 'off'],
        portalSize: ['off', 'small', 'mid', 'full'],
        volumeBoost: ['1', '1.5', '2', '3'],
        accent: ['on', 'off'],
        colorScheme: ['black', 'white'],
        monoColor: ['on', 'off'],
        fontScale: ['xs', 's', 'm', 'l', 'xl'],
      });
      const settingBlocked = (key, value, manualOnly = false) => (
        !Object.hasOwn(settingValues, key) || !settingValues[key].includes(value)
        || (manualOnly && state?.autopilot !== 'off')
        || (key === 'monoColor' && state?.colorScheme === 'white' && value === 'off')
        || (vcardPlaylistStyleLocked() && ['accent', 'colorScheme', 'monoColor', 'randomColor'].includes(key))
        || (key === 'randomColor' && !['mono', 'duo'].includes(state?.preset))
        || (!vcardVisualizationAvailable() && key === 'background' && ['graph1', 'graph2'].includes(value))
        || (vcardFileMode && key === 'volumeBoost' && value !== '1')
      );
      const settingCommandAvailable = ({ target, key, value, revision } = {}) => Boolean(
        !playerControlsScope.signal.aborted && state && dialogOpen && revision === dialogRevision
        && target?.isConnected && content.contains(target)
        && target.getAttribute('sd-opt') === key && target.getAttribute('sd-val') === value
        && !settingBlocked(key, value, Boolean(target.closest('[data-settings-autopilot-options]')))
      );
      const settingsPresetAvailable = ({ target, preset, revision } = {}) => Boolean(
        !playerControlsScope.signal.aborted && state && dialogOpen && revision === dialogRevision && state.autopilot === 'off'
        && target?.isConnected && content.contains(target)
        && target.getAttribute('dd-preset') === preset
        && window.VCardDecoration?.presetAvailable(preset)
      );
      const cacheActionReady = (action) => ['preload', 'clear'].includes(action)
        && 'caches' in window && !cacheOperations.has(action)
        && (action !== 'preload' || !cacheOperations.has('clear'));
      const cacheActionAvailable = ({ target, action, revision } = {}) => Boolean(
        !playerControlsScope.signal.aborted && state && dialogOpen && revision === dialogRevision
        && target?.isConnected && content.contains(target)
        && target.getAttribute('sd-opt') === 'mediaCache' && target.getAttribute('sd-val') === action
        && cacheActionReady(action)
      );
      const runCacheAction = (input) => {
        if (!cacheActionAvailable(input)) return false;
        const { action } = input;
        const operation = { progress: null };
        cacheOperations.set(action, operation);
        const renderProgress = (event) => {
          const progress = { completed: Number(event.detail?.completed) || 0,
            total: Number(event.detail?.total) || 0 };
          postSettingsOperation('Settings.Cache.Progress', () => {
            if (cacheOperations.get(action) !== operation) return false;
            operation.progress = progress;
          });
        };
        if (action === 'preload') document.addEventListener('vcard:media-cache-progress', renderProgress,
          { signal: playerControlsScope.signal });
        publishSettingsOperations();
        // The cache owns network work; closing settings only hides its projection.
        const task = action === 'preload' ? vcardMediaCache.preloadAll() : vcardMediaCache.clear();
        task.catch((error) => postSettingsOperation(`Settings.Cache.${action}.Failed`, () => {
          const life = window.VCLife;
          if (life) life.reportFault(error, { type: `Settings.Cache.${action}.Failed`, owner: life });
          else console.warn(`VCard media cache: ${action} failed`, error);
          return false;
        }))
          .finally(() => {
            document.removeEventListener('vcard:media-cache-progress', renderProgress);
            return postSettingsOperation('Settings.Cache.Complete', () => {
              if (cacheOperations.get(action) !== operation) return false;
              cacheOperations.delete(action);
              if (state && dialogOpen) updateMediaCacheSummary();
            });
          });
        return true;
      };
      const renderCacheControl = (link) => {
        const action = link.getAttribute('sd-val');
        const cache = state?.operations.cache || currentSettingsOperations().cache;
        const operation = action === 'preload' ? cache.preload : cache.clearing;
        const progress = action === 'preload' ? cache.preload : null;
        if (operation) {
          const label = action === 'preload'
            ? `ПРОГРУЖАЕМ ${progress?.completed || 0}/${progress?.total || 0}` : 'ОЧИЩАЕМ…';
          if (link.textContent !== label) link.textContent = label;
        } else {
          const markup = cacheActionMarkup.get(action);
          if (markup !== undefined && link.innerHTML !== markup) link.innerHTML = markup;
        }
        const disabled = !cache.supported || Boolean(operation) || (action === 'preload' && cache.clearing);
        link.classList.remove('is-selected');
        link.classList.toggle('is-loading', Boolean(operation));
        link.classList.toggle('is-disabled', disabled);
        link.removeAttribute('aria-current');
        link.setAttribute('aria-disabled', disabled ? 'true' : 'false');
        link.disabled = disabled;
      };

      const renderState = () => {
        const manualSettingsEnabled = Boolean(state) && state.autopilot === 'off';
        dialog.querySelectorAll('[data-settings-autopilot-options]').forEach((block) => {
          block.classList.toggle('is-disabled', !manualSettingsEnabled);
          block.setAttribute('aria-disabled', manualSettingsEnabled ? 'false' : 'true');
        });
        dialog.querySelectorAll('[sd-opt]').forEach((link) => {
          const key = link.getAttribute('sd-opt');
          if (key === 'get-link' || key === 'save-mp3') {
            const preview = currentSettingsPreview();
            const available = key === 'get-link'
              ? Boolean(songAddress(preview)) && !state.operations.copyPending
              : Boolean(state.operations.download.source) && !state.operations.download.submitted;
            if (key === 'save-mp3' && state.operations.download.submitted) {
              if (link.textContent !== 'Отправлен в загрузки') link.textContent = 'Отправлен в загрузки';
              if (link.getAttribute('aria-live') !== 'polite') link.setAttribute('aria-live', 'polite');
            }
            link.classList.remove('is-selected');
            link.classList.toggle('is-disabled', !available);
            link.removeAttribute('aria-current');
            link.setAttribute('aria-disabled', available ? 'false' : 'true');
            return;
          }
          if (key === 'mediaCache') {
            renderCacheControl(link);
            return;
          }
          if (key === 'full-reset') {
            const pending = state.operations.resetPending;
            link.classList.remove('is-selected');
            link.classList.toggle('is-loading', pending);
            link.classList.toggle('is-disabled', pending);
            link.removeAttribute('aria-current');
            link.setAttribute('aria-disabled', pending ? 'true' : 'false');
            if (state.operations.resetError) link.setAttribute('title', state.operations.resetError);
            else link.removeAttribute('title');
            if (pending) {
              if (link.textContent !== 'СБРАСЫВАЕМ…') link.textContent = 'СБРАСЫВАЕМ…';
            }
            else if (state.operations.resetError) link.textContent = 'СБРОС НЕ ЗАВЕРШЁН — ПОВТОРИТЬ';
            else if (resetMarkup !== undefined && link.innerHTML !== resetMarkup) link.innerHTML = resetMarkup;
            return;
          }
          const monoForced = key === 'monoColor' && state && state.colorScheme === 'white';
          const currentValue = monoForced ? 'on' : state && state[key];
          const backgroundGroup = key === 'background' || link.hasAttribute('data-background-off');
          const selected = backgroundGroup
            ? (link.hasAttribute('data-background-off')
              ? state?.brightness === '0'
              : state?.brightness !== '0' && currentValue === link.getAttribute('sd-val'))
            : currentValue === link.getAttribute('sd-val');
          const disabled = settingBlocked(key, link.getAttribute('sd-val'),
            Boolean(link.closest('[data-settings-autopilot-options]')));
          link.classList.toggle('is-selected', selected);
          link.classList.toggle('is-disabled', disabled);
          link.setAttribute('aria-current', selected ? 'true' : 'false');
          link.setAttribute('aria-disabled', disabled ? 'true' : 'false');
        });
        dialog.querySelectorAll('[dd-preset]').forEach((link) => {
          const selected = Boolean(state) && state.preset === link.getAttribute('dd-preset');
          const disabled = !window.VCardDecoration?.presetAvailable(link.getAttribute('dd-preset'))
            || !manualSettingsEnabled;
          link.classList.toggle('is-selected', selected);
          link.classList.toggle('is-disabled', disabled);
          link.setAttribute('aria-current', selected ? 'true' : 'false');
          link.setAttribute('aria-disabled', disabled ? 'true' : 'false');
        });
        dialog.querySelectorAll('[sd-opt], [dd-preset], [dd-action]').forEach((control) => {
          const disabled = control.getAttribute('aria-disabled') === 'true';
          control.tabIndex = disabled ? -1 : 0;
          if (control.tagName === 'BUTTON') {
            control.disabled = disabled;
            control.removeAttribute('aria-current');
            if (control.hasAttribute('sd-val') || control.hasAttribute('dd-preset')) {
              control.setAttribute('aria-pressed', String(control.classList.contains('is-selected')));
            }
          }
        });
      };

      const currentSettingsPreview = () => {
        return currentOpenedPreview() || null;
      };

      const songAddress = (preview = currentSettingsPreview()) => {
        const button = previewButton(preview);
        const listId = String((button && button.dataset.list) || '');
        const songId = String((button && button.dataset.song) || '');
        if (!listId || !songId) return '';
        const url = new URL(window.location.href);
        url.searchParams.set('list', listId);
        url.searchParams.set('song', songId);
        url.hash = '';
        return url.href;
      };

      const copyText = async (value, isCurrent) => {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          try {
            await navigator.clipboard.writeText(value);
            return true;
          } catch (_error) {}
        }
        if (!isCurrent()) return false;
        const previousFocus = document.activeElement;
        const field = document.createElement('textarea');
        field.value = value;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.append(field);
        field.select();
        let copied = false;
        try {
          copied = document.execCommand('copy');
        } catch (_error) {}
        field.remove();
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
        return copied;
      };

      const copyContextCurrent = ({ target, revision } = {}) => Boolean(
        !playerControlsScope.signal.aborted && state && dialogOpen && revision === dialogRevision
        && target?.isConnected && content.contains(target)
        && target.getAttribute('sd-opt') === 'get-link'
      );
      const copyLinkAvailable = (input) => Boolean(!playerControlsScope.signal.aborted && !copyPending && copyContextCurrent(input)
        && songAddress(currentSettingsPreview()));
      const publishSettingsOperations = () => {
        if (playerControlsScope.signal.aborted) return;
        if (window.VCLife) window.VCLife.publish();
        else if (state && dialogOpen) {
          state.operations = currentSettingsOperations();
          renderState();
        }
      };
      const postSettingsOperation = (type, apply) => {
        const commit = () => {
          if (playerControlsScope.signal.aborted || apply() === false) return;
          publishSettingsOperations();
        };
        const life = window.VCLife;
        return life ? life.queue.post(commit, { type, owner: life, scope: playerControlsScope }) : commit();
      };
      const copySongLink = (input) => {
        if (!copyLinkAvailable(input)) return false;
        const address = songAddress(currentSettingsPreview());
        const restoreFocus = document.activeElement === input.target;
        copyPending = true;
        publishSettingsOperations();
        // Start inside the user gesture; the queue does not await clipboard I/O.
        copyText(address, () => copyContextCurrent(input))
          .then((copied) => {
            if (!copyContextCurrent(input)) return;
            window.alert(copied ? 'Ссылка скопирована' : `Не удалось скопировать: ${address}`);
          })
          .catch((error) => console.warn('VCard: cannot copy song link', error))
          .finally(() => {
            const complete = () => {
              if (playerControlsScope.signal.aborted) return;
              copyPending = false;
              queueMicrotask(() => {
                if (!playerControlsScope.signal.aborted && restoreFocus && copyContextCurrent(input)
                  && document.activeElement === document.body) input.target.focus({ preventScroll: true });
              });
            };
            return postSettingsOperation('Settings.Copy.Complete', complete);
          });
        return true;
      };

      const downloadAvailable = ({ target, revision } = {}) => Boolean(
        !playerControlsScope.signal.aborted && state && dialogOpen && revision === dialogRevision
        && target?.isConnected && content.contains(target)
        && target.getAttribute('sd-opt') === 'save-mp3' && !submittedDownloads.has(downloadKey())
        && isPlayableSource(resolveSource(currentSettingsPreview()))
      );
      const downloadSong = (input) => {
        if (!downloadAvailable(input)) return false;
        const preview = currentSettingsPreview();
        const download = document.createElement('a');
        const source = downloadKey(preview);
        download.href = source;
        download.download = preview.dataset.downloadName || '';
        download.hidden = true;
        submittedDownloads.add(source);
        document.body.append(download);
        try {
          // Hand off to the browser inside the gesture; completion is browser-owned.
          download.click();
        } catch (error) {
          submittedDownloads.delete(source);
          publishSettingsOperations();
          throw error;
        } finally {
          download.remove();
        }
        publishSettingsOperations();
        return true;
      };

      const updateDownloadLinks = () => {
        const operations = state?.operations || currentSettingsOperations();
        const preview = currentSettingsPreview();
        const source = preview ? resolveSource(preview) : '';
        content.querySelectorAll('[data-dialog-download], [sd-opt="save-mp3"]').forEach((link) => {
          const available = isPlayableSource(source) && !operations.download.submitted;
          if (!available) {
            link.removeAttribute('href');
            link.removeAttribute('download');
            return;
          }
          link.href = new URL(source, document.baseURI).href;
          link.download = preview.dataset.downloadName || '';
        });
      };

      let projectedSettingsTrack = '';
      const updateSettingsTrackInfo = (preview) => {
        const button = previewButton(preview);
        const entry = entriesByButton.get(button);
        const author = entry?.author || '';
        const songTitle = entry?.title || '';
        const fileName = String((preview && preview.dataset.downloadName) || '').trim();
        const fullInfo = String((preview && preview.dataset.downloadTitle) || '').trim();
        const fileInfo = fileName && fullInfo.startsWith(fileName)
          ? fullInfo.slice(fileName.length).trim()
          : fullInfo;
        const displayFileName = fileName || '—';
        const displayFileInfo = fileInfo || '—';
        const displayAuthor = author || '—';
        const displaySongTitle = songTitle || '—';
        const hasPlayableMp3 = isPlayableSource(
          preview ? resolveSource(preview) : ''
        );
        const track = JSON.stringify([preview?.id || '', author, songTitle, fileName, fullInfo,
          preview ? resolveSource(preview) : '', hasPlayableMp3]);
        if (track === projectedSettingsTrack) return false;
        projectedSettingsTrack = track;
        const focusSelector = 'button, a, input, select, textarea, summary';
        const focusedControl = [...content.querySelectorAll(focusSelector)].indexOf(document.activeElement);
        const escapeHtml = (value) => String(value || '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
        content.innerHTML = settingsHtmlTemplate
          .replaceAll('%AUTHOR%', escapeHtml(displayAuthor))
          .replaceAll('%TIT%', escapeHtml(displaySongTitle))
          .replaceAll('%SOUND%', escapeHtml(displayFileName))
          .replaceAll('%NOHASH_SOUND%', escapeHtml(displayFileName))
          .replaceAll('%MP3INFO%', escapeHtml(displayFileInfo));
        normalizeSettingsControls();
        content.querySelectorAll('.mp3-block').forEach((block) => {
          block.hidden = !hasPlayableMp3;
        });
        updateDownloadLinks();
        settingsTitle.innerHTML = settingsTitleTemplate
          .replaceAll('%AUTHOR%', escapeHtml(displayAuthor))
          .replaceAll('%TIT%', escapeHtml(displaySongTitle))
          .replaceAll('%SOUND%', escapeHtml(displayFileName))
          .replaceAll('%NOHASH_SOUND%', escapeHtml(displayFileName))
          .replaceAll('%MP3INFO%', escapeHtml(displayFileInfo));
        dialog.querySelectorAll('[data-settings-mp3-name]').forEach((item) => {
          item.textContent = fileName;
          item.hidden = !fileName;
        });
        dialog.querySelectorAll('[data-settings-mp3-info]').forEach((item) => {
          item.textContent = fileInfo;
          item.hidden = !fileInfo;
        });
        settingsTitle.hidden = !settingsTitle.textContent.trim();
        dialog.setAttribute(
          'aria-label',
          settingsTitle.textContent.trim() || 'Settings'
        );
        scheduleSettingsLayout();
        if (state) renderState();
        if (dialogOpen && focusedControl >= 0) {
          const restored = [...content.querySelectorAll(focusSelector)][focusedControl];
          const available = restored && !restored.disabled
            && restored.getAttribute('aria-disabled') !== 'true' && restored.getClientRects().length;
          (available ? restored : closeButton).focus({ preventScroll: true });
        }
        return true;
      };

      const closeDialog = () => {
        dialogRevision += 1;
        cancelSettingsLayout();
        const trigger = activeTrigger;
        activeTrigger = null;
        state = null;
        dialogOpen = false;
        dialog.hidden = true;
        backgroundInert.forEach((inert, element) => { element.inert = inert; });
        backgroundInert.clear();
        document.documentElement.classList.remove('vcard-settings-dialog-open');
        triggers.forEach((item) => item.setAttribute('aria-expanded', 'false'));
        if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      };

      const openDialog = (trigger) => {
        if (playerControlsScope.signal.aborted) return false;
        if (dialogOpen) {
          closeDialog();
          return true;
        }
        dialogRevision += 1;
        activeTrigger = trigger;
        state = readState();
        updateSettingsTrackInfo(currentSettingsPreview());
        renderState();
        updateDownloadLinks();
        updateMediaCacheSummary();
        dialogOpen = true;
        dialog.hidden = false;
        for (const element of document.body.children) {
          if (element === dialog || element.contains(dialog)) continue;
          backgroundInert.set(element, element.inert);
          element.inert = true;
        }
        document.documentElement.classList.add('vcard-settings-dialog-open');
        trigger.setAttribute('aria-expanded', 'true');
        scheduleSettingsLayout({ focus: true });
        return true;
      };

      const applySetting = (key, value) => {
        if (!state) return;
        const changesColorPreset = key === 'colorScheme' || key === 'monoColor';
        if (changesColorPreset) {
          if (window.VCardDecoration) window.VCardDecoration.clearPreset();
          else if (!vcardAutopilotEnabled()) vcardStorage.local.setItem('vcard-preset', 'custom');
        }
        if (key === 'autopilot') {
          vcardSetAutopilotEnabled(value !== 'off');
        } else if (key === 'background') {
          vcardStorage.local.setItem('vcard-background-mode', value);
          document.dispatchEvent(new CustomEvent('vcard:set-background', {
            detail: { mode: value, force: true }
          }));
        } else if (key === 'brightness') {
          document.dispatchEvent(new CustomEvent('vcard:set-visualization-brightness', {
            detail: { level: Number(value) }
          }));
        } else if (key === 'trackPlay') {
          vcardStorage.local.setItem('vcard-trackplay', value);
          document.dispatchEvent(new CustomEvent('vcard:set-trackplay', {
            detail: { enabled: value === 'on' }
          }));
        } else if (key === 'playlistAlternation') {
          playlistAlternation = normalizePlaylistAlternation(value);
          vcardStorage.local.setItem(PLAYLIST_ALTERNATION_STORAGE_KEY, playlistAlternation);
          cancelAutoAdvance();
          publishManualSelection();
        } else if (key === 'songAlternation') {
          songAlternation = normalizeSongAlternation(value);
          vcardStorage.local.setItem(SONG_ALTERNATION_STORAGE_KEY, songAlternation);
          randomSongBags.clear();
          cancelAutoAdvance();
          publishManualSelection();
        } else if (key === 'randomColor') {
          vcardStorage.local.setItem('vcard-random-color', value);
          document.dispatchEvent(new CustomEvent('vcard:random-color-state'));
        } else if (key === 'portalSize') {
          setPlayerPortalSize(value);
        } else if (key === 'volumeBoost') {
          const normalizedBoost = normalizeVolumeBoost(value);
          vcardStorage.local.setItem('vcard-volume-boost', normalizedBoost);
          document.dispatchEvent(new CustomEvent('vcard:set-volume-boost', {
            detail: { value: normalizedBoost }
          }));
        } else if (key === 'accent') {
          if (!vcardAutopilotEnabled()) vcardStorage.local.setItem('vcard-accent', value);
          document.dispatchEvent(new CustomEvent('vcard:set-accent', {
            detail: { enabled: value === 'on' }
          }));
        } else if (key === 'colorScheme') {
          if (!vcardAutopilotEnabled()) vcardStorage.local.setItem('vcard-color-scheme', value);
          document.dispatchEvent(new CustomEvent('vcard:set-color-scheme', {
            detail: { key: value }
          }));
        } else if (key === 'monoColor') {
          if (!vcardAutopilotEnabled()) vcardStorage.local.setItem('vcard-mono-color', value);
          document.dispatchEvent(new CustomEvent('vcard:set-mono-color', {
            detail: { enabled: value === 'on' }
          }));
        } else if (key === 'fontScale') {
          vcardStorage.local.setItem('vcard-song-scale', value);
          document.dispatchEvent(new CustomEvent('vcard:set-font-scale', {
            detail: { key: value }
          }));
        }
        if (!window.VCPlayer) {
          state = readState();
          renderState();
        }
      };

      const deleteIndexedDatabase = (name) => new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.addEventListener('success', resolve, { once: true });
        request.addEventListener('error', () => reject(
          new Error(`IndexedDB ${name}: ${request.error?.message || 'ошибка удаления'}`)
        ), { once: true });
        request.addEventListener('blocked', () => reject(
          new Error(`IndexedDB ${name}: удаление заблокировано открытым соединением`)
        ), { once: true });
      });

      const checkResetResults = (results, area) => {
        const failures = results.filter((result) => result.status === 'rejected' || result.value === false)
          .map((result) => result.status === 'rejected'
            ? String(result.reason?.message || result.reason) : 'удаление не подтверждено');
        if (failures.length) throw new Error(`${area}: ${failures.join('; ')}`);
      };

      const fullReset = async () => {
        document.querySelectorAll('audio, video').forEach((media) => {
          try {
            media.pause();
          } catch (_) {}
        });

        const cleanupTasks = [];
        if ('serviceWorker' in navigator) {
          cleanupTasks.push(
            navigator.serviceWorker.getRegistrations()
              .then((registrations) => Promise.allSettled(
                registrations.map((registration) => registration.unregister())
              )).then((results) => checkResetResults(results, 'Service Worker'))
          );
        }
        if ('caches' in window) {
          cleanupTasks.push(
            caches.keys()
              .then((names) => Promise.allSettled(names.map((name) => caches.delete(name))))
              .then((results) => checkResetResults(results, 'Cache Storage'))
          );
        }
        if ('indexedDB' in window) {
          cleanupTasks.push(
            Promise.resolve().then(() => {
              if (typeof indexedDB.databases !== 'function') {
                throw new Error('IndexedDB: браузер не позволяет получить список баз для полного сброса');
              }
              return indexedDB.databases();
            })
              .then((databases) => Promise.allSettled(
                databases
                  .map((database) => database.name)
                  .filter(Boolean)
                  .map(deleteIndexedDatabase)
              )).then((results) => checkResetResults(results, 'IndexedDB'))
          );
        }
        const results = await Promise.allSettled(cleanupTasks);

        for (const area of ['local', 'session']) {
          try {
            if (!vcardStorage[area].clear()) throw new Error(`${area}Storage: очистка не подтверждена`);
          } catch (error) { results.push({ status: 'rejected', reason: error }); }
        }
        try {
          window.VCardBrowserNavigation?.reset();
        } catch (error) { results.push({ status: 'rejected', reason: error }); }
        checkResetResults(results, 'Сброс не завершён');
      };

      const closeAfterFullReset = () => {
        try {
          window.close();
        } catch (_) {}
        if (!window.closed) window.location.replace('about:blank');
      };

      const resetAvailable = ({ target, revision } = {}) => Boolean(
        !playerControlsScope.signal.aborted && state && dialogOpen && revision === dialogRevision && !resetPending
        && target?.isConnected && content.contains(target)
        && target.getAttribute('sd-opt') === 'full-reset'
      );
      const resetData = (input) => {
        if (!resetAvailable(input)) return false;
        if (!window.confirm('Сейчас будут сброшены все настройки сайта и закрыта страница, ОК?')) return false;
        if (!resetAvailable(input)) return false;
        resetPending = true;
        resetError = '';
        publishSettingsOperations();
        // Cleanup owns its I/O; the command queue stays synchronous.
        fullReset().then(closeAfterFullReset).catch((error) => {
          console.warn('VCard: cannot reset local data', error);
          return postSettingsOperation('Settings.Reset.Failed', () => {
            resetPending = false;
            resetError = String(error?.message || error);
          });
        });
        return true;
      };


      triggers.forEach((trigger) => {
        trigger.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (!window.VCCommands) window.VCardSettingsContext.toggle(trigger);
          else window.VCCommands.dispatch({ type: 'Settings.Toggle', source: 'Player',
            target: trigger, trusted: event.isTrusted });
        }, { capture: true, signal: playerControlsScope.signal });
      });

      content.addEventListener('click', (event) => {
        const preset = event.target.closest('[dd-preset]');
        if (preset) {
          event.preventDefault();
          event.stopPropagation();
          const input = { type: 'Color.Preset', source: 'Settings', target: preset,
            preset: preset.getAttribute('dd-preset'), trusted: event.isTrusted, revision: dialogRevision };
          if (!window.VCCommands) window.VCardDecoration?.applyPreset(input);
          else window.VCCommands.dispatch(input);
          return;
        }
        const link = event.target.closest('[sd-opt]');
        if (!link) return;
        event.preventDefault();
        const action = link.getAttribute('sd-opt');
        if (action === 'get-link') {
          const input = { type: 'Song.CopyLink', source: 'Settings', target: link,
            revision: dialogRevision, trusted: event.isTrusted };
          if (!window.VCCommands) copySongLink(input);
          else window.VCCommands.dispatch(input);
          return;
        }
        if (action === 'save-mp3') {
          const input = { type: 'Song.Download', source: 'Settings', target: link,
            revision: dialogRevision, trusted: event.isTrusted };
          if (!window.VCCommands) downloadSong(input);
          else window.VCCommands.dispatch(input);
          return;
        }
        if (link.getAttribute('sd-opt') === 'full-reset') {
          const input = { type: 'Data.Reset', source: 'Settings', target: link,
            revision: dialogRevision, trusted: event.isTrusted };
          if (!window.VCCommands) resetData(input);
          else window.VCCommands.dispatch(input);
          return;
        }
        if (link.getAttribute('sd-opt') === 'mediaCache') {
          const input = { type: 'MediaCache.Action', source: 'Settings', target: link,
            action: link.getAttribute('sd-val'), revision: dialogRevision, trusted: event.isTrusted };
          if (!window.VCCommands) runCacheAction(input);
          else window.VCCommands.dispatch(input);
          return;
        }
        if (!state || link.getAttribute('aria-disabled') === 'true') return;
        const input = { type: 'Settings.Set', source: 'Settings', trusted: event.isTrusted,
          target: link, key: link.getAttribute('sd-opt'), value: link.getAttribute('sd-val'),
          revision: dialogRevision };
        if (!window.VCCommands) window.VCardSettingsContext.set(input);
        else window.VCCommands.dispatch(input);
      }, { signal: playerControlsScope.signal });
      new TViewProjection(playerControlsScope, (snapshot) => {
        if (!state || !dialogOpen) return;
        let changed = false;
        let cacheChanged = false;
        if (snapshot.settingsOperations) {
          const previous = state.operations.cache;
          const next = snapshot.settingsOperations.cache;
          cacheChanged = previous.supported !== next.supported || previous.clearing !== next.clearing
            || Boolean(previous.preload) !== Boolean(next.preload)
            || previous.preload?.completed !== next.preload?.completed
            || previous.preload?.total !== next.preload?.total;
        }
        if (snapshot.settingsOperations && (
          state.operations.copyPending !== snapshot.settingsOperations.copyPending
          || state.operations.resetPending !== snapshot.settingsOperations.resetPending
          || state.operations.resetError !== snapshot.settingsOperations.resetError
          || state.operations.download.source !== snapshot.settingsOperations.download.source
          || state.operations.download.submitted !== snapshot.settingsOperations.download.submitted
        )) {
          state.operations = snapshot.settingsOperations;
          changed = true;
        }
        if (cacheChanged) state.operations = snapshot.settingsOperations;
        if (snapshot.manualSelection) {
          for (const key of ['songAlternation', 'playlistAlternation']) {
            if (state[key] !== snapshot.manualSelection[key]) {
              state[key] = snapshot.manualSelection[key];
              changed = true;
            }
          }
        }
        if ((snapshot.trackPlay === 'on' || snapshot.trackPlay === 'off')
          && state.trackPlay !== snapshot.trackPlay) {
          state.trackPlay = snapshot.trackPlay;
          changed = true;
        }
        if (snapshot.background) {
          const { mode, brightness } = snapshot.background;
          if (mode && state.background !== mode) {
            state.background = mode;
            changed = true;
          }
          if (brightness !== null && state.brightness !== brightness) {
            state.brightness = brightness;
            changed = true;
          }
        }
        if (snapshot.colorSettings) {
          for (const key of ['preset', 'monoColor', 'accent', 'randomColor']) {
            if (state[key] !== snapshot.colorSettings[key]) {
              state[key] = snapshot.colorSettings[key];
              changed = true;
            }
          }
        }
        if ((snapshot.colorScheme === 'white' || snapshot.colorScheme === 'black')
          && state.colorScheme !== snapshot.colorScheme) {
          state.colorScheme = snapshot.colorScheme;
          changed = true;
        }
        if (snapshot.selectionMode === 'AUTO' || snapshot.selectionMode === 'MAN') {
          const autopilot = snapshot.selectionMode === 'AUTO' ? 'on' : 'off';
          if (state.autopilot !== autopilot) {
            state.autopilot = autopilot;
            changed = true;
          }
        }
        if (snapshot.textScale && state.fontScale !== snapshot.textScale) {
          state.fontScale = snapshot.textScale;
          changed = true;
        }
        if (snapshot.volumeBoost && state.volumeBoost !== snapshot.volumeBoost) {
          state.volumeBoost = snapshot.volumeBoost;
          changed = true;
        }
        const layout = snapshot.portalLayout;
        const entryKey = window.VCardCatalogView?.forPreview(currentSettingsPreview())?.entryKey || '';
        if (layout && layout.entryKey === entryKey) {
          const size = layout.visible ? layout.size : 'off';
          if (state.portalSize !== size) {
            state.portalSize = size;
            changed = true;
          }
        }
        if (changed) renderState();
        else if (cacheChanged) content.querySelectorAll('[sd-opt="mediaCache"]').forEach(renderCacheControl);
      });
      document.addEventListener('vcard:visualization-availability', () => {
        if (state && dialogOpen) renderState();
      }, { signal: playerControlsScope.signal });
      window.VCardSettingsContext = Object.freeze({
        operations: currentSettingsOperations,
        isOpen: () => dialogOpen,
        available: () => !playerControlsScope.signal.aborted && dialogOpen,
        canSet: settingCommandAvailable,
        canPreset: settingsPresetAvailable,
        canCopyLink: copyLinkAvailable,
        copyLink: copySongLink,
        canDownload: downloadAvailable,
        download: downloadSong,
        canReset: resetAvailable,
        reset: resetData,
        canCache: cacheActionAvailable,
        cache: runCacheAction,
        set: (input) => {
          if (!settingCommandAvailable(input)) return false;
          applySetting(input.key, input.value);
          return true;
        },
        canToggle: (trigger) => Boolean(!playerControlsScope.signal.aborted && trigger?.isConnected && triggers.includes(trigger)),
        toggle: (trigger) => {
          if (!trigger?.isConnected || !triggers.includes(trigger)) return false;
          return openDialog(trigger);
        },
        close: () => {
          if (playerControlsScope.signal.aborted || !dialogOpen) return false;
          closeDialog();
          return true;
        },
      });
      const requestSettingsClose = (event) => {
        if (!window.VCCommands) return window.VCardSettingsContext.close();
        return window.VCCommands.dispatch({ type: 'Settings.Close',
          source: event.type === 'keydown' ? 'Keyboard' : 'Settings', trusted: event.isTrusted });
      };
      closeButton.addEventListener('click', requestSettingsClose, { signal: playerControlsScope.signal });
      document.addEventListener('vcard:mp3-info-change', () => {
        if (dialogOpen && updateSettingsTrackInfo(currentSettingsPreview())) updateMediaCacheSummary();
      }, { signal: playerControlsScope.signal });
      document.addEventListener('vcard:media-cache-change', () => {
        if (dialogOpen) updateMediaCacheSummary();
      }, { signal: playerControlsScope.signal });
      vcardKeyboard.register((event) => {
        if (!dialogOpen) return false;
        if (event.key === 'Escape') {
          if (!event.repeat) requestSettingsClose(event);
          return true;
        } else if (event.key === 'Tab') {
          const controls = [...dialog.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]')]
            .filter((element) => !element.disabled && element.tabIndex >= 0
              && element.getAttribute('aria-disabled') !== 'true' && element.getClientRects().length);
          if (!controls.length) return true;
          const current = controls.indexOf(document.activeElement);
          const next = (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
          controls[next].focus();
          return true;
        }
        return false;
      }, 100);
    })();

    document.querySelectorAll('.news-link').forEach((link) => {
      songInputButtons.set(link, findSongButton(link.dataset.list || '', link.dataset.song || ''));
      link.addEventListener('click', (event) => {
        event.preventDefault();
        requestSongCard(event);
      }, { signal: playerControlsScope.signal });
    });
  })();

  (() => {
    const scope = new AbortController();
    const state = { state: location.protocol === 'file:' ? 'disabled-file'
      : ('serviceWorker' in navigator ? 'registering' : 'unsupported'),
      controlled: false, controllerUrl: '', workerState: '', updates: 0, error: '' };
    window.VCardServiceWorker = Object.freeze({ snapshot: () => ({ ...state }) });
    const publish = () => {
      if (scope.signal.aborted) return;
      document.dispatchEvent(new CustomEvent('vcard:service-worker-state', { detail: { ...state } }));
    };
    if (state.state !== 'registering') { publish(); return; }
    let registration = null;
    const watched = new WeakSet();
    const sync = (worker = registration?.active) => {
      if (scope.signal.aborted) return;
      state.controlled = Boolean(navigator.serviceWorker.controller);
      state.controllerUrl = navigator.serviceWorker.controller?.scriptURL || '';
      state.workerState = worker?.state || '';
      state.state = registration?.active || state.controlled ? 'ready' : 'registering';
      if (worker?.state === 'redundant' && !registration?.active && !state.controlled) state.state = 'failed';
      publish();
    };
    const watch = (worker) => {
      if (scope.signal.aborted || !worker || watched.has(worker)) return;
      watched.add(worker);
      worker.addEventListener('statechange', () => sync(worker), { signal: scope.signal });
      sync(worker);
    };
    navigator.serviceWorker.addEventListener('controllerchange', () => sync(), { signal: scope.signal });
    window.addEventListener('pagehide', (event) => { if (!event.persisted) scope.abort(); }, { signal: scope.signal });
    Promise.resolve().then(() => scope.signal.aborted ? null
      : navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }))
      .then((result) => {
        if (scope.signal.aborted || !result) return;
        registration = result;
        registration.addEventListener('updatefound', () => {
          if (scope.signal.aborted) return;
          state.updates += 1;
          watch(registration.installing);
        }, { signal: scope.signal });
        const worker = registration.installing || registration.waiting || registration.active;
        if (worker) watch(worker);
        else sync();
      }).catch((error) => {
        if (scope.signal.aborted) return;
        state.state = 'failed';
        state.error = String(error?.message || error);
        publish();
        if (!scope.signal.aborted && document.documentElement.dataset.debug === 'on') console.warn('VCard service worker registration failed', error);
      });
  })();

  // Email copy handler
  (() => {
    const email1 = '475';
    const emailLink = document.getElementById('email-link');
    if (emailLink) {
      const scope = new AbortController();
      window.addEventListener('pagehide', (event) => {
        if (!event.persisted) scope.abort();
      }, { signal: scope.signal });
      emailLink.addEventListener('click', (e) => {
        e.preventDefault();
        const email2 = '@gmail.com';
        const email = email0 + email1 + email2;
        navigator.clipboard.writeText(email).then(() => {
          if (!scope.signal.aborted) alert('скопирован в буфер обмена');
        }).catch(() => {
          if (!scope.signal.aborted) alert('Не удалось скопировать: ' + email);
        });
      }, { signal: scope.signal });
    }
  })();
  (() => {
    const root = document.documentElement;
    const STORAGE_KEY = 'vcard-background-mode';
    const backgroundScope = new AbortController();
    const { signal: backgroundSignal } = backgroundScope;
    const IMAGE_STORAGE_KEY = 'vcard-background-image';
    const imageListUrl = 'sys/v_bkimg/list.js';
    const videoListUrl = 'sys/v_bkvid/list.js';
    const modes = ['wallpaper', 'graph1', 'graph2', 'smoke'];
    const migrateMode = (value) => ({
      off: 'wallpaper',
      light: 'wallpaper',
      h: 'graph1',
      horizontal: 'graph1',
      v: 'graph2',
      vertical: 'graph2'
    })[value] || value;
    let backgroundMode = migrateMode(vcardStorage.local.getItem(STORAGE_KEY)) || migrateMode(vcardStorage.local.getItem('vcard-visualization')) || 'smoke';
    if (!modes.includes(backgroundMode)) backgroundMode = 'smoke';
    if (!vcardVisualizationAvailable() && ['graph1', 'graph2'].includes(backgroundMode)) backgroundMode = 'wallpaper';
    let images = [];
    let videos = [];
    let backgroundSourcesReady = false;
    let currentImageIndex = -1;
    let currentVideoIndex = -1;
    let currentVideoCommitted = false;
    let backgroundIntensityOff = root.dataset.visBri === '0';
    let imageReservation = null;
    let videoReservation = null;
    let backgroundImageVersion = 0;
    let backgroundVideoVersion = 0;
    let backgroundImageAbort = null;
    let backgroundVideoAbort = null;
    const backgroundPreparations = { image: null, video: null };
    const beginBackgroundPreparation = (kind, controller, reservation) => {
      const life = window.VCLife;
      const task = life && window.VCLifeCore?.TOperation
        ? new window.VCLifeCore.TOperation(life, `background-${kind}-prepare`) : null;
      const publish = () => {
        if (backgroundSignal.aborted) return;
        backgroundPreparations[kind] = task?.snapshot() || null;
        root.dataset.backgroundPreparation = JSON.stringify(backgroundPreparations);
      };
      controller.signal.addEventListener('abort', () => {
        reservation?.cancel();
        task?.cancel('background-source-cancelled');
        publish();
      }, { once: true });
      task?.scope.signal.addEventListener('abort', () => {
        if (task.status !== 'Completed') controller.abort();
      }, { once: true, signal: controller.signal });
      publish();
      return (type, apply, error = null) => {
        const finish = () => {
          if (backgroundSignal.aborted || controller.signal.aborted) return false;
          try {
            if (apply() === false) { controller.abort(); return false; }
            if (error) {
              task?.fail(error);
              life?.reportFault(error, { type, owner: task || life }, 'ResourceFailure');
              controller.abort();
            } else task?.complete({ kind });
          } catch (failure) {
            task?.fail(failure);
            controller.abort();
            life?.reportFault(failure, { type, owner: task || life }, 'ComponentFailure');
            if (!life) console.warn('VCard background: publication failed', failure);
          }
          publish();
          return true;
        };
        return life ? life.queue.post(finish, { type, owner: life, scope: backgroundScope }) : finish();
      };
    };
    let lastAppliedBackground = null;
    const publishAppliedBackground = () => {
      if (backgroundSignal.aborted || backgroundIntensityOff) return;
      const image = root.style.getPropertyValue('--vc-page-background-image');
      const visibleVideo = backgroundMode === 'smoke' && !video.hidden
        && !video.classList.contains('is-pending') ? video.currentSrc || video.src : '';
      const key = JSON.stringify([backgroundMode, image, visibleVideo]);
      const previous = lastAppliedBackground;
      lastAppliedBackground = key;
      if (previous === null || previous === key) return;
      document.dispatchEvent(new CustomEvent('vcard:background-applied', {
        detail: { previous, key, mode: backgroundMode },
      }));
    };
    let video = document.createElement('video');
    video.className = 'vcard-page-background-video';
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.disablePictureInPicture = true;
    video.setAttribute('aria-hidden', 'true');
    video.hidden = true;
    document.body.prepend(video);
    const fadeCurtain = document.createElement('div');
    fadeCurtain.className = 'vcard-page-background-curtain';
    fadeCurtain.setAttribute('aria-hidden', 'true');
    document.body.prepend(fadeCurtain);
    const backgroundOrigin = (event) => {
      const life = window.VCLife;
      return { commandId: life?.queue.current?.id || null,
        event: life?.queue.current?.type || event, revision: life?.revision ?? null,
        runId: null, profile: null, entryKey: null };
    };
    class TBackgroundTransition {
      constructor() {
        this.active = null;
        this.next = null;
        this.sequence = 0;
        this.stage = 'idle';
        this.last = null;
      }

      publish(stage = this.stage) {
        if (backgroundSignal.aborted) return;
        this.stage = stage;
        if (this.active) this.active[`${stage}At`] ??= performance.now();
        root.dataset.backgroundTransition = JSON.stringify({ stage, id: this.active?.id || 0,
          operation: this.active?.task?.snapshot() || null,
          next: Boolean(this.next), mode: this.active?.prepared?.mode || backgroundMode, last: this.last });
      }

      request(request) {
        if (backgroundSignal.aborted) return { changed: false, pending: false, reason: 'page-disposed' };
        this.next?.resolve({ changed: false, pending: false, reason: 'background-request-replaced' });
        let resolve;
        const completion = new Promise((done) => { resolve = done; });
        request = { ...request, resolve, origin: backgroundOrigin(
          request.random ? 'Decoration.Background.Request' : 'Background.Request'
        ) };
        this.next = request;
        this.publish();
        if (!this.active) this.run();
        return { changed: false, pending: true, reason: 'background-requested', completion };
      }

      wait(duration, signal) {
        const clock = window.VCLife?.transitionClock;
        if (clock) {
          const waiting = new AbortController();
          const abort = () => waiting.abort();
          const finishMotion = () => {
            if (!vcardMotionPolicy.snapshot().motionAllowed) waiting.abort();
          };
          signal.addEventListener('abort', abort, { once: true });
          document.addEventListener('vcard:motion-state', finishMotion);
          if (signal.aborted || !vcardMotionPolicy.snapshot().motionAllowed) waiting.abort();
          return clock.wait(duration / 1000, waiting.signal).catch((error) => {
            if (error?.name !== 'AbortError' || signal.aborted) throw error;
          }).finally(() => {
            signal.removeEventListener('abort', abort);
            document.removeEventListener('vcard:motion-state', finishMotion);
          });
        }
        return new Promise((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new DOMException('Background transition cancelled', 'AbortError'));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve();
          }, duration);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      }

      cancel(reason = 'background-request-cancelled') {
        this.next?.resolve({ changed: false, pending: false, reason });
        this.next = null;
        if (this.active) this.active.error = reason;
        this.active?.task?.cancel(reason);
        this.active?.controller.abort();
        fadeCurtain.classList.remove('is-visible');
      }

      async run() {
        const request = this.next;
        this.next = null;
        const operation = { id: ++this.sequence, controller: new AbortController(), prepared: null,
          image: null, video: null, modeReservation: null, committed: false, color: null,
          backgroundChanged: false, commitColor: request.commitColor, error: '' };
        this.active = operation;
        const life = window.VCLife;
        operation.task = life && window.VCLifeCore?.TOperation
          ? new window.VCLifeCore.TOperation(life, 'background-transition') : null;
        operation.task?.scope.signal.addEventListener('abort', () => {
          if (operation.task.status !== 'Completed') operation.controller.abort();
        }, { once: true });
        const signal = operation.controller.signal;
        const releaseUncommitted = () => {
          if (operation.committed) return;
          operation.image?.reservation?.cancel();
          operation.video?.reservation?.cancel();
          operation.modeReservation?.cancel();
          if (operation.preparingVideo) {
            releasePreparedVideo(operation.preparingVideo);
            operation.preparingVideo = null;
          }
        };
        try {
          this.publish('prepare');
          operation.prepared = await prepareBackground(request, operation);
          if (signal.aborted || backgroundIntensityOff) return;
          if (request.soft && vcardMotionPolicy.snapshot().renderingActive) {
            this.publish('darken');
            fadeCurtain.style.transitionDuration = '900ms';
            fadeCurtain.classList.add('is-visible');
            await this.wait(900, signal);
          }
          if (signal.aborted || backgroundIntensityOff) return;
          const commit = () => {
            if (signal.aborted || backgroundIntensityOff) return false;
            this.publish('commit');
            commitBackground(operation);
            operation.committed = true;
          };
          if (life?.queue) await life.queue.post(commit, { type: 'Decoration.Commit', owner: life, scope: { signal } });
          else commit();
          if (!operation.committed) return;
          if (request.soft && vcardMotionPolicy.snapshot().renderingActive) {
            // Keep the curtain opaque across a paint of the committed layers.
            await vcardRenderScheduler.prepare(() => undefined, { signal });
            await vcardRenderScheduler.prepare(() => undefined, { signal });
            this.publish('reveal');
            fadeCurtain.style.transitionDuration = '1200ms';
            fadeCurtain.classList.remove('is-visible');
            await this.wait(1200, signal);
          }
        } catch (error) {
          operation.error ||= error?.name === 'AbortError' ? 'cancelled' : String(error?.message || error);
          if (error?.name !== 'AbortError') {
            const fail = () => {
              if (this.active !== operation || backgroundSignal.aborted) return false;
              operation.task?.fail(error);
              operation.controller.abort();
              releaseUncommitted();
              life?.reportFault(error, { type: 'Operation.Fail', owner: operation.task || life },
                'ComponentFailure');
              return true;
            };
            if (life) await life.queue.post(fail, { type: 'Operation.Fail', owner: life, scope: backgroundScope });
            else { fail(); console.warn('VCard background: transition failed', error); }
          }
        } finally {
          const cancelled = signal.aborted;
          operation.controller.abort();
          releaseUncommitted();
          const finish = () => {
            if (operation.committed && !cancelled) {
              operation.task?.complete({ mode: operation.prepared?.mode || '',
                backgroundChanged: Boolean(operation.backgroundChanged) });
            } else operation.task?.cancel(operation.error || 'background-cancelled');
            fadeCurtain.classList.remove('is-visible');
            this.last = { id: operation.id, mode: operation.prepared?.mode || '', committed: operation.committed,
              operation: operation.task?.snapshot() || null,
              reason: operation.committed ? 'background-applied' : operation.error || 'background-cancelled',
              prepareAt: operation.prepareAt, darkenAt: operation.darkenAt,
              commitAt: operation.commitAt, revealAt: operation.revealAt, finishedAt: performance.now() };
            this.active = null;
            this.publish('idle');
            request.resolve({ changed: operation.committed && Boolean(operation.backgroundChanged || operation.color?.changed),
              pending: false, reason: operation.committed ? 'background-applied' : operation.error || 'background-cancelled',
              backgroundChanged: operation.backgroundChanged, color: operation.color, id: operation.id });
            if (this.next) this.run();
            return true;
          };
          if (!life || !await life.queue.post(finish, { type: 'Operation.Complete', owner: life,
            scope: backgroundScope })) finish();
        }
      }
    }
    const transition = new TBackgroundTransition();
    transition.publish();

    const hideVideo = () => {
      backgroundVideoAbort?.abort();
      backgroundVideoAbort = null;
      videoReservation?.cancel();
      videoReservation = null;
      backgroundVideoVersion += 1;
      freezeVCardVideo(video);
      video.hidden = true;
      video.classList.remove('is-pending');
    };

    const showVideo = (source, reservation = null) => {
      if (backgroundSignal.aborted) { reservation?.cancel(); return; }
      backgroundVideoAbort?.abort();
      const preparation = new AbortController();
      backgroundVideoAbort = preparation;
      if (videoReservation !== reservation) videoReservation?.cancel();
      videoReservation = reservation;
      const finishPreparation = beginBackgroundPreparation('video', preparation, reservation);
      const version = ++backgroundVideoVersion;
      root.dataset.pageBackgroundKind = 'image-video';
      video.playbackRate = vcardBackgroundPlaybackRate;
      if (backgroundIntensityOff) {
        preparation.abort();
        backgroundVideoAbort = null;
        reservation?.cancel();
        videoReservation = null;
        freezeVCardVideo(video);
        video.hidden = true;
        return;
      }
      // A newly attached video paints a browser-default (often white) frame
      // before its first decoded image.  This is especially visible after
      // brightness 0, when the wallpaper layer is deliberately absent.
      const revealWhenReady = () => {
        return finishPreparation('Operation.Complete', () => {
          if (version !== backgroundVideoVersion || backgroundIntensityOff || video.readyState < 2) return false;
          video.classList.remove('is-pending');
          root.dataset.pageBackgroundKind = 'image-video';
          if (reservation?.commit()) currentVideoCommitted = true;
          if (videoReservation === reservation) videoReservation = null;
          publishAppliedBackground();
        });
      };
      video.classList.add('is-pending');
      const fail = (error) => {
        if (error?.name === 'AbortError' || version !== backgroundVideoVersion || preparation.signal.aborted) return;
        const failure = error instanceof Error ? error : new Error(`Background video failed: ${video.currentSrc || source}`);
        finishPreparation('Operation.Fail', () => {
          if (version !== backgroundVideoVersion) return false;
          if (reservation) vcardSelectionBags.get('background.videos')?.invalidate(reservation.item);
          if (videoReservation === reservation) videoReservation = null;
          video.hidden = true;
          video.classList.remove('is-pending');
          freezeVCardVideo(video);
          root.dataset.pageBackgroundKind = 'image';
          publishAppliedBackground();
        }, failure);
      };
      video.addEventListener('error', fail, { once: true, signal: preparation.signal });
      video.hidden = false;
      if (video.src !== source) {
        video.src = source;
        video.load();
      }
      playVCardAnimation(video, vcardBackgroundPlaybackRate);
      vcardMedia.prepareVideo(video, { signal: preparation.signal,
        readyState: HTMLMediaElement.HAVE_CURRENT_DATA }).then(revealWhenReady).catch(fail);
    };

    const reserveSource = (name, sources, currentIndex, origin = backgroundOrigin('Background.Source.Select')) => {
      const bag = vcardSelectionBag(name, sources.map((source, index) => ({ source, index })),
        (item) => item.source);
      bag.reservation?.cancel();
      const reservation = bag.reserve({ prefer: (item) => item.index !== currentIndex, origin });
      return reservation ? { ...reservation.item, reservation } : null;
    };

    const nextImageSource = (origin) => reserveSource('background.images', images, currentImageIndex, origin);
    const availableModes = () => modes.filter((mode) => (
      vcardVisualizationAvailable() || !['graph1', 'graph2'].includes(mode)
    ));

    const nextBackgroundMode = (origin) => {
      const bag = vcardSelectionBag('background.modes', availableModes());
      bag.reservation?.cancel();
      return bag.reserve({ prefer: (mode) => mode !== backgroundMode, origin });
    };

    const imageStorageName = (source) => {
      const sourceUrl = new URL(source, document.baseURI);
      const name = sourceUrl.pathname.split('/').filter(Boolean).pop() || '';
      try {
        return decodeURIComponent(name);
      } catch (_error) {
        return name;
      }
    };

    const showImage = (choice) => {
      if (!choice) return;
      if (backgroundSignal.aborted) { choice.reservation?.cancel(); return; }
      backgroundImageAbort?.abort();
      const preparation = new AbortController();
      backgroundImageAbort = preparation;
      imageReservation?.cancel();
      imageReservation = choice.reservation || null;
      const finishPreparation = beginBackgroundPreparation('image', preparation, choice.reservation);
      const sourceUrl = new URL(choice.source, document.baseURI);
      const source = sourceUrl.href;
      const version = ++backgroundImageVersion;
      vcardMedia.prepareImage(source, { signal: preparation.signal }).then(() => {
        return finishPreparation('Operation.Complete', () => {
          if (version !== backgroundImageVersion) return false;
          currentImageIndex = choice.index;
          root.dataset.pageBackgroundKind = backgroundMode === 'smoke' && !video.hidden
            ? 'image-video' : 'image';
          const imageName = imageStorageName(source);
          root.dataset.pageBackgroundName = imageName || '—';
          root.dataset.pageBackgroundColor = sourceUrl.searchParams.get('vc-color') === '1'
            ? 'color'
            : 'mono';
          vcardStorage.local.setItem(IMAGE_STORAGE_KEY, imageName);
          root.style.setProperty('--vc-page-background-image', 'url("' + source + '")');
          choice.reservation?.commit();
          if (imageReservation === choice.reservation) imageReservation = null;
          publishAppliedBackground();
        });
      }).catch((error) => {
        if (error?.name === 'AbortError' || version !== backgroundImageVersion || preparation.signal.aborted) return;
        return finishPreparation('Operation.Fail', () => {
          if (version !== backgroundImageVersion) return false;
          if (choice.reservation) vcardSelectionBags.get('background.images')?.invalidate(choice.reservation.item);
          if (imageReservation === choice.reservation) imageReservation = null;
        }, error);
      }).finally(() => {
        preparation.abort();
        if (backgroundImageAbort === preparation) backgroundImageAbort = null;
      });
    };

    window.addEventListener('pagehide', (event) => {
      if (event.persisted) return;
      backgroundScope.abort();
      transition.cancel('page-disposed');
      backgroundImageAbort?.abort();
      imageReservation?.cancel();
      hideVideo();
      releasePreparedVideo(video);
      fadeCurtain.remove();
    }, { signal: backgroundSignal });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) transition.cancel('page-hidden');
    }, { signal: backgroundSignal });
    document.addEventListener('vcard:motion-state', () => {
      if (!vcardMotionPolicy.snapshot().motionAllowed) {
        fadeCurtain.style.transitionDuration = '0ms';
        fadeCurtain.classList.remove('is-visible');
      }
      if (!vcardMotionPolicy.snapshot().renderingActive) video.pause();
      else if (backgroundMode === 'smoke' && !video.hidden) playVCardAnimation(video, vcardBackgroundPlaybackRate);
    }, { signal: backgroundSignal });

    const showRandomImage = () => {
      if (!backgroundSourcesReady) return;
      showImage(nextImageSource());
    };

    const restoreStoredImage = () => {
      const storedName = vcardStorage.local.getItem(IMAGE_STORAGE_KEY);
      if (!storedName) return false;
      const index = images.findIndex((source) => imageStorageName(source) === storedName);
      if (index < 0) return false;
      showImage({ source: images[index], index });
      return true;
    };

    const showRandomVideo = () => {
      if (!backgroundSourcesReady) return;
      const choice = reserveSource('background.videos', videos, currentVideoIndex);
      if (!choice) return;
      currentVideoIndex = choice.index;
      currentVideoCommitted = false;
      showVideo(new URL(choice.source, document.baseURI).href, choice.reservation);
    };

    const applyBackgroundMode = (nextMode, randomize = false) => {
      if (!vcardVisualizationAvailable() && ['graph1', 'graph2'].includes(nextMode)) nextMode = 'wallpaper';
      backgroundMode = modes.includes(nextMode) ? nextMode : 'wallpaper';
      vcardStorage.local.setItem(STORAGE_KEY, backgroundMode);
      root.dataset.backgroundMode = backgroundMode;
      if (backgroundMode === 'wallpaper' && (randomize || currentImageIndex < 0)) {
        showRandomImage();
      }
      if (backgroundMode === 'smoke') {
        if (randomize || currentVideoIndex < 0 || (!currentVideoCommitted && !videoReservation)) showRandomVideo();
        else showVideo(new URL(videos[currentVideoIndex], document.baseURI).href, videoReservation);
      } else {
        hideVideo();
        root.dataset.pageBackgroundKind = 'image';
      }
      const visualizationMode = backgroundMode === 'graph1'
        ? 'h'
        : (backgroundMode === 'graph2' ? 'v' : 'off');
      document.dispatchEvent(new CustomEvent('vcard:set-visualization', {
        detail: { mode: visualizationMode, force: true }
      }));
      document.dispatchEvent(new CustomEvent('vcard:background-state', {
        detail: { mode: backgroundMode, videoEnabled: backgroundMode === 'smoke' }
      }));
      if (backgroundMode !== 'smoke' && !(backgroundMode === 'wallpaper' && imageReservation)) {
        publishAppliedBackground();
      }
    };

    const releasePreparedVideo = (element) => {
      element.pause();
      element.removeAttribute('src');
      element.load();
      element.remove();
    };

    const prepareBackground = async (request, operation) => {
      const signal = operation.controller.signal;
      operation.modeReservation = request.random ? nextBackgroundMode(request.origin) : null;
      if (request.random && !operation.modeReservation) throw new Error('No background modes available');
      let mode = operation.modeReservation?.item || request.mode || backgroundMode;
      if (!vcardVisualizationAvailable() && ['graph1', 'graph2'].includes(mode)) mode = 'wallpaper';
      if (!modes.includes(mode)) mode = 'wallpaper';
      const prepared = { mode, video: null, image: null };
      if (request.refreshImage || (mode === 'wallpaper' && (request.randomize || currentImageIndex < 0))) {
        operation.image = nextImageSource(request.origin);
        if (!operation.image) throw new Error('No background images available');
      }
      if (mode === 'smoke') {
        operation.video = request.randomize || currentVideoIndex < 0 || !currentVideoCommitted
          ? reserveSource('background.videos', videos, currentVideoIndex, request.origin)
          : { source: videos[currentVideoIndex], index: currentVideoIndex };
        if (!operation.video?.source) throw new Error('No background videos available');
      }
      await Promise.all([
        operation.image ? vcardMedia.prepareImage(operation.image.source, { signal }).then((image) => {
          prepared.image = image;
        }).catch((error) => {
          if (error?.name !== 'AbortError') vcardSelectionBags.get('background.images')?.invalidate(operation.image.reservation?.item);
          throw error;
        }) : Promise.resolve(),
        operation.video ? (async () => {
          const element = video.cloneNode(false);
          element.muted = true;
          element.playsInline = true;
          element.loop = true;
          element.disablePictureInPicture = true;
          element.hidden = true;
          element.classList.remove('is-pending');
          element.preload = 'auto';
          element.src = new URL(operation.video.source, document.baseURI).href;
          operation.preparingVideo = element;
          document.body.prepend(element);
          try {
            await vcardMedia.prepareVideo(element, { signal, readyState: HTMLMediaElement.HAVE_CURRENT_DATA });
            prepared.video = element;
          } catch (error) {
            if (error?.name !== 'AbortError' && operation.video.reservation) {
              vcardSelectionBags.get('background.videos')?.invalidate(operation.video.reservation.item);
            }
            throw error;
          }
        })() : Promise.resolve(),
      ]);
      return prepared;
    };

    const commitBackground = (operation) => {
      const prepared = operation.prepared;
      const previousBackground = lastAppliedBackground;
      backgroundImageAbort?.abort();
      backgroundImageAbort = null;
      imageReservation?.cancel();
      imageReservation = null;
      backgroundImageVersion += 1;
      if (prepared.image) {
        const source = prepared.image.src;
        const sourceUrl = new URL(source, document.baseURI);
        const name = imageStorageName(source);
        currentImageIndex = operation.image.index;
        root.dataset.pageBackgroundName = name || '—';
        root.dataset.pageBackgroundColor = sourceUrl.searchParams.get('vc-color') === '1' ? 'color' : 'mono';
        root.style.setProperty('--vc-page-background-image', `url("${source}")`);
        vcardStorage.local.setItem(IMAGE_STORAGE_KEY, name);
      }
      if (prepared.video) {
        const previous = video;
        hideVideo();
        video = prepared.video;
        currentVideoIndex = operation.video.index;
        currentVideoCommitted = true;
        releasePreparedVideo(previous);
      }
      // Prepared sources are already decoded; mode application must not choose
      // or load another source in this synchronous commit.
      backgroundMode = prepared.mode;
      vcardStorage.local.setItem(STORAGE_KEY, backgroundMode);
      root.dataset.backgroundMode = backgroundMode;
      if (prepared.video) {
        showVideo(prepared.video.src);
        video.classList.remove('is-pending');
      } else hideVideo();
      root.dataset.pageBackgroundKind = prepared.video ? 'image-video' : 'image';
      operation.image?.reservation?.commit();
      operation.video?.reservation?.commit();
      operation.modeReservation?.commit();
      operation.color = operation.commitColor?.() || null;
      document.dispatchEvent(new CustomEvent('vcard:set-visualization', {
        detail: { mode: backgroundMode === 'graph1' ? 'h' : backgroundMode === 'graph2' ? 'v' : 'off', force: true },
      }));
      document.dispatchEvent(new CustomEvent('vcard:background-state', {
        detail: { mode: backgroundMode, videoEnabled: backgroundMode === 'smoke' },
      }));
      publishAppliedBackground();
      operation.backgroundChanged = previousBackground !== null && previousBackground !== lastAppliedBackground;
    };

    const requestBackground = (request) => {
      if (backgroundSignal.aborted) return { changed: false, reason: 'page-disposed' };
      if (!backgroundSourcesReady) return { changed: false, reason: 'background-sources-pending' };
      if (backgroundIntensityOff) {
        if (!request.random) applyBackgroundMode(request.mode || backgroundMode, false);
        const color = request.commitColor?.() || null;
        return { changed: Boolean(color?.changed), color, reason: 'background-intensity-off' };
      }
      return transition.request(request);
    };

    document.addEventListener('vcard:set-background', (event) => {
      const requestedMode = event.detail && event.detail.mode;
      const forceMode = Boolean(event.detail && event.detail.force);
      requestBackground({ mode: requestedMode, randomize: forceMode });
    }, { signal: backgroundSignal });
    document.addEventListener('vcard:autopilot-state', (event) => {
      if (event.detail?.enabled) return;
      if (transition.next?.random) {
        transition.next.resolve({ changed: false, pending: false, reason: 'autopilot-off' });
        transition.next = null;
        transition.publish();
      }
      if (transition.active && !transition.active.committed && transition.active.modeReservation) transition.cancel('autopilot-off');
    }, { signal: backgroundSignal });
    document.addEventListener('vcard:randomize-wallpaper', () => {
      requestBackground({ mode: 'wallpaper', randomize: true });
    }, { signal: backgroundSignal });
    document.addEventListener('vcard:request-background-state', () => {
      document.dispatchEvent(new CustomEvent('vcard:background-state', {
        detail: { mode: backgroundMode, videoEnabled: backgroundMode === 'smoke' }
      }));
    }, { signal: backgroundSignal });
    document.addEventListener('vcard:visualization-state', (event) => {
      const brightnessLevel = Number(event.detail && event.detail.brightnessLevel);
      const wasOff = backgroundIntensityOff;
      backgroundIntensityOff = brightnessLevel === 0;
      if (backgroundIntensityOff) transition.cancel('background-intensity-off');
      if (wasOff === backgroundIntensityOff) return;
      if (backgroundMode !== 'smoke') return;
      if (backgroundIntensityOff) {
        hideVideo();
        return;
      }
      if (currentVideoIndex >= 0 && videos[currentVideoIndex] && (currentVideoCommitted || videoReservation)) {
        showVideo(new URL(videos[currentVideoIndex], document.baseURI).href, videoReservation);
      } else {
        showRandomVideo();
      }
    }, { signal: backgroundSignal });
    document.addEventListener('vcard:playlist-change', () => {
      if (vcardAutopilotEnabled()) return;
      requestBackground({ mode: backgroundMode, randomize: true, refreshImage: true });
    }, { signal: backgroundSignal });

    window.VCardBackgroundControl = Object.freeze({
      randomize: ({ soft = false, commitColor = null } = {}) => {
        return requestBackground({ random: true, randomize: true, soft, commitColor });
      },
      current: () => backgroundMode,
    });

    (async () => {
      await vcardSelectionReady;
      if (backgroundSignal.aborted) return;
      const life = window.VCLife;
      const operation = life && window.VCLifeCore?.TOperation
        ? new window.VCLifeCore.TOperation(life, 'background-catalog') : null;
      if (operation) backgroundSignal.addEventListener('abort', () => operation.cancel('page-disposed'),
        { once: true, signal: operation.scope.signal });
      const publish = () => {
        if (!backgroundSignal.aborted && operation) {
          root.dataset.backgroundCatalog = JSON.stringify(operation.snapshot());
        }
      };
      const post = (type, apply) => {
        const run = () => {
          if (backgroundSignal.aborted || (operation && operation.status !== 'Running')) return false;
          try { return apply(); }
          catch (error) {
            operation?.fail(error);
            if (life) life.reportFault(error, { type: 'Operation.Fail', owner: operation || life }, 'ComponentFailure');
            else console.warn('VCard background: cannot apply catalog', error);
            return false;
          }
        };
        return life ? life.queue.post(run, { type, owner: life, scope: backgroundScope }) : Promise.resolve(run());
      };
      publish();
      try {
        const results = await Promise.allSettled([
          vcardMedia.loadList(imageListUrl), vcardMedia.loadList(videoListUrl),
        ]);
        await post('Operation.Complete', () => {
          const supported = (result, pattern, url) => result.status === 'fulfilled'
            ? result.value.filter((item) => pattern.test(item)).map((item) => vcardMedia.listItemUrl(url, item)) : [];
          const nextImages = supported(results[0], /\.(?:avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i, imageListUrl);
          const nextVideos = supported(results[1], /\.(?:webm|mp4|ogv)(?:[?#].*)?$/i, videoListUrl);
          results.forEach((result, index) => {
            if (result.status !== 'rejected' || result.reason?.name === 'AbortError') return;
            if (life) life.reportFault(result.reason, { type: 'Background.List.Fail', owner: operation || life }, 'ResourceFailure');
            else console.warn(`VCard background: cannot load ${[imageListUrl, videoListUrl][index]}`, result.reason);
          });
          if (nextImages.length) images = nextImages;
          if (nextVideos.length) videos = nextVideos;
          backgroundSourcesReady = true;
          if (!restoreStoredImage()) showRandomImage();
          applyBackgroundMode(backgroundMode, false);
          operation?.complete({ images: images.length, videos: videos.length,
            failedLists: results.filter((result) => result.status === 'rejected').length });
          return true;
        });
      } catch (error) {
        await post('Operation.Fail', () => {
          operation?.fail(error);
          if (life) life.reportFault(error, { type: 'Operation.Fail', owner: operation || life }, 'ComponentFailure');
          else console.warn('VCard background: cannot initialize catalog', error);
          return false;
        });
      } finally {
        operation?.cancel('background-catalog-finished');
        publish();
      }
    })();
  })();
  (() => {
    const STORAGE_KEY = "vcard-color-scheme";
    const schemeScope = new AbortController();
    const { signal: schemeSignal } = schemeScope;
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) schemeScope.abort();
    }, { signal: schemeSignal });
    const root = document.documentElement;
    const links = Array.from(document.querySelectorAll(':is(a, button)[data-color-scheme]'));
    const defaultScheme = () => {
      const key = vcardCssDefault('color-scheme', 'black').toLowerCase();
      return key === 'white' ? 'white' : 'black';
    };
    let currentScheme = defaultScheme();
    window.VCardColorScheme = Object.freeze({ current: () => currentScheme });

    function applyScheme(key, { force = false, persist = true } = {}) {
      if (schemeSignal.aborted) return;
      if (vcardPlaylistStyleLocked() && !force) return;
      if (key !== "black" && key !== "white") key = "white";

      currentScheme = key;
      root.dataset.colorScheme = currentScheme;
      if (persist && !vcardAutopilotEnabled()) vcardStorage.local.setItem(STORAGE_KEY, key);

      links.forEach((link) => {
        link.classList.toggle("is-active", link.dataset.colorScheme === key);
      });

      document.dispatchEvent(new CustomEvent("vcardcolorschemechange", {
        detail: { key }
      }));
      document.dispatchEvent(new CustomEvent("vcard:color-scheme-state", {
        detail: { key }
      }));
    }

    document.addEventListener("vcard:set-color-scheme", (event) => {
      const detail = event.detail || {};
      applyScheme(detail.key, {
        force: Boolean(detail.force),
        persist: detail.persist !== false,
      });
    }, { signal: schemeSignal });

    document.addEventListener("vcard:request-color-scheme-state", () => {
      document.dispatchEvent(new CustomEvent("vcard:color-scheme-state", {
        detail: {
          key: currentScheme
        }
      }));
    }, { signal: schemeSignal });

    links.forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        applyScheme(link.dataset.colorScheme);
      }, { signal: schemeSignal });
    });

    applyScheme(vcardStoredSetting(STORAGE_KEY, 'color-scheme', defaultScheme()));
  })();
  (() => {
    const root = document.documentElement;
    const MONO_COLOR_STORAGE_KEY = "vcard-mono-color";
    const paletteScope = new AbortController();
    const { signal: paletteSignal } = paletteScope;
    const ACCENT_STORAGE_KEY = "vcard-accent";
    const PRESET_STORAGE_KEY = "vcard-preset";
    let textColorValue = "white";
    let accColorValue = "white";
    let monoColorEnabled = vcardSettingEnabled(MONO_COLOR_STORAGE_KEY, 'mono-color', 'off');
    let accentEnabled = vcardSettingEnabled(ACCENT_STORAGE_KEY, 'accent');
    let currentPreset = '';
    let nightTone = '';
    let paletteReady = false;
    let paletteTransaction = false;
    let paletteReservation = null;
    let colorTransitionTimer = 0;
    let lastPublishedPalette = '';
    let palettePublishPending = false;
    window.addEventListener('pagehide', (event) => {
      if (event.persisted) return;
      paletteScope.abort();
      window.clearTimeout(colorTransitionTimer);
      paletteReservation?.cancel();
      paletteReservation = null;
      root.classList.remove('vcard-decor-color-transition');
    }, { signal: paletteSignal });
    const paletteKey = () => ['--vc-page', '--vc-acc'].map((name) => {
      const value = root.style.getPropertyValue(name).trim().toLowerCase();
      return ({ white: '#ffffff', black: '#000000' })[value] || value;
    }).join('/');
    const publishAppliedPalette = () => {
      if (paletteSignal.aborted || paletteTransaction) return;
      if (!paletteReady) { lastPublishedPalette = paletteKey(); return; }
      if (palettePublishPending) return;
      palettePublishPending = true;
      // Several synchronous setters may belong to one user action.
      queueMicrotask(() => {
        palettePublishPending = false;
        if (paletteSignal.aborted) return;
        const pair = paletteKey();
        if (pair === lastPublishedPalette) return;
        const previous = lastPublishedPalette;
        lastPublishedPalette = pair;
        document.dispatchEvent(new CustomEvent('vcard:palette-applied', {
          detail: { previous, pair, preset: currentPreset || 'custom' },
        }));
      });
    };
    const beginPaletteTransition = () => {
      if (paletteSignal.aborted) return;
      if (!vcardMotionPolicy.snapshot().renderingActive) return;
      if (!paletteReady) return;
      root.classList.add('vcard-decor-color-transition');
      getComputedStyle(root).getPropertyValue('--vc-page');
      window.clearTimeout(colorTransitionTimer);
      colorTransitionTimer = window.setTimeout(() => {
        root.classList.remove('vcard-decor-color-transition');
      }, 1600);
    };
    document.addEventListener('vcard:motion-state', () => {
      if (vcardMotionPolicy.snapshot().motionAllowed) return;
      window.clearTimeout(colorTransitionTimer);
      root.classList.remove('vcard-decor-color-transition');
    }, { signal: paletteSignal });
    // Manual accent saturation adjustment: 100 keeps the palette unchanged,
    // lower values mute it, and values above 100 intensify it up to HSL 100%.
    const ACCENT_SATURATION_PERCENT = 100;
    // Keep 90% of the palette accent's HSL lightness.
    const ACCENT_LIGHTNESS_PERCENT = 90;
    // Light OKLCH-derived colors, stored as sRGB hex for the existing color math.
    // Each 16-color pass covers the whole spectrum in farthest-first order.
    const PRIMARY_COLOR_PALETTE = Object.freeze([
      "#ffa6c1", //   0 deg
      "#00e3c8", // 180 deg
      "#ecbe24", //  90 deg
      "#adc2ff", // 270 deg
      "#ffae89", //  45 deg
      "#5ed4ff", // 225 deg
      "#95db6c", // 135 deg
      "#e4a9ff", // 315 deg
      "#ffaaa6", //  22.5 deg
      "#00deeb", // 202.5 deg
      "#c6ce3f", // 112.5 deg
      "#c6b9ff", // 292.5 deg
      "#ffb259", //  67.5 deg
      "#92caff", // 247.5 deg
      "#55e39b", // 157.5 deg
      "#ff9fe5", // 337.5 deg
    ]);
    const INTERMEDIATE_COLOR_PALETTE = Object.freeze([
      "#ffa8b3", //  11.25 deg
      "#00e0da", // 191.25 deg
      "#dbc62d", // 101.25 deg
      "#b9beff", // 281.25 deg
      "#ffb076", //  56.25 deg
      "#7ecfff", // 236.25 deg
      "#78df83", // 146.25 deg
      "#f99dfb", // 326.25 deg
      "#ffac98", //  33.75 deg
      "#00dbfc", // 213.75 deg
      "#afd555", // 123.75 deg
      "#d3b2ff", // 303.75 deg
      "#fbb62b", //  78.75 deg
      "#a1c6ff", // 258.75 deg
      "#20e4b2", // 168.75 deg
      "#ffa3d1", // 348.75 deg
    ]);
    const COLOR_PALETTE = Object.freeze([
      ...PRIMARY_COLOR_PALETTE,
      ...INTERMEDIATE_COLOR_PALETTE,
    ]);
    const ACCENT_VARIANTS_PER_COLOR = 3;
    const svgNamespace = "http://www.w3.org/2000/svg";
    const tintSvg = document.createElementNS(svgNamespace, "svg");
    const tintFilter = document.createElementNS(svgNamespace, "filter");
    const tintFlood = document.createElementNS(svgNamespace, "feFlood");
    const tintBlend = document.createElementNS(svgNamespace, "feBlend");
    const tintClip = document.createElementNS(svgNamespace, "feComposite");
    const emojiTintFilter = document.createElementNS(svgNamespace, "filter");
    const emojiTintGray = document.createElementNS(svgNamespace, "feColorMatrix");
    const emojiTintFlood = document.createElementNS(svgNamespace, "feFlood");
    const emojiTintBlend = document.createElementNS(svgNamespace, "feBlend");
    const emojiTintClip = document.createElementNS(svgNamespace, "feComposite");
    const songEmojiTintFilter = document.createElementNS(svgNamespace, "filter");
    const songEmojiTintGray = document.createElementNS(svgNamespace, "feColorMatrix");
    const songEmojiTintFlood = document.createElementNS(svgNamespace, "feFlood");
    const songEmojiTintBlend = document.createElementNS(svgNamespace, "feBlend");
    const songEmojiTintClip = document.createElementNS(svgNamespace, "feComposite");
    const videoTintFilter = document.createElementNS(svgNamespace, "filter");
    const videoTintGray = document.createElementNS(svgNamespace, "feColorMatrix");
    const videoTintFlood = document.createElementNS(svgNamespace, "feFlood");
    const videoTintBlend = document.createElementNS(svgNamespace, "feBlend");
    tintSvg.setAttribute("aria-hidden", "true");
    tintSvg.setAttribute("width", "0");
    tintSvg.setAttribute("height", "0");
    tintSvg.style.position = "absolute";
    tintFilter.id = "vc-text-tint";
    tintFilter.setAttribute("x", "0");
    tintFilter.setAttribute("y", "0");
    tintFilter.setAttribute("width", "100%");
    tintFilter.setAttribute("height", "100%");
    tintFilter.setAttribute("color-interpolation-filters", "sRGB");
    tintFlood.setAttribute("flood-color", "white");
    tintFlood.setAttribute("result", "text-color");
    tintBlend.setAttribute("in", "text-color");
    tintBlend.setAttribute("in2", "SourceGraphic");
    tintBlend.setAttribute("mode", "multiply");
    tintBlend.setAttribute("result", "tinted-image");
    tintClip.setAttribute("in", "tinted-image");
    tintClip.setAttribute("in2", "SourceAlpha");
    tintClip.setAttribute("operator", "in");
    tintFilter.append(tintFlood, tintBlend, tintClip);
    emojiTintFilter.id = "vc-emoji-tint";
    emojiTintFilter.setAttribute("x", "-25%");
    emojiTintFilter.setAttribute("y", "-25%");
    emojiTintFilter.setAttribute("width", "150%");
    emojiTintFilter.setAttribute("height", "150%");
    emojiTintFilter.setAttribute("color-interpolation-filters", "sRGB");
    emojiTintGray.setAttribute("in", "SourceGraphic");
    emojiTintGray.setAttribute("type", "saturate");
    emojiTintGray.setAttribute("values", "0");
    emojiTintGray.setAttribute("result", "emoji-gray");
    emojiTintFlood.setAttribute("flood-color", "white");
    emojiTintFlood.setAttribute("result", "emoji-color");
    emojiTintBlend.setAttribute("in", "emoji-color");
    emojiTintBlend.setAttribute("in2", "emoji-gray");
    emojiTintBlend.setAttribute("mode", "multiply");
    emojiTintBlend.setAttribute("result", "emoji-tinted");
    emojiTintClip.setAttribute("in", "emoji-tinted");
    emojiTintClip.setAttribute("in2", "SourceAlpha");
    emojiTintClip.setAttribute("operator", "in");
    emojiTintFilter.append(
      emojiTintGray,
      emojiTintFlood,
      emojiTintBlend,
      emojiTintClip
    );
    songEmojiTintFilter.id = "vc-song-emoji-tint";
    songEmojiTintFilter.setAttribute("x", "-25%");
    songEmojiTintFilter.setAttribute("y", "-25%");
    songEmojiTintFilter.setAttribute("width", "150%");
    songEmojiTintFilter.setAttribute("height", "150%");
    songEmojiTintFilter.setAttribute("color-interpolation-filters", "sRGB");
    songEmojiTintGray.setAttribute("in", "SourceGraphic");
    songEmojiTintGray.setAttribute("type", "saturate");
    songEmojiTintGray.setAttribute("values", "0");
    songEmojiTintGray.setAttribute("result", "song-emoji-gray");
    songEmojiTintFlood.setAttribute("flood-color", "white");
    songEmojiTintFlood.setAttribute("result", "song-emoji-color");
    songEmojiTintBlend.setAttribute("in", "song-emoji-color");
    songEmojiTintBlend.setAttribute("in2", "song-emoji-gray");
    songEmojiTintBlend.setAttribute("mode", "multiply");
    songEmojiTintBlend.setAttribute("result", "song-emoji-tinted");
    songEmojiTintClip.setAttribute("in", "song-emoji-tinted");
    songEmojiTintClip.setAttribute("in2", "SourceAlpha");
    songEmojiTintClip.setAttribute("operator", "in");
    songEmojiTintFilter.append(
      songEmojiTintGray,
      songEmojiTintFlood,
      songEmojiTintBlend,
      songEmojiTintClip
    );
    videoTintFilter.id = "vc-page-background-video-tint-filter";
    videoTintFilter.setAttribute("x", "0");
    videoTintFilter.setAttribute("y", "0");
    videoTintFilter.setAttribute("width", "100%");
    videoTintFilter.setAttribute("height", "100%");
    videoTintFilter.setAttribute("color-interpolation-filters", "sRGB");
    videoTintGray.setAttribute("in", "SourceGraphic");
    videoTintGray.setAttribute("type", "saturate");
    videoTintGray.setAttribute("values", "0");
    videoTintGray.setAttribute("result", "video-gray");
    videoTintFlood.setAttribute("flood-color", "white");
    videoTintFlood.setAttribute("result", "video-color");
    videoTintFlood.style.floodOpacity = "var(--vc-page-background-video-tint, 1)";
    videoTintBlend.setAttribute("in", "video-color");
    videoTintBlend.setAttribute("in2", "video-gray");
    videoTintBlend.setAttribute("mode", "multiply");
    videoTintFilter.append(videoTintGray, videoTintFlood, videoTintBlend);
    tintSvg.append(
      tintFilter,
      emojiTintFilter,
      songEmojiTintFilter,
      videoTintFilter
    );
    document.body.append(tintSvg);

    function isBlackScheme() {
      return window.VCardColorScheme.current() === "black";
    }

    function effectiveTextColor() {
      return isBlackScheme() ? textColorValue : "black";
    }

    const linearRgbChannel = (channel) => (
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4
    );

    const rgbRelativeLuminance = (red, green, blue) => (
      0.2126 * linearRgbChannel(red)
      + 0.7152 * linearRgbChannel(green)
      + 0.0722 * linearRgbChannel(blue)
    );

    const hexChannels = (color) => {
      const match = /^#([0-9a-f]{6})$/i.exec(String(color || '').trim());
      if (!match) return [255, 255, 255];
      return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
    };

    const colorHue = (color) => {
      const [redByte, greenByte, blueByte] = hexChannels(color);
      const red = redByte / 255;
      const green = greenByte / 255;
      const blue = blueByte / 255;
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const delta = maximum - minimum;
      if (!delta) return 0;
      let hue;
      if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
      else if (maximum === green) hue = 60 * (((blue - red) / delta) + 2);
      else hue = 60 * (((red - green) / delta) + 4);
      return (hue + 360) % 360;
    };

    const withAccentAdjustments = (color) => {
      const saturationFactor = Math.max(0, ACCENT_SATURATION_PERCENT) / 100;
      const lightnessFactor = Math.max(0, ACCENT_LIGHTNESS_PERCENT) / 100;
      if (saturationFactor === 1 && lightnessFactor === 1) return color;
      const [redByte, greenByte, blueByte] = hexChannels(color);
      const red = redByte / 255;
      const green = greenByte / 255;
      const blue = blueByte / 255;
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const delta = maximum - minimum;
      const lightness = (maximum + minimum) / 2;
      const adjustedLightness = Math.min(1, lightness * lightnessFactor);
      if (!delta) {
        const channel = Math.round(adjustedLightness * 255)
          .toString(16)
          .padStart(2, '0');
        return `#${channel}${channel}${channel}`;
      }

      const saturation = delta / (1 - Math.abs(2 * lightness - 1));
      const adjustedSaturation = Math.min(1, saturation * saturationFactor);
      const hue = colorHue(color);
      const chroma = (1 - Math.abs(2 * adjustedLightness - 1)) * adjustedSaturation;
      const segment = hue / 60;
      const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
      const [redPart, greenPart, bluePart] = (
        segment < 1 ? [chroma, secondary, 0]
          : segment < 2 ? [secondary, chroma, 0]
            : segment < 3 ? [0, chroma, secondary]
              : segment < 4 ? [0, secondary, chroma]
                : segment < 5 ? [secondary, 0, chroma]
                  : [chroma, 0, secondary]
      );
      const match = adjustedLightness - chroma / 2;
      const toHex = (channel) => Math.round((channel + match) * 255)
        .toString(16)
        .padStart(2, '0');
      return `#${toHex(redPart)}${toHex(greenPart)}${toHex(bluePart)}`;
    };

    const colorLuminance = (color) => {
      const [red, green, blue] = hexChannels(color);
      return rgbRelativeLuminance(red / 255, green / 255, blue / 255);
    };

    const accentContrastScore = (pageColor, accentColor) => {
      const hueDistance = Math.abs(colorHue(pageColor) - colorHue(accentColor));
      const spectralDistance = Math.min(hueDistance, 360 - hueDistance) / 180;
      const luminanceDistance = Math.abs(
        colorLuminance(pageColor) - colorLuminance(accentColor)
      );
      return spectralDistance * 4 + luminanceDistance;
    };

    const accentForPage = (page, variantIndex) => {
      const candidates = COLOR_PALETTE
        .filter((color) => color !== page)
        .sort((left, right) => (
          accentContrastScore(page, right) - accentContrastScore(page, left)
        ));
      const variantCount = Math.min(ACCENT_VARIANTS_PER_COLOR, candidates.length);
      return candidates[variantIndex % variantCount];
    };

    let colorBags = null;
    const reservePalettePair = (mode) => {
      if (!colorBags) {
        const random = window.VCPlayer.randomStream('decor.color');
        const key = (pair) => `${pair.page}/${pair.accent}`;
        colorBags = {
          mono: new window.VCLifeCore.TShuffleBag(
            COLOR_PALETTE.map((page) => ({ page, accent: page })), key, random),
          duo: new window.VCLifeCore.TShuffleBag(COLOR_PALETTE.flatMap((page) => (
            Array.from({ length: ACCENT_VARIANTS_PER_COLOR }, (_, index) => ({
              page, accent: accentForPage(page, index),
            }))
          )), key, random),
        };
      }
      return colorBags[mode].reserve();
    };

    const withPalettePair = (mode, apply) => {
      const reservation = reservePalettePair(mode);
      if (!reservation) return;
      try {
        apply(reservation.item);
        if (paletteTransaction) paletteReservation = reservation;
        else reservation.commit();
      } finally {
        if (paletteReservation !== reservation) reservation.cancel();
      }
    };

    function syncAccColor({ publish = true } = {}) {
      if (paletteTransaction) return;
      let color = effectiveTextColor();
      if (isBlackScheme() && accentEnabled) {
        if (vcardPlaylistStyleLocked()) {
          color = accColorValue;
        } else {
          const nightAccent = getComputedStyle(root)
            .getPropertyValue("--vc-night-accent").trim() || "#ffd400";
          const brightNightPair = currentPreset === 'night'
            && nightTone === 'accent'
            && textColorValue === 'white'
            && accColorValue.toLowerCase() === nightAccent.toLowerCase();
          // Only the white/yellow Night pair keeps its full-brightness accent.
          color = brightNightPair ? accColorValue : withAccentAdjustments(accColorValue);
        }
      } else if (isBlackScheme() && monoColorEnabled) {
        color = effectiveTextColor();
      }
      root.dataset.accent = accentEnabled ? 'on' : 'off';
      root.style.setProperty("--vc-acc", color);
      if (publish) document.dispatchEvent(new CustomEvent("vcardacccolorchange", {
        detail: { color }
      }));
      if (publish) publishAppliedPalette();
    }

    function setAccent(enabled, { persist = true, force = false } = {}) {
      if (vcardPlaylistStyleLocked() && !force) return;
      accentEnabled = Boolean(enabled);
      if (persist && !vcardAutopilotEnabled()) {
        vcardStorage.local.setItem(ACCENT_STORAGE_KEY, accentEnabled ? "on" : "off");
      }
      syncAccColor();
      document.dispatchEvent(new CustomEvent("vcard:accent-state", {
        detail: { enabled: accentEnabled }
      }));
    }

    document.addEventListener("vcard:set-accent", (event) => {
      setAccent(Boolean(event.detail && event.detail.enabled));
    }, { signal: paletteSignal });


    function setMonoColor(enabled, { persist = true, force = false } = {}) {
      if (vcardPlaylistStyleLocked() && !force) return;
      monoColorEnabled = Boolean(enabled);
      if (persist && !vcardAutopilotEnabled()) {
        vcardStorage.local.setItem(MONO_COLOR_STORAGE_KEY, monoColorEnabled ? "on" : "off");
      }
      const monoActive = !isBlackScheme() || monoColorEnabled;
      syncAccColor();
      document.dispatchEvent(new CustomEvent("vcard:mono-color-state", {
        detail: { enabled: monoActive }
      }));
    }

    function setTextColor(color) {
      textColorValue = color;
      if (paletteTransaction) return;
      beginPaletteTransition();
      const effectiveColor = effectiveTextColor();
      root.style.setProperty("--vc-page", effectiveColor);
      root.dataset.authorCommentMuted = isBlackScheme() ? 'on' : 'off';
      tintFlood.setAttribute("flood-color", effectiveColor);
      const mutedColor = getComputedStyle(document.body).color || effectiveColor;
      emojiTintFlood.setAttribute("flood-color", mutedColor);
      songEmojiTintFlood.setAttribute("flood-color", effectiveColor);
      videoTintFlood.setAttribute("flood-color", effectiveColor);
      syncAccColor({ publish: false });
      document.dispatchEvent(new CustomEvent("vcardtextcolorchange", {
        detail: { color: effectiveColor }
      }));
      document.dispatchEvent(new CustomEvent("vcardacccolorchange", {
        detail: { color: root.style.getPropertyValue('--vc-acc') }
      }));
      publishAppliedPalette();
    }

    function setPalette(text) {
      textColorValue = text;
      setTextColor(text);
    }

    function setPalettePair(page, accent) {
      textColorValue = page;
      accColorValue = accent;
      setTextColor(page);
    }

    function refreshPalette() {
      if (!isBlackScheme()) {
        setPalettePair("black", "black");
      } else {
        withPalettePair('duo', (pair) => setPalettePair(pair.page, pair.accent));
      }
    }

    function publishPreset(key, { sync = true } = {}) {
      currentPreset = String(key || '');
      if (key) {
        root.dataset.colorPreset = key;
      } else {
        delete root.dataset.colorPreset;
      }
      // Palette setters run before the preset is published; refresh its exception.
      if (sync) syncAccColor();
      document.querySelectorAll("[dd-preset]").forEach((link) => {
        if (link.closest('#vcard-settings-dialog')) return;
        const selected = Boolean(key) && link.getAttribute("dd-preset") === key;
        link.classList.toggle("is-selected", selected);
        link.setAttribute("aria-current", selected ? "true" : "false");
      });
      document.dispatchEvent(new CustomEvent("vcard:preset-state", {
        detail: { key }
      }));
      window.VCLife?.publish();
    }

    function markCustomPreset() {
      if (paletteSignal.aborted) return;
      if (!vcardAutopilotEnabled()) vcardStorage.local.setItem(PRESET_STORAGE_KEY, "custom");
      publishPreset("");
    }

    const presetAvailable = (key) => !paletteSignal.aborted && !vcardPlaylistStyleLocked()
      && ['night', 'mono', 'duo', 'newspaper'].includes(key);
    const presetCommandAvailable = (input = {}) => {
      const { target, preset } = input;
      if (!presetAvailable(preset) || !target?.isConnected) return false;
      if (target.disabled || target.getAttribute('aria-disabled') === 'true') return false;
      if ((target.getAttribute('dd-preset') || target.dataset.vcardPreset) !== preset) return false;
      if (target.closest('#vcard-settings-dialog')) return Boolean(window.VCardSettingsContext?.canPreset(input));
      return true;
    };
    const applyPresetCommand = (input) => {
      if (!presetCommandAvailable(input)) return false;
      applyPreset(input.preset);
      return true;
    };

    function applyPreset(key, { persist = true } = {}) {
      if (!presetAvailable(key)) return;

      beginPaletteTransition();
      paletteTransaction = true;
      try {
        const cycleActiveNight = key === 'night' && currentPreset === 'night';
        const useNightMono = cycleActiveNight && nightTone !== 'mono';
        if (persist && !vcardAutopilotEnabled()) vcardStorage.local.setItem(PRESET_STORAGE_KEY, key);
        document.documentElement.style.removeProperty("--vc-win");
        if (key !== 'night') { nightTone = ''; delete root.dataset.nightTone; }
        if (key === 'newspaper') {
          document.dispatchEvent(new CustomEvent("vcard:set-color-scheme", {
            detail: { key: "white", persist }
          }));
          setMonoColor(true, { persist });
          setPalettePair("black", "black");
          setAccent(false, { persist });
        } else if (key === 'mono') {
          withPalettePair('mono', (pair) => {
            document.dispatchEvent(new CustomEvent("vcard:set-color-scheme", {
              detail: { key: "black", persist }
            }));
            setMonoColor(true, { persist });
            setPalettePair(pair.page, pair.accent);
            setAccent(false, { persist });
          });
        } else if (key === 'duo') {
          withPalettePair('duo', (pair) => {
            document.dispatchEvent(new CustomEvent("vcard:set-color-scheme", {
              detail: { key: "black", persist }
            }));
            setMonoColor(true, { persist });
            setPalettePair(pair.page, pair.accent);
            setAccent(true, { persist });
          });
        } else {
          nightTone = useNightMono ? 'mono' : 'accent';
          root.dataset.nightTone = nightTone;
          document.dispatchEvent(new CustomEvent("vcard:set-color-scheme", {
            detail: { key: "black", persist }
          }));
          if (useNightMono) {
            setMonoColor(true, { persist });
            setPalettePair("white", "white");
            setAccent(false, { persist });
          } else {
            setMonoColor(false, { persist });
            const nightAccent = getComputedStyle(root)
              .getPropertyValue("--vc-night-accent")
              .trim() || "#ffd400";
            setPalettePair("white", nightAccent);
            setAccent(true, { persist });
          }
        }
        currentPreset = key;
        root.dataset.colorPreset = currentPreset;
      } finally {
        paletteTransaction = false;
        try {
          setTextColor(textColorValue);
          paletteReservation?.commit();
        } finally {
          paletteReservation?.cancel();
          paletteReservation = null;
        }
      }
      publishPreset(key, { sync: false });
    }

    document.addEventListener("vcardcolorschemechange", () => {
      if (
        isBlackScheme()
        && textColorValue === "black"
      ) {
        textColorValue = "white";
        accColorValue = getComputedStyle(root)
          .getPropertyValue("--vc-night-accent")
          .trim() || "#ffd400";
      }
      setTextColor(textColorValue);
    }, { signal: paletteSignal });

    document.addEventListener("vcard:set-mono-color", (event) => {
      if (vcardPlaylistStyleLocked()) return;
      const enabled = Boolean(event.detail && event.detail.enabled);
      setMonoColor(enabled);
      if (!enabled) refreshPalette();
      markCustomPreset();
    }, { signal: paletteSignal });

    document.addEventListener("click", (event) => {
      const preset = event.target.closest("[dd-preset]");
      if (preset) {
        event.preventDefault();
        const input = { type: 'Color.Preset', source: 'Page', target: preset,
          preset: preset.getAttribute('dd-preset'), trusted: event.isTrusted };
        if (!window.VCCommands) applyPresetCommand(input);
        else window.VCCommands.dispatch(input);
        return;
      }

      if (event.target.closest(':is(a, button)[data-color-scheme]')) return;
    }, { signal: paletteSignal });

    const playlistStyle = (listId) => {
      const button = Array.from(document.querySelectorAll('.tabs__item[list]'))
        .find((item) => item.getAttribute('list') === listId);
      if (!button) return null;
      const page = String(button.dataset.vcStylePage || '').trim();
      const accent = String(button.dataset.vcStyleAccent || '').trim();
      return page && accent ? { page, accent } : null;
    };

    const storedPreset = () => {
      const value = vcardStorage.local.getItem(PRESET_STORAGE_KEY);
      return ['night', 'mono', 'duo', 'newspaper'].includes(value) ? value : 'duo';
    };

    const applyPlaylistStyle = (listId, { changed = false } = {}) => {
      if (vcardAutopilotEnabled()) {
        playlistStyleLocked = false;
        delete root.dataset.playlistStyleLocked;
        delete root.dataset.playlistStyle;
        return;
      }
      const style = playlistStyle(listId);
      if (style) {
        playlistStyleLocked = true;
        root.dataset.playlistStyleLocked = 'on';
        root.dataset.playlistStyle = listId;
        document.dispatchEvent(new CustomEvent("vcard:set-color-scheme", {
          detail: { key: "black", force: true, persist: false }
        }));
        setMonoColor(true, { persist: false, force: true });
        setPalettePair(style.page, style.accent);
        setAccent(true, { persist: false, force: true });
        publishPreset("");
        return;
      }

      const wasLocked = vcardPlaylistStyleLocked();
      playlistStyleLocked = false;
      delete root.dataset.playlistStyleLocked;
      delete root.dataset.playlistStyle;
      const preset = storedPreset();
      if (wasLocked || changed) {
        applyPreset(preset);
      }
    };

    document.addEventListener('vcard:playlist-change', (event) => {
      const detail = event.detail || {};
      applyPlaylistStyle(detail.listId, { changed: Boolean(detail.changed) });
    }, { signal: paletteSignal });

    document.addEventListener('vcard:autopilot-state', (event) => {
      playlistStyleLocked = false;
      delete root.dataset.playlistStyleLocked;
      delete root.dataset.playlistStyle;
      if (event.detail?.enabled) applyPreset('duo', { persist: false });
      else {
        applyPreset(storedPreset(), { persist: false });
        applyPlaylistStyle(window.VCardPlaylist?.current().listId || '');
      }
    }, { signal: paletteSignal });

    window.VCardDecoration = Object.freeze({
      applyShowPreset: (key) => {
        if (!['mono', 'duo'].includes(key) || !presetAvailable(key)) return false;
        if (currentPreset !== key) applyPreset(key, { persist: false });
        return true;
      },
      clearPreset: markCustomPreset,
      current: () => Object.freeze({
        preset: currentPreset, nightTone, paletteReady,
        playlistStyleLocked: vcardPlaylistStyleLocked(),
        monoColor: !isBlackScheme() || monoColorEnabled ? 'on' : 'off',
        accent: accentEnabled ? 'on' : 'off',
        randomColor: vcardSettingEnabled('vcard-random-color', 'random-color', 'on') ? 'on' : 'off',
      }),
      presetAvailable,
      canPreset: presetCommandAvailable,
      applyPreset: applyPresetCommand,
      autopilotEnabled: vcardAutopilotEnabled,
      initializeColors: () => {
        if (paletteSignal.aborted || paletteReady) return;
        const listId = window.VCardPlaylist?.current().listId || '';
        if (!vcardAutopilotEnabled() && playlistStyle(listId)) {
          applyPlaylistStyle(listId);
        } else {
          applyPreset(vcardAutopilotEnabled() ? 'duo' : storedPreset(), { persist: false });
          if (listId) applyPlaylistStyle(listId);
        }
        paletteReady = true;
        root.dataset.paletteReady = 'on';
      },
      colorBagSnapshot: () => colorBags && Object.fromEntries(
        Object.entries(colorBags).map(([mode, bag]) => [mode, {
          total: bag.items.length, remaining: bag.remaining.length,
          last: bag.last, reserved: bag.reservation ? bag.key(bag.reservation.item) : null,
        }])
      ),
      refreshActiveColor: ({ reason = '' } = {}) => {
        if (paletteSignal.aborted) return { changed: false, reason: 'page-disposed' };
        if (!vcardAutopilotEnabled()) {
          return { changed: false, reason: 'autopilot-off', preset: storedPreset() };
        }
        playlistStyleLocked = false;
        delete root.dataset.playlistStyleLocked;
        delete root.dataset.playlistStyle;
        const preset = currentPreset || 'duo';
        const before = `${root.style.getPropertyValue('--vc-page')}/${root.style.getPropertyValue('--vc-acc')}`;
        applyPreset(preset);
        const after = `${root.style.getPropertyValue('--vc-page')}/${root.style.getPropertyValue('--vc-acc')}`;
        return { changed: before !== after, reason: reason || 'refresh', preset };
      },
      refreshBackground: ({ reason = '', commitColor = null } = {}) => {
        if (paletteSignal.aborted) return { changed: false, reason: 'page-disposed' };
        if (!vcardAutopilotEnabled()) {
          return { changed: false, reason: 'autopilot-off' };
        }
        const result = window.VCardBackgroundControl?.randomize?.({ soft: true, commitColor }) || {
          changed: false,
          reason: 'background-control-unavailable',
        };
        return { ...result, trigger: reason || 'refresh' };
      },
    });

    vcardMedia.refresh();
  })();
  (() => {
    const STORAGE_KEY = "vcard-song-scale";
    const textScaleScope = new AbortController();
    const { signal: textScaleSignal } = textScaleScope;
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) textScaleScope.abort();
    }, { signal: textScaleSignal });

    const fontSizes = {
      xs: "12px",
      s: "16px",
      m: "20px",
      l: "24px",
      xl: "28px"
    };

    const root = document.documentElement;
    const links = Array.from(document.querySelectorAll("[data-song-scale]"));
    const normalizeScale = (value) => ({
      '75%': 's',
      '100%': 'm',
      '125%': 'l',
      xs: 'xs',
      s: 's',
      m: 'm',
      l: 'l',
      xl: 'xl',
    })[String(value || '').toLowerCase()] || 'm';
    const storedScale = () => normalizeScale(vcardStoredSetting(
      STORAGE_KEY,
      'font-size',
      '100%'
    ));
    let currentScale = storedScale();
    window.VCardTextScale = Object.freeze({ current: () => currentScale });

    function applyScale(key) {
      if (textScaleSignal.aborted) return;
      if (!fontSizes[key]) key = "m";
      currentScale = key;

      root.style.setProperty("--font-size", fontSizes[key]);
      vcardStorage.local.setItem(STORAGE_KEY, key);

      links.forEach((link) => {
        link.classList.toggle("is-active", link.dataset.songScale === key);
      });
      document.dispatchEvent(new CustomEvent("vcard:font-scale-state", {
        detail: { key }
      }));
    }

    document.addEventListener("vcard:set-font-scale", (event) => {
      applyScale(event.detail && event.detail.key);
    }, { signal: textScaleSignal });

    document.addEventListener("vcard:request-font-scale-state", () => {
      document.dispatchEvent(new CustomEvent("vcard:font-scale-state", {
        detail: { key: storedScale() }
      }));
    }, { signal: textScaleSignal });

    links.forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        applyScale(link.dataset.songScale);
      }, { signal: textScaleSignal });
    });

    applyScale(storedScale());
  })();
