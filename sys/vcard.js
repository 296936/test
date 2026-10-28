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
      if (event.target?.closest?.('.vcard-list-dialog')) return;
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
const vcardInstanceName = String(window.VCardUI?.instName || new URL('.', location.href).pathname).trim();
const vcardStoragePrefix = `vcard:${encodeURIComponent(vcardInstanceName)}:`;
const vcardPhysicalKey = (key) => `${vcardStoragePrefix}${key}`;
const vcardFaqSection = document.querySelector('.faq-block[data-faq-first-visit-collapse]');
const vcardFaqQuestions = vcardFaqSection
  ? Array.from(vcardFaqSection.querySelectorAll(':scope > details')) : [];
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
  const enumSetting = (key, values, fallback, css = key.replace(/^vcard-/, ''), aliases = {}) => {
    const defaultValue = () => {
      const value = css ? vcardCssDefault(css, fallback).toLowerCase() : fallback;
      return values.includes(aliases[value] || value) ? aliases[value] || value : fallback;
    };
    add(key, choice(values, defaultValue, aliases), defaultValue);
  };
  for (const [key, css, fallback] of [
    ['images-visible', 'images-visible', 'on'], ['trackplay', 'trackplay', 'on'],
  ]) enumSetting(`vcard-${key}`, ['on', 'off'], fallback, css);
  enumSetting('vcard-portal-size', ['small', 'mid'], 'small');
  enumSetting('vcard-playlist-alternation', ['none', 'previous', 'next', 'repeat', 'random'], 'random');
  enumSetting('vcard-song-alternation', ['none', 'sequential', 'repeat', 'random'], 'random');
  enumSetting('vcard-volume-boost', ['1', '1.5', '2', '3'], '1');
  enumSetting('vcard-auto-next', ['on', 'off'], 'on');
  enumSetting('vcard-last-preset', ['night', 'mono', 'duo', 'newspaper'], 'duo');
  enumSetting('vcard-preset', ['auto', 'night', 'mono', 'duo', 'newspaper', 'custom'], 'duo');
  enumSetting('vcard-song-scale', ['xs', 's', 'm', 'l', 'xl'], 'm', 'font-size',
    { '75%': 's', '100%': 'm', '125%': 'l' });
  enumSetting('vcard-visualization', ['off', 'h', 'v'], 'v', 'visualization',
    { horizontal: 'h', vertical: 'v' });
  enumSetting('vcard-visualization-choice', ['manual', 'auto', 'off', 'h', 'v'], 'manual');
  if (vcardFaqQuestions.length) {
    add('vcard-faq-intro-seen', choice(['no', 'yes'], () => 'no'), () => 'no');
  }
  const backgroundAliases = { light: 'wallpaper', h: 'wallpaper', horizontal: 'wallpaper', v: 'wallpaper', vertical: 'wallpaper', graph1: 'wallpaper', graph2: 'wallpaper' };
  enumSetting('vcard-background-mode', ['off', 'wallpaper', 'smoke'], 'smoke', 'background-mode', backgroundAliases);
  const brightnessDefault = () => String(Math.max(0, Math.min(5, Number.parseInt(vcardCssDefault('visualization-brightness', '2'), 10) || 0)));
  add('vcard-visualization-brightness', choice(['0', '1', '2', '3', '4', '5'], brightnessDefault), brightnessDefault);
  for (const key of ['vcard-active-playlist']) {
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
  add('vcard-playlist-filter', jsonObject(1, (value) => (
    value.version === 1 && Array.isArray(value.disabled)
      ? { version: 1, disabled: value.disabled.filter((id) => typeof id === 'string') } : null
  )), () => null, 'Session');
  add('vcard-user-playlists', jsonObject(1, (value) => (
    value.version === 1 && Array.isArray(value.lists)
      ? { version: 1, lists: value.lists, excluded: value.excluded || {} } : null
  )), () => null, 'UserData');
  add('aliswb:vclife:stats', jsonObject(1, (value) => value.version === 1 ? {
    ...value, lifetime: { counters: { ...(value.lifetime?.counters || {}) }, last: { ...(value.lifetime?.last || {}) } },
    sessions: Array.isArray(value.sessions) ? value.sessions.slice(-10) : [],
    currentSession: value.currentSession && typeof value.currentSession === 'object' ? value.currentSession : null,
  } : null), () => null, 'Statistics');
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
        const version = Number(backend?.getItem(vcardPhysicalKey('vcard-storage-schema')) || 0);
        if (version > vcardStorageSchemaVersion) {
          canMigrate = false;
          errors.push({ area: name, message: `Storage schema ${version} is newer than ${vcardStorageSchemaVersion}; automatic writes skipped` });
        }
      } catch (error) { report(error); }
    }
    const migrateStructured = (definition) => {
      let value;
      try { value = backend?.getItem(vcardPhysicalKey(definition.key)) ?? null; }
      catch (error) { report(error); return; }
      inspectVersion(definition.key, value, definition);
      if (value === null || futureKeys.has(definition.key)) return;
      const normalized = definition.normalize(value);
      if (canMigrate && normalized !== value) {
        if (normalized === null || normalized === 'null') storage.removeItem(definition.key);
        else storage.setItem(definition.key, normalized);
      }
    };
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
          const value = backend.getItem(vcardPhysicalKey(key));
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
            inspectVersion(key, backend.getItem(vcardPhysicalKey(key)), definition);
            if (futureKeys.has(key)) return false;
          }
          backend.setItem(vcardPhysicalKey(key), String(value));
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
          inspectVersion(key, backend.getItem(vcardPhysicalKey(key)), vcardStorageSchema[key]);
          if (futureKeys.has(key)) return false;
          backend.removeItem(vcardPhysicalKey(key));
          pending.delete(key);
          return true;
        } catch (error) { report(error); return false; }
      },
      clear() {
        memory.clear();
        pending.clear();
        cleared = true;
        if (!backend) return false;
        try {
          const keys = Array.from({ length: backend.length }, (_, index) => backend.key(index))
            .filter((key) => key?.startsWith(vcardStoragePrefix)
              && key !== vcardPhysicalKey('tvcm-profile-v1'));
          keys.forEach((key) => backend.removeItem(key));
          cleared = false;
          return true;
        }
        catch (error) { report(error); return false; }
      },
      available: () => Boolean(backend) && !reported && canMigrate,
    };
    const raw = new Map();
    for (const definition of definitions.filter((item) => item.group === 'Preferences')) {
      try { raw.set(definition.key, backend?.getItem(vcardPhysicalKey(definition.key)) ?? null); }
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
      migrateStructured(definition);
    }
    if (areaName === 'local') {
      // Retired transient flags have no successor value; schema acknowledgement
      // must reach disk before removing them.
      if (canMigrate && pending.size === 0 && storage.setItem('vcard-storage-schema', vcardStorageSchemaVersion)) {
        for (const key of ['vcard-portal-view', 'vcard-portal-fullscreen', 'vcard-player-simplified', 'vcard-auto-color', 'vcard-win-color', 'vcard-media-cache-session-v1']) storage.removeItem(key);
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
    instanceName: vcardInstanceName, prefix: vcardStoragePrefix, key: vcardPhysicalKey,
    schemaVersion: vcardStorageSchemaVersion, ready: true, snapshot });
})();
window.VCardStorage = vcardStorage;

// FAQ is open by default. Only the first visit in this browser starts with
// the instance-configured introductory questions collapsed, except the sitemap.
const vcardInitializeFaq = () => {
  if (!vcardFaqQuestions.length) return;
  const count = Number.parseInt(vcardFaqSection.dataset.faqFirstVisitCollapse, 10);
  if (!Number.isInteger(count) || count <= 0) return;
  if (vcardStorage.local.getItem('vcard-faq-intro-seen') === 'yes') return;
  vcardFaqQuestions.slice(0, count)
    .filter((item) => !item.querySelector(':scope > summary#sitemap'))
    .forEach((item) => { item.open = false; });
  vcardStorage.local.setItem('vcard-faq-intro-seen', 'yes');
};
vcardInitializeFaq();

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


window.VCardAutoNext = Object.freeze({
  current: () => vcardStorage.local.getItem('vcard-auto-next') === 'off' ? 'off' : 'on',
  set(value) {
    vcardStorage.local.setItem('vcard-auto-next', value === 'off' ? 'off' : 'on');
    const chain = window.VCLife?.playbackChain;
    if (value === 'off' && chain?.phase === 'NextPending') chain.finishStopped(chain.playback);
    window.VCLife?.publish();
  },
});

window.VCardUserActivity = (() => {
  let until = 0;
  let menu = false;
  let scrollbarHeld = false;
  const touch = () => {
    until = performance.now() + 5000;
    window.VCLife?.playbackChain?.resetNextCountdown?.();
    document.dispatchEvent(new CustomEvent('vcard:user-activity'));
  };
  window.addEventListener('wheel', (event) => {
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) touch();
  }, { passive: true, capture: true });
  window.addEventListener('touchmove', touch, { passive: true, capture: true });
  window.addEventListener('keydown', (event) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
      && !event.target.closest('input, textarea, select, [contenteditable="true"]')) touch();
  }, { capture: true });
  window.addEventListener('pointerdown', (event) => {
    if (event.clientX >= document.documentElement.clientWidth) { scrollbarHeld = true; touch(); }
  }, { passive: true });
  window.addEventListener('pointermove', () => { if (scrollbarHeld) touch(); }, { passive: true });
  const releaseScrollbar = () => { if (scrollbarHeld) { scrollbarHeld = false; touch(); } };
  window.addEventListener('pointerup', releaseScrollbar, { passive: true });
  window.addEventListener('pointercancel', releaseScrollbar, { passive: true });
  window.addEventListener('blur', releaseScrollbar);
  return Object.freeze({ touch, remaining: () => Math.max(0, (until - performance.now()) / 1000),
    blocked: () => menu || scrollbarHeld || performance.now() < until,
    menuOpen: () => menu,
    setMenu(open) { menu = Boolean(open); touch(); },
  });
})();

// The director flag is published configuration; subsequent locking is owned
// by decoration. DOM attributes below are projections, never policy inputs.
const directorStyleLocked = document.documentElement.hasAttribute('data-director-style-locked');
const vcardColorSettingsLocked = () => directorStyleLocked;

let vcardPublishedMediaVersions = null;
let vcardPublishedAudioPaths = null;
const vcardAudioPublished = (url) => {
  const resources = window.VCardMediaManifest?.resources;
  if (!Array.isArray(resources) || !url || url.origin !== location.origin) return true;
  if (!vcardPublishedAudioPaths) {
    vcardPublishedAudioPaths = new Set();
    for (const item of resources) {
      // Older manifests did not classify resources; retain their membership
      // fallback. Current builds need only their published audio entries here.
      if (item.kind && item.kind !== 'audio') continue;
      vcardPublishedAudioPaths.add(new URL(item.url, document.baseURI).pathname);
    }
  }
  return vcardPublishedAudioPaths.has(url.pathname);
};
const vcardPublishedMediaUrl = (value) => {
  const url = new URL(value, document.baseURI);
  if (url.origin !== location.origin || url.searchParams.has('v')) return url.href;
  if (!vcardPublishedMediaVersions) {
    vcardPublishedMediaVersions = new Map();
    for (const item of window.VCardMediaManifest?.resources || []) {
      const published = new URL(item.url, document.baseURI);
      vcardPublishedMediaVersions.set(published.pathname, published.searchParams.get('v'));
    }
  }
  const version = vcardPublishedMediaVersions.get(url.pathname);
  if (version) url.searchParams.set('v', version);
  return url.href;
};

const vcardMediaCache = (() => {
  const CACHE_NAME = vcardPhysicalKey('media-v1');
  const cacheChannel = (() => {
    try { return new BroadcastChannel(`${CACHE_NAME}:control`); } catch (_) { return null; }
  })();
  const MEDIA_PATH = /\/(?:sys|usr)\//i;
  const MEDIA_EXT = /\.(?:aac|aiff?|avif|flac|gif|jpe?g|m4a|m4v|mov|mp3|mp4|oga|ogg|ogv|opus|png|svg|wav|webm|webp)$/i;
  const AUDIO_EXT = /\.(?:aac|aiff?|flac|m4a|mp3|oga|ogg|opus|wav)$/i;
  const scope = new AbortController();
  const sessionResources = new Map();
  let resourceObserver = null;
  let scheduleNonAudioCache = null;
  let cacheGeneration = 0;
  const cacheRequests = new Set();

  const recordSessionResource = (value, source = 'loaded', bytes = 0, replaceBytes = false) => {
    if (scope.signal.aborted || !isMediaUrl(value)) return;
    const url = new URL(value, document.baseURI).href;
    const previous = sessionResources.get(url);
    if (!previous) {
      sessionResources.set(url, { source, bytes: Math.max(0, Number(bytes) || 0) });
      return;
    }
    const nextBytes = Math.max(0, Number(bytes) || 0);
    previous.bytes = replaceBytes
      ? Math.max(previous.bytes, nextBytes)
      : previous.bytes + nextBytes;
    // A service-worker answer is authoritative.  A performance entry seen
    // earlier is only a fallback and must not turn a real cache hit into a load.
    if (source === 'cached') previous.source = 'cached';
  };

  const isMediaUrl = (value) => {
    try {
      const url = new URL(value, document.baseURI);
      return url.origin === location.origin && MEDIA_PATH.test(url.pathname)
        && (MEDIA_EXT.test(url.pathname) || /\/usr\/texts\/[^/]+\.json$/i.test(url.pathname));
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
    const generation = cacheGeneration;
    const currentUrl = new URL(currentRequest.url);
    if (!currentUrl.searchParams.has('v')) return;
    const keys = await cache.keys();
    if (scope.signal.aborted || generation !== cacheGeneration) return;
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

  let backgroundTail = Promise.resolve();
  const hasComplete = async (urls, signal = null) => {
    if (scope.signal.aborted || signal?.aborted || !urls?.length || !('caches' in window)) return false;
    const generation = cacheGeneration;
    const current = () => !scope.signal.aborted && !signal?.aborted && generation === cacheGeneration;
    try {
      const cache = await caches.open(CACHE_NAME);
      for (const source of urls) {
        if (!current()) return false;
        const response = await cache.match(new URL(source, document.baseURI).href);
        if (!response?.ok || response.status === 206 || response.headers.has('Content-Range')) return false;
      }
      return current();
    } catch (_error) { return false; }
  };

  const enqueue = (task, signal = null) => {
    const work = backgroundTail.then(() => {
      if (!scope.signal.aborted && !signal?.aborted) return task();
    });
    backgroundTail = work.catch(() => {});
    return work;
  };
  const cacheUrls = async (urls, onProgress = null, { signal = null, required = false, prepare = null, concurrency = 3 } = {}) => {
    if (scope.signal.aborted || signal?.aborted) {
      if (required) throw new DOMException('Media caching cancelled', 'AbortError');
      return;
    }
    if (!required && !('caches' in window)) return;
    const generation = cacheGeneration;
    const current = () => !scope.signal.aborted && !signal?.aborted && generation === cacheGeneration;
    if (navigator.storage?.persist) {
      try { await navigator.storage.persist(); } catch (_error) { }
    }
    if (generation !== cacheGeneration) return;
    let cache = null;
    try { if ('caches' in window) cache = await caches.open(CACHE_NAME); }
    catch (error) { if (!required) throw error; }
    if (generation !== cacheGeneration) return;
    const unique = [...new Map((urls || [])
      .filter((item) => isMediaUrl(typeof item === 'string' ? item : item?.url))
      .map((item) => {
        const url = new URL(typeof item === 'string' ? item : item.url, document.baseURI).href;
        return [url, typeof item === 'string' ? { url, size: 0 } : { ...item, url }];
      })).values()];
    const progress = { total: unique.length, completed: 0, cached: 0, loaded: 0, failed: 0, bytes: 0 };
    const failedUrls = [];
    const reportProgress = () => { if (current()) onProgress?.({ ...progress }); };
    reportProgress();
    let cursor = 0;
    const cacheOne = async () => {
      while (cursor < unique.length && current()) {
        const item = unique[cursor++];
        let controller = null;
        let timeout = 0;
        const abort = () => controller?.abort();
        try {
          const request = new Request(item.url);
          let source = 'cached';
          let response = null;
          try { response = await cache?.match(request); }
          catch (error) {
            cache = null;
            console.warn('VCard media cache read unavailable; using network', error);
          }
          if (!current()) return;
          if (!response?.ok || response.status === 206 || response.headers.has('Content-Range')) {
            source = 'loaded';
            controller = new AbortController();
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) controller.abort();
            cacheRequests.add(controller);
            // Cover the response body too: headers alone do not complete Preload.
            timeout = window.setTimeout(() => controller.abort(), 30000);
            response = await fetch(request, { cache: 'force-cache', credentials: 'same-origin', signal: controller.signal });
            if (!response.ok || response.status === 206 || response.headers.has('Content-Range')
              || !current()) throw new Error('Media response is unavailable');
            // Cache Storage consumes the entire response before resolving put.
            if (cache) {
              try {
                await cache.put(request, response.clone());
                if (!current()) return;
                await discardObsoleteVersions(cache, request);
              } catch (error) {
                if (!current()) return;
                cache = null;
                console.warn('VCard media cache write unavailable; using downloaded resource', error);
                await response.arrayBuffer();
              }
            } else await response.arrayBuffer();
          }
          if (!current()) return;
          if (prepare) await prepare(item.url, signal);
          if (!current()) return;
          const bytes = Math.max(
            0,
            Number(item.size) || Number(response?.headers.get('Content-Length')) || 0
          );
          recordSessionResource(item.url, source, bytes, true);
          progress[source] += 1;
          progress.bytes += bytes;
        } catch (_error) {
          progress.failed += 1;
          failedUrls.push(item.url);
          if (current()) console.warn(`VCard media preload failed: ${item.url}`, _error);
        } finally {
          window.clearTimeout(timeout);
          signal?.removeEventListener('abort', abort);
          if (controller) cacheRequests.delete(controller);
          progress.completed += 1;
          reportProgress();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, cacheOne));
    if (required && !current()) throw new DOMException('Media caching cancelled', 'AbortError');
    if (required && progress.failed) {
      const error = new Error(`Song media preload failed: ${progress.failed} file(s): ${failedUrls.join(', ')}`);
      error.songAudioRequired = failedUrls.some(isAudioUrl);
      throw error;
    }
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
    cacheChannel?.close();
  }, { once: true });
  cacheChannel?.addEventListener('message', (event) => {
    if (event.data?.type === 'clear') {
      cancelPendingCache();
      sessionResources.clear();
    }
    if (event.data?.type === 'cleared') document.dispatchEvent(new CustomEvent('vcard:media-cache-change'));
  }, { signal: scope.signal });
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) scope.abort();
  }, { signal: scope.signal });
  const clear = async () => {
    if (scope.signal.aborted || !('caches' in window)) return false;
    cancelPendingCache();
    cacheChannel?.postMessage({ type: 'clear' });
    sessionResources.clear();
    try { performance.clearResourceTimings(); } catch (_error) { }
    const cleared = await caches.delete(CACHE_NAME);
    cacheChannel?.postMessage({ type: 'cleared' });
    if (!scope.signal.aborted) document.dispatchEvent(new CustomEvent('vcard:media-cache-change'));
    return cleared;
  };
  return {
    CACHE_NAME,
    cacheLoadedNonAudioMedia,
    cacheUrls,
    hasComplete,
    enqueue,
    clear,
    getStats,
    manifestStats,
    preloadAll,
  };
})();

window.vcardMediaCache = vcardMediaCache;

// Resolve at click time: playback/navigation can change the current song.
document.getElementById('vcard-mini-link')?.addEventListener('click', (event) => {
  const target = new URL('m/', location.href);
  const current = new URL(location.href);
  for (const key of ['list', 'song']) {
    if (current.searchParams.has(key)) target.searchParams.set(key, current.searchParams.get(key));
  }
  event.currentTarget.href = target.href;
});

const vcardSettingEnabled = (storageKey, defaultName, fallback = 'on') => (
  vcardStoredSetting(storageKey, defaultName, fallback).toLowerCase() !== 'off'
);

const vcardHorizontalWaveActive = () => document.documentElement.dataset.visualizationMode === 'h'
  && document.documentElement.dataset.visBri !== '0' && vcardVisualizationAvailable()
  && window.VCardMotionPolicy?.snapshot().renderingActive !== false;

const vcardHorizontalWaveBounds = ({ forReading = false } = {}) => {
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
    // The graph may fall back to the full viewport; text must stay below the portal.
    if (spaceBelow > 1 && (forReading || spaceBelow >= viewportHeight * portalSpaceMinimum)) {
      return { top, bottom: viewportHeight, height: spaceBelow };
    }
    if (forReading) return null;
  }
  return { top: 0, bottom: viewportHeight, height: viewportHeight };
};

const vcardUiConfig = window.VCardUI || {};
if (vcardUiConfig.siteMedia?.textDivider) {
  const dividerUrl = new URL(vcardUiConfig.siteMedia.textDivider, document.baseURI).href;
  document.documentElement.style.setProperty('--vc-text-divider-image', `url(${JSON.stringify(dividerUrl)})`);
  document.documentElement.dataset.textDivider = 'on';
}
const vcardHints = vcardUiConfig.hints || {};

const vcardPortalConfig = Object.freeze({
  settings: Object.freeze({
    FrameTransitionTime: 0,
    FirstFrameFade: 2,
    FinishFade: 2,
    PlayAniPosterFile: vcardUiConfig.playAniMedia?.poster || '',
    PlayAniVideoFile: vcardUiConfig.playAniMedia?.video || '',
    CrossAniFile: 'usr/v_cross_ani/list.js',
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
      preserveStyleColor: Boolean(directive.preserveStyleColor),
      transitionDuration: Number.isFinite(Number(directive.fade))
        ? Number(directive.fade)
        : configuredFrame.transitionDuration,
    };
  };
  const transition = (preview, verseNumber) => {
    const plan = preview ? effectPlans.get(preview) : null;
    const effects = plan?.verseNumber === verseNumber
      ? (plan.effects || []).filter((item) => ['CrossAni', 'CrossImg'].includes(item.name))
      : [];
    const frameEffect = effects.find((item) => item.name === 'CrossImg') || null;
    const overlayEffect = effects.find((item) => item.name === 'CrossAni') || null;
    return {
      kind: frameEffect && overlayEffect
        ? 'crossimg+crossani'
        : (frameEffect ? 'crossimg' : (overlayEffect ? 'crossani' : 'none')),
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
 * CrossAni is an independent overlay and cannot mutate either main slot.
 */
const portalController = (() => {
  if (!sharedSongAudio) return;

  // Instance-owned animation sets are published from winst/<instance>/usr.
  const portalSettings = vcardPortalPlan.settings();
  const PLAY_ANI_POSTER_FILE = String(
    portalSettings?.PlayAniPosterFile || ''
  );
  const PLAY_ANI_VIDEO_FILE = String(
    portalSettings?.PlayAniVideoFile || ''
  );
  let portalMotionAllowed = vcardMotionPolicy.snapshot().motionAllowed;

  const mediaUrl = vcardPublishedMediaUrl;

  const state = {
    preview: null,
    frame: null,
    layer: null,
    image: null,
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
    started: false,
    firstVerseActivated: false,
    endSequenceStarted: false,
    seeking: false,
    finishMedia: null,
    finishPosterPreparation: null,
    crossAniSource: '',
    crossAniItems: null,
    crossAniPromise: null,
    lastCrossAniSource: '',
    portalClickTimer: 0,
    portalClickPending: false,
    verseSlotKind: '',
    scene: null,
  };

  const portalNumber = (name, fallback = 0) => {
    const value = Number(vcardPortalPlan.settings(state.preview)[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };

  const portalMediaScope = new AbortController();
  portalMediaScope.signal.addEventListener('abort', () => crossAni.reset(null, 'page-died'), { once: true });
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) portalMediaScope.abort();
  }, { signal: portalMediaScope.signal });

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

  const portalAction = () => {
    if (state.action) return state.action;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'song-portal-action';
    action.setAttribute('aria-label', 'Воспроизвести MP3');
    action.innerHTML = [
      `<img class="song-portal-action__logo song-portal-action__logo--play" src="${mediaUrl('sys/playbutton/audio-play.webp')}" alt="" aria-hidden="true" draggable="false">`,
      `<img class="song-portal-action__logo song-portal-action__logo--pause" src="${mediaUrl('sys/playbutton/audio-pause.webp')}" alt="" aria-hidden="true" draggable="false">`,
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
      this.playAniStill = null;
      this.playAniVideo = null;
      this.playAniMotionRequested = false;
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

    ensurePlayAni() {
      if (this.playAniStill && this.playAniVideo) return;
      const media = loadFinishMedia();
      const still = document.createElement('img');
      still.className = 'song-portal-play-ani-still';
      still.alt = '';
      still.draggable = false;
      still.setAttribute('aria-hidden', 'true');
      still.src = media.poster;
      const video = createPortalVideo('play-ani');
      video.preload = 'auto';
      video.loop = true;
      // Keep the separately stretched still until a decoded video frame.
      // Native video posters can briefly fall back to their intrinsic crop.
      setVideoSource(video, media.video);
      this.element.append(still, video);
      this.playAniStill = still;
      this.playAniVideo = video;
      video.addEventListener('error', () => {
        if (this.kind === 'play-ani') this.setPlayAniMotion(false);
      });
      still.addEventListener('error', () => {
        if (this.kind === 'play-ani' && video.hidden) {
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
      this.playAniMotionRequested = false;
      this.element.style.backgroundColor = '';
      this.motionSuppressed = !portalMotionAllowed;
      this.plan = plan;
      this.photoLayer.hidden = false;
      if (this.playAniStill) this.playAniStill.hidden = true;
      if (this.playAniVideo) this.playAniVideo.hidden = true;
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

    preparePlayAni(plan, resourceId, animated = true) {
      this.ensurePlayAni();
      animated = Boolean(animated && portalMotionAllowed);
      this.resourceId = resourceId;
      this.kind = 'play-ani';
      this.plan = plan;
      if (this.photoLayer) this.photoLayer.hidden = true;
      this.setPlayAniMotion(animated);
      return true;
    }

    waitForPlayAniReady(signal = null, preloadVideo = false) {
      if (!preloadVideo && !this.playAniMotionRequested && this.playAniStill && !this.playAniStill.hidden) {
        return vcardMedia.prepareImage(this.playAniStill.src, { signal }).then(() => true, () => false);
      }
      const video = this.playAniVideo;
      if (!video || signal?.aborted) return Promise.resolve(false);
      return vcardMedia.prepareVideo(video, { signal, timeoutMs: 4000 })
        .then(() => true, () => {
          if (signal?.aborted || this.kind !== 'play-ani') return false;
          this.setPlayAniMotion(false);
          return vcardMedia.prepareImage(this.playAniStill.src, { signal }).then(() => true, () => false);
        });
    }

    setPlayAniMotion(animated, reset = false) {
      this.ensurePlayAni();
      animated = Boolean(animated && portalMotionAllowed && !this.playAniVideo.error);
      this.kind = 'play-ani';
      this.playAniMotionRequested = animated;
      if (reset) {
        try { this.playAniVideo.currentTime = 0; } catch (_error) { }
      }
      const ready = animated && this.playAniVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
      this.playAniStill.hidden = ready
        || (this.playAniStill.complete && this.playAniStill.naturalWidth === 0);
      this.playAniVideo.hidden = !animated;
      this.playAniVideo.classList.toggle('is-priming', animated && !ready);
      this.element.style.backgroundColor = this.playAniStill.hidden && this.playAniVideo.hidden ? '#000' : '';
      if (animated) this.playVideo();
      else this.playAniVideo.pause();
    }

    playVideo() {
      if (
        this.kind !== 'play-ani'
        || !this.playAniVideo
        || this.playAniVideo.hidden
        || !portalMotionAllowed
        || ['waiting', 'failed'].includes(state.playback)
        || window.VCLife?.renderingActive === false
        || (sharedSongAudio.paused && this.plan?.phase !== 'finish')
        || !this.playAniVideo.paused
      ) return;
      this.playAniVideo.playbackRate = vcardAnimationPlaybackRate;
      this.playAniVideo.play().catch(() => {});
    }

    pauseVideo() {
      this.playAniVideo?.pause();
    }

    render(now) {
      if (this.kind === 'play-ani') {
        this.setPlayAniMotion(this.playAniMotionRequested);
        // The finish sequence belongs to TransitionClock and continues after
        // the audio element has ended. Ordinary PlayAni slots still freeze
        // together with Pause and Buffering.
        if (sharedSongAudio.paused && this.plan?.phase !== 'finish') this.pauseVideo();
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
      this.playAniMotionRequested = false;
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
      const video = this.playAniVideo;
      const still = this.playAniStill;
      this.playAniVideo = null;
      this.playAniStill = null;
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
      this.playAniRevision = 0;
      this.destroyed = false;
      this.nextResourceId = 1;
      this.frameHandle = 0;
      if (keepImage) this.root.append(sourceLayer);
      else sourceLayer.remove();
      vcardMedia.setActive(sourceImage, false);
      frame.insertBefore(this.root, state.controls || null);
      this.tick = this.tick.bind(this);
      this.scheduleFrame();
    }

    scheduleFrame() {
      if (this.destroyed || this.frameHandle || window.VCLife?.renderingActive === false) return;
      this.frameHandle = vcardRenderScheduler.request(this.tick, { owner: this, priority: 5,
        onCancel: () => { this.frameHandle = 0; } });
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
      this.playAniRevision += 1;
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
            if (reservation?.pending && !signal?.aborted) {
              vcardMedia.cancelPortalFrame(this.sourceImage, reservation);
              reservation = null;
              kind = 'play-ani';
              plan = { ...plan, showFallback: 'loading' };
              slot.preparePlayAni(plan, resourceId, true);
              if (!await slot.waitForPlayAniReady(signal) || signal?.aborted) {
                slot.clear();
                return null;
              }
              break;
            }
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
          slot.preparePlayAni(plan, resourceId, true);
          const ready = await slot.waitForPlayAniReady(signal);
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
      ]);
    }

    show(resource, timing = {}, signal = null, clock = 'audio') {
      if (this.destroyed || resource?.slot?.scene !== this || resource.slot.resourceId !== resource.id) return false;
      if (resource !== this.reserved || signal?.aborted || window.VCLife?.renderingActive === false
        || (clock === 'audio' && resource.plan?.phase !== 'start' && sharedSongAudio.paused)) {
        this.cancel(resource);
        return false;
      }
      if (resource.kind === 'image' && !vcardMedia.commitPortalFrame(this.sourceImage, resource.reservation)) {
        this.cancel(resource);
        return false;
      }
      this.reserved = null;
      resource.shown = true;
      const incoming = resource.slot;
      incoming.element.hidden = false;
      if (resource.kind === 'image') {
        // New photo layers continue the outgoing zoom instead of restarting it.
        const previousLayer = this.current?.photoLayer || this.sourceLayer;
        const previousFloat = previousLayer?.getAnimations()
          .find((animation) => animation.animationName === 'vcard-image-breathe');
        const incomingFloat = incoming.photoLayer?.getAnimations()
          .find((animation) => animation.animationName === 'vcard-image-breathe');
        if (previousFloat?.currentTime != null && incomingFloat) {
          incomingFloat.currentTime = previousFloat.currentTime;
        }
      }
      const keepCurrent = this.current?.kind === 'play-ani' && resource.kind === 'play-ani';
      const animate = this.current && !keepCurrent && portalMotionAllowed;
      const fade = animate ? Math.max(0, Number(timing.fade) || 0) : 0;
      const unfade = animate ? Math.max(0, Number(timing.unfade) || 0) : 0;
      incoming.element.style.opacity = '0';
      if (resource.kind === 'play-ani' && Math.max(fade, unfade)) incoming.playVideo();
      const transition = { resource, outgoing: this.current, incoming,
        startsAt: this.now(clock), fade, unfade, duration: Math.max(fade, unfade), clock, signal, keepCurrent };
      transition.abort = () => { if (this.transition === transition) this.cancel(resource); };
      this.transition = transition;
      signal?.addEventListener('abort', transition.abort, { once: true });
      if (!transition.duration) this.renderTransition();
      return true;
    }

    async showPlayAni({ animated = false, reset = false, phase = 'play', timing = null } = {}) {
      const revision = ++this.playAniRevision;
      while (this.preparing) {
        this.preparationAbort?.abort();
        await this.preparing;
        if (this.destroyed || revision !== this.playAniRevision) return false;
      }
      if (this.destroyed) return Promise.resolve(false);
      if (this.transition) this.cancel(this.transition.resource);
      if (this.reserved) this.cancel(this.reserved);
      if (this.current?.kind === 'play-ani') {
        this.current.plan = { ...this.current.plan, phase, showFallback: 'none' };
        this.current.setPlayAniMotion(animated, reset);
        setPortalStatic(true);
        return Promise.resolve(true);
      }
      const slot = this.freeSlot();
      if (!slot) return Promise.resolve(false);
      const plan = { phase, displayStartsAt: this.now('audio'), displayEndsAt: Infinity };
      const resource = {
        id: this.nextResourceId++, kind: 'play-ani', plan, slot, reservation: null,
      };
      slot.preparePlayAni(plan, resource.id, animated);
      this.reserved = resource;
      resource.playAniMotion = { animated, reset };
      return this.show(resource, timing || {}, null, phase === 'finish' ? 'life' : 'audio');
    }

    renderTransition(audioTime = this.now('audio')) {
      const transition = this.transition;
      if (!transition) return;
      if (transition.signal?.aborted) {
        this.cancel(transition.resource);
        return;
      }
      const now = transition.clock === 'audio' ? audioTime : this.now(transition.clock);
      const elapsed = Math.max(0, now - transition.startsAt);
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
      if (transition.incoming.resourceId !== transition.resource.id
        || window.VCLife?.renderingActive === false) {
        this.cancel(transition.resource);
        return;
      }
      if (transition.keepCurrent) {
        this.current.plan = transition.resource.plan;
        this.current.setPlayAniMotion(true);
        transition.incoming.clear();
      } else {
        transition.outgoing?.clear();
        transition.incoming.element.style.opacity = '1';
        this.current = transition.incoming;
        if (transition.resource.kind === 'play-ani') {
          const motion = transition.resource.playAniMotion;
          if (motion) {
            this.current.setPlayAniMotion(motion.animated, motion.reset);
            setPortalStatic(true);
          }
          else this.current.playVideo();
        }
      }
      this.sourceLayer.remove();
      this.transition = null;
      transition.signal?.removeEventListener('abort', transition.abort);
      transition.resource.completed = true;
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
      // One pass owns timeline decisions and visible scene/overlay rendering.
      render('Timeline.Update', () => {
        const playback = window.VCLife?.playingSong?.playback;
        const environment = playback?.playbackEnvironment;
        if (playback?.song.preview === state.preview && environment?.canRender()) environment.onTick(now);
      }, () => {});
      render('Scene.Transition', () => {
        this.renderTransition(now);
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
      render('Overlay.Render', () => crossAni.render(now), () => crossAni.release('render-failure'));
      this.scheduleFrame();
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
        if (slot.kind === 'play-ani') slot.setPlayAniMotion(false);
        slot.render(this.now('audio'));
      });
      if (this.transition) {
        this.transition.fade = this.transition.unfade = this.transition.duration = 0;
        this.renderTransition();
      }
    }

    resume() {
      if (this.destroyed || window.VCLife?.renderingActive === false) return;
      this.scheduleFrame();
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
    const controls = portalControls();
    // Keep controls outside the breathing motion layer. Their geometry must
    // match the fixed controls of the external video card exactly.
    if (controls.parentElement !== frame) frame.append(controls);
    if (state.clickFrame !== frame) {
      if (state.clickFrame) {
        state.clickFrame.removeEventListener('click', onPortalClick, true);
        state.clickFrame.removeEventListener('pointerdown', onPortalMiddlePress, true);
      }
      frame.addEventListener('click', onPortalClick, { capture: true, signal: portalMediaScope.signal });
      frame.addEventListener('pointerdown', onPortalMiddlePress, { capture: true, signal: portalMediaScope.signal });
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
    if (portalMediaScope.signal.aborted) return;
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
    const preview = button.closest('.song__preview');
    const pending = Boolean(window.VCLife?.songs.get(preview)?.preloading)
      && !window.VCLife?.canReplacePlayback(preview);
    button.disabled = pending || (button === state.action && !button.classList.contains('is-visible'));
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
    const opened = window.VCardSongControls?.currentPreview?.();
    opened?.querySelectorAll('.song-portal-idle-action').forEach((action) => {
      projectPortalButton(action, portalActionFor(opened));
    });
    if (state.frame) {
      let label = state.frame.querySelector('.vcard-next-countdown');
      const count = state.chain.phase === 'NextPending' && !window.VCardUserActivity.menuOpen()
        ? state.chain.countdown : 0;
      if (count && !label) {
        label = document.createElement('span');
        label.className = 'vcard-next-countdown';
        label.setAttribute('role', 'status');
        state.frame.append(label);
      }
      if (label) { label.hidden = !count; label.textContent = count ? String(count) : ''; }
    }
    refreshPortalAction();
    publishPortalControllerState();
  };

  const setPhase = (phase) => {
    state.phase = phase;
    if (phase !== 'finish' && state.controls) delete state.controls.dataset.ending;
    refreshPortalAction();
  };


  new TViewProjection(portalMediaScope, projectPortalState);

  const loadFinishMedia = () => {
    if (state.finishMedia) return state.finishMedia;
    const poster = mediaUrl(PLAY_ANI_POSTER_FILE);
    const video = mediaUrl(PLAY_ANI_VIDEO_FILE);
    state.finishMedia = { video, poster };
    // Prepare the shared poster on first actual PlayAni use, joining slot loads.
    state.finishPosterPreparation = Promise.resolve().then(() => (
      vcardMedia.prepareImage(poster, { signal: portalMediaScope.signal })
    )).catch((error) => {
      if (error?.name !== 'AbortError') console.warn('VCard PlayAni poster: cannot prepare', error);
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

  portalMediaScope.signal.addEventListener('abort', cancelPortalClick, { once: true });
  const portalPlaybackAvailable = ({ preview, target, generation } = {}) => Boolean(
    !portalMediaScope.signal.aborted
    && generation === state.generation && preview?.isConnected
    && preview === window.VCardSongControls?.currentPreview?.()
    && ((preview === state.preview && target === state.frame)
      || (target === preview?.querySelector('.song-vibeframe')
        && target.querySelector(':scope > .song-portal-idle-action')))
    && target?.isConnected && !target.hidden && !target.closest('[inert]')
    && target.getClientRects().length
    && !window.VCardSettingsContext?.isOpen?.()
    && window.VCardCatalogView?.forPreview(preview)?.playable
    && (!window.VCLife?.songs.get(preview)?.preloading || window.VCLife?.canReplacePlayback(preview))
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

  let hoveredPortal = null;
  const clearPortalHover = () => {
    if (hoveredPortal) delete hoveredPortal.dataset.hoverZone;
    hoveredPortal = null;
  };
  document.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse') return;
    const frame = event.target.closest?.('.song-vibeframe');
    if (frame !== hoveredPortal) clearPortalHover();
    if (!frame) return;
    hoveredPortal = frame;
    const rect = frame.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const zone = x > 0.2 && x < 0.8 && y > 0.2 && y < 0.8 ? 'center' : 'edge';
    if (frame.dataset.hoverZone !== zone) frame.dataset.hoverZone = zone;
  }, { passive: true, signal: portalMediaScope.signal });
  document.addEventListener('pointerout', (event) => {
    if (hoveredPortal && !hoveredPortal.contains(event.relatedTarget)) clearPortalHover();
  }, { passive: true, signal: portalMediaScope.signal });
  window.addEventListener('blur', clearPortalHover, { signal: portalMediaScope.signal });
  document.addEventListener('vcard:song-close', clearPortalHover, { signal: portalMediaScope.signal });

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
    { signal: portalMediaScope.signal });

  // Capture portal playback clicks at document level because the frame can be
  // rebuilt while a song opens. Size changes are handled separately by
  // `dblclick` and cancel the delayed playback action above.
  document.addEventListener('click', onPortalClick,
    { capture: true, signal: portalMediaScope.signal });

  const crossAniFiles = (source) => {
    if (!source) return Promise.resolve([]);
    return (source.split(/[?#]/, 1)[0].toLocaleLowerCase().endsWith('.js')
      ? vcardMedia.loadList(source).then((items) => items.map((item) => vcardMedia.listItemUrl(source, item)))
      : Promise.resolve([source]))
      .then((items) => items.filter((item) => /\.(?:mp4|webm|ogv)(?:[?#]|$)/i.test(item)));
  };

  const loadCrossAniItems = () => {
    if (portalMediaScope.signal.aborted) return Promise.resolve([]);
    const configured = String(
      vcardPortalPlan.settings(state.preview).CrossAniFile || ''
    ).trim();
    const source = configured ? mediaUrl(configured) : '';
    if (!source) return Promise.resolve([]);
    if (state.crossAniSource !== source) {
      state.crossAniSource = source;
      state.crossAniItems = null;
      state.crossAniPromise = null;
    }
    if (state.crossAniItems) return Promise.resolve(state.crossAniItems);
    if (state.crossAniPromise) return state.crossAniPromise;
    const current = () => !portalMediaScope.signal.aborted
      && state.crossAniSource === source && state.crossAniPromise === loading;
    const loading = crossAniFiles(source)
      .then((items) => {
        if (!current()) return [];
        state.crossAniItems = items;
        return state.crossAniItems;
      })
      .catch((error) => {
        if (!current() || error?.name === 'AbortError') return [];
        console.warn('VCard portal: cannot load CrossAni media; using CrossImg', error);
        state.crossAniItems = [];
        return state.crossAniItems;
      })
      .finally(() => {
        if (state.crossAniPromise === loading) state.crossAniPromise = null;
      });
    state.crossAniPromise = loading;
    return loading;
  };

  const crossAniStats = (items = state.crossAniItems || []) => {
    const source = state.lastCrossAniSource || '';
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

  const publishCrossAniState = (items = state.crossAniItems || []) => {
    if (portalMediaScope.signal.aborted) return;
    document.dispatchEvent(new CustomEvent('vcard:crossani-state', {
      detail: crossAniStats(items),
    }));
  };

  const adjacentCrossAniSource = (items, direction) => {
    if (!items.length) return '';
    const current = items.indexOf(state.lastCrossAniSource);
    const start = current >= 0 ? current : (direction < 0 ? 0 : -1);
    const index = (start + direction + items.length) % items.length;
    return items[index];
  };

  // One owner holds the interval, media preparation, choice and visible video.
  class TCrossAni {
    constructor() { this.pending = null; this.request = null; this.lastCue = null; }
    get cue() { return this.request?.cue || null; }
    get video() { return this.request?.video || null; }

    current(request) {
      return this.request === request && !request.controller.signal.aborted && !portalMediaScope.signal.aborted
        && !request.owner?.dead && !request.owner?.scope?.signal.aborted
        && state.preview === request.preview && state.frame === request.frame;
    }

    moving() {
      return window.VCLife?.renderingActive !== false && portalMotionAllowed
        && !sharedSongAudio.paused && !sharedSongAudio.ended
        && !['waiting', 'failed'].includes(state.playback) && !state.endSequenceStarted;
    }

    describe(request) {
      return { ...request.cue, crossAniSource: request.source || '', crossAniStart: request.start ?? null,
        crossAniShown: request.shown, status: request.shown
          ? (request.needsSync ? 'suspended' : 'active') : request.ready ? 'ready' : 'preparing' };
    }

    remember(cue, owner, status) { this.lastCue = { owner: owner?.id, cue: { ...cue, status } }; }

    schedule(cue, owner) {
      if (portalMediaScope.signal.aborted || owner?.dead || !cue || cue.name !== 'CrossAni') return false;
      if (this.pending) this.remember(this.pending.cue, this.pending.owner, 'superseded');
      if (this.request?.owner === owner && !this.request.shown) this.release('superseded');
      this.pending = { cue, owner };
      return true;
    }

    async prepare(cue, owner) {
      if (portalMediaScope.signal.aborted || owner?.dead || owner?.scope?.signal.aborted) return;
      const request = { cue, owner, preview: state.preview, frame: state.frame, life: window.VCLife,
        controller: new AbortController(), video: null, reservation: null, ready: false, shown: false };
      this.request = request;
      const abort = () => { if (this.request === request) this.release('owner-ended'); };
      request.abort = abort;
      owner?.scope?.signal.addEventListener('abort', abort, { once: true });
      try {
        const items = await loadCrossAniItems();
        if (!this.current(request)) return;
        const select = () => {
          if (!this.current(request)) return false;
          request.items = items;
          request.reservation = cue.crossAniSource ? null
            : window.VCPlayer.reserveCrossAni(state.crossAniSource, items, cue.decisionOrigin);
          request.source = cue.crossAniSource || request.reservation?.item;
          if (!request.source || !ensurePortal(request.preview)) { this.release('unavailable'); return false; }
          const video = request.video = createPortalVideo('crossani');
          video.loop = Boolean(cue.continuous);
          video.dataset.overlayStartsAt = String(cue.startsAt);
          video.dataset.overlayEndsAt = String(cue.endsAt);
          video.preload = 'auto';
          video.style.setProperty('--vc-crossani-opacity', String(cue.opacity));
          video.style.transitionDuration = '0s';
          request.frame.insertBefore(video, state.controls || null);
          setVideoSource(video, request.source);
          video.addEventListener('error', () => this.fail(request, video.error || new Error('CrossAni media failed')),
            { once: true, signal: request.controller.signal });
          return true;
        };
        const selected = request.life ? await request.life.queue.run(select,
          { type: 'CrossAni.Select', owner, scope: owner?.scope }) : select();
        if (!selected) {
          if (this.current(request)) this.release('selection-failed');
          return;
        }
        if (!this.current(request)) return;
        await vcardMedia.prepareVideo(request.video, {
          signal: request.controller.signal, readyState: HTMLMediaElement.HAVE_CURRENT_DATA,
        });
        if (this.current(request)) { request.ready = true; request.life?.publish(); }
      } catch (error) { this.fail(request, error); }
    }

    fail(request, error) {
      if (error?.name === 'AbortError' || !this.current(request)) return;
      const apply = () => {
        if (!this.current(request)) return;
        request.reservation?.invalidate();
        this.release('failed');
        request.life?.reportFault(error, { type: 'CrossAni.Media', owner: request.owner }, 'ResourceFailure');
      };
      if (!request.life || request.life.queue.current) apply();
      else request.life.queue.run(apply, { type: 'CrossAni.Failed', owner: request.owner, scope: request.owner?.scope });
    }

    sync(request, now) {
      const video = request.video;
      const duration = Number(video.duration);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('CrossAni duration is unavailable');
      request.start ??= request.cue.crossAniStart ?? window.VCPlayer.crossAniStart(request.source, duration,
        request.cue.duration * request.cue.playbackRate, request.cue.minimumStartGap);
      const offset = request.start + Math.max(0, now - request.cue.startsAt) * request.cue.playbackRate;
      try { video.currentTime = request.cue.continuous ? Math.max(0, offset) % duration
        : Math.min(Math.max(0, offset), Math.max(0, duration - 0.05)); } catch (_error) { }
      request.needsSync = false;
    }

    applyColor(request) {
      const slot = state.scene?.transition?.incoming || state.scene?.current;
      const image = slot?.kind === 'image' ? slot.photoImage
        : state.surface === 'photo' ? portalImage(request.preview) : null;
      const bitmap = document.documentElement.dataset.colorPreset === 'newspaper'
        || vcardMedia.mediaStates.get(image)?.frameStyle === 's_bitmap';
      request.video.classList.toggle('is-bitmap', bitmap);
    }

    project(request) {
      if (!request) {
        state.overlay = 'none';
        if (['scene', 'photo'].includes(state.surface)) {
          const photo = state.surface === 'photo' || state.scene?.current?.kind === 'image';
          setPhase(photo ? 'photo' : 'play');
          setControllerMode(photo ? 'photo' : 'play-ani-playing');
        }
        return;
      }
      request.video.classList.add('is-visible');
      this.applyColor(request);
      state.overlay = 'crossani';
      setPortalStatic(false);
      setPhase('overlay');
      setControllerMode('photo-crossani');
    }

    show(request, now) {
      const apply = () => {
        if (!this.current(request) || request.shown || !this.moving()) return false;
        const position = Number(sharedSongAudio.currentTime) || now;
        if (position >= request.cue.endsAt) { this.release('missed'); return false; }
        try { this.sync(request, position); } catch (error) { this.fail(request, error); return false; }
        if (request.reservation && !request.reservation.commit()) { this.release('unavailable'); return false; }
        request.shown = true;
        this.project(request);
        state.lastCrossAniSource = request.source;
        publishCrossAniState(request.items);
        this.play();
        request.life?.publish();
        return true;
      };
      return request.life ? request.life.queue.run(apply,
        { type: 'CrossAni.Show', owner: request.owner, scope: request.owner?.scope }) : apply();
    }

    render(now) {
      if (!this.moving()) return;
      let request = this.request;
      if (request && now >= request.cue.endsAt) this.release(request.shown ? 'completed' : 'missed');
      const pending = this.pending;
      if (pending) {
        if (pending.owner?.dead || pending.owner?.scope?.signal.aborted || now >= pending.cue.endsAt) {
          this.remember(pending.cue, pending.owner, 'missed'); this.pending = null;
        } else if (this.request?.shown && now >= pending.cue.startsAt) {
          this.remember(pending.cue, pending.owner, 'skipped-active-overlay'); this.pending = null;
        } else if (!this.request) {
          this.pending = null;
          if (['scene', 'photo'].includes(state.surface)) this.prepare(pending.cue, pending.owner);
          else this.remember(pending.cue, pending.owner, 'skipped');
        }
      }
      request = this.request;
      if (!request || !request.ready) return;
      if (!request.shown && now >= request.cue.startsAt) this.show(request, now);
      if (!this.current(request) || !request.shown) return;
      if (request.needsSync) { this.sync(request, now); this.project(request); this.play(); }
      this.applyColor(request);
      const cue = request.cue;
      const peakAt = cue.fadeOutStartsAt ?? cue.fadeStartsAt ?? cue.startsAt;
      const opacity = now < peakAt
        ? (cue.unfade > 0 ? Math.min(1, Math.max(0, (now - cue.startsAt) / cue.unfade)) : 1)
        : (cue.fade > 0 ? Math.max(0, 1 - (now - peakAt) / cue.fade) : 0);
      request.video.style.opacity = String(Math.max(0, Math.min(1, cue.opacity)) * opacity);
    }

    play({ allowPausedPlayback = false } = {}) {
      const request = this.request;
      if (!request?.shown) return;
      this.pause();
      const scope = request.playScope = new AbortController();
      let timer = 0;
      scope.signal.addEventListener('abort', () => window.clearTimeout(timer), { once: true });
      const attempt = () => {
        if (scope.signal.aborted || !this.current(request) || !portalMotionAllowed
          || window.VCLife?.renderingActive === false || state.playback === 'waiting'
          || (!allowPausedPlayback && (sharedSongAudio.paused || sharedSongAudio.ended))) return;
        request.video.playbackRate = request.cue.playbackRate;
        request.video.play().catch(() => {});
      };
      request.video.addEventListener('canplay', attempt, { signal: scope.signal });
      attempt();
      timer = window.setTimeout(attempt, 120);
    }

    pause(resync = false) {
      const request = this.request;
      request?.playScope?.abort();
      request?.video?.pause();
      if (request && resync) {
        request.needsSync = true;
        request.video?.classList.remove('is-visible');
        this.project(null);
      }
    }

    release(reason = 'cancelled') {
      const request = this.request;
      if (!request) return false;
      this.request = null;
      this.remember(this.describe(request), request.owner, reason);
      state.overlay = 'none';
      cleanupPortalResources('Overlay.Cleanup', [
        () => request.owner?.scope?.signal.removeEventListener('abort', request.abort),
        () => request.playScope?.abort(), () => request.controller.abort(),
        () => request.reservation?.cancel(), () => request.video?.pause(),
        () => request.video?.removeAttribute('src'), () => request.video?.load(), () => request.video?.remove(),
      ]);
      this.project(null);
      return true;
    }

    reset(owner = null, reason = 'cancelled') {
      if (this.pending && (!owner || this.pending.owner === owner)) {
        this.remember(this.pending.cue, this.pending.owner, reason); this.pending = null;
      }
      if (this.request && (!owner || this.request.owner === owner)) this.release(reason);
    }

    snapshot(owner = null) {
      const request = !owner || this.request?.owner === owner ? this.request : null;
      return { pending: this.pending && (!owner || this.pending.owner === owner) ? { ...this.pending.cue, status: 'scheduled' }
        : request && (!request.shown || request.needsSync) ? this.describe(request) : null,
        active: request?.shown && !request.needsSync ? this.describe(request) : null,
        lastCue: this.lastCue && (!owner || this.lastCue.owner === owner.id) ? this.lastCue.cue : null };
    }
  }
  const crossAni = new TCrossAni();

  const startManualCrossAni = (startsAt, source = '') => {
    const song = window.VCLife?.playingSong;
    if (song && !song.playback?.profile?.allowsCrossAni(song)) return;
    if (portalMediaScope.signal.aborted || !portalMotionAllowed || state.endSequenceStarted
      || sharedSongAudio.paused || sharedSongAudio.ended || state.playback === 'failed') return;
    if (crossAni.request?.shown) return;
    crossAni.release('superseded-manual');
    const cue = { ...makeInsertSlot(startsAt), name: 'CrossAni', kind: 'crossani', manual: true };
    if (source) cue.crossAniSource = source;
    crossAni.prepare(cue, window.VCLife?.playingSong?.playback);
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
    // Middle click is an explicit CrossAni preview, independent from the
    // active VerseChain, so it is useful for checking the overlay treatment.
    startManualCrossAni(Number(sharedSongAudio.currentTime) || 0);
  };

  document.addEventListener('vcard:debug-crossani', (event) => {
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
      startManualCrossAni(Number(sharedSongAudio.currentTime) || 0);
      return;
    }
    const generation = state.generation;
    loadCrossAniItems().then((items) => {
      if (!items.length || portalMediaScope.signal.aborted
        || generation !== state.generation || preview !== state.preview) return;
      const source = adjacentCrossAniSource(items, direction);
      startManualCrossAni(Number(sharedSongAudio.currentTime) || 0, source);
    });
  }, { signal: portalMediaScope.signal });

  const makeInsertSlot = (startsAt) => {
    const p = window.VCPlayer.crossAniParameters();
    const timing = { lead: p.CROSS_MANUAL_LEAD, unfade: p.CROSS_MANUAL_UNFADE,
      fade: p.CROSS_MANUAL_FADE, opacity: p.CROSS_MANUAL_OPACITY };
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
      opacity: timing.opacity,
      playbackRate: p.CROSS_PLAYBACK_RATE,
      minimumStartGap: p.CROSS_START_GAP,
    };
  };

  const resetSeek = () => {
    if (!state.preview || state.preview.hidden || sharedSongAudio.ended) return;
    const image = state.preview?.querySelector('.song__preview-image');
    if (image) vcardMedia.clearPreload(image);
    state.generation += 1;
    if (crossAni.cue && !crossAni.cue.manual) {
      crossAni.reset();
      state.overlay = 'none';
      if (state.surface === 'photo' || state.surface === 'scene') {
        const imageCurrent = state.surface === 'photo'
          || state.scene?.current?.kind === 'image';
        setPhase(imageCurrent ? 'photo' : 'play');
        setControllerMode(imageCurrent ? 'photo' : 'play-ani-playing');
      }
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
      crossAni.reset();
      state.surface = 'none';
    }
    state.scene?.destroy();
    state.scene = null;
    if (!ensurePortal(preview, keepImage)) return;
    cancelPortalClick();
    crossAni.reset();
    if (state.frame) delete state.frame.dataset.playbackPaused;
    state.generation += 1;
    state.started = false;
    state.firstVerseActivated = false;
    state.endSequenceStarted = false;
    state.seeking = false;
    state.surface = 'none';
    vcardMedia.setActive(state.image, false);
    vcardMedia.clearPreload(state.image);
    if (state.layer) state.layer.style.visibility = keepImage ? 'visible' : 'hidden';
    setPlaybackState('idle');
    setControllerMode('closed');
    // Keep the inactive compositor connected until TrackOpen atomically
    // selects its surface. Detaching the layer here also detaches the source
    // image, so a following PlayAni command can no longer resolve the frame.
    setPhase('start');
  };

  const open = (preview, { keepImage = false, frame = null } = {}) => {
    selectTrack(preview, keepImage);
    // Frame styling belongs to the scenario, including its prepared preview.
    const image = portalImage(preview);
    if (image && frame) vcardMedia.setPortalFrame(image, vcardPortalPlan.frameFor(frame));
    state.started = false;
    setPlaybackState('idle');
    return Boolean(state.preview);
  };

  const openIdle = (preview, directive = null) => {
    // Missing media is not an implicit request for a PlayAni poster.
    const hold = !directive || directive.mediaType === 'hold';
    const image = portalImage(preview);
    const frame = image?.closest('.song-vibeframe') || (preview === state.preview ? state.frame : null);
    if (!frame) return Promise.resolve(false);
    let ready = Promise.resolve(true);
    const layer = image.closest('.vcard-portal-motion-layer');
    const playAni = directive?.mediaType === 'play-ani';
    const crossAni = directive?.mediaType === 'cross-ani';
    const animationStill = playAni || crossAni;
    if (layer && !hold) layer.style.display = animationStill ? 'none' : '';
    if (!hold) vcardMedia.setActive(image, false);
    let still = frame.querySelector(':scope > .song-portal-idle-still');
    if (!hold && !animationStill) {
      still?.remove();
      image.dataset.portalPreviewPending = 'true';
      if (layer) layer.style.visibility = 'visible';
      vcardMedia.setPortalFrame(image, vcardPortalPlan.frameFor(directive), false);
      vcardMedia.setActive(image, true, false);
      ready = vcardMedia.renderState(image, true, '', false);
    } else if (animationStill && !still) {
      still = document.createElement('img');
      still.className = 'song-portal-play-ani-still song-portal-idle-still';
      still.classList.toggle('song-portal-crossani-still', crossAni);
      still.alt = '';
      still.setAttribute('aria-hidden', 'true');
      if (playAni) still.src = mediaUrl(PLAY_ANI_POSTER_FILE);
      frame.append(still);
      if (crossAni) {
        const target = still;
        const source = mediaUrl(String(vcardPortalPlan.settings(preview).CrossAniFile || ''));
        const load = /\.js(?:[?#]|$)/i.test(source)
          ? vcardMedia.loadList(source).then((items) => items
            .map((item) => vcardMedia.listItemUrl(source, item)))
          : Promise.resolve([source]);
        ready = load.then((items) => {
          if (!target.isConnected || !frame.contains(target)) return false;
          const poster = items.find((item) => /\.(?:jpg|jpeg|png|webp)(?:[?#]|$)/i.test(item));
          if (!poster) return false;
          target.src = poster;
          return vcardMedia.prepareImage(poster).then(() => true);
        }).catch((error) => {
          if (target.isConnected) console.warn('VCard CrossAni preview: cannot load poster', error);
          return false;
        });
      }
    }
    if (playAni && still?.src) ready = vcardMedia.prepareImage(still.src).then(() => true, () => false);
    if (!frame.querySelector(':scope > .song-portal-idle-action')) {
      const action = portalAction().cloneNode(true);
      action.classList.add('song-portal-idle-action', 'is-visible');
      action.classList.remove('is-playing', 'is-finished');
      action.disabled = false;
      projectPortalButton(action, portalActionFor(preview));
      frame.append(action);
    }
    return ready;
  };

  const setPreloading = (preview, pending, progress = 0) => {
    const frame = preview?.querySelector('.song-vibeframe') || (preview === state.preview ? state.frame : null);
    if (!frame) return;
    frame.dataset.preload = pending ? 'on' : 'off';
    frame.setAttribute('aria-busy', String(pending));
    let indicator = frame.querySelector(':scope > .song-portal-preload');
    if (pending && !indicator) {
      indicator = document.createElement('span');
      indicator.className = 'song-portal-preload';
      indicator.setAttribute('role', 'progressbar');
      indicator.setAttribute('aria-label', 'Загрузка медиа песни');
      indicator.setAttribute('aria-valuemin', '0');
      indicator.setAttribute('aria-valuemax', '100');
      frame.append(indicator);
    }
    if (!indicator) return;
    const percent = pending ? Math.max(0, Math.min(99, Math.floor(Number(progress) || 0))) : 100;
    indicator.textContent = `${percent}%`;
    indicator.setAttribute('aria-valuenow', String(percent));
    indicator.hidden = !pending;
  };

  const prepareStart = async (preview, directive, signal) => {
    if (signal?.aborted || !ensurePortal(preview)) return false;
    if (directive?.mediaType === 'play-ani') {
      await vcardMedia.prepareImage(mediaUrl(PLAY_ANI_POSTER_FILE), { signal });
      if (signal?.aborted || state.preview !== preview) return false;
      const shown = await state.scene.showPlayAni({ animated: false, phase: 'start' });
      const slot = state.scene.current;
      if (shown && !signal?.aborted && state.preview === preview && state.scene.current === slot) {
        // The decoded poster remains visible while the video buffers.
        slot?.setPlayAniMotion(true);
      }
      return shown;
    }
    if (directive?.mediaType === 'cross-ani') return openIdle(preview, directive);
    if (!directive || !vcardMedia.mediaStates.get(portalImage(preview))?.groups.length) return false;
    const plan = { preview, index: -1, portalFrame: directive, phase: 'start', effects: [],
      displayStartsAt: 0, displayEndsAt: Infinity };
    const resource = await prepareVerseDisplay({ kind: 'image', plan }, signal);
    return resource ? showVerseDisplay(resource, { fade: 0, unfade: 0 }, signal) : false;
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

  const showPlayAni = ({
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
      if (state.controls) state.controls.dataset.ending = motion === 'static' ? 'hold' : 'play-ani';
    }
    setPhase(phase);
    state.surface = 'scene';
    state.verseSlotKind = 'play-ani';
    const scene = state.scene;
    const preview = state.preview;
    const generation = state.generation;
    scene.showPlayAni({
      animated: motion === 'animated',
      reset: phase === 'start' || phase === 'finish',
      phase,
      timing,
    }).then((shown) => {
      if (!shown || state.scene !== scene || state.preview !== preview
        || state.generation !== generation || portalMediaScope.signal.aborted) return;
      setControllerMode(
        phase === 'finish'
          ? (motion === 'animated' ? 'play-ani-finish-playing' : 'play-ani-finish-static')
          : (motion === 'animated' ? 'play-ani-playing' : 'play-ani-static')
      );
    });
  };

  const beginPortalRun = (preview) => {
    vcardPortalPlan.beginPlayback(
      preview,
      Number(sharedSongAudio.currentTime) || 0
    );
    loadCrossAniItems().then(publishCrossAniState);
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

  const prepareShow = (preview, options) => vcardMedia.selectPlaybackShow(portalImage(preview), options);

  const prepareSongMedia = (preview, sources, { signal } = {}) => {
    const ownerSignal = signal || portalMediaScope.signal;
    if (ownerSignal.aborted) return;
    let scheduled = false;
    const startBackgroundCache = () => {
      if (scheduled || ownerSignal.aborted || sharedSongAudio.paused
        || sharedSongAudio.vcardPlayingPreview !== preview) return;
      scheduled = true;
      sharedSongAudio.removeEventListener('playing', startBackgroundCache);
      // Let streaming audio start before competing for the connection. The
      // next-song reservation uses the same queue while this song is playing.
      vcardMediaCache.enqueue(async () => {
        const crossSource = String(vcardPortalPlan.settings(preview).CrossAniFile || '').trim();
        const crossUrl = crossSource ? mediaUrl(crossSource) : '';
        const crossFiles = /\.js(?:[?#]|$)/i.test(crossUrl)
          ? (await vcardMedia.loadList(crossUrl)).map((item) => vcardMedia.listItemUrl(crossUrl, item))
          : crossUrl ? [crossUrl] : [];
        if (ownerSignal.aborted) return;
        const logos = [...preview.querySelectorAll('.song-video-link__logo')];
        const urls = [...new Set([
          ...(sources || []), ...crossFiles,
          mediaUrl('sys/playbutton/audio-play.webp'), mediaUrl('sys/playbutton/audio-pause.webp'),
          ...logos.map((image) => image.getAttribute('src')),
          mediaUrl(PLAY_ANI_POSTER_FILE), mediaUrl(PLAY_ANI_VIDEO_FILE),
        ].filter(Boolean).map(vcardPublishedMediaUrl))];
        // Do not download the current MP3 a second time alongside its stream.
        // The ended handler caches completed audio; preloadNext caches the
        // reserved next MP3 in advance with its own cancellation signal.
        await vcardMediaCache.cacheUrls(urls, null, { signal: ownerSignal, concurrency: 1 });
      }, ownerSignal).catch((error) => {
        if (!ownerSignal.aborted && error?.name !== 'AbortError') {
          console.warn('VCard background song media cache failed', error);
        }
      });
    };
    sharedSongAudio.addEventListener('playing', startBackgroundCache, { signal: ownerSignal });
    startBackgroundCache();
  };

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
    const initialized = kind !== 'image' || await vcardMedia.initializePortalImage?.(image);
    if (
      signal?.aborted
      || !initialized
      || preview !== state.preview
      || state.scene !== scene
    ) return null;
    vcardPortalPlan.setVersePlan(plan);
    return scene.prepare(kind, plan, signal);
  };

  const verseDisplayBusy = () => Boolean(state.scene?.transition);

  const showVerseDisplay = (resource, timing = {}, signal = null) => {
    if (!resource || signal?.aborted || !state.scene || resource.slot?.scene !== state.scene) return false;
    // Apply image motion while the prepared layer is still invisible.
    if (resource.kind === 'image') setPortalStatic(false);
    if (!state.scene.show(resource, timing, signal)) return false;
    state.surface = 'scene';
    state.verseSlotKind = resource.kind;
    state.firstVerseActivated = Number.isInteger(resource.plan?.index) && resource.plan.index >= 0;
    setPortalStatic(false);
    setPhase(resource.kind === 'image' ? (state.overlay === 'crossani' ? 'overlay' : 'photo') : 'play');
    setControllerMode(resource.kind === 'image' ? 'photo' : 'play-ani-playing');
    return true;
  };

  const cancelVerseDisplay = (resource = null) => {
    if (resource) resource.slot?.scene?.cancel(resource);
    else state.scene?.cancel(state.scene.reserved);
  };

  const cancelVerseFrame = () => {
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
    crossAni.reset(null, 'portal-reset');
    state.endSequenceStarted = true;
    state.firstVerseActivated = false;
    state.started = false;
    showPlayAni({
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
    scene?.showPlayAni({ animated: false, phase: 'finish' }).then((shown) => {
      if (shown && state.scene === scene && state.preview === preview
        && state.generation === generation && !portalMediaScope.signal.aborted) {
        setControllerMode('play-ani-finish-static');
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
      if (crossAni.cue) crossAni.reset(null, 'skipped-motion');
      return;
    }
    if (state.playback !== 'failed') state.scene?.resume();
    if (state.overlay === 'crossani' && !sharedSongAudio.paused && !sharedSongAudio.ended) {
      crossAni.play();
    }
  };

  const close = (preview = state.preview) => {
    if (preview !== state.preview) return;
    cancelPortalClick();
    crossAni.reset();
    state.generation += 1;
    state.overlay = 'none';
    state.scene?.destroy();
    state.scene = null;
    parkPhotoSurface();
    state.surface = 'none';
    state.verseSlotKind = '';
    setPlaybackState('idle');
    setControllerMode('closed');
    state.preview = null;
    state.frame = null;
    state.layer = null;
    state.image = null;
  };

  portalMediaScope.signal.addEventListener('abort', () => {
    close(state.preview);
  }, { once: true });

  const resume = () => {
    if (!state.preview) return;
    setPlaybackState('starting');
    if (state.frame) delete state.frame.dataset.playbackPaused;
    const image = portalImage();
    if (image) vcardMedia.resume(image);
    state.scene?.resume();
    if (
      portalMotionAllowed
      && (!state.firstVerseActivated || state.verseSlotKind === 'play-ani')
      && state.mode === 'play-ani-static'
    ) {
      state.scene?.current?.setPlayAniMotion(true);
      setControllerMode('play-ani-playing');
    }
    if (portalMotionAllowed && state.overlay === 'crossani') {
      crossAni.play({ allowPausedPlayback: true });
    }
    setPhase(state.phase);
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
    if (portalMotionAllowed && state.overlay === 'crossani') {
      crossAni.play();
    }
    const image = portalImage();
    if (image) vcardMedia.resume(image);
  };
  const waiting = () => {
    if (!state.preview || sharedSongAudio.paused) return;
    setGlowPlayback(false);
    state.scene?.pause();
    crossAni.pause();
    const image = portalImage();
    if (image) vcardMedia.freeze(image);
    setPlaybackState('waiting');
  };
  const failed = () => {
    if (!state.preview) return;
    setPlaybackState('failed');
    cancelVerseFrame();
    if (crossAni.cue) crossAni.reset(null, 'playback-failed');
    setRenderingActive(false);
    setPortalStatic(true);
  };
  const finishCurrent = () => {
    setRenderingActive(false);
    setPortalStatic(true);
  };
  const pause = () => {
    if (!state.preview || sharedSongAudio.ended) return;
    // Pause freezes the current exclusive surface. It does not invalidate the
    // verse plan, choose another frame, or recreate any portal media.
    state.scene?.pause();
    crossAni.pause();
    if (state.frame) state.frame.dataset.playbackPaused = 'on';
    const image = portalImage();
    if (image) vcardMedia.freeze(image);
    setPlaybackState('paused');
  };
  const setRenderingActive = (active) => {
    const renderActive = active && state.playback !== 'failed';
    const running = renderActive && !sharedSongAudio.paused && !sharedSongAudio.ended;
    const image = portalImage();
    if (!renderActive && state.scene?.frameHandle) {
      vcardRenderScheduler.cancel(state.scene.frameHandle);
      state.scene.frameHandle = 0;
    } else if (renderActive && state.scene && !state.scene.frameHandle) {
      state.scene.scheduleFrame();
    }
    if (!running) {
      crossAni.pause(true);
      state.scene?.pause();
      if (image) vcardMedia.freeze(image);
    } else {
      state.scene?.resume();
      if (image) vcardMedia.resume(image);
    }
    setGlowPlayback(running);
  };
  const seek = () => {
    if (!state.preview) return;
    state.seeking = true;
  };
  const seeked = () => {
    state.seeking = false;
    resetSeek();
  };
  const ended = () => {
    if (!state.preview) return;
    // The playback controller owns the complete ending timeline.
    state.started = false;
    crossAni.reset(null, 'song-ended');
    setPlaybackState('ended');
  };

  const beforeFirstVerse = (isPlaying) => {
    state.firstVerseActivated = false;
    state.verseSlotKind = '';
    crossAni.reset(null, 'portal-reset');
    showPlayAni({
      motion: isPlaying ? 'animated' : 'static',
      phase: isPlaying ? 'play' : 'start',
    });
  };

  const holdSongPreview = () => {
    const image = portalImage();
    if (!image || !state.layer) return;
    // Holding the surface must preserve the scenario's current frame pipeline.
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
      frameScheduled: Boolean(state.scene?.frameHandle),
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
    frameActive: (preview) => state.preview === preview && Boolean(state.scene && !state.scene.destroyed)
      && window.VCLife?.renderingActive !== false,
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
    hasSongTV: (preview) => Boolean(portalImage(preview)?.dataset.portalTv),
    open,
    openIdle,
    prepareStart,
    setPreloading,
    pause,
    playing,
    scheduleOverlay: (cue, owner) => crossAni.schedule(cue, owner),
    resetOverlay: (owner, reason) => crossAni.reset(owner, reason),
    suspendOverlay: (owner) => { if (crossAni.request?.owner === owner) crossAni.pause(true); },
    overlaySnapshot: (owner) => crossAni.snapshot(owner),
    prepareVerseDisplay,
    hasVerseImages: (plan) => vcardMedia.hasPortalFrames(
      portalImage(plan.preview), vcardPortalPlan.frameFor(plan.portalFrame)
    ),
    prepareShow,
    prepareSongMedia,
    completeSongPreload: (preview, signal) => vcardMedia.completeSongPreload(portalImage(preview), signal),
    startSlideLoading: (preview) => vcardMedia.startSlideLoading(portalImage(preview)),
    slidesLoading: (preview) => Boolean(vcardMedia.mediaStates.get(portalImage(preview))?.slideLoading?.running),
    resume,
    seek,
    seeked,
    showPlayAni,
    setMotionAllowed,
    setRenderingActive,
    start,
    waiting,
    showVerseDisplay,
    verseDisplayBusy,
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
    frameActive: portalController.frameActive,
    imageFor: portalController.imageFor,
    hasSongTV: portalController.hasSongTV,
    ended: portalController.ended,
    failed: portalController.failed,
    finishAnimated: portalController.finishAnimated,
    finishStatic: portalController.finishStatic,
    open: portalController.open,
    openIdle: portalController.openIdle,
    prepareStart: portalController.prepareStart,
    setPreloading: portalController.setPreloading,
    pause: portalController.pause,
    playing: portalController.playing,
    scheduleOverlay: portalController.scheduleOverlay,
    resetOverlay: portalController.resetOverlay,
    suspendOverlay: portalController.suspendOverlay,
    overlaySnapshot: portalController.overlaySnapshot,
    prepareVerseDisplay: portalController.prepareVerseDisplay,
    hasVerseImages: portalController.hasVerseImages,
    prepareShow: portalController.prepareShow,
    prepareSongMedia: portalController.prepareSongMedia,
    completeSongPreload: portalController.completeSongPreload,
    startSlideLoading: portalController.startSlideLoading,
    slidesLoading: portalController.slidesLoading,
    selectionSnapshot: (preview) => {
      const image = portalController.imageFor(preview);
      const frame = vcardMedia.mediaStates.get(image)?.frameBag;
      const loading = vcardMedia.mediaStates.get(image)?.slideLoading;
      const show = image?.vcardShowBag;
      const snapshot = (bag) => bag ? { total: bag.items.length, remaining: bag.remaining.length,
        reserved: Boolean(bag.reservation), last: bag.last } : null;
      return { frame: snapshot(frame), show: snapshot(show),
        loading: loading ? { total: loading.frames.length, ready: loading.ready.size,
          failed: loading.failed.size, pending: loading.preparing.size,
          started: loading.started, running: loading.running, current: loading.current() } : null,
        songSeriesAbsent: image?.vcardSongSeriesAbsent === true,
        published: portalController.publishedFrame(preview) };
    },
    resume: portalController.resume,
    seek: portalController.seek,
    seeked: portalController.seeked,
    showPlayAni: portalController.showPlayAni,
    finishCurrent: portalController.finishCurrent,
    setMotionAllowed: portalController.setMotionAllowed,
    setRenderingActive: portalController.setRenderingActive,
    start: portalController.start,
    waiting: portalController.waiting,
    showVerseDisplay: portalController.showVerseDisplay,
    verseDisplayBusy: portalController.verseDisplayBusy,
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
    document.documentElement.dataset.visualizationMode = this.mode();
    document.dispatchEvent(new CustomEvent('vcard:visualization-state', {
      detail: { mode: this.mode(), choice: document.documentElement.dataset.visualizationChoice || this.mode(),
        brightnessLevel: this.level },
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
  let visualizationChoice = vcardStorage.local.getItem('vcard-visualization-choice');
  if (!['auto', MODE_OFF, MODE_HORIZONTAL, MODE_VERTICAL].includes(visualizationChoice)) {
    visualizationChoice = visualizationMode;
    vcardStorage.local.setItem('vcard-visualization-choice', visualizationChoice);
  }
  document.documentElement.dataset.visualizationChoice = visualizationChoice;
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

  let canvas = null;
  let softCanvas = null;
  let canvasContext = null;
  let softContext = null;
  let audioContext = null;
  let audioOutputReady = false;
  let analyser = null;
  let analysisFailed = false;
  let startedVisualizationRun = null;
  let audioResumePending = null;
  let audioResumeAttempts = 0;
  let audioResumeError = '';
  window.VCardVisualization = Object.freeze({
    available: () => !analysisFailed,
    prepareCopyFeedback(isCurrent) {
      if (signal.aborted) return () => {};
      let ready;
      try {
        ensureAudioContext();
        ready = resumeAudioOutput(true);
      } catch (_error) { return () => {}; }
      return () => { void ready.then((running) => {
        if (!running || signal.aborted || document.hidden || audioContext?.state !== 'running' || !isCurrent()) return;
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const now = audioContext.currentTime;
        oscillator.type = 'sine';
        oscillator.frequency.value = 880;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.045, now + 0.005);
        gain.gain.linearRampToValueAtTime(0, now + 0.08);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        oscillator.start(now);
        oscillator.stop(now + 0.09);
      }).catch((error) => console.warn('VCard: copy feedback unavailable', error)); };
    },
    audioOutput: () => {
      let signalRms = null;
      if (analyser && audioContext?.state === 'running') {
        try {
          const samples = new Uint8Array(analyser.fftSize);
          analyser.getByteTimeDomainData(samples);
          signalRms = Math.sqrt(samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) / samples.length);
        } catch (_error) { }
      }
      return {
        state: audioContext?.state || 'uninitialized',
        contextTime: audioContext?.currentTime ?? null,
        outputReady: audioOutputReady,
        analysisFailed,
        resumePending: Boolean(audioResumePending),
        resumeAttempts: audioResumeAttempts,
        lastResumeError: audioResumeError,
        signalRms,
        media: audios.map((audio) => ({ paused: audio.paused, ended: audio.ended,
          time: audio.currentTime, readyState: audio.readyState, networkState: audio.networkState,
          muted: audio.muted, volume: audio.volume, error: audio.error?.message || '' })),
      };
    },
    beginSong(runId) {
      if (signal.aborted || !runId || runId === startedVisualizationRun) return false;
      startedVisualizationRun = runId;
      if (visualizationChoice !== 'auto' || !vcardVisualizationAvailable()) return false;
      const reservation = vcardSelectionBag('visualization.auto', [MODE_OFF, MODE_HORIZONTAL, MODE_VERTICAL])
        .reserve({ origin: { event: 'Playback.Playing', runId } });
      if (!reservation) return false;
      try {
        setVisualizationMode(reservation.item);
        reservation.commit();
      } finally { reservation.cancel(); }
      return true;
    },
  });
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
    const probe = document.querySelector('.vcard-player-dock')
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

  const ensureVisualizationCanvas = () => {
    if (canvas) return;
    const main = document.createElement('canvas');
    const soft = document.createElement('canvas');
    const mainContext = main.getContext('2d', { alpha: true, desynchronized: true });
    const blurContext = soft.getContext('2d', { alpha: true, desynchronized: true });
    if (!mainContext || !blurContext) throw new Error('Visualization canvas is unavailable');
    main.className = 'audio-spectrum is-enabled';
    soft.className = 'audio-spectrum-soft';
    main.setAttribute('aria-hidden', 'true');
    soft.setAttribute('aria-hidden', 'true');
    main.dataset.brightnessLevel = String(brightnessLevel);
    canvas = main;
    softCanvas = soft;
    canvasContext = mainContext;
    softContext = blurContext;
    document.body.prepend(canvas, softCanvas);
    resizeCanvas();
  };
  const resizeCanvas = () => {
    if (!canvas) return;
    const pixelRatio = visualizationPixelRatio;
    canvas.width = Math.round(window.innerWidth * pixelRatio);
    canvas.height = Math.round(window.innerHeight * pixelRatio);
    softCanvas.height = canvas.height;
    canvasContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    scheduleHorizontalBoundsRefresh();
  };

  const readingWaveBounds = () => {
    const preview = window.VCardSongControls?.currentPreview?.();
    const text = preview?.querySelector('.song__preview-text');
    const textRect = text?.getBoundingClientRect();
    const widths = text ? [...text.querySelectorAll('.song__track-verse')]
      .map((verse) => verse.getBoundingClientRect().width).filter((width) => width > 0) : [];
    if (textRect?.width > 0 && widths.length) {
      const width = Math.min(window.innerWidth, widths.reduce((sum, value) => sum + value, 0) / widths.length);
      const center = textRect.left + textRect.width / 2;
      const left = Math.max(0, Math.min(window.innerWidth - width, center - width / 2));
      return { left, right: left + width, width };
    }
    const bounds = verticalWaveBounds();
    const inset = bounds.width * 0.125;
    return { left: bounds.left + inset, right: bounds.right - inset, width: bounds.width * 0.75 };
  };
  let cachedHorizontalBounds = null;
  let cachedReadingBounds = null;
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
    if (!canvas || signal.aborted) return;
    cachedHorizontalBounds = vcardHorizontalWaveBounds();
    cachedReadingBounds = readingWaveBounds();
    const { left, right, width } = cachedReadingBounds;
    canvas.style.setProperty('--vc-spectrum-reading-left', `${left}px`);
    canvas.style.setProperty('--vc-spectrum-reading-right', `${right}px`);
    softCanvas.style.left = `${left}px`;
    softCanvas.style.width = `${width}px`;
    softCanvas.width = Math.max(1, Math.round(width * visualizationPixelRatio));
  };
  const scheduleHorizontalBoundsRefresh = () => {
    if (!canvas || signal.aborted || brightnessLevel === 0) return;
    if (horizontalBoundsFrame) vcardRenderScheduler.cancel(horizontalBoundsFrame);
    horizontalBoundsFrame = vcardRenderScheduler.request(() => {
      horizontalBoundsFrame = vcardRenderScheduler.request(refreshHorizontalBounds, {
        owner: canvas, scope: visualizationScope, phase: 'measure', priority: 0,
      });
    }, { owner: canvas, scope: visualizationScope, phase: 'measure', priority: 0 });
  };

  const clearVisualizationFrame = () => {
    canvasContext?.clearRect(0, 0, window.innerWidth, window.innerHeight);
    softContext?.clearRect(0, 0, softCanvas.width, softCanvas.height);
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
    canvas?.classList.remove('is-enabled');
    reportAudioFault(error, type);
    document.dispatchEvent(new CustomEvent('vcard:visualization-availability', {
      detail: { available: false },
    }));
  };

  const ensureAudioContext = () => {
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
        context.addEventListener('statechange', handleAudioOutputState, { signal });
      } catch (error) {
        context.close().catch(() => { });
        throw error;
      }
    }
  };

  const initializeAudio = () => {
    if (audioOutputReady) return;
    ensureAudioContext();
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

  const resumeAudioOutput = (force = false) => {
    if (signal.aborted || !audioContext || audioContext.state === 'closed') return Promise.resolve(false);
    if (audioContext.state === 'running') return Promise.resolve(true);
    if (audioResumePending && !force) return audioResumePending;
    audioResumeAttempts += 1;
    audioResumeError = '';
    let request;
    try {
      // iOS exposes interrupted in addition to suspended. Call resume inside
      // the gesture, without awaiting another operation first.
      request = Promise.resolve(audioContext.resume());
    } catch (error) { request = Promise.reject(error); }
    const pending = request.then(() => !signal.aborted && audioContext.state === 'running')
      .catch((error) => {
        audioResumeError = String(error?.message || error);
        reportAudioFault(error, 'Audio.Output.Resume');
        return false;
      }).finally(() => {
        if (audioResumePending === pending) audioResumePending = null;
      });
    audioResumePending = pending;
    return pending;
  };

  const prepareAudioOutput = async ({ boost = false, forceResume = false } = {}) => {
    if (signal.aborted) return false;
    try {
      initializeAudio();
      if (boost) applyVolumeBoost();
    } catch (error) {
      reportAudioFault(error, 'Audio.Output.Prepare');
      return false;
    }
    return await resumeAudioOutput(forceResume) && !signal.aborted && audioOutputReady;
  };

  function handleAudioOutputState() {
    if (signal.aborted) return;
    if (audioContext?.state !== 'running') {
      stopVisualization();
      if (!document.hidden && audios.some((audio) => !audio.paused && !audio.ended)) {
        void prepareAudioOutput();
      }
    } else if (audios.some((audio) => !audio.paused && !audio.ended)) {
      void startVisualization();
    }
  }

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
    const fromTextCenter = window.innerWidth > window.innerHeight;
    const centerX = cachedReadingBounds.left + cachedReadingBounds.width / 2;
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
      const distanceFromEdge = (waveformHistory.length - index) * horizontalColumnStep
        + phaseOffset;
      const distanceFromCenter = distanceFromEdge - horizontalColumnStep;
      const x = fromTextCenter
        ? centerX + distanceFromCenter
        : window.innerWidth - distanceFromEdge;
      const columnWidth = horizontalBarWidth;
      if (fromTextCenter && distanceFromCenter > Math.max(centerX, window.innerWidth - centerX)) continue;
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
        columnWidth,
        upperHeight + lowerHeight
      );
      if (fromTextCenter) {
        // New samples start at the reading column's centre and travel out.
        canvasContext.fillRect(
          centerX - distanceFromCenter - columnWidth,
          centerY - upperHeight,
          columnWidth,
          upperHeight + lowerHeight
        );
      }
    }
    canvasContext.restore();
    if (fromTextCenter && softContext) {
      // Copy only the narrow reading strip. CSS blurs/fades this separate
      // layer, without filtering the wallpaper or the foreground text.
      softContext.clearRect(0, 0, softCanvas.width, softCanvas.height);
      softContext.drawImage(
        canvas,
        cachedReadingBounds.left * visualizationPixelRatio, 0,
        cachedReadingBounds.width * visualizationPixelRatio, canvas.height,
        0, 0, softCanvas.width, softCanvas.height
      );
    }
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
    canvasContext.globalAlpha = [0, 0.24, 0.42, 0.62, 0.82, 1][brightnessLevel];
    canvasContext.fillStyle = waveformColor;
    amplitudes.forEach((amplitude, index) => {
      if (amplitude < 0.004) return;
      const halfWidth = amplitude * maxHalfWidth;
      const y = (VERTICAL_BAR_COUNT - index - 1) * slotHeight + gap / 2;
      canvasContext.fillRect(centerX - halfWidth, y, halfWidth * 2, barHeight);
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
      || audioContext?.state !== 'running'
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
      if (!cachedHorizontalBounds || !cachedReadingBounds) refreshHorizontalBounds();
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
    try {
      ensureVisualizationCanvas();
    } catch (error) {
      disableAudioAnalysis(error, 'Visualization.Canvas');
      return;
    }
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
    if (!audioContext && (visualizationMode === MODE_OFF || brightnessLevel === 0) && volumeBoost === 1) return;
    void prepareAudioOutput({ forceResume: true });
  };

  const restoreAudioOutput = () => {
    if (signal.aborted || document.hidden || !audioContext
      || audios.every((audio) => audio.paused || audio.ended)) return;
    void prepareAudioOutput().then((ready) => { if (ready) return startVisualization(); });
  };
  document.addEventListener('visibilitychange', restoreAudioOutput, { signal });
  window.addEventListener('pageshow', restoreAudioOutput, { signal });
  window.addEventListener('focus', restoreAudioOutput, { signal });

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
      if (audioContext || volumeBoost !== 1) void prepareAudioOutput();
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
  document.addEventListener('vcard:song-open', scheduleHorizontalBoundsRefresh, { signal });
  document.addEventListener('vcard:song-text-ready', scheduleHorizontalBoundsRefresh, { signal });
  document.addEventListener('vcard:song-close', scheduleHorizontalBoundsRefresh, { signal });
  document.addEventListener('vcard:font-scale-state', scheduleHorizontalBoundsRefresh, { signal });
  document.fonts?.addEventListener('loadingdone', scheduleHorizontalBoundsRefresh, { signal });
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
    canvas?.classList.toggle(
      'is-enabled',
      !analysisFailed && visualizationMode !== MODE_OFF && brightnessLevel > 0
    );
    if (canvas) canvas.dataset.brightnessLevel = String(brightnessLevel);
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
    if (!['auto', MODE_OFF, MODE_HORIZONTAL, MODE_VERTICAL].includes(requestedMode)) return;
    const forceMode = Boolean(event.detail && event.detail.force);
    visualizationChoice = !forceMode && requestedMode === visualizationChoice ? MODE_OFF : requestedMode;
    vcardStorage.local.setItem('vcard-visualization-choice', visualizationChoice);
    document.documentElement.dataset.visualizationChoice = visualizationChoice;
    if (visualizationChoice === 'auto') backgroundBrightness.publish();
    else setVisualizationMode(visualizationChoice);
  }, { signal });

  document.addEventListener('vcard:visualization-state', (event) => {
    const nextLevel = event.detail?.brightnessLevel;
    if (nextLevel === brightnessLevel) return;
    brightnessLevel = nextLevel;
    if (canvas) canvas.dataset.brightnessLevel = String(brightnessLevel);
    canvas?.classList.toggle(
      'is-enabled',
      !analysisFailed && visualizationMode !== MODE_OFF && brightnessLevel > 0
    );
    if (brightnessLevel === 0) {
      if (animationFrame) vcardRenderScheduler.cancel(animationFrame);
      animationFrame = 0;
      lastVisualizationFrame = 0;
      clearVisualizationFrame();
    } else {
      scheduleHorizontalBoundsRefresh();
      const playingAudio = audios.find((audio) => !audio.paused && !audio.ended);
      if (playingAudio) startVisualization();
    }
  }, { signal });

  setVisualizationMode(visualizationMode);
})();

const vcardDebugStyleSource = () => document.querySelector(
  'link[href*="vcard-debug.css"], style[data-vcard-source$="vcard-debug.css"]'
) || document.getElementById('vcard-debug-style')?.content.querySelector('link[rel="stylesheet"]');

(() => {
  const styleSource = vcardDebugStyleSource();
  if (!styleSource) return;
  const scope = new AbortController();
  const { signal } = scope;
  const root = document.documentElement;
  const toggle = document.querySelector('[data-debug-toggle]');
  let requested = false;
  let stylesReady = styleSource.isConnected && Boolean(styleSource.sheet);
  let styleLoading = null;
  const prepareStyles = () => {
    if (styleLoading) return styleLoading;
    styleLoading = new Promise((resolve, reject) => {
      const link = styleSource.isConnected ? styleSource : styleSource.cloneNode(true);
      const onLoad = () => finish();
      const onError = () => finish(new Error('VCard diagnostic stylesheet failed to load'));
      const onAbort = () => finish(new DOMException('Diagnostics cancelled', 'AbortError'));
      const finish = (error = null) => {
        link.removeEventListener('load', onLoad);
        link.removeEventListener('error', onError);
        signal.removeEventListener('abort', onAbort);
        if (error) {
          if (link !== styleSource) link.remove();
          reject(error);
        } else {
          stylesReady = true;
          resolve();
        }
      };
      link.addEventListener('load', onLoad, { once: true });
      link.addEventListener('error', onError, { once: true });
      signal.addEventListener('abort', onAbort, { once: true });
      try { if (!link.isConnected) document.head.append(link); }
      catch (error) { finish(error); }
    }).catch((error) => { styleLoading = null; throw error; });
    return styleLoading;
  };
  const publishDebug = (enabled) => {
    if (root.dataset.debug === (enabled ? 'on' : 'off')) return;
    root.dataset.debug = enabled ? 'on' : 'off';
    document.dispatchEvent(new CustomEvent('vcard:debug-state', {
      detail: { enabled }
    }));
  };
  const setDebug = (enabled) => {
    if (signal.aborted) return;
    requested = enabled;
    if (!enabled || stylesReady) { publishDebug(enabled); return; }
    prepareStyles().then(() => {
      if (!signal.aborted && requested) publishDebug(true);
    }).catch((error) => {
      if (signal.aborted || error?.name === 'AbortError') return;
      requested = false;
      publishDebug(false);
      console.warn('VCard diagnostics unavailable', error);
    });
  };
  setDebug(false);
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) scope.abort();
  }, { signal });
  toggle?.addEventListener('click', (event) => {
    event.preventDefault();
    setDebug(!requested);
  }, { signal });
  vcardKeyboard.register((event) => {
    if (signal.aborted) return false;
    const target = event.target;
    if (target instanceof Element
      && (target.isContentEditable || target.closest('input, textarea, select'))) return false;
    if (event.key !== 'F12' || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false;
    if (!event.repeat) setDebug(!requested);
    return true;
  }, 200);
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
  let preparedMixImages = new Map();
  const mediaStates = new Map();
  const activeImages = new Set();
  let releasedStyleUrls = 0;
  const releaseStyleResources = (state) => {
    if (!state) return;
    state.released = true;
    state.renderAbort?.abort();
    state.renderVersion += 1;
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
  let scriptBaseUrl = null;
  const scriptVersion = (section, resolved) => {
    const versions = window.VCardMediaManifest?.[section];
    if (!versions) return '';
    scriptBaseUrl ||= new URL('.', document.baseURI);
    if (resolved.origin !== scriptBaseUrl.origin || !resolved.pathname.startsWith(scriptBaseUrl.pathname)) return '';
    try {
      // The builder publishes quoted paths relative to the site root. Resolve
      // only the requested path instead of indexing every release at startup.
      const path = resolved.pathname.slice(scriptBaseUrl.pathname.length).split('/').map((part) => (
        encodeURIComponent(decodeURIComponent(part)).replace(/[!'()*]/g,
          (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
      )).join('/');
      return String(versions[path] || '');
    } catch (_error) { return ''; }
  };

  const listKey = (listUrl) => {
    const resolved = new URL(String(listUrl || ''), document.baseURI);
    const version = scriptVersion(resolved.hash.startsWith('#release=') ? 'tvCatalogs' : 'lists', resolved);
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
      const reference = new URL(key);
      const release = reference.hash.startsWith('#release=')
        ? decodeURIComponent(reference.hash.slice('#release='.length)) : null;
      reference.hash = '';
      const pending = release === null ? loadListScript(key) : loadShowCatalog(reference.href).then((catalog) => {
        const selection = Object.entries(catalog.selections || {}).find(
          ([name]) => name.toLowerCase() === release.toLowerCase())?.[1];
        const series = new Map((catalog.series || []).map((item) => [item.name, item]));
        return (selection?.ids || []).map((id) => {
          const split = id.lastIndexOf(':');
          return series.get(id.slice(0, split))?.images?.img?.[id.slice(split + 1)];
        }).filter(Boolean);
      });
      listCache.set(key, pending);
      pending.catch(() => { if (listCache.get(key) === pending) listCache.delete(key); });
    }
    return listCache.get(key);
  };

  const loadShowCatalog = (catalogUrl) => {
    const resolved = new URL(String(catalogUrl || ''), document.baseURI);
    resolved.hash = '';
    const version = scriptVersion('tvCatalogs', resolved);
    if (version) resolved.searchParams.set('v', version);
    const key = resolved.href;
    if (!showCatalogCache.has(key)) {
      const catalogs = window.VCARD_TV_CATALOGS ||= {};
      const read = () => {
        const catalog = catalogs[key];
        if (catalog?.format !== 'aliswb-tv-1') return null;
        // The existing scene owns one mixed pool. Its source can contain any
        // number of free-named TV series; no series is chosen or excluded here.
        const images = {}, styleParams = {};
        for (const series of catalog.series || []) {
          for (const [collection, items] of Object.entries(series.images || {})) {
            images[`${series.name}/${collection}`] = items;
          }
          for (const [style, values] of Object.entries(series.styleParams || {})) {
            styleParams[`${series.name}/${style}`] = values;
          }
        }
        const name = 'tv';
        const selections = Object.fromEntries(Object.entries(catalog.selections || {}).map(
          ([release, selection]) => {
            const value = { ...selection, list: `${key}#release=${encodeURIComponent(release)}` };
            return [release, { ...value, shows: { [name]: value } }];
          }
        ));
        return { ...catalog, selections, defaultShow: name,
          shows: [{ name, images, styleParams }] };
      };
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
    return 'night';
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
    document.documentElement.style.getPropertyValue('--vc-acc').trim()
      || getComputedStyle(document.documentElement).getPropertyValue('--vc-acc').trim()
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
    // Recolour around the source luminance instead of lifting the object to
    // the accent's brightness. Highlights and shadows keep their original level.
    const targetRed = accent[0] / 255;
    const targetGreen = accent[1] / 255;
    const targetBlue = accent[2] / 255;
    const targetLuminance = targetRed * 0.3 + targetGreen * 0.59 + targetBlue * 0.11;
    const redChroma = targetRed - targetLuminance;
    const greenChroma = targetGreen - targetLuminance;
    const blueChroma = targetBlue - targetLuminance;
    const minimumChroma = Math.min(redChroma, greenChroma, blueChroma);
    const maximumChroma = Math.max(redChroma, greenChroma, blueChroma);
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
        const chromaScale = Math.min(
          1,
          minimumChroma < 0 ? sourceLuminance / -minimumChroma : 1,
          maximumChroma > 0 ? (1 - sourceLuminance) / maximumChroma : 1
        );
        const red = sourceLuminance + redChroma * chromaScale;
        const green = sourceLuminance + greenChroma * chromaScale;
        const blue = sourceLuminance + blueChroma * chromaScale;
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

  const loadPortalPairImage = (source, signal = null) => {
    if (signal?.aborted) return Promise.reject(new DOMException('Image load cancelled', 'AbortError'));
    const prepared = preparedMixImages.get(vcardPublishedMediaUrl(source));
    if (prepared) return Promise.resolve(prepared);
    return loader.request(
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
  };

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
      catalogUrl: String(image.vcardShowSelection?.catalogUrl || image.dataset.portalTv || ''),
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
    return String(parts.at(-2) || '').replace(/\.(?:s_|sx_)[a-z0-9_-]+$/i, '');
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

  // Match the gallery's levels LUT, including flat output ranges and rounding.
  // Keep the existing Alarm and Burn transforms independent of this contract.
  const portalBitmapLevel = (value, params) => {
    const black = Number(params.black ?? 0);
    const white = Number(params.white ?? 255);
    const gamma = Number(params.gamma ?? 1);
    const outBlack = Number(params.out_black ?? 0);
    const outWhite = Number(params.out_white ?? 255);
    if (!(white > black) || !(gamma > 0) || !(outWhite >= outBlack)) return value;
    const normalized = Math.max(0, Math.min(1, (value - black) / (white - black)));
    return Math.max(0, Math.min(255, Math.floor(
      outBlack + (outWhite - outBlack) * normalized ** (1 / gamma) + 0.5
    )));
  };

  // Python round() uses ties-to-even for both the radius and alpha division.
  const roundPortalBitmap = (value) => {
    const floor = Math.floor(value);
    return value - floor === 0.5 ? floor + floor % 2 : Math.round(value);
  };

  const blurPortalBitmap = async (input, width, height, radius, checkpoint) => {
    // Match Pillow 12.2 BoxBlur's separable, edge-clamped, 8-bit passes:
    // https://github.com/python-pillow/Pillow/blob/12.2.0/src/libImaging/BoxBlur.c
    const scale = 2 ** 24;
    const weight = Math.floor(Math.fround(scale / (radius * 2 + 1)));
    const farWeight = Math.floor((scale - (radius * 2 + 1) * weight) / 2);
    let source = input;
    for (const vertical of [false, true]) {
      const output = new Uint8Array(input.length);
      const lines = vertical ? width : height;
      const length = vertical ? height : width;
      const stride = vertical ? width : 1;
      const last = length - 1;
      for (let line = 0; line < lines; line += 1) {
        if (line % 16 === 0) await checkpoint();
        const base = vertical ? line : line * width;
        let sum = source[base] * (radius + 1);
        for (let offset = 1; offset <= radius; offset += 1) {
          sum += source[base + Math.min(last, offset) * stride];
        }
        for (let position = 0; position < length; position += 1) {
          const leftFar = source[base + Math.max(0, position - radius - 1) * stride];
          const rightFar = source[base + Math.min(last, position + radius + 1) * stride];
          output[base + position * stride] = Math.floor(
            (sum * weight + (leftFar + rightFar) * farWeight + scale / 2) / scale
          );
          sum += rightFar - source[base + Math.max(0, position - radius) * stride];
        }
      }
      source = output;
    }
    return source;
  };

  const applyPortalBitmap = async (pixels, width, height, params, entry) => {
    const threshold = Number(params.threshold) || 128;
    const strength = Number(params.strength ?? 0);
    const bias = Number(params.bias ?? 0);
    const inverted = Boolean(Number(params.invert));
    const count = width * height;
    let chunkStarted = performance.now();
    const checkpoint = async () => {
      if (!entry.owners.size || entry.controller.signal.aborted) {
        throw new DOMException('Style owner released', 'AbortError');
      }
      if (performance.now() - chunkStarted >= 4) {
        await yieldPortalRender(() => entry.owners.size > 0, entry.controller.signal);
        chunkStarted = performance.now();
      }
    };
    let means = null;
    if (strength) {
      const fraction = Number(params.radius);
      if (!(fraction > 0 && fraction <= 0.5)
        || !(strength > 0 && strength <= 1) || !Number.isFinite(bias)) {
        throw new Error('Invalid adaptive Bitmap parameters');
      }
      const radius = Math.max(1, roundPortalBitmap(Math.min(width, height) * fraction));
      const gray = new Uint8Array(count);
      const alpha = new Uint8Array(count);
      let opaque = true;
      for (let index = 0; index < count; index += 1) {
        if (index % (portalRenderChunkBytes / 4) === 0) await checkpoint();
        gray[index] = pixels.data[index * 4];
        alpha[index] = pixels.data[index * 4 + 3];
        if (alpha[index] !== 255) opaque = false;
      }
      if (opaque) {
        means = await blurPortalBitmap(gray, width, height, radius, checkpoint);
      } else {
        // ImageChops.multiply truncates gray * alpha / 255 before blurring.
        for (let index = 0; index < count; index += 1) {
          if (index % (portalRenderChunkBytes / 4) === 0) await checkpoint();
          gray[index] = Math.floor(gray[index] * alpha[index] / 255);
        }
        means = await blurPortalBitmap(gray, width, height, radius, checkpoint);
        const denominator = await blurPortalBitmap(alpha, width, height, radius, checkpoint);
        for (let index = 0; index < count; index += 1) {
          if (index % (portalRenderChunkBytes / 4) === 0) await checkpoint();
          means[index] = denominator[index]
            ? Math.min(255, roundPortalBitmap(means[index] * 255 / denominator[index])) : 0;
        }
      }
    }
    for (let index = 0; index < count; index += 1) {
      if (index % (portalRenderChunkBytes / 4) === 0) await checkpoint();
      const limit = means ? (1 - strength) * threshold + strength * (means[index] + bias) : threshold;
      let value = pixels.data[index * 4] >= limit ? 255 : 0;
      if (inverted) value = 255 - value;
      pixels.data[index * 4] = value;
      pixels.data[index * 4 + 1] = value;
      pixels.data[index * 4 + 2] = value;
    }
    await checkpoint();
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
        const bitmap = style === 's_bitmap' || style === 's_inverse';
        const bitmapLevels = bitmap
          ? Uint8Array.from({ length: 256 }, (_, value) => portalBitmapLevel(value, params)) : null;
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
          if (style === 's_alarm' && !params.preserve_color || style === 's_bitmap' || style === 's_inverse') {
            const gray = inputMode === 'gray'
              ? pixels.data[index]
              : Math.round(portalProfileGray(
                pixels.data[index],
                pixels.data[index + 1],
                pixels.data[index + 2],
                grayProfile
              ));
            const value = bitmapLevels ? bitmapLevels[gray]
              : Math.round(Math.max(0, Math.min(255, portalLevel(gray, params))));
            pixels.data[index] = value;
            pixels.data[index + 1] = value;
            pixels.data[index + 2] = value;
          } else if (style === 's_burn' || style === 's_alarm' && params.preserve_color) {
            pixels.data[index] = Math.round(Math.max(
              0, Math.min(255, portalLevel(pixels.data[index], params))
            ));
            pixels.data[index + 1] = Math.round(Math.max(
              0, Math.min(255, portalLevel(pixels.data[index + 1], params))
            ));
            pixels.data[index + 2] = Math.round(Math.max(
              0, Math.min(255, portalLevel(pixels.data[index + 2], params))
            ));
          }
        }
        if (bitmap && Number(params.apply_bitmap ?? 1) !== 0) {
          await applyPortalBitmap(pixels, width, height, params, entry);
        }
        context.putImageData(pixels, 0, 0);
        if (style === 's_burn') applyBurnGlow(canvas, params.glow_stage);
        const blob = await new Promise((resolve, reject) => canvas.toBlob(
          (value) => value ? resolve(value) : reject(new Error('PortalTV style encoding failed')),
          bitmap ? 'image/png' : 'image/webp',
          0.9
        ));
        if (!entry.owners.size || entry.controller.signal.aborted) {
          throw new DOMException('Style owner released', 'AbortError');
        }
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

  const runWhenIdle = (callback) => {
    if (typeof window.requestIdleCallback === 'function') {
      return window.requestIdleCallback(callback, { timeout: 1200 });
    }
    return window.setTimeout(callback, 80);
  };

  const portalPairKey = (baseSource, maskSource, accentColor) => (
    [baseSource, maskSource, String(accentColor).trim().toLowerCase()].join('\n')
  );

  const preparePortalPairOverlay = async (
    baseSource,
    maskSource,
    accentColor,
    shouldContinue = () => true,
    signal = null
  ) => {
    const color = String(accentColor || currentAccentColor()).trim();
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
    accentContext.fillStyle = color;
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
      sourceKey: portalPairKey(baseSource, maskSource, color),
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

  const portalRequiresMask = (image, state) => (
    state?.frameMaskMode === 'required'
    && !(root.dataset.colorPreset === 'newspaper'
      && !window.VCardPortalLayout?.isFullscreen(image))
  );

  const publishPortalFrameReady = async (image, version, status = {}) => {
    const state = mediaStates.get(image);
    const dayPending = image.dataset.dayMediaPending === 'true';
    if ((image.dataset.portalPreviewPending === 'true' || dayPending) && !status.failed) {
      try { await image.decode(); } catch (_error) {
        if (dayPending) status = { ...status, failed: true };
      }
      if (mediaStates.get(image) !== state || state?.renderVersion !== version || !state.active) return false;
    }
    if (!state || state.released || !state.active || state.renderVersion !== version) return false;
    if (state?.renderVersion === version) delete image.dataset.portalPreviewPending;
    if (dayPending && state?.renderVersion === version && !status.failed && !status.maskFailed) {
      delete image.dataset.dayMediaPending;
    }
    if (!document.hidden && document.documentElement.dataset.imagesVisible !== 'off'
      && state?.active && state.pendingRandomIndex === null
      && !status.failed
      && (!portalRequiresMask(image, state) || status.maskReady === true)
      && state.frameReservation?.item.index === state.index) {
      state.frameReservation.commit();
      state.frameReservation = null;
      publishPortalImageState(image);
    }
    document.dispatchEvent(new CustomEvent('vcard:portal-frame-ready', {
      detail: { image, version, ...status },
    }));
    return !status.failed && (!portalRequiresMask(image, state) || status.maskReady === true);
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
    canvas.vcardPairSource = prepared.sourceKey;
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

  const setActive = (image, active = true, render = true) => {
    if (!image) return;
    const state = mediaStates.get(image);
    if (active) {
      const wasActive = activeImages.has(image) && (!state || state.active);
      activeImages.add(image);
      if (state) {
        state.active = true;
        if (render && !wasActive) renderState(image);
      }
      return;
    }
    activeImages.delete(image);
    if (!state) return;
    state.active = false;
    state.renderVersion = (state.renderVersion || 0) + 1;
    state.renderAbort?.abort();
    releasePortalPairOverlay(image);
  };

  const syncPortalPairOverlay = (image, baseSource = '', maskSource = '', hideUntilReady = false) => {
    const state = mediaStates.get(image);
    if (!state?.active || vcardFileMode) {
      releasePortalPairOverlay(image);
      return Promise.resolve({ maskReady: false, maskFailed: true });
    }
    if (!baseSource || !maskSource) {
      clearPortalPairOverlay(image);
      return Promise.resolve({ maskReady: false, maskFailed: false });
    }
    const pair = ensurePortalPairCanvas(image);
    if (!pair) return Promise.resolve({ maskReady: false, maskFailed: true });
    const color = state.portalAccentColor || currentAccentColor();
    const sourceKey = portalPairKey(baseSource, maskSource, color);
    if (pair.canvas.classList.contains('is-ready') && pair.canvas.vcardPairSource === sourceKey) {
      return Promise.resolve({ maskReady: true, maskFailed: false });
    }
    const version = state.renderVersion;
    const signal = state.renderAbort?.signal;
    const current = () => !mediaScope.signal.aborted && !signal?.aborted
      && !state.released && state.active && mediaStates.get(image) === state
      && version === state.renderVersion;
    if (hideUntilReady) pair.motionLayer.classList.add('is-pair-pending');
    return preparePortalPairOverlay(baseSource, maskSource, color, current, signal)
      .then((prepared) => ({ maskReady: current() && commitPortalPairOverlay(image, prepared), maskFailed: false }))
      .catch((error) => {
        if (!current() || error?.name === 'AbortError') return { maskReady: false, maskFailed: false };
        console.warn('VCard portal: cannot prepare mask overlay', error);
        if (state.frameMaskMode !== 'required') clearPortalPairOverlay(image);
        return { maskReady: false, maskFailed: true };
      });
  };

  const portalStyleSpec = (state, source, fullscreen) => {
    const newspaper = !fullscreen && root.dataset.colorPreset === 'newspaper';
    const style = fullscreen ? '' : newspaper ? 's_bitmap' : String(state?.frameStyle || '');
    const number = portalSourceNumber(source);
    const maskCollection = portalCollectionName(source, 's_mask');
    const maskItem = !fullscreen && !newspaper && state?.frameUsesMask && number
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
    const physicalSource = newspaper && number
      ? portalCatalogItemUrl(state?.showCatalogUrl, state?.showImages?.[styleCollection]?.[number]) : '';
    if (physicalSource) return { style: '', params: null, inputMode: 'color', mask, physicalSource };
    const entry = number && state?.showStyleParams?.[styleCollection]?.[number];
    const params = entry?.parameters || entry;
    if (!params || !['s_alarm', 's_bitmap', 's_inverse', 's_burn'].includes(style)) {
      return { style: '', params: null, inputMode: 'color', mask };
    }
    return {
      style,
      params: state?.framePreserveStyleColor && style === 's_alarm' ? { ...params, preserve_color: true } : params,
      inputMode: entry?.inputMode || 'color',
      mask,
    };
  };

  const portalFrameSource = (state, source) => {
    if (root.dataset.colorPreset === 'newspaper') return source;
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
    if (root.dataset.colorPreset === 'newspaper'
      && !window.VCardPortalLayout?.isFullscreen(image)) return 'gray';
    if (state?.frameTone === 'vc_yellow') return 'yellow-tint';
    if (state?.frameTone === 'vc_accent') return 'accent-tint';
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
    styleSpec.physicalSource ? Promise.resolve(vcardPublishedMediaUrl(styleSpec.physicalSource)) : styleSpec.style
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
    if (state && !state.active) return Promise.resolve(false);
    // The first preview has no published outgoing frame to crossfade from.
    // In particular, never retain its unprocessed HTML source as an overlay.
    if (image.dataset.portalPreviewPending === 'true' || image.dataset.dayMediaPending === 'true') {
      crossfade = false;
    }
    const mode = portalImageMode(image, state);
    if (!state || !state.groups.length) {
      applyImageEffect(image, mode);
      return Promise.resolve(false);
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
    if (!items.length) return Promise.resolve(false);
    const original = sourceForMode(group, 'original');
    const originalUrl = original && vcardPublishedMediaUrl(state.listUrl
      ? listItemUrl(state.listUrl, original) : original);
    const hoverLayer = image.closest('.vcard-portal-motion-layer');
    if (hoverLayer && originalUrl) {
      hoverLayer.style.setProperty('--portal-hover-original', `url(${JSON.stringify(originalUrl)})`);
    }
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
      root.dataset.colorPreset === 'newspaper' && !fullscreen ? 'gray' : styleSpec.style
        ? (state.frameTone === 'vc_yellow' ? 'yellow-tint' : state.frameTone === 'vc_accent'
          ? 'accent-tint' : state.frameTone === 'vc' ? 'vc-tint'
          : (state.frameTone === 'vc_grey' ? 'gray' : 'original'))
        : baseMode
    );
    const nextDisplayKey = [
      normalizedSource(nextSource),
      nextStyle.style,
      nextStyle.physicalSource || '',
      nextStyle.inputMode || '',
      nextStyle.mask,
      JSON.stringify(nextStyle.params || {}),
    ].join('\n');
    const pairedTone = (mode === 'duo' || mode === 'color-tint' || mode === 'vc-tint' || mode === 'accent-tint')
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
    if (portalRequiresMask(image, state) && !(nextStyle.mask || pairMask)) {
      return publishPortalFrameReady(image, version, { failed: true, maskFailed: true });
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
      return syncPortalPairOverlay(image, activePairBase, activePairMask, hideUntilReady)
        .then((status) => {
          return isCurrent() ? publishPortalFrameReady(image, version, status) : false;
        });
    }
    if (!preload) {
      const displaySource = renderPortalStyleSource(nextSource, nextStyle, state, renderSignal);
      return displaySource.then((resolvedSource) => {
        if (!isCurrent()) return false;
        image.setAttribute('src', resolvedSource);
        applyImageEffect(image, imageEffectFor(nextStyle));
        state.sourceKey = normalizedSource(nextSource);
        state.renderedSource = resolvedSource;
        state.displayKey = nextDisplayKey;
        return syncPortalPairOverlay(
          image,
          nextStyle.mask ? resolvedSource : pairBase,
          nextStyle.mask || pairMask
        ).then((status) => {
          return isCurrent() ? publishPortalFrameReady(image, version, status) : false;
        });
      }).catch((error) => {
        if (!isCurrent() || error?.name === 'AbortError'
          || error?.message === 'Portal render cancelled') return false;
        if (portalRequiresMask(image, state)) {
          return publishPortalFrameReady(image, version, { failed: true, maskFailed: true });
        }
        image.setAttribute('src', nextSource);
        applyImageEffect(image, imageEffectFor(nextStyle));
        state.sourceKey = normalizedSource(nextSource);
        state.renderedSource = nextSource;
        state.displayKey = nextDisplayKey;
        clearPortalPairOverlay(image);
        return publishPortalFrameReady(image, version, { maskFailed: Boolean(nextStyle.mask) });
      });
    }
    const tryCandidate = (index) => {
      if (!isCurrent()) return Promise.resolve(false);
      if (index >= candidates.length) {
        return publishPortalFrameReady(image, version, { failed: true, maskFailed: portalRequiresMask(image, state) });
      }
      const candidate = candidates[index];
      const candidateStyle = portalStyleSpec(state, candidate, fullscreen);
      const candidateDisplayKey = [
        normalizedSource(candidate),
        candidateStyle.style,
        candidateStyle.physicalSource || '',
        candidateStyle.inputMode || '',
        candidateStyle.mask,
        JSON.stringify(candidateStyle.params || {}),
      ].join('\n');
      const accentColor = state.portalAccentColor || currentAccentColor();
      const displaySource = renderPortalStyleSource(candidate, candidateStyle, state, renderSignal);
      return displaySource.then(async (resolvedSource) => {
        await loadPortalPairImage(resolvedSource, renderSignal);
        return resolvedSource;
      }).then(async (resolvedSource) => {
        if (!isCurrent()) return false;
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
          if (!isCurrent()) return false;
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
          return publishPortalFrameReady(image, version, { maskReady: false });
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
        return publishPortalFrameReady(image, version, { maskReady: true });
      }).catch((error) => {
        if (!isCurrent() || error?.name === 'AbortError' || error?.message === 'Portal render cancelled') return false;
        console.warn('VCard portal: cannot publish styled frame with mask', error);
        if (portalRequiresMask(image, state)) {
          return tryCandidate(index + 1);
        }
        return loadPortalPairImage(candidate, renderSignal).then(() => {
          if (!isCurrent()) return false;
          image.setAttribute('src', candidate);
          applyImageEffect(image, imageEffectFor(candidateStyle));
          state.sourceKey = normalizedSource(candidate);
          state.renderedSource = candidate;
          state.displayKey = candidateDisplayKey;
          const existingPairCanvas = image.closest('.vcard-portal-motion-layer')?.querySelector(
            ':scope > .vcard-portal-mask-overlay'
          );
          if (existingPairCanvas) clearPortalPairOverlay(image);
          return publishPortalFrameReady(image, version, {
            maskFailed: Boolean(candidateStyle.mask),
          });
        }).catch(() => tryCandidate(index + 1));
      });
    };
    return tryCandidate(0);
  };

  const register = (image, listUrl, groups, index = 0) => {
    if (mediaScope.signal.aborted) return;
    const previousState = mediaStates.get(image);
    const previousFrame = previousState?.debugBaseFrame;
    if (!groups.length && !previousState?.renderedSource) image.removeAttribute('src');
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
      portalAccentColor: '',
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
      image.vcardPendingPortalFrame || previousFrame || vcardPortalPlan.frame(image.closest('.song__preview')),
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
    const tone = styleNames.includes('vc_yellow') ? 'vc_yellow' : styleNames.includes('vc_accent')
      ? 'vc_accent' : styleNames.includes('vc')
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
      || Boolean(step.preserveStyleColor) !== Boolean(state.framePreserveStyleColor)
      || style !== state.frameStyle
      || tone !== state.frameTone;
    const maskChanged = usesMask !== state.frameUsesMask
      || maskMode !== state.frameMaskMode;
    const pipelineChanged = basePipelineChanged || maskChanged;
    const levelsChanged = brightness !== state.frameBrightness
      || contrast !== state.frameContrast;
    state.frameSource = source;
    state.frameStyle = style;
    state.framePreserveStyleColor = Boolean(step.preserveStyleColor);
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
    const pendingLoad = waitingForSlide(state);
    if (signal?.aborted || (!prepared && !pendingLoad)) {
      clearPreload(image);
      return null;
    }
    const pending = Number.isInteger(state.pendingRandomIndex)
      ? state.pendingRandomIndex
      : state.index;
    if (signal?.aborted || state.preloadGeneration !== generation) return null;
    return {
      index: pending,
      pending: pendingLoad,
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
    // A compositor clone inherits the source scenario before its first render.
    target.vcardPendingPortalFrame = sourceState.debugBaseFrame
      ? { ...sourceState.debugBaseFrame } : null;
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
    if (mediaScope.signal.aborted || !state?.groups.length || !frame || !Number.isInteger(index) || signal?.aborted) return Promise.resolve(false);
    state.pendingRandomIndex = null;
    state.index = ((index % state.groups.length) + state.groups.length) % state.groups.length;
    setPortalFrame(image, frame, false);
    setActive(image, true, false);
    const rendering = renderState(image, true, '', false);
    const renderOwner = state.renderAbort;
    let cancelled;
    const cancellation = new Promise((resolve) => { cancelled = () => resolve(false); });
    const abort = () => { renderOwner?.abort(); cancelled(); };
    signal?.addEventListener('abort', abort, { once: true });
    mediaScope.signal.addEventListener('abort', abort, { once: true });
    renderOwner?.signal.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted || mediaScope.signal.aborted || !isCurrent()) abort();
    else if (renderOwner?.signal.aborted) cancelled();
    return Promise.race([rendering, cancellation])
      .then((ready) => Boolean(ready && !signal?.aborted && isCurrent()))
      .finally(() => {
        signal?.removeEventListener('abort', abort);
        mediaScope.signal.removeEventListener('abort', abort);
        renderOwner?.signal.removeEventListener('abort', cancelled);
      });
  };

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

  const waitingForSlide = (state, index = state?.pendingRandomIndex) => Boolean(
    state?.slideLoading?.started && Number.isInteger(index)
    && !state.slideLoading.ready.has(index) && !state.slideLoading.failed.has(index)
  );

  const preloadIndex = async (image, index, signal = null) => {
    const state = mediaStates.get(image);
    if (signal?.aborted || !state || !Number.isInteger(index) || index < 0 || index >= state.groups.length) {
      return Promise.resolve(false);
    }
    const targetIndex = ((index % state.groups.length) + state.groups.length) % state.groups.length;
    const loading = state.slideLoading;
    if (loading?.started && !loading.ready.has(targetIndex)) {
      if (!await loading.prepareCached(targetIndex, signal)) return false;
      if (signal?.aborted || mediaStates.get(image) !== state) return false;
    }
    const group = state.groups[targetIndex];
    const mode = portalImageMode(image, state);
    const fullscreen = Boolean(window.VCardPortalLayout?.isFullscreen(image));
    const item = sourceForMode(group, mode, fullscreen);
    const source = item && portalFrameSource(
      state,
      state.listUrl ? listItemUrl(state.listUrl, item) : item
    );
    if (!source) return Promise.resolve(false);
    const pairedTone = (mode === 'duo' || mode === 'color-tint' || mode === 'vc-tint' || mode === 'accent-tint')
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
      const loading = state.slideLoading;
      if (loading) {
        loading.frames.push(...historyGroups.map(loading.sourcesForGroup));
        if (loading.started) Promise.resolve(loading.work).then(() => vcardMedia.startSlideLoading(image));
      }
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
      if (!ready && !signal?.aborted && maskMode !== 'required' && !waitingForSlide(state, reservation.item.index)
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
      if (!ready && waitingForSlide(state)) return false;
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
    const skipPortal = Boolean(options && options.skipPortal);
    activeImages.forEach((image) => {
      if (skipPortal && image.closest('.song__preview')) return;
      const state = mediaStates.get(image);
      const hasPair = Boolean(
        state && state.groups.some((group) => group.pairedPortal)
      );
      if (hasPair && skipPaired) return;
      renderState(image);
    });
  };

  const refreshPalette = () => refresh({ skipPortal: true });
  let wasNewspaper = root.dataset.colorPreset === 'newspaper';
  document.addEventListener('vcard:preset-state', () => {
    const newspaper = root.dataset.colorPreset === 'newspaper';
    refresh({ skipPortal: !newspaper && !wasNewspaper });
    wasNewspaper = newspaper;
  }, { signal: mediaScope.signal });
  document.addEventListener('vcardcolorschemechange', refreshPalette, { signal: mediaScope.signal });
  document.addEventListener('vcardacccolorchange', refreshPalette, { signal: mediaScope.signal });
  document.addEventListener('vcardtextcolorchange', () => refresh({ skipPaired: true, skipPortal: true }),
    { signal: mediaScope.signal });
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
      layer.querySelectorAll('.vcard-portal-crossfade-previous')
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
    preparedMixImages: preparedMixImages.size,
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
    preparedMixImages.clear();
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
    portalSourceSeries,
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
        if (['s_alarm', 's_bitmap', 's_inverse', 's_burn'].includes(style)) available.add(style);
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
    selectPlaybackShow: async (image, { profile, sourceScope, releaseId, releaseKey, signal, isCurrent, origin = null, onProgress = null, prepareResources = null }) => {
      if (!image) return null;
      image.vcardSongSeriesAbsent = false;
      image.vcardShowReservation?.cancel();
      image.vcardShowReservation = null;
      await vcardMedia.initializePortalImage(image);
      if (!isCurrent()) return null;
      const catalogUrl = String(image.dataset.portalTv || '');
      let catalog = null;
      try {
        if (catalogUrl) catalog = await loadShowCatalog(catalogUrl);
      } catch (error) {
        if (!isCurrent() || error?.name === 'AbortError') return null;
        console.warn(`VCard PortalTV: cannot load ${catalogUrl}`, error);
      }
      if (!isCurrent()) return null;
      image.vcardSongSeriesAbsent = (!catalogUrl
        || Boolean(catalog && !(catalog.series || []).length));
      const requestedRelease = String(releaseId || '').toLowerCase();
      const release = Object.entries(catalog?.selections || {}).find(
        ([key]) => key.toLowerCase() === requestedRelease
      )?.[1];
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
      const prepared = new Map();
      preparedMixImages = prepared;
      const imageState = mediaStates.get(image);
      const sourcesForGroup = (group) => {
        const original = sourceForMode(group, 'original');
        const source = original && (imageState.listUrl ? listItemUrl(imageState.listUrl, original) : original);
        if (!source) return [];
        const mask = portalStyleSpec({ ...imageState, frameUsesMask: true }, source, false).mask;
        return [source, mask].filter(Boolean);
      };
      const frames = (imageState?.groups || []).map(sourcesForGroup);
      if (imageState) {
        const job = { frames, ready: new Set(), failed: new Set(), preparing: new Map(), started: false, running: false };
        job.sourcesForGroup = sourcesForGroup;
        job.current = () => !mediaScope.signal.aborted && !signal?.aborted && isCurrent()
          && mediaStates.get(image) === imageState && imageState.slideLoading === job;
        job.prepare = (index) => {
          if (!job.current() || job.ready.has(index) || job.failed.has(index)) return Promise.resolve();
          if (job.preparing.has(index)) return job.preparing.get(index);
          const work = (async () => {
            try {
              await vcardMediaCache.cacheUrls(frames[index] || [], null, { signal, required: true, concurrency: 1,
                prepare: async (source) => {
                  const ready = await loadPortalPairImage(source, signal);
                  if (job.current()) prepared.set(vcardPublishedMediaUrl(source), ready);
                } });
              if (job.current()) job.ready.add(index);
            } catch (error) {
              if (job.current() && error?.name !== 'AbortError') {
                job.failed.add(index);
                console.warn(`VCard TV slide preload failed: ${frames[index]?.[0] || index}`, error);
              }
            }
          })().finally(() => job.preparing.delete(index));
          job.preparing.set(index, work);
          return work;
        };
        job.prepareCached = async (index, callerSignal) => {
          if (!job.current() || callerSignal?.aborted || job.failed.has(index)) return false;
          if (job.ready.has(index)) return true;
          const sources = frames[index];
          if (!sources?.length) return false;
          if (sources.every((source) => prepared.has(vcardPublishedMediaUrl(source)))) {
            job.ready.add(index);
            return true;
          }
          // A warm cache is ready for decoding even before the sequential
          // loader reaches this frame. Never start a cold download here.
          if (!await vcardMediaCache.hasComplete(sources, callerSignal)
            || !job.current() || callerSignal?.aborted) return false;
          await job.prepare(index);
          return job.current() && !callerSignal?.aborted && job.ready.has(index);
        };
        imageState.slideLoading = job;
      }
      // Register nonblocking background caching. Only the selected first
      // visual frame remains part of initial preparation.
      if (prepareResources) await prepareResources([]);
      else onProgress?.(1, 1);
      if (signal?.aborted || !isCurrent()) return null;
      const frame = image.closest('.song-vibeframe');
      if (frame) {
        frame.dataset.showName = items.length ? show.name : '';
        frame.dataset.showProfile = profile;
      }
      return items.length ? { name: show.name, catalogUrl, list: selection.list,
        scope: catalog.scope, count: items.length } : null;
    },
    completeSongPreload: async (image, signal) => {
      const state = mediaStates.get(image);
      if (!signal?.aborted && state?.slideLoading) await state.slideLoading.prepare(state.index);
    },
    startSlideLoading: (image) => {
      const job = mediaStates.get(image)?.slideLoading;
      if (!job || job.running || !job.current()) return;
      job.started = true;
      job.running = true;
      // Current slides must not wait behind optional next-song MP3s or videos.
      // Keep this show's downloads sequential, independently of that cache queue.
      job.work = (async () => {
        for (let index = 0; index < job.frames.length && job.current(); index += 1) {
          await job.prepare(index);
        }
      })().finally(() => { job.running = false; });
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
// Share pending requests only. Parsed playlist payloads are released after
// delivery; reusable text files remain in the browser's resource cache.
const vcardSongTexts = (() => {
  const requests = new Map();
  const load = (source) => {
    const url = vcardPublishedMediaUrl(source);
    if (!requests.has(url)) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 30000);
      const request = (window.VCardCrypt?.protectedUrl(url)
        ? window.VCardCrypt.json(url).then(texts => new Response(JSON.stringify(texts)))
        : fetch(url, { cache: 'force-cache', credentials: 'same-origin', signal: controller.signal }))
        .then((response) => {
          if (!response.ok) throw new Error(`Song text HTTP ${response.status}`);
          return response.json();
        }).then((texts) => {
          if (!texts || Array.isArray(texts) || typeof texts !== 'object') throw new Error('Invalid song text payload');
          vcardMediaCache.cacheUrls([url]).catch((error) => console.warn('VCard text cache failed', error));
          return texts;
        }).finally(() => {
          window.clearTimeout(timeout);
          if (requests.get(url) === request) requests.delete(url);
        });
      requests.set(url, request);
    }
    return requests.get(url);
  };
  return { load };
})();
window.VCardMediaLoader = Object.freeze({
  preloadNext: (entry, signal) => vcardMediaCache.enqueue(async () => {
    const preview = window.VCardCatalogView?.previewFor(entry);
    if (!preview || signal.aborted) return;
    // Cache only: never open the card, bind audio or reserve visual bags.
    const settings = vcardPortalPlan.settings(preview);
    const crossUrl = settings.CrossAniFile ? vcardPublishedMediaUrl(settings.CrossAniFile) : '';
    const crossFiles = crossUrl && /\.js(?:[?#]|$)/i.test(crossUrl)
      ? (await vcardMedia.loadList(crossUrl)).map((item) => vcardMedia.listItemUrl(crossUrl, item))
      : crossUrl ? [crossUrl] : [];
    await vcardMediaCache.cacheUrls([
      entry.audioSrc, settings.PlayAniPosterFile, settings.PlayAniVideoFile,
      preview.querySelector('.song__preview-text')?.dataset.textSrc,
      'sys/playbutton/audio-play.webp', 'sys/playbutton/audio-pause.webp',
      ...Array.from(preview.querySelectorAll('.song-video-link__logo'), (image) => image.getAttribute('src')),
      ...crossFiles,
    ].filter(Boolean).map(vcardPublishedMediaUrl), null, { signal, required: true, concurrency: 1 });
    if (!signal.aborted && window.VCardCrypt?.protectedUrl(entry.audioSrc)) {
      await window.VCardCrypt.audioUrl(entry.audioSrc);
    }
    if (signal.aborted) return;
    const scopes = window.VCLife?.scenario.profile?.preloadScopes(entry) || [];
    if (scopes.includes('song')) {
      if (signal.aborted) return;
      const catalogUrl = preview.querySelector('.song__preview-image')?.dataset.portalTv;
      if (!catalogUrl) return;
      const catalog = await vcardMedia.loadShowCatalog(catalogUrl);
      if (signal.aborted) return;
      const releaseId = entry.releaseId.toLowerCase();
      const selection = Object.entries(catalog.selections || {}).find(
        ([release]) => release.toLowerCase() === releaseId)?.[1];
      for (const id of selection?.ids || []) {
        if (signal.aborted) return;
        const split = id.lastIndexOf(':');
        const series = catalog.series.find((item) => item.name === id.slice(0, split));
        const index = id.slice(split + 1);
        const urls = [series?.images?.img?.[index], series?.images?.s_mask?.[index]]
          .filter(Boolean).map((source) => new URL(source, new URL(catalogUrl, document.baseURI)).href);
        await vcardMediaCache.cacheUrls(urls, null, { signal, required: true, concurrency: 1 });
      }
    }
  }, signal),
  activateAudio: async (audio, preview) => {
    if (audio.vcardPlayingPreview !== preview) throw new DOMException('Selected song changed', 'AbortError');
    const source = audio.dataset.audioSrc;
    if (!source) throw new Error('Selected audio source is unavailable');
    const playable = window.VCardCrypt?.protectedUrl(source)
      ? await window.VCardCrypt.audioUrl(source, {current:true}) : source;
    if (audio.vcardPlayingPreview !== preview || audio.dataset.audioSrc !== source) throw new DOMException('Selected song changed', 'AbortError');
    if (audio.getAttribute('src') !== playable || audio.error) {
      audio.vcardResolvedSource = playable;
      audio.dataset.cryptOriginal = source;
      audio.setAttribute('src', playable);
      audio.load();
    }
  },
  prepareAudio: vcardMedia.prepareAudio,
  prepareVideo: vcardMedia.prepareVideo,
});

(() => {
  const imageInitializationScope = new AbortController();
  const { signal } = imageInitializationScope;
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) imageInitializationScope.abort();
  }, { signal });
  document.querySelectorAll(':is(.page-image, img[image-color]):not(.song__preview-image)').forEach(async (image) => {
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
      reason: origin?.event === 'BuildMedia.Init' ? 'build-selection' : 'calendar-day',
      day: origin?.event === 'BuildMedia.Init' ? null : vcardCalendarDay, index, count,
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
    const origin = vcardDecisionOrigin(image.hasAttribute('image-build') ? 'BuildMedia.Init' : 'DayMedia.Init', true);
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

      const index = image.hasAttribute('image-build') ? 0 : (vcardCalendarDay - 1) % groups.length;
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

const createVCardFrameInitializer = () => {
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

  return initializeFrame;
};

  const createVCardSlideshowInitializer = () => {
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
    return initializeSlideshow;
  };

  (() => {
    const scope = new AbortController();
    const { signal } = scope;
    let frameInitializer = null;
    let slideshowInitializer = null;
    let observer = null;
    const prepareFrame = (host) => {
      if (signal.aborted || !host?.isConnected) return;
      frameInitializer ||= createVCardFrameInitializer();
      void frameInitializer(host);
    };
    const prepareSlideshow = (image) => {
      if (signal.aborted || !image?.isConnected) return;
      slideshowInitializer ||= createVCardSlideshowInitializer();
      void slideshowInitializer(image);
    };
    const prepare = (element) => {
      if (element.matches('.image-vibeframe[frame]')) prepareFrame(element);
      if (element.matches('img[slideshow]:not(.song__preview-image)')) prepareSlideshow(element);
    };
    const observe = (root) => {
      const elements = root.querySelectorAll('.image-vibeframe[frame], img[slideshow]:not(.song__preview-image)');
      if (!elements.length || signal.aborted) return;
      if (!('IntersectionObserver' in window)) {
        elements.forEach(prepare);
        return;
      }
      observer ||= new IntersectionObserver((entries) => {
        if (signal.aborted) return;
        for (const entry of entries) {
          if (!entry.target.isConnected) { observer.unobserve(entry.target); continue; }
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          prepare(entry.target);
        }
      });
      elements.forEach((element) => observer.observe(element));
    };
    observe(document);
    document.addEventListener('vcard:song-text-ready', (event) => observe(event.target), { signal });
    document.addEventListener('vcard:activate-portal-image', (event) => {
      const image = event.detail?.image;
      prepareFrame(image?.closest('.song-vibeframe[frame]'));
      if (image?.hasAttribute('slideshow')) prepareSlideshow(image);
    }, { signal });
    signal.addEventListener('abort', () => observer?.disconnect(), { once: true });
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) scope.abort();
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
      // Closed cards carry a URL as data, so parsing HTML never fetches their frames.
      if (!image.getAttribute('src') && image.dataset.portalSrc) {
        image.src = image.dataset.portalSrc;
      }
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
      const showCatalogUrl = String(image.dataset.portalTv || '').trim();
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
      : 'small';
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

    const applyImagesVisibility = (visibilityChanged = false) => {
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
          visible: imagesVisible,
          visibilityChanged
        }
      }));
      document.dispatchEvent(new CustomEvent('vcard:images-visible-state', {
        detail: { visible: imagesVisible }
      }));
    };

    const setImagesVisible = (visible) => {
      const nextVisible = Boolean(visible);
      if (nextVisible === imagesVisible) return;
      const readingText = openedPortalPreview()?.querySelector('.song__preview-text');
      const readingTop = readingText?.getBoundingClientRect().top;
      imagesVisible = nextVisible;
      vcardStorage.local.setItem(IMAGES_VISIBLE_STORAGE_KEY, imagesVisible ? 'on' : 'off');
      applyImagesVisibility(true);
      if (readingText?.isConnected && Number.isFinite(readingTop)) {
        const shift = readingText.getBoundingClientRect().top - readingTop;
        if (Math.abs(shift) > 0.5) {
          window.scrollTo({ top: window.scrollY + shift, behavior: 'instant' });
        }
      }
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
      // it for the next track briefly promoted the PlayAni/poster to the full
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
    const portalOrigins = new WeakMap();
    const preparePortalOrigin = (preview) => {
      const portal = preview.querySelector('.song-portal-stage, .song-vibeframe');
      if (!portal || portalOrigins.has(portal)) return;
      const origin = document.createElement('div');
      origin.className = 'song-portal-origin';
      origin.setAttribute('aria-hidden', 'true');
      portal.before(origin);
      portalOrigins.set(portal, origin);
    };
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
      const audioUrl = audioSrc ? new URL(audioSrc, document.baseURI) : null;
      const audioPublished = vcardAudioPublished(audioUrl);
      if (preview) preview.dataset.audioPublished = String(audioPublished);
      if (audioSrc && !audioPublished) console.warn(`VCard audio is not published; excluded from playback selection: ${audioSrc}`);
      const entry = Object.freeze({
        listId, localId, songId, releaseId, releaseKey,
        entryKey: releaseKey ? JSON.stringify([listId.toLowerCase(), songId.toLowerCase(), releaseId.toLowerCase()]) : '',
        title: (button.querySelector('.song__player-title')?.textContent || button.querySelector('.song__item-text')?.textContent || button.textContent || '').replace(/\s+/g, ' ').trim(),
        author: String(preview?.dataset.mp3Author || '').trim(),
        audioSrc,
        playable: Boolean(audioSrc && !audioSrc.endsWith('/') && audioPublished),
        hasTrackBand: Boolean(preview?.querySelector('[data-track-band]')?.dataset.trackBand?.trim()),
        hasImages: Boolean(image),
        hasShow: Boolean(image?.dataset.portalTv),
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
    let entriesByKey = null;
    let buttonsByEntryKey = null;
    const entriesByList = new Map();
    let userLists = null;
    let playingPlaylistId = '';
    const entryForKey = (entryKey) => {
      entriesByKey ||= new Map(catalogEntries.map((entry) => [entry.entryKey, entry]));
      return entriesByKey.get(entryKey) || null;
    };
    const buttonForEntry = (entry) => {
      if (!entry) return null;
      buttonsByEntryKey ||= new Map(buttons.map((button) => [entriesByButton.get(button).entryKey, button]));
      return buttonsByEntryKey.get(entry.entryKey) || null;
    };
    const entriesForList = (listId) => {
      if (!catalogListIds.includes(listId)) return Object.freeze([]);
      if (!entriesByList.has(listId)) entriesByList.set(listId,
        Object.freeze(catalogEntries.filter((entry) => entry.listId === listId)));
      return entriesByList.get(listId);
    };
    window.VCardCatalog = Object.freeze({
      entries: catalogEntries,
      get listIds() { return Object.freeze(userLists ? userLists.listIds : [...catalogListIds]); },
      get: entryForKey,
      find: (listId, localId) => entriesByButton.get(buttonsByAddress.get(addressKey(listId, localId))) || null,
      forList: (id) => userLists?.isUser(id) ? userLists.entries(id) : entriesForList(id),
    });
    userLists = new window.TUserPlaylists({ storage: vcardStorage.local,
      catalog: window.VCardCatalog, builtinIds: catalogListIds, tabs: indexButtons, sections: listSections,
      previewFor: (entry) => buttonPreview(buttonForEntry(entry)),
      titleFor: (entry) => buttonForEntry(entry)?.closest('.song__title') });
    window.VCardUserLists = userLists;
    window.VCardPlaylistFilter = Object.freeze({
      allows: (entry, listId) => userLists.allows(entry, listId),
      playbackEntries: () => userLists.playbackEntries(),
      disabled: () => Object.freeze(userLists.listIds.filter((id) =>
        !userLists.entries(id).some((entry) => userLists.selected(id, entry.releaseKey)))),
    });
    document.addEventListener('vcard:playlist-filter-change', () => {
      const life = window.VCLife;
      if (!life) return;
      life.queue.post(() => {
        life.cancelContinuation('playlist-filter-changed');
        life.playlistSelector.reset();
        life.publish();
      }, { type: 'Selection.Filter', owner: life, scope: life.scope });
    });
    // The catalog has no DOM handles. Resolve them only at the view boundary.
    window.VCardCatalogView = Object.freeze({
      forButton: (button) => entriesByButton.get(button) || null,
      forPreview: (preview) => entriesByButton.get(previewButton(preview)) || null,
      buttonFor: buttonForEntry,
      previewFor: (entry) => buttonPreview(buttonForEntry(entry)),
    });
    const audios = () => sharedSongAudio ? [sharedSongAudio] : [];
    const players = new WeakMap();

    const playerDock = document.createElement('div');
    playerDock.className = 'vcard-player-dock block-small has-player is-audio-unavailable';
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
    playerDock.append(playerTopline);
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
    const secretTarget = (target) => target.closest?.('button[data-plyr="mute"]');
    const secretAction = () => window.VCPlayer?.grayShow?.();
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
    document.body.prepend(playerDock);
    vcardSetBootstrapState('PlayerShellReady');
    let portalStickyHeight = 0;

    const createPlayerDiagnostics = () => {
    const debugScope = new AbortController();
    playerControlsScope.signal.addEventListener('abort', () => debugScope.abort(),
      { once: true, signal: debugScope.signal });
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
      '<span data-debug-value="slideLoading">SlideLoading=—</span>',
      '<span data-debug-value="pageReload">Page.Reload=—</span>',
      '<span data-debug-value="decision">Decision=—</span>',
      '<span data-debug-value="randomSeed">RandomSeed=—</span>',
      '<span data-debug-value="mediaLoader">MediaLoader=—</span>',
      '<span data-debug-value="audioOutput">AudioOutput=—</span>',
      '<span data-debug-value="renderScheduler">RenderScheduler=—</span>',
      '<span data-debug-value="lastFault">LastFault=—</span>',
      '<span data-debug-value="selectionSettings">SelectionSettings=—</span>',
      '<span data-debug-value="selectionMemory">SelectionMemory=—</span>',
      '<span data-debug-value="playbackHistory">PlaybackHistory=—</span>',
      '<button type="button" data-debug-export-decisions>Сохранить решения</button>',
      '<details data-debug-decisions><summary>Журнал решений</summary><pre></pre></details>',
      '<span class="vcard-player-debug__heading">VCDecor</span>',
      '<span data-debug-value="COLOR_CHANGE_PERIOD">COLOR_CHANGE_PERIOD=— rem=—</span>',
      '<span class="vcard-player-debug__heading">VCPlayer</span>',
      '<span data-debug-value="STATIC_PLAY_ANI_DELAY">STATIC_PLAY_ANI_DELAY=—</span>',
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
    }, { signal: debugScope.signal });
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
        selectionSettings: snapshot?.selectionSettings,
        playlistSelection: snapshot?.playlistSelection,
        playbackHistory: snapshot?.playbackHistory,
        playbackContext: { revision: snapshot?.revision, phase: snapshot?.phase,
          chain: snapshot?.playbackChain,
          showProfile: snapshot?.showProfile,
          counters: { verses: snapshot?.globalVerseNumber, slides: snapshot?.globalSlideNumber },
          openedSong: snapshot?.openedSong, playingSong: snapshot?.playingSong },
        commandQueue: snapshot?.commandQueue || null,
        lastFault: snapshot?.commandQueue?.lastError || null,
        mediaLoader,
        audioOutput: window.VCardVisualization?.audioOutput?.() || null,
        mediaResources,
        renderScheduler: vcardRenderScheduler.snapshot(),
        mediaVersions: { lists: window.VCardMediaManifest?.lists,
          shows: window.VCardMediaManifest?.tvCatalogs },
        decisions: window.VCPlayer?.decisionTrace?.() || [] };
    };
    const decisionDetails = playerDebug.querySelector('[data-debug-decisions]');
    const decisionExports = new Map();
    debugScope.signal.addEventListener('abort', () => {
      decisionExports.forEach((timer, url) => {
        window.clearTimeout(timer);
        URL.revokeObjectURL(url);
      });
      decisionExports.clear();
    }, { once: true });
    decisionDetails.addEventListener('toggle', () => {
      if (decisionDetails.open) decisionDetails.querySelector('pre').textContent = JSON.stringify(decisionPayload(), null, 2);
    }, { signal: debugScope.signal });
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
    }, { signal: debugScope.signal });
    playerDock.prepend(playerDebug);

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
      if (debugScope.signal.aborted || (snapshot && snapshot.revision < debugRevision)) return;
      const output = window.VCardVisualization?.audioOutput?.();
      setDebugValue('audioOutput', 'AudioOutput', output
        ? `${output.state} clock=${output.contextTime ?? '—'} rms=${output.signalRms?.toFixed(4) ?? '—'} resume=${output.resumeAttempts} pending=${output.resumePending} error=${output.lastResumeError || '—'}` : '—');
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
      playerDebug.dataset.autoCandidates = String(snapshot?.playlistSelection?.candidates || 0);
      playerDebug.dataset.autoRemaining = String(snapshot?.playlistSelection?.remaining || 0);
      const selectionBags = snapshot?.selectionSettings?.bags || null;
      playerDebug.dataset.selectionSettings = JSON.stringify(selectionBags);
      const manualRemaining = selectionBags?.songs.reduce((sum, bag) => sum + bag.remaining, 0) || 0;
      setDebugValue('selectionSettings', 'SelectionSettings', selectionBags
        ? `${selectionBags.songs.length} bags / ${manualRemaining} songs / ${selectionBags.playlist?.remaining ?? 0} lists / ${selectionBags.pending?.entryKey || '—'}` : '—');
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
      playerDebug.dataset.slideTimeline = JSON.stringify(playbackEnvironment?.slideTimeline || null);
      playerDebug.dataset.overlayTimeline = JSON.stringify(playbackEnvironment?.overlayTimeline || null);
      playerDebug.dataset.showName = playbackEnvironment?.showSource?.name || '';
      playerDebug.dataset.showScope = playbackEnvironment?.showSource?.scope || '';
      playerDebug.dataset.showPreparation = JSON.stringify(playbackEnvironment?.preparation
        || snapshot?.openedSong?.environment?.preparation || null);
      const showSelection = playbackEnvironment?.showSelection;
      const slideLoading = showSelection?.loading;
      playerDebug.dataset.slideLoading = JSON.stringify(slideLoading || null);
      setDebugValue('slideLoading', 'SlideLoading', slideLoading
        ? `${slideLoading.ready}/${slideLoading.total} ready / ${slideLoading.pending} pending / ${slideLoading.failed} failed / ${slideLoading.current ? (slideLoading.running ? 'loading' : 'idle') : 'cancelled'}`
        : '—');
      const publishedFrame = showSelection?.published;
      const sourcePath = publishedFrame?.source ? new URL(publishedFrame.source).pathname.split('/') : [];
      const series = publishedFrame?.source
        ? vcardMedia.portalSourceSeries(publishedFrame.source) || '—' : '—';
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
      const crossAniBags = showProfile?.crossAniBags || [];
      playerDebug.dataset.crossAniRemaining = String(crossAniBags.reduce((sum, bag) => sum + bag.remaining, 0));
      playerDebug.dataset.crossAniReserved = String(crossAniBags.filter((bag) => bag.reserved).length);
      playerDebug.dataset.crossAniInvalid = String(crossAniBags.reduce((sum, bag) => sum + bag.invalid, 0));
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
      setDebugValue('showProfile', 'ShowProfile', showProfile
        ? `${showProfile.name} (${showProfile.ruleSource}) Launch=${profilePlayback?.launch ?? '—'} RunId=${profilePlayback?.runId ?? '—'}` : '—');
      setDebugValue('pageReload', 'Page.Reload', formatDebugTime(pageReload?.at));
      ['COLOR_CHANGE_PERIOD'].forEach((name) => {
        const period = Number(snapshot?.decoration?.colorPeriod ?? decorConstants[name]);
        const elapsed = Number(snapshot?.pageReloadTime);
        const remaining = Number.isFinite(period) && period > 0 && Number.isFinite(elapsed)
          ? Math.ceil(period - (elapsed % period))
          : null;
        const remainingText = remaining === null
          ? '—'
          : `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
        setDebugValue(name, name, `${Number.isFinite(period) ? period : '—'} rem=${remainingText}`);
      });
      ['STATIC_PLAY_ANI_DELAY'].forEach((name) => {
        setDebugValue(name, name, playerConstants[name]);
      });

    };
    let debugProjectionFrame = 0;
    let pendingDebugSnapshot = null;
    const requestDebugProjection = (snapshot = null) => {
      if (debugScope.signal.aborted) return;
      if (snapshot && (!pendingDebugSnapshot || snapshot.revision >= pendingDebugSnapshot.revision)) pendingDebugSnapshot = snapshot;
      if (debugProjectionFrame) return;
      debugProjectionFrame = vcardRenderScheduler.request(() => {
        debugProjectionFrame = 0;
        const current = pendingDebugSnapshot;
        pendingDebugSnapshot = null;
        refreshPlayerDebug(current || undefined);
      }, { owner: playerDebug, scope: debugScope, priority: 0 });
    };
    new TViewProjection(debugScope, requestDebugProjection);
    const debugClockTimer = window.setInterval(() => {
      if (document.documentElement.dataset.debug === 'on') requestDebugProjection();
    }, 1000);
    debugScope.signal.addEventListener('abort', () => {
      window.clearInterval(debugClockTimer);
      vcardRenderScheduler.cancel(debugProjectionFrame);
      debugProjectionFrame = 0;
      pendingDebugSnapshot = null;
      playerDebug.remove();
    }, { once: true });
    refreshPlayerDebug();
    return () => debugScope.abort();
    };

    let closePlayerDiagnostics = null;
    document.addEventListener('vcard:debug-state', () => {
      if (document.documentElement.dataset.debug === 'on') {
        if (!closePlayerDiagnostics && !playerControlsScope.signal.aborted) {
          closePlayerDiagnostics = createPlayerDiagnostics();
        }
      } else {
        closePlayerDiagnostics?.();
        closePlayerDiagnostics = null;
      }
    }, { signal: playerControlsScope.signal });

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
    let refreshDynamicPlayerHints = () => {};
    let projectedBackgroundBrightness = null;
    let playerImagesVisible = vcardSettingEnabled(
      'vcard-images-visible',
      'images'
    );
    let playerBackgroundMode = vcardStorage.local.getItem('vcard-background-mode') || 'smoke';

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
      // exclusive PlayAni surface. Only PortalController publishes a photo.
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
      portalController.setPreloading(preview, true);
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
    const SONG_ALTERNATION_STORAGE_KEY = 'vcard-song-alternation';
    const normalizeSongAlternation = (value) => (
      ['none', 'sequential', 'repeat', 'random'].includes(String(value || '').toLowerCase())
        ? String(value).toLowerCase()
        : 'random'
    );
    const playlistAlternation = 'random';
    let songAlternation = normalizeSongAlternation(
      vcardStorage.local.getItem(SONG_ALTERNATION_STORAGE_KEY)
    );
    // The settings choice replaces the former X/N/R/S song-order controls.
    songAlternation = songAlternation === 'random' ? 'random' : 'sequential';
    let randomPlaylistBag = null;
    let pendingSelection = null;
    const selectionBagSnapshot = (bag) => bag ? {
      total: bag.items.length,
      remaining: bag.remaining.length,
      reserved: bag.reservation ? bag.key(bag.reservation.item) : null,
      last: bag.last,
    } : null;
    const globalSongBagSnapshot = () => {
      const selector = window.VCLife?.playlistSelector;
      return selector ? { ...(selectionBagSnapshot(selector.preparedBag) || { reserved: null, last: null }), scope: 'checked-playlists',
        round: selector.round,
        total: selector.entries.filter((entry) => !selector.invalid.has(entry.releaseKey)).length,
        remaining: selector.remaining.length } : null;
    };
    window.VCardSelectionSettings = Object.freeze({ current: () => Object.freeze({
      songAlternation, playlistAlternation,
      bags: {
        songs: songAlternation === 'random' && window.VCLife?.playlistSelector ? [globalSongBagSnapshot()] : [],
        playlist: selectionBagSnapshot(randomPlaylistBag),
        pending: pendingSelection ? {
          entryKey: pendingSelection.entryKey,
          reason: pendingSelection.reason,
          song: pendingSelection.songBag ? globalSongBagSnapshot() : null,
          playlist: selectionBagSnapshot(pendingSelection.playlistBag),
        } : null,
      },
    }) });
    const publishSelectionSettings = () => document.dispatchEvent(new CustomEvent('vcard:selection-settings-state'));
    const clearSelectionBags = () => {
      window.VCLife?.playlistSelector.reset({ restart: true });
      randomPlaylistBag = null;
    };
    document.addEventListener('vcard:selection-memory-reset', () => {
      clearSelectionBags();
      window.VCLife?.cancelContinuation('selection-memory-reset');
    }, { signal: playerControlsScope.signal });

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
      requestPortalStickyHeight();
      const currentSize = layout.size;

      document.querySelectorAll('[data-portal-toggle="image"]').forEach((button) => {
        const pressed = String(layout.visible);
        const label = layout.visible ? 'Телевизор: включён. Скрыть портал' : 'Телевизор: выключен. Показать портал';
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
      && input.target === playerTitle && playerTitle.getAttribute('aria-disabled') !== 'true'
    );
    const playerPortalVisibilityAvailable = (input = {}) => Boolean(
      playerPortalInputAvailable(input) && (
        (input.target === playerTitle && playerTitle.getAttribute('aria-disabled') !== 'true')
        || (playerDock.contains(input.target) && input.target.matches('button[data-portal-toggle="image"]'))
      )
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
      && (!window.VCLife?.songs.get(preview)?.preloading || !sharedSongAudio.paused)
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
    const trackNavigationAvailable = ({ source, target, current, direction, trackRunId } = {}) => {
      const snapshot = window.VCPlayer?.current?.();
      if (playerControlsScope.signal.aborted || window.VCardBootstrap.state !== 'Interactive'
        || !snapshot || trackRunId !== snapshot.trackRunId
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
        trackRunId: snapshot?.trackRunId,
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
        && !(!vcardVisualizationAvailable() && key === 'visualization' && value !== 'off'));
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

    const SONG_TEXT_LIMIT = 3;
    const songTextHistory = new Map();
    const songTextScopes = new WeakMap();
    const retainSongText = (text) => {
      songTextHistory.delete(text);
      songTextHistory.set(text, true);
      for (const previous of songTextHistory.keys()) {
        if (songTextHistory.size <= SONG_TEXT_LIMIT) break;
        const preview = previous.closest('.song__preview');
        if (previous === text || preview === currentOpenedPreview()
          || preview === sharedSongAudio?.vcardPlayingPreview) continue;
        songTextScopes.get(previous)?.abort();
        songTextScopes.delete(previous);
        songTextHistory.delete(previous);
        previous.replaceChildren();
        delete previous.dataset.trackBandPrepared;
        // Inline texts are not reloadable; only externally delivered texts
        // enter this history, so their source URL/key remain intact.
        delete previous.dataset.textLoaded;
      }
    };
    const prepareTrackBandText = (text) => {
      if (!text || text.dataset.trackBandPrepared === 'true') return;
      if (text.dataset.textSrc && text.dataset.textLoaded !== 'true') return;
      text.dataset.trackBandPrepared = 'true';
      const lines = text.innerHTML.split(/<br\s*\/?>/i);
      const fragment = document.createDocumentFragment();
      const times = parseTrackBand(text.dataset.trackBand);
      let verse = null;
      let verseIndex = 0;
      let previousVerse = null;
      lines.forEach((line, index) => {
        const plain = decodeHtmlLine(line).trim();
        const isMarker = /^\*\s*\*\s*\*$/.test(plain);
        const isDivider = plain === '-*-';
        const isYear = /^\d{4}(?:\s*[-–—]\s*(?:\d{4}|\d{2}))?$/.test(plain);
        const isBlank = plain === '';
        const isBoundary = isMarker || isDivider || isYear || isBlank;
        if (index > 0 && verse && !isBoundary) verse.append(document.createElement('br'));
        if (isBoundary) {
          verse = null;
          if (isBlank && previousVerse) {
            const gap = document.createElement('span');
            gap.className = 'song__verse-gap';
            gap.setAttribute('aria-hidden', 'true');
            fragment.append(gap);
          } else if (isDivider) {
            const divider = document.createElement('span');
            divider.className = 'song__text-divider';
            divider.setAttribute('aria-hidden', 'true');
            divider.textContent = '-*-';
            fragment.append(divider);
          } else if (isYear) {
            const year = document.createElement('span');
            year.className = 'song__text-year';
            year.append(lineFragment(line));
            fragment.append(year);
          } else if (isMarker) {
            const separator = document.createElement('span');
            separator.className = 'song__stanza-separator';
            separator.append(lineFragment(line));
            fragment.append(separator);
          } else fragment.append(lineFragment(line));
          return;
        }
        if (!verse) {
          verse = document.createElement('span');
          verse.className = 'song__track-verse';
          verse.dataset.trackVerse = String(verseIndex);
          if (Number.isFinite(times[verseIndex])) {
            verse.setAttribute('role', 'button');
            verse.tabIndex = 0;
            verse.setAttribute('aria-description', 'Начать воспроизведение с этого куплета: Enter или пробел.');
          }
          verse.dataset.trackGlow = plain;
          verseIndex += 1;
          fragment.append(verse);
          previousVerse = verse;
        } else verse.dataset.trackGlow += `\n${plain}`;
        verse.append(lineFragment(line));
      });
      text.replaceChildren(fragment);
      const scope = new AbortController();
      songTextScopes.set(text, scope);
      playerControlsScope.signal.addEventListener('abort', () => scope.abort(),
        { once: true, signal: scope.signal });
      prepareTrackBandControls(text, times);
      prepareSongYearControls(text);
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

    let untimedFollowResumeTimer = 0;
    playerControlsScope.signal.addEventListener('abort', () => window.clearTimeout(untimedFollowResumeTimer), { once: true });
    const suspendTrackLayoutForUser = () => {
      window.clearTimeout(untimedFollowResumeTimer);
      const wasSuspended = trackLayoutSuspendedByUser;
      trackLayoutSuspendedByUser = window.VCardUserActivity.blocked();
      if (!wasSuspended && trackLayoutSuspendedByUser) {
        window.scrollTo({ top: window.scrollY, behavior: 'auto' });
      }
      const resume = () => {
        untimedFollowResumeTimer = 0;
        if (playerControlsScope.signal.aborted || window.VCardUserActivity.menuOpen()) return;
        const remaining = window.VCardUserActivity.remaining();
        if (remaining <= 0 && window.VCardUserActivity.blocked()) return;
        if (remaining > 0) {
          untimedFollowResumeTimer = window.setTimeout(resume, Math.ceil(remaining * 1000));
          return;
        }
        trackLayoutSuspendedByUser = false;
        if (!trackLayoutCanFollow()) return;
        trackVerseRepositionRequested = true;
        scheduleTrackVerseLayout(playingPreview, 'smooth');
        scheduleUntimedTrackScroll(playingPreview);
      };
      if (!window.VCardUserActivity.menuOpen()) {
        untimedFollowResumeTimer = window.setTimeout(resume, Math.max(1, Math.ceil(window.VCardUserActivity.remaining() * 1000)));
      }
    };
    document.addEventListener('vcard:user-activity', suspendTrackLayoutForUser, { signal: playerControlsScope.signal });

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
      if (!parseTrackBand(text.dataset.trackBand).length) return;
      // Verse centering is handled by scrolling the whole document.  A top
      // padding derived from viewport coordinates grows after every scroll:
      // the first verse moves above the viewport, the next recalculation sees
      // that negative position and pushes the complete text block farther
      // down.  Keep the portal and all verses in their natural document flow.
      text.style.paddingTop = '0px';
      text.style.paddingBottom = '0px';
    };

    const portalPinScrollTop = (preview) => {
      const portal = preview && preview.querySelector('.song-portal-stage, .song-vibeframe');
      if (!portal || portal.hidden || getComputedStyle(portal).display === 'none') return 0;
      const portalStyle = getComputedStyle(portal);
      // Title-aligned portals are already fixed below the dock. Applying their
      // former flow origin as a sticky threshold scrolls the verse behind them.
      if (portalStyle.position === 'fixed') return 0;
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
      if (vcardHorizontalWaveActive()) return vcardHorizontalWaveBounds({ forReading: true });
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

    let untimedTrackScrollFrame = 0;
    let untimedScrollLastTick = 0;
    const untimedLineRanges = new WeakMap();
    const trackLineRanges = (verse) => {
      if (untimedLineRanges.has(verse)) return untimedLineRanges.get(verse);
      const ranges = [];
      let range = document.createRange();
      range.setStart(verse, 0);
      [...verse.childNodes].forEach((node, index) => {
        if (node.nodeName !== 'BR') return;
        range.setEnd(verse, index);
        if (range.toString().trim()) ranges.push(range);
        range = document.createRange();
        range.setStart(verse, index + 1);
      });
      range.setEnd(verse, verse.childNodes.length);
      if (range.toString().trim()) ranges.push(range);
      untimedLineRanges.set(verse, ranges);
      return ranges;
    };
    const stopUntimedTrackScroll = () => {
      vcardRenderScheduler.cancel(untimedTrackScrollFrame);
      untimedTrackScrollFrame = 0;
      untimedScrollLastTick = 0;
    };
    playerControlsScope.signal.addEventListener('abort', stopUntimedTrackScroll, { once: true });
    const scheduleUntimedTrackScroll = (preview = playingPreview, { finish = false } = {}) => {
      if (finish) stopUntimedTrackScroll();
      if (untimedTrackScrollFrame) return;
      const audio = sharedSongAudio;
      const text = preview?.querySelector('.song__preview-text');
      const source = audio?.currentSrc;
      const current = () => Boolean(audio) && !playerControlsScope.signal.aborted && trackPlayEnabled
        && !trackLayoutSuspendedByUser && !document.hidden
        && preview === playingPreview && preview === currentOpenedPreview()
        && preview?.isConnected && !preview.hidden && audio?.currentSrc === source
        && !parseTrackBand(text?.dataset.trackBand).length
        && (finish ? audio?.ended : window.VCPlayer?.current?.()?.phase === 'AudioPlaying');
      if (!text || !current() || !(Number.isFinite(audio.duration) && audio.duration > 0)) return;
      // Once audio following takes over, a delayed card alignment must not
      // snap the viewport back to the portal during the first few frames.
      cardScrollScope?.abort();
      prepareTrackBandText(text);
      untimedTrackScrollFrame = vcardRenderScheduler.request(() => {
        untimedTrackScrollFrame = 0;
        const verses = text.querySelectorAll('.song__track-verse');
        if (!verses.length) return;
        const bounds = trackVerseViewportBounds(preview);
        if (!bounds) return;
        // Interpolate the sounding source line; only measure its two neighbours.
        const lines = [...verses].flatMap(trackLineRanges);
        const lineCount = lines.length;
        if (!lineCount) return;
        const progress = finish ? 1 : Math.max(0, Math.min(1, audio.currentTime / audio.duration));
        const position = Math.max(0, Math.min(lineCount - 1, progress * lineCount - 0.5));
        const line = Math.floor(position);
        const firstRect = lines[line].getBoundingClientRect();
        const lastRect = lines[Math.min(line + 1, lineCount - 1)].getBoundingClientRect();
        const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        const clamp = (value) => Math.max(0, Math.min(maxScroll, value));
        const firstCenter = firstRect.top + firstRect.height / 2;
        const nextCenter = lastRect.top + lastRect.height / 2;
        const center = window.scrollY + firstCenter + (nextCenter - firstCenter) * (position - line);
        const centeredTop = clamp(center - (bounds.top + bounds.height / 2));
        const top = trackVerseRepositionRequested ? centeredTop : Math.max(window.scrollY, centeredTop);
        untimedTrackScrollFrame = vcardRenderScheduler.request(() => {
          untimedTrackScrollFrame = 0;
          const now = performance.now();
          const elapsed = untimedScrollLastTick ? Math.min(50, now - untimedScrollLastTick) : 16;
          untimedScrollLastTick = now;
          // Ease from the current reading position into audio following instead
          // of jumping to the calculated center on Play or after a layout change.
          const next = finish ? top : window.scrollY + (top - window.scrollY) * (1 - Math.exp(-elapsed / 180));
          if (Math.abs(window.scrollY - next) > 0.1) window.scrollTo({ top: next, behavior: 'instant' });
          if (Math.abs(window.scrollY - top) < 1) trackVerseRepositionRequested = false;
          if (!finish) scheduleUntimedTrackScroll(preview);
        }, { owner: preview, scope: playerControlsScope, phase: 'write', priority: 0,
          isCurrent: current, onCancel: () => { untimedTrackScrollFrame = 0; } });
      }, { owner: preview, scope: playerControlsScope, phase: 'measure', priority: 1,
        isCurrent: current, onCancel: () => { untimedTrackScrollFrame = 0; } });
    };

    let trackVerseScrollFrame = 0;
    const TRACK_VERSE_SCROLL_MS = 240;
    let trackVerseAnimation = null;
    const stopTrackVerseAnimation = () => {
      const animation = trackVerseAnimation;
      trackVerseAnimation = null;
      if (animation) vcardRenderScheduler.cancel(animation.frame);
    };
    const writeTrackVerseScroll = (top, behavior, verse, preview, guard, onApplied) => {
      if (behavior !== 'smooth' || vcardEnvironment.media('(prefers-reduced-motion: reduce)').matches
        || Math.abs(top - window.scrollY) < 1) {
        stopTrackVerseAnimation();
        writeViewportScroll(top, behavior === 'smooth' ? 'instant' : behavior, preview, guard, onApplied);
        return;
      }
      if (trackVerseAnimation?.verse === verse && Math.abs(trackVerseAnimation.top - top) < 0.5) {
        trackVerseAnimation.guard = guard;
        trackVerseAnimation.onApplied = onApplied;
        return;
      }
      stopTrackVerseAnimation();
      const animation = { verse, top, from: window.scrollY, start: null, frame: 0, guard, onApplied };
      trackVerseAnimation = animation;
      const current = () => trackVerseAnimation === animation && animation.guard()
        && !trackLayoutSuspendedByUser && trackPlayEnabled && !document.hidden
        && currentOpenedPreview() === preview && preview.isConnected && !preview.hidden
        && verse.isConnected && window.VCPlayer?.current?.()?.phase === 'AudioPlaying';
      const draw = (timestamp) => {
        animation.frame = 0;
        animation.start ??= timestamp;
        const progress = Math.min(1, (timestamp - animation.start) / TRACK_VERSE_SCROLL_MS);
        const eased = progress ** 3 * (progress * (progress * 6 - 15) + 10);
        window.scrollTo({ top: animation.from + (animation.top - animation.from) * eased, behavior: 'instant' });
        if (progress >= 1) {
          trackVerseAnimation = null;
          animation.onApplied();
        } else request();
      };
      const request = () => {
        animation.frame = vcardRenderScheduler.request(draw, {
          owner: verse, scope: playerControlsScope, priority: 0, phase: 'write', isCurrent: current,
          onCancel: () => { if (trackVerseAnimation === animation) trackVerseAnimation = null; },
        });
      };
      request();
    };
    playerControlsScope.signal.addEventListener('abort', () => {
      stopTrackVerseAnimation();
      vcardRenderScheduler.cancel(trackVerseScrollFrame);
      trackVerseScrollFrame = 0;
    }, { once: true });
    const centerTrackBandVerse = (verse, behavior = 'smooth', guard = () => true) => {
      vcardRenderScheduler.cancel(trackVerseScrollFrame);
      trackVerseScrollFrame = 0;
      if (!verse || trackLayoutSuspendedByUser || playerControlsScope.signal.aborted) return;
      // Once audio following owns this position, late card-opening writes
      // must not move the first verse away from the spectrum axis.
      if (vcardHorizontalWaveActive()) cardScrollScope?.abort();
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
        // Outside the horizontal graph, timed verse following is forward-only.
        // The horizontal graph requires matching its axis in either direction.
        // If ordinary vertical centering would
        // reduce scrollY and move the page back down, leave the current reading
        // position intact; a later verse may advance the document again.
        if (!trackVerseRepositionRequested && !vcardHorizontalWaveActive()
          && clampedTarget < window.scrollY - 1) return;
        writeTrackVerseScroll(clampedTarget, behavior, verse, preview, () => guard() && !trackLayoutSuspendedByUser
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
    const eligibleTrackLayoutPreview = (preferredPreview) => {
      const preview = preferredPreview && preferredPreview === currentOpenedPreview()
        ? preferredPreview : playingPreview;
      return preview && preview === currentOpenedPreview()
        && !trackLayoutSuspendedByUser && trackPlayEnabled
        && window.VCPlayer?.current?.()?.phase === 'AudioPlaying' ? preview : null;
    };
    const scheduleTrackVerseLayout = (preferredPreview = null, behavior = 'smooth') => {
      if (playerControlsScope.signal.aborted) return;
      if (trackVerseLayoutFrame) vcardRenderScheduler.cancel(trackVerseLayoutFrame);
      trackVerseLayoutFrame = 0;
      if (!eligibleTrackLayoutPreview(preferredPreview)) return;
      trackVerseLayoutFrame = vcardRenderScheduler.request(() => {
        trackVerseLayoutFrame = vcardRenderScheduler.request(() => {
          trackVerseLayoutFrame = 0;
          const preview = eligibleTrackLayoutPreview(preferredPreview);
          if (!preview) return;
          const text = preview.querySelector('.song__preview-text');
          if (text && !parseTrackBand(text.dataset.trackBand).length) {
            scheduleUntimedTrackScroll(preview);
            return;
          }
          // The first timed verse starts one full line below the pinned portal.
          // Later verses retain the normal forward-only centering.
          const verses = Array.from(preview.querySelectorAll('.song__track-verse'));
          if (!vcardHorizontalWaveActive() && !trackVerseRepositionRequested
            && initialTrackLayoutPreview === preview && verses.indexOf(activeTrackBandVerse) === 0) {
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
      if (event.type !== 'vcard:portal-items-change' && !event.detail?.visibilityChanged) {
        trackVerseRepositionRequested = true;
      }
      scheduleTrackVerseLayout(event.detail && event.detail.preview);
    };

    let trackLayoutEventsReady = false;
    const ensureTrackLayoutEvents = () => {
      if (trackLayoutEventsReady || playerControlsScope.signal.aborted) return;
      trackLayoutEventsReady = true;
      let horizontal = vcardHorizontalWaveActive();
      const updateHorizontalAlignment = () => {
        const next = vcardHorizontalWaveActive();
        if (next === horizontal) return;
        horizontal = next;
        trackVerseRepositionRequested = true;
        scheduleTrackVerseLayout();
      };
      document.addEventListener('vcard:visualization-state', updateHorizontalAlignment, { signal: playerControlsScope.signal });
      document.addEventListener('vcard:visualization-availability', updateHorizontalAlignment, { signal: playerControlsScope.signal });
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
    };

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

    let trackLayoutObserver = null;
    let observedTrackPortal = null;
    const observeTrackPortal = (portal) => {
      if (portal === observedTrackPortal) return;
      if (observedTrackPortal) trackLayoutObserver?.unobserve(observedTrackPortal);
      observedTrackPortal = portal;
      if (portal) trackLayoutObserver?.observe(portal);
    };
    if ('ResizeObserver' in window) {
      trackLayoutObserver = new ResizeObserver(() => {
        requestPortalStickyHeight();
        scheduleTrackVerseLayout();
      });
      trackLayoutObserver.observe(playerDock);
      playerControlsScope.signal.addEventListener('abort', () => trackLayoutObserver.disconnect(), { once: true });
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
        if (seeked && !projectOnly) {
          trackVerseRepositionRequested = Number(audio.currentTime) > 0.05;
          trackLayoutSuspendedByUser = window.VCardUserActivity.blocked();
        }
        if (!projectOnly) scheduleUntimedTrackScroll(playingPreview);
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
        trackLayoutSuspendedByUser = window.VCardUserActivity.blocked();
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
          trackLayoutSuspendedByUser = window.VCardUserActivity.blocked();
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
        stopUntimedTrackScroll();
        clearTrackBandHighlight();
      } else {
        const text = playingPreview?.querySelector('.song__preview-text');
        if (text && !parseTrackBand(text.dataset.trackBand).length) trackLayoutSuspendedByUser = window.VCardUserActivity.blocked();
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
        && isPlayableSource(snapshot.audio?.selectedSource || snapshot.audio?.source) && !snapshot.audio?.error;
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
          const enabled = available
            && !(control.matches('[data-plyr="play"]') && snapshot.preloading && audio.paused)
            && !(control.matches('[data-plyr="seek"]') && !(Number.isFinite(audio.duration) && audio.duration > 0));
          if (control.disabled !== !enabled) control.disabled = !enabled;
          const value = enabled ? 'false' : 'true';
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
          const speed = 12.5;
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
        storage: { enabled: true, key: vcardPhysicalKey('plyr') },
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
        const listEntries = window.VCardCatalog.forList(playingPlaylistId || currentListId());
        const currentIndex = listEntries.indexOf(entriesByButton.get(currentButton));
        return {
          current: currentIndex < 0 ? 0 : currentIndex + 1,
          total: listEntries.length
        };
      };
      const expandPlayerHint = (template) => {
        let hint = String(template || '');
        if (hint.includes('%CUR_TRACK_NO%') || hint.includes('%TOTAL_TRACKS_IN_LIST%')) {
          const trackNumbers = currentHintTrackNumbers();
          hint = hint.replaceAll('%CUR_TRACK_NO%', String(trackNumbers.current))
            .replaceAll('%TOTAL_TRACKS_IN_LIST%', String(trackNumbers.total));
        }
        if (hint.includes('%CUR_BRIGHT%')) {
          const storedBrightness = Number.parseInt(document.documentElement.dataset.visBri, 10);
          const currentBrightness = Number.isInteger(storedBrightness)
            ? Math.max(0, Math.min(5, storedBrightness)) : 0;
          hint = hint.replaceAll('%CUR_BRIGHT%', String(currentBrightness));
        }
        return hint;
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
        const applyHint = keepPlayerHint(button, () => expandPlayerHint(
          button.matches('[data-plyr="play"]') ? window.VCLife?.scenario.profileFor()?.playHint() || template : template));
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
          // The player starts/replays a global (MONO) show, including after
          // a stopped continuation. Portal playback has its own surface.
          playSong(preview, button, 'click', -1, 'player');
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
        playerTopline.replaceChildren(
          playButton,
          previousButton,
          playerTitle,
          nextButton,
          settingsButton
        );
        controls.prepend(sitemapButton);
        const televisionButton = document.createElement('button');
        televisionButton.type = 'button';
        televisionButton.className = 'plyr__control plyr__controls__item vcard-player-television';
        televisionButton.dataset.portalToggle = 'image';
        televisionButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2v10M7 5.5a8.5 8.5 0 1 0 10 0" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="butt"/></svg>';
        televisionButton.addEventListener('click', (event) => {
          const input = { type: 'Portal.ToggleVisibility', source: 'Player', target: televisionButton,
            preview: currentPortalPreview(), trusted: event.isTrusted };
          if (!window.VCCommands) window.VCardPlayerControls.toggleVisibility(input);
          else window.VCCommands.dispatch(input);
        }, { signal: playerControlsScope.signal });
        controls.append(televisionButton);
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
          update(button, button.dataset.vcardPreset === (snapshot.colorSettings.choice || snapshot.colorSettings.preset));
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
      userLists.project(activeListId);
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
      if (playerControlsScope.signal.aborted || !userLists.hasList(targetListId)) return;
      const previousListId = currentListId();
      if (collapseOpenSong && currentOpenedPreview()) {
        const openedPreview = currentOpenedPreview();
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
    };

    // Restore the chosen cassette before writing any startup selection. Without
    // a valid saved choice, skip blank cassettes to reach the newest song list.
    const initialListId = (() => {
      let savedListId = '';
      try {
        savedListId = vcardStorage.local.getItem(ACTIVE_PLAYLIST_STORAGE_KEY) || '';
      } catch (_error) { }
      if (userLists.hasList(savedListId)) return savedListId;
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
      && userLists.hasList(input.nextListId));
    let playlistScrollRevision = 0;
    const selectPlaylist = (input) => {
      if (!playlistInputAvailable(input)) return false;
      const revision = ++playlistScrollRevision;
      const selector = input.target.closest('.tabs-selector');
      const checks = selector.querySelector('.tabs__checks-bar');
      const bottom = input.target.closest('.tabs-block').classList.contains('tabs-block--bottom');
      vcardRenderScheduler.cancel(catalogScrollFrame);
      // The layout replacement and its scroll correction must reach the same
      // paint. Splitting measure/write across frames exposes scroll clamping
      // and browser anchoring while the preceding list disappears.
      catalogScrollFrame = vcardRenderScheduler.request(() => {
        catalogScrollFrame = 0;
        activateList(input.nextListId, { collapseOpenSong: true });
        cardScrollScope?.abort();
        projectPlaylist({ playlist: playlistState });
        const rect = checks.getBoundingClientRect();
        const gap = Number.parseFloat(getComputedStyle(selector).fontSize) * 0.2;
        const top = bottom
          ? window.scrollY + rect.bottom - window.innerHeight + gap
          : window.scrollY + rect.top - playerDock.getBoundingClientRect().bottom - gap;
        window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
      }, { owner: playerDock, scope: playerControlsScope, priority: 0, phase: 'write',
        isCurrent: () => revision === playlistScrollRevision && playlistInputAvailable(input),
        onCancel: () => { catalogScrollFrame = 0; } });
      return true;
    };
    userLists.onCatalogChange = (selectedId = '') => {
      for (const list of userLists.lists) playlistLabels.set(list.id, {
        name: list.name, count: String(userLists.entries(list.id).length),
      });
      randomPlaylistBag?.update(userLists.listIds);
      projectedListId = '';
      activateList(selectedId || (userLists.hasList(currentListId()) ? currentListId() : catalogListIds[0]),
        { collapseOpenSong: true });
      projectPlaylist({ playlist: playlistState });
    };
    for (const list of userLists.lists) playlistLabels.set(list.id, {
      name: list.name, count: String(userLists.entries(list.id).length),
    });
    document.addEventListener('click', (event) => {
        const button = event.target.closest('.tabs__item');
        if (!button || !indexButtons.includes(button)) return;
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
      const source = audioEl.dataset.audioSrc;
      const request = { preview, scope: new AbortController() };
      audioPositionRequest = request;
      const current = () => !playerControlsScope.signal.aborted && !request.scope.signal.aborted
        && audioPositionRequest === request && preview.isConnected
        && audioEl.vcardPlayingPreview === preview && audioEl.dataset.audioSrc === source
        && (!audioEl.hasAttribute('src') || audioEl.getAttribute('src') === (audioEl.vcardResolvedSource || source));
      const apply = () => {
        if (!current()) return;
        try { audioEl.currentTime = position; }
        catch (error) { console.warn(`VCard audio: cannot seek to ${position}`, error); }
      };
      if (audioEl.readyState >= 1) apply();
      else audioEl.addEventListener('loadedmetadata', apply, { once: true, signal: request.scope.signal });
      return current;
    };

    const selectAudioSource = (preview, audioEl) => {
      if (!preview || !audioEl) return '';
      const src = resolveSource(preview);
      if (!isPlayableSource(src)) {
        cancelAudioPosition();
        clearTrackBandHighlight();
        audioEl.pause();
        delete audioEl.dataset.audioSrc;
        audioEl.removeAttribute('src');
        audioEl.load && audioEl.load();
        publishPlayerMp3Info(preview);
        document.dispatchEvent(new CustomEvent('vcard:request-portal-state', {
          detail: { preview }
        }));
        return '';
      }
      preview.dataset.src = src;
      audioEl.dataset.audioSrc = src;
      if (audioEl.hasAttribute('src') && ((audioEl.dataset.cryptOriginal !== src && audioEl.getAttribute('src') !== src) || audioEl.error)) {
        cancelAudioPosition();
        clearTrackBandHighlight();
        audioEl.pause();
        audioEl.removeAttribute('src');
        delete audioEl.vcardResolvedSource;
        audioEl.dataset.cryptOriginal = src;
        audioEl.load && audioEl.load();
      }
      if (window.VCardCrypt?.protectedUrl(src)) {
        window.VCardCrypt.audioUrl(src, {current:true}).then(playable => {
          if (audioEl.dataset.audioSrc !== src || audioEl.vcardPlayingPreview !== preview) return;
          if (audioEl.getAttribute('src') === playable) return;
          audioEl.vcardResolvedSource = playable;
          audioEl.dataset.cryptOriginal = src;
          audioEl.setAttribute('src', playable);
          audioEl.load();
        }).catch(error => console.warn('VCard protected audio preparation failed', error));
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

    const songTextRequests = new WeakMap();
    const loadOpenedSongText = async (preview, text) => {
      if (!text?.dataset.textSrc || text.dataset.textLoaded === 'true') return;
      const request = {};
      songTextRequests.set(text, request);
      const current = () => !playerControlsScope.signal.aborted
        && songTextRequests.get(text) === request && preview.isConnected
        && preview === currentOpenedPreview() && !preview.hidden;
      text.setAttribute('aria-busy', 'true');
      text.textContent = 'Загрузка текста…';
      try {
        const texts = await vcardSongTexts.load(text.dataset.textSrc);
        if (!current()) return;
        const html = texts[text.dataset.textKey];
        if (typeof html !== 'string') throw new Error('Song text is missing from playlist');
        text.innerHTML = html;
        text.dataset.textLoaded = 'true';
        prepareTrackBandText(text);
        retainSongText(text);
        text.dispatchEvent(new CustomEvent('vcard:song-text-ready', { bubbles: true }));
        updateTrackBandHighlight({ scroll: false, allowPaused: true, force: true });
        requestPortalStickyHeight();
        scheduleTrackVerseLayout(preview, 'auto');
        scheduleUntimedTrackScroll(preview);
      } catch (error) {
        if (!current()) return;
        console.warn('VCard song text load failed', error);
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Не удалось загрузить текст. Повторить';
        retry.addEventListener('click', () => loadOpenedSongText(preview, text),
          { once: true, signal: playerControlsScope.signal });
        text.replaceChildren(retry);
      } finally {
        if (songTextRequests.get(text) === request) text.removeAttribute('aria-busy');
      }
    };
    const showPreview = (preview) => {
      if (!preview || playerControlsScope.signal.aborted) return;
      ensureTrackLayoutEvents();
      cancelPreviewTransition(preview);
      preparePortalOrigin(preview);
      observeTrackPortal(preview.querySelector('.song-portal-stage, .song-vibeframe'));
      const text = preview.querySelector('.song__preview-text');
      text?.style.removeProperty('padding-top');
      text?.style.removeProperty('padding-bottom');
      if (text) prepareTrackBandText(text);
      if (text?.dataset.textLoaded === 'true') retainSongText(text);
      loadOpenedSongText(preview, text);
      preparePreviewPortal(preview, true);
      preview.hidden = false;
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
      if (preview.contains(observedTrackPortal)) observeTrackPortal(null);
      cancelPreviewTransition(preview);
      preview.classList.remove('is-title-aligned');
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

    const openRelativeSong = (direction, options = {}) => {
      const chain = window.VCLife?.playbackChain;
      if (direction > 0 && chain?.pendingPlan) {
        const plan = chain.pendingPlan;
        chain.pendingPlan = null;
        chain.stopPendingWait('explicit-next-navigation');
        chain.continuationBlocked = false;
        if (plan.commit({ automatic: false }) !== false) return true;
        chain.cancelPlan(plan);
      }
      window.VCPlayer?.cancelContinuation?.(direction > 0 ? 'explicit-next-navigation' : 'explicit-track-navigation');
      if (direction > 0) {
        const current = previewButton(playingPreview) || previewButton(currentOpenedPreview())
          || null;
        return openAutoNextSong(current, { automatic: false, explicit: true });
      }
      if (direction < 0) {
        const previous = window.VCPlayer?.previousHistory?.();
        const button = previous && findSongButton(previous.listId, previous.songId);
        if (!button) return false;
        activateList(userLists.contextFor(entriesByButton.get(button), playingPlaylistId));
        openSongButton(button, { forceOpen: true, play: true,
          reason: 'history', historyIndex: previous.index });
        return true;
      }
      return false;
    };

    const playableEntriesForList = (listId) => window.VCardCatalog.forList(listId).filter((entry) => {
      return window.VCardPlaylistFilter?.allows(entry, listId) !== false
        && entry.playable
        && window.VCPlayer?.releaseAvailable?.(entry.releaseKey) !== false;
    });

    const playableListIds = () => userLists.listIds.filter((listId) => playableEntriesForList(listId).length);

    const nextPlaylistId = (currentListId) => {
      const listIds = playableListIds();
      if (!listIds.length) return '';
      randomPlaylistBag ||= new window.VCLifeCore.TShuffleBag(userLists.listIds, (listId) => listId,
        window.VCPlayer?.randomStream?.('playlists.manual'));
      return randomPlaylistBag.reserve({
        allow: (listId) => listIds.includes(listId) && (listIds.length === 1 || listId !== currentListId),
        prefer: (listId) => !window.VCPlayer?.recentPlaylist?.(listId),
      });
    };

    const reserveNextEntry = (currentEntry, { explicit = false } = {}) => {
      const songMode = songAlternation;
      if (!currentEntry) return null;
      const currentListId = userLists.hasList(playingPlaylistId) ? playingPlaylistId : currentEntry.listId;
      const currentListEntries = playableEntriesForList(currentListId);
      let nextEntry = null;
      let nextContextListId = currentListId;
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
        if (songMode === 'random') {
          songReservation = window.VCLife.playlistSelector.reserve();
          songBag = window.VCLife.playlistSelector.bag;
          nextEntry = songReservation?.entry || null;
          if (nextEntry) nextContextListId = userLists.contextFor(nextEntry, currentListId);
        } else {
          const listEntries = window.VCardCatalog.forList(currentListId);
          const currentIndex = listEntries.indexOf(currentEntry);
          nextEntry = listEntries.slice(currentIndex + 1).find((entry) => currentListEntries.includes(entry)) || null;
        }

        if (!nextEntry && songMode !== 'random') {
          const target = nextPlaylistId(currentListId);
          playlistReservation = typeof target === 'object' ? target : null;
          playlistBag = playlistReservation ? randomPlaylistBag : null;
          const targetListId = playlistReservation?.item || target;
          if (!targetListId) return false;
          const targetEntries = playableEntriesForList(targetListId);
          nextContextListId = targetListId;
          nextEntry = targetEntries[0] || null;
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
      const selection = { entryKey: nextEntry.entryKey, songBag, playlistBag, reason: songReservation?.reason || 'sequential' };
      pendingSelection = selection;
      const releaseSelection = () => {
        if (pendingSelection === selection) pendingSelection = null;
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
        listId: nextContextListId,
        title,
        songId: nextEntry.localId,
        commit() {
          if (!active) return false;
          const nextListId = nextContextListId;
          // Validate the global release reservation before opening its card.
          if (!playableEntriesForList(nextListId).includes(nextEntry)
              || (songReservation && window.VCLife.playlistSelector.reservation !== songReservation)
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
      const reservation = reserveNextEntry(entriesByButton.get(currentButton), { explicit });
      if (!reservation) return null;
      const entry = reservation.entry;
      const listId = reservation.listId;
      const preloadController = new AbortController();
      return {
        title: entry.title, songId: entry.localId,
        entryKey: entry.entryKey,
        preload: () => window.VCardMediaLoader.preloadNext(entry, preloadController.signal),
        commit({ automatic = true } = {}) {
          preloadController.abort();
          const button = window.VCardCatalogView.buttonFor(entry);
          if (!button?.isConnected || !buttonPreview(button)?.isConnected) {
            reservation.cancel();
            return false;
          }
          if (!reservation.commit()) return false;
          activateList(listId);
          autoPlayFromEnded = Boolean(automatic);
          openSongButton(button, { forceOpen: true, play: true, fromEnded: true,
            reason: automatic ? 'auto' : 'next' });
          return true;
        },
        cancel: () => { preloadController.abort(); reservation.cancel(); },
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
        return reserveAutoNextSong(currentButton);
      });
    };

    const playSong = (preview, button, reason = 'click', historyIndex = -1, surface = 'player') => {
      if (window.VCardBootstrap.state !== 'Interactive') return;

      const audioEl = sharedSongAudio;
      if (!preview || !button || !audioEl) return;
      cancelAudioPosition();
      if (preview === playingPreview && audioEl.ended && reason === 'click') {
        restartFinishedSong(preview, surface);
        return;
      }
      playingPreview = preview;
      const newSongSelected = audioEl.vcardPlayingPreview !== preview;
      if (newSongSelected || !playingPlaylistId || userLists.entries(currentListId()).includes(entriesByButton.get(button))) {
        playingPlaylistId = currentListId();
      }
      audioEl.vcardPlayingPreview = preview;
      if (newSongSelected) {
        clearTrackBandHighlight();
        document.dispatchEvent(new CustomEvent('vcard:song-start', {
          detail: { preview }
        }));
      }
      setPlayerTitle(button, preview);
      const audioSrc = selectAudioSource(preview, audioEl);
      if (!audioSrc) return;
      bindAutoAdvance(audioEl, button);

      const startFromBeginning = () => {
        if (
          playingPreview !== preview
          || audioEl.dataset.audioSrc !== audioSrc
        ) return;
        try {
          if (audioEl.hasAttribute('src')) audioEl.currentTime = 0;
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
      const audioSrc = selectAudioSource(preview, audioEl);
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
      const surface = 'portal';
      initialTrackLayoutPreview = null;
      cancelAutoAdvance();
      if (!prepareSongPlayer(preview, button)) return;

      setOpenedPreview(preview);

      const positionCurrent = requestAudioPosition(preview, startTime);

      document.dispatchEvent(new CustomEvent('vcard:prepare-audio-context'));
      const startRequest = window.VCPlayer?.start?.(preview, { reason: 'click', surface });
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

    // Install controls only when this text is first opened/prepared.
    const prepareTrackBandControls = (text, times) => {
      if (!times.length) return;
      const signal = songTextScopes.get(text).signal;

      let lastTouchTap = null;
      let suppressNativeDoubleClickUntil = 0;
      const doubleTapDelay = 360;
      const doubleTapDistance = 24;
      text.addEventListener('keydown', (event) => {
        const verse = event.target.closest('.song__track-verse[role="button"]');
        if (!verse || !['Enter', ' '].includes(event.key) || event.isComposing || event.defaultPrevented) return;
        event.preventDefault();
        if (!event.repeat) requestTrackBandVerse(verse, event);
      }, { signal });
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
      }, { signal });
      text.addEventListener('pointercancel', () => {
        lastTouchTap = null;
      }, { signal });
      text.addEventListener('contextmenu', (event) => {
        if (!event.target.closest('.song__track-verse')) return;
        event.preventDefault();
      }, { signal });
      text.addEventListener('dblclick', (event) => {
        const verse = event.target.closest('.song__track-verse');
        if (!verse) return;
        if (performance.now() < suppressNativeDoubleClickUntil) return;
        event.preventDefault();
        requestTrackBandVerse(verse, event);
      }, { signal });
    };

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
            // finished PlayAni without an automatic next-song transition.
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
        scheduleUntimedTrackScroll(playingPreview, { finish: true });
        // Keep the marquee moving during the end-rewind PlayAni phase.
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
      const title = preview && previewButton(preview)?.closest('.song__title');
      if (!title || !title.classList.contains('song__title')) return null;
      const titleDocumentTop = window.scrollY + title.getBoundingClientRect().top;
      const playerHeight = playerDockHeight();
      const portal = preview.querySelector('.song-vibeframe');
      const portalRect = portal && portal.getBoundingClientRect();
      const portalHeight = (
        portalRect
        && !portal.hidden
        && getComputedStyle(portal).display !== 'none'
        && portalRect.height > 0
      ) ? portalRect.height : 0;
      requestPortalStickyHeight();
      const titleTop = portalHeight ? portalRect.bottom + 30 : playerHeight;
      const top = Math.max(0, titleDocumentTop - titleTop);
      writeViewportScroll(top, behavior, preview);
      return top;
    };

    const scheduleCardScroll = (preview, behavior, portal = false) => {
      cardScrollScope?.abort();
      // Next can request the card while VCPlayer.open is still queued.
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
      const image = preview.querySelector('.song__preview-image');
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
      if (preview.classList.contains('is-title-aligned')) scheduleSongTitleScroll(preview, 'auto');
      else schedulePortalScroll(preview, 'auto');
      document.dispatchEvent(new CustomEvent('vcard:prepare-audio-context'));
      const startRequest = window.VCPlayer?.start?.(preview, { reason: 'restart', surface });
      updateTrackBandHighlight({ scroll: false, force: true });
      startRequest?.then?.(() => updateTrackBandHighlight({ scroll: false, force: true }));
    };

    const openSongButton = (button, options = {}) => {
      if (window.VCardBootstrap.state !== 'Interactive') return;
      const preview = buttonPreview(button);
      if (!preview || !preview.classList.contains('song__preview')) return;
      if (!preview.id) preview.id = `vcard-song-preview-${buttons.indexOf(button)}`;
      if (button.getAttribute('aria-controls') !== preview.id) button.setAttribute('aria-controls', preview.id);
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
      const alignTitle = !startsAutomatically;
      preview.classList.toggle('is-title-aligned', alignTitle);
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
        || (sharedSongAudio.paused && !window.VCPlayer?.current?.()?.trackRunId)
      ) {
        prepareSongPlayer(preview, button);
      }
      refreshDynamicPlayerHints();

      try {
        // Automatic playback reveals the portal. A later title alignment
        // would overwrite the first verse scroll requested by AudioPlaying.
        // Cards opened for reading still reveal their title.
        if (!alignTitle) schedulePortalScroll(preview, 'auto');
        else scheduleSongTitleScroll(preview, 'auto');
      } catch (e) { }
    };

    const songAddress = (preview) => {
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
      const confirm = window.VCardVisualization?.prepareCopyFeedback?.(isCurrent) || (() => {});
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(value);
          if (isCurrent()) confirm();
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
      if (copied && isCurrent()) confirm();
      return copied;
    };

    const songInputButtons = new WeakMap();
    const songInputButton = (target) => {
      if (entriesByButton.has(target)) return target;
      if (target?.matches('.faq-link')) return findSongButton(target.dataset.list || '', target.dataset.song || '');
      return songInputButtons.get(target);
    };
    const songCardAvailable = ({ target, button, current } = {}) => Boolean(
      !playerControlsScope.signal.aborted && window.VCardBootstrap.state === 'Interactive'
      && songInputButton(target) === button && entriesByButton.has(button)
      && target?.isConnected && button?.isConnected && buttonPreview(button)?.isConnected
      && !target.disabled && target.getAttribute('aria-disabled') !== 'true'
      && !target.closest('[inert]') && target.getClientRects().length
      && !window.VCardSettingsContext?.isOpen?.()
      && current === currentOpenedPreview()
    );
    const toggleSongCard = (input) => {
      if (!songCardAvailable(input)) return false;
      const fromFaq = input.target.matches('.faq-link');
      if (fromFaq) activateList(String(input.button.dataset.list || ''));
      openSongButton(input.button, { forceOpen: fromFaq });
      return true;
    };
    let mapCopyPending = false;
    const mapCopyCurrent = (input) => Boolean(input?.target?.matches('.faq-link') && songCardAvailable(input));
    const mapCopyAvailable = (input) => Boolean(!mapCopyPending && mapCopyCurrent(input)
      && songAddress(buttonPreview(input.button)));
    const copyMapSongLink = (input) => {
      if (!mapCopyAvailable(input)) return false;
      const address = songAddress(buttonPreview(input.button));
      mapCopyPending = true;
      copyText(address, () => mapCopyCurrent(input))
        .then((copied) => { if (!copied && mapCopyCurrent(input)) console.warn('VCard: cannot copy song link'); })
        .catch((error) => console.warn('VCard: cannot copy song link', error))
        .finally(() => { mapCopyPending = false; });
      return true;
    };
    window.VCardSongControls = Object.freeze({ canToggleCard: songCardAvailable, toggleCard: toggleSongCard,
      canCopyLink: mapCopyAvailable, copyLink: copyMapSongLink,
      currentPreview: () => currentOpenedPreview(),
      canPlayVerse: trackBandVerseAvailable, playVerse: playTrackBandVerse,
      canSelectPlaylist: playlistInputAvailable, selectPlaylist,
      canShowMap: sitemapInputAvailable, showMap: showSitemap });
    const requestSongCard = (event, target = event.currentTarget) => {
      const input = { type: 'Song.ToggleCard', source: 'SongCard', target,
        button: songInputButton(target), current: currentOpenedPreview(), trusted: event.isTrusted };
      return window.VCCommands ? window.VCCommands.dispatch(input) : toggleSongCard(input);
    };

    // Resolve a catalog input only when it is used. Native buttons/links keep
    // their keyboard activation; custom song controls retain Enter/Space.
    document.addEventListener('click', (event) => {
      const target = event.target?.closest?.('.song__item, .faq-link');
      if (!target) return;
      if (target.matches('.faq-link')) event.preventDefault();
      requestSongCard(event, target);
    }, { signal: playerControlsScope.signal });
    document.addEventListener('contextmenu', (event) => {
      const target = event.target?.closest?.('.faq-link');
      if (!target) return;
      const input = { type: 'Song.CopyLink', source: 'SongMap', target,
        button: songInputButton(target), current: currentOpenedPreview(), trusted: event.isTrusted };
      if (!mapCopyAvailable(input)) return;
      event.preventDefault();
      if (window.VCCommands) window.VCCommands.dispatch(input);
      else copyMapSongLink(input);
    }, { signal: playerControlsScope.signal });
    document.addEventListener('keydown', (event) => {
      const target = event.target?.closest?.('.song__item');
      if (!target || target.tagName === 'BUTTON') return;
      if (event.isComposing || event.defaultPrevented || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      if (!event.repeat) requestSongCard(event, target);
    }, { signal: playerControlsScope.signal });

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

    const prepareSongYearControls = (text) => {
      const signal = songTextScopes.get(text).signal;
      text.querySelectorAll('.song__text-year').forEach((year) => {
        songInputButtons.set(year, previewButton(year.closest('.song__preview')));
        year.addEventListener('click', requestSongCard, { signal });
        year.addEventListener('keydown', (event) => {
          if (event.isComposing || event.defaultPrevented || !['Enter', ' '].includes(event.key)) return;
          event.preventDefault();
          if (!event.repeat) requestSongCard(event);
        }, { signal });
      });
    };

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

      let settingsContext = null;
      let settingsOpening = null;
      const prepareSettingsStyles = () => new Promise((resolve, reject) => {
        const source = document.getElementById('vcard-settings-style');
        const styleSource = source?.content.querySelector('link[rel="stylesheet"]');
        if (!styleSource) { reject(new Error('VCard settings stylesheet is missing')); return; }
        const link = styleSource.cloneNode(true);
        const { signal } = playerControlsScope;
        const onLoad = () => finish();
        const onError = () => finish(new Error('VCard settings stylesheet failed to load'));
        const onAbort = () => finish(new DOMException('Settings cancelled', 'AbortError'));
        const finish = (error = null) => {
          link.removeEventListener('load', onLoad);
          link.removeEventListener('error', onError);
          signal.removeEventListener('abort', onAbort);
          if (error) { link.remove(); reject(error); }
          else resolve();
        };
        if (signal.aborted) { onAbort(); return; }
        link.addEventListener('load', onLoad, { once: true });
        link.addEventListener('error', onError, { once: true });
        signal.addEventListener('abort', onAbort, { once: true });
        // Preserve the cascade: optional defaults still precede instance CSS.
        try { source.before(link); }
        catch (error) { finish(error); }
      });
      const canToggleSettings = (trigger) => Boolean(!playerControlsScope.signal.aborted
        && trigger?.isConnected && triggers.includes(trigger));
      triggers.forEach((trigger) => trigger.setAttribute('aria-controls', 'vcard-settings-dialog'));

      // The factory body creates no DOM, observers or operation state until
      // the first authorized Settings.Toggle reaches the facade below.
      const initializeSettingsDialog = () => {
      const dialog = document.createElement('div');
      dialog.className = 'vcard-settings-dialog';
      let dialogOpen = false;
      dialog.hidden = true;
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.id = 'vcard-settings-dialog';
      const backgroundInert = new Map();

      const panel = document.createElement('div');
      panel.className = 'vcard-settings-dialog__panel';
      const header = document.createElement('header');
      header.className = 'vcard-settings-dialog__header';
      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'vcard-settings-dialog__command';
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
          const titleWidth = settingsTitle.getBoundingClientRect().width;
          request('write', () => {
            const topValue = `${top}px`;
            if (dialog.style.getPropertyValue('--vcard-settings-top') !== topValue) {
              dialog.style.setProperty('--vcard-settings-top', topValue);
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
          visualization: document.documentElement.dataset.visualizationChoice
            || document.documentElement.dataset.visualizationMode || 'off',
          brightness: window.VCardBrightness?.current() || String(brightness),
          ...window.VCardSelectionSettings.current(),
          trackPlay: window.VCardTrackPlay.current(),
          autoNext: window.VCardAutoNext.current(),
          accent: colorSettings?.accent || 'off',
          colorScheme: (window.VCardColorScheme?.current()
            || 'black') === 'white'
            ? 'white'
            : 'black',
          portalSize,
          volumeBoost: vcardFileMode
            ? '1'
            : normalizeVolumeBoost(window.VCardVolumeBoost?.current() || vcardStorage.local.getItem('vcard-volume-boost')),
          fontScale: window.VCardTextScale?.current() || normalizeScale(vcardStoredSetting('vcard-song-scale', 'font-size', '100%')),
          preset: colorSettings ? (colorSettings.choice || colorSettings.preset) : vcardColorSettingsLocked()
            ? ''
            : (vcardStorage.local.getItem('vcard-preset') || ''),
        };
      };

      window.VCardWheelSettings = Object.freeze({
        current: () => Object.freeze({ ...readState() }),
      });

      const settingValues = Object.freeze({
        visualization: ['auto', 'off', 'h', 'v'],
        brightness: ['0', '1', '2', '3', '4', '5'],
        trackPlay: ['on', 'off'],
        songAlternation: ['random', 'sequential'],
        portalSize: ['off', 'small', 'mid', 'full'],
        volumeBoost: ['1', '1.5', '2', '3'],
        accent: ['on', 'off'],
        colorScheme: ['black', 'white'],
        fontScale: ['xs', 's', 'm', 'l', 'xl'],
        autoNext: ['on', 'off'],
      });
      const settingBlocked = (key, value) => (
        !Object.hasOwn(settingValues, key) || !settingValues[key].includes(value)
        || (vcardColorSettingsLocked() && ['accent', 'colorScheme'].includes(key))
        || (!vcardVisualizationAvailable() && key === 'visualization' && value !== 'off')
        || (vcardFileMode && key === 'volumeBoost' && value !== '1')
      );
      const settingCommandAvailable = ({ target, key, value, revision } = {}) => Boolean(
        !playerControlsScope.signal.aborted && state && dialogOpen && revision === dialogRevision
        && target?.isConnected && content.contains(target)
        && target.getAttribute('sd-opt') === key && target.getAttribute('sd-val') === value
        && !settingBlocked(key, value)
      );
      const settingsPresetAvailable = ({ target, preset, revision } = {}) => Boolean(
        !playerControlsScope.signal.aborted && state && dialogOpen && revision === dialogRevision
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
          const currentValue = state && state[key];
          const selected = currentValue === link.getAttribute('sd-val');
          const disabled = settingBlocked(key, link.getAttribute('sd-val'));
          link.classList.toggle('is-selected', selected);
          link.classList.toggle('is-disabled', disabled);
          link.setAttribute('aria-current', selected ? 'true' : 'false');
          link.setAttribute('aria-disabled', disabled ? 'true' : 'false');
        });
        dialog.querySelectorAll('[dd-preset]').forEach((link) => {
          const selected = Boolean(state) && state.preset === link.getAttribute('dd-preset');
          const disabled = !window.VCardDecoration?.presetAvailable(link.getAttribute('dd-preset'));
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
            if (!copied) console.warn('VCard: cannot copy song link');
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
        window.VCardUserActivity.setMenu(false);
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
        window.VCardUserActivity.setMenu(true);
        trigger.setAttribute('aria-expanded', 'true');
        scheduleSettingsLayout({ focus: true });
        return true;
      };

      const applySetting = (key, value) => {
        if (!state) return;
        const changesColorPreset = key === 'colorScheme';
        if (changesColorPreset) {
          if (window.VCardDecoration) window.VCardDecoration.clearPreset();
        }
        if (key === 'visualization') {
          if (value !== 'off' && window.VCardBrightness?.current() === '0') {
            document.dispatchEvent(new CustomEvent('vcard:set-visualization-brightness', {
              detail: { level: 3 }
            }));
          }
          document.dispatchEvent(new CustomEvent('vcard:set-visualization', {
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
        } else if (key === 'songAlternation') {
          songAlternation = value;
          vcardStorage.local.setItem(SONG_ALTERNATION_STORAGE_KEY, value);
          clearSelectionBags();
          cancelAutoAdvance();
          publishSelectionSettings();
        } else if (key === 'portalSize') {
          setPlayerPortalSize(value);
        } else if (key === 'volumeBoost') {
          const normalizedBoost = normalizeVolumeBoost(value);
          vcardStorage.local.setItem('vcard-volume-boost', normalizedBoost);
          document.dispatchEvent(new CustomEvent('vcard:set-volume-boost', {
            detail: { value: normalizedBoost }
          }));
        } else if (key === 'accent') {
          document.dispatchEvent(new CustomEvent('vcard:set-accent', {
            detail: { enabled: value === 'on' }
          }));
        } else if (key === 'colorScheme') {
          document.dispatchEvent(new CustomEvent('vcard:set-color-scheme', {
            detail: { key: value }
          }));
        } else if (key === 'autoNext') {
          window.VCardAutoNext.set(value);
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
        cleanupTasks.push((async () => {
          let registrations;
          try {
            // API presence does not grant access in an opaque or restricted context.
            if (!['http:', 'https:'].includes(location.protocol)
              || !window.isSecureContext || window.origin === 'null') return;
            const serviceWorker = navigator.serviceWorker;
            if (!serviceWorker) return;
            registrations = await serviceWorker.getRegistrations();
          } catch (error) {
            if (['SecurityError', 'NotSupportedError'].includes(error?.name)) return;
            throw error;
          }
          const ownScope = new URL('./', location.href).href;
          const results = await Promise.allSettled(
            registrations.filter((registration) => registration.scope === ownScope)
              .map((registration) => registration.unregister())
          );
          checkResetResults(results, 'Service Worker');
        })());
        if ('caches' in window) {
          cleanupTasks.push(
            vcardMediaCache.clear().then(() => caches.keys())
              .then((names) => Promise.allSettled(names
                .filter((name) => name.startsWith(vcardStoragePrefix))
                .map((name) => caches.delete(name))))
              .then((results) => checkResetResults(results, 'Cache Storage'))
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
        if (snapshot.selectionSettings) {
          for (const key of ['songAlternation', 'playlistAlternation']) {
            if (state[key] !== snapshot.selectionSettings[key]) {
              state[key] = snapshot.selectionSettings[key];
              changed = true;
            }
          }
        }
        if ((snapshot.trackPlay === 'on' || snapshot.trackPlay === 'off')
          && state.trackPlay !== snapshot.trackPlay) {
          state.trackPlay = snapshot.trackPlay;
          changed = true;
        }
        const autoNext = window.VCardAutoNext.current();
        if (state.autoNext !== autoNext) { state.autoNext = autoNext; changed = true; }
        if (snapshot.background) {
          const { brightness } = snapshot.background;
          if (brightness !== null && state.brightness !== brightness) {
            state.brightness = brightness;
            changed = true;
          }
        }
        if (snapshot.colorSettings) {
          for (const key of ['preset', 'accent']) {
            const value = key === 'preset'
              ? (snapshot.colorSettings.choice || snapshot.colorSettings.preset) : snapshot.colorSettings[key];
            if (state[key] !== value) {
              state[key] = value;
              changed = true;
            }
          }
        }
        if ((snapshot.colorScheme === 'white' || snapshot.colorScheme === 'black')
          && state.colorScheme !== snapshot.colorScheme) {
          state.colorScheme = snapshot.colorScheme;
          changed = true;
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
      document.addEventListener('vcard:visualization-state', (event) => {
        if (!state || !dialogOpen) return;
        state.visualization = event.detail.choice || event.detail.mode;
        state.brightness = String(event.detail.brightnessLevel);
        renderState();
      }, { signal: playerControlsScope.signal });
      settingsContext = Object.freeze({
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
      return settingsContext;
      };

      // Keep command availability cheap and stable before the view exists.
      // Other settings commands cannot initialize a hidden dialog accidentally.
      const deferredMethods = [
        'available', 'canSet', 'canPreset', 'canCopyLink', 'copyLink',
        'canDownload', 'download', 'canReset', 'reset', 'canCache', 'cache', 'set', 'close',
      ];
      window.VCardSettingsContext = Object.freeze({
        isOpen: () => settingsContext?.isOpen() || false,
        operations: () => settingsContext?.operations() || null,
        canToggle: canToggleSettings,
        toggle: (trigger) => {
          if (!canToggleSettings(trigger)) return false;
          if (settingsContext) return settingsContext.toggle(trigger);
          if (!settingsOpening) {
            // Network preparation must not hold the shared command queue.
            settingsOpening = prepareSettingsStyles().then(() => {
              if (!canToggleSettings(trigger)) return;
              initializeSettingsDialog().toggle(trigger);
            }).catch((error) => {
              if (error?.name !== 'AbortError') console.warn('VCard settings unavailable', error);
            }).finally(() => { settingsOpening = null; });
          }
          return true;
        },
        ...Object.fromEntries(deferredMethods.map((name) => [name,
          (...args) => settingsContext?.[name](...args) || false])),
      });
      triggers.forEach((trigger) => {
        trigger.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (!window.VCCommands) window.VCardSettingsContext.toggle(trigger);
          else window.VCCommands.dispatch({ type: 'Settings.Toggle', source: 'Player',
            target: trigger, trusted: event.isTrusted });
        }, { capture: true, signal: playerControlsScope.signal });
      });
    })();

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
      : navigator.serviceWorker.register(
        `sw.js?inst=${encodeURIComponent(vcardInstanceName)}`,
        { updateViaCache: 'none' }
      ))
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

  (() => {
    const root = document.documentElement;
    const STORAGE_KEY = 'vcard-background-mode';
    const backgroundScope = new AbortController();
    const { signal: backgroundSignal } = backgroundScope;
    // Optional instance-owned decoration; no timers or extra rendering loop.
    let sparklesInitialized = false;
    const ensureIdleSparkles = () => {
      if (sparklesInitialized) return;
      sparklesInitialized = true;
    const sparkleCount = Math.min(50, Math.max(0, Number.parseInt(
      getComputedStyle(root).getPropertyValue('--vc-idle-sparkles'), 10) || 0));
    if (sparkleCount) {
      const layer = document.createElement('div');
      layer.className = 'vcard-idle-sparkles';
      layer.setAttribute('aria-hidden', 'true');
      layer.hidden = true;
      const random = () => window.VCPlayer?.randomStream?.('background.idle-sparkles')
        ?.next('IdleSparkle.Position') ?? Math.random();
      const sparkles = Array.from({ length: sparkleCount }, (_, index) => {
        const item = document.createElement('div');
        item.className = 'vcard-idle-sparkle';
        const duration = 8 + random() * 8;
        item.style.setProperty('--sparkle-duration', `${duration}s`);
        item.style.setProperty('--sparkle-delay', `${-duration * index / sparkleCount}s`);
        item.style.setProperty('--sparkle-size', `${4 + random() * 5}px`);
        item.style.setProperty('--sparkle-drift', `${(random() - 0.5) * 60}px`);
        item.addEventListener('animationiteration', (event) => {
          if (event.animationName === 'vcard-idle-sparkle-fall') {
            item.style.setProperty('--sparkle-x', String(random()));
          }
        }, { signal: backgroundSignal });
        layer.append(item);
        return item;
      });
      document.body.prepend(layer);
      let needsPosition = true;
      const syncIdleSparkles = () => {
        const visible = root.dataset.visBri !== '0'
          && vcardMotionPolicy.snapshot().renderingActive;
        if (visible && needsPosition) {
          for (const item of sparkles) {
            item.style.setProperty('--sparkle-x', String(random()));
          }
          needsPosition = false;
        }
        layer.hidden = !visible;
      };
      for (const type of ['vcard:motion-state', 'vcard:visualization-state']) {
        document.addEventListener(type, () => syncIdleSparkles(), { signal: backgroundSignal });
      }
      backgroundSignal.addEventListener('abort', () => layer.remove(), { once: true });
      syncIdleSparkles();
    }
    };
    const selected = window.VCardUI?.siteMedia?.background || { mode: 'off', source: '' };
    const backgroundMode = selected.source ? selected.mode : 'off';
    const source = selected.source ? new URL(selected.source, document.baseURI).href : '';
    root.dataset.backgroundMode = backgroundMode;
    root.dataset.backgroundChoice = 'build';
    root.dataset.pageBackgroundColor = selected.color ? 'color' : 'mono';
    root.dataset.pageBackgroundName = source ? decodeURIComponent(new URL(source).pathname.split('/').pop()) : '—';
    root.dataset.pageBackgroundKind = backgroundMode === 'smoke' ? 'image-video' : 'image';
    vcardStorage.local.setItem(STORAGE_KEY, backgroundMode);
    const publish = () => document.dispatchEvent(new CustomEvent('vcard:background-state', {
      detail: { mode: backgroundMode, choice: 'build', videoEnabled: backgroundMode === 'smoke' }
    }));
    window.VCardBackgroundControl = Object.freeze({
      current: () => backgroundMode, choice: () => 'build',
    });
    document.addEventListener('vcard:request-background-state', publish, { signal: backgroundSignal });
    let video = null;
    let prepared = false;
    let preparationStarted = false;
    const sync = () => {
      if (backgroundSignal.aborted) return;
      if (root.dataset.visBri !== '0') {
        ensureIdleSparkles();
        if (!preparationStarted) {
          preparationStarted = true;
          void prepareBackground();
        }
      }
      if (!video) return;
      const active = prepared && root.dataset.visBri !== '0'
        && vcardMotionPolicy.snapshot().renderingActive;
      video.hidden = !prepared || root.dataset.visBri === '0';
      if (active) playVCardAnimation(video, vcardBackgroundPlaybackRate);
      else freezeVCardVideo(video);
    };
    for (const type of ['vcard:motion-state', 'vcard:visualization-state']) {
      document.addEventListener(type, sync, { signal: backgroundSignal });
    }
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) backgroundScope.abort();
    }, { signal: backgroundSignal });
    backgroundSignal.addEventListener('abort', () => {
      if (video) { freezeVCardVideo(video); video.remove(); }
    }, { once: true });
    const prepareBackground = async () => {
      if (!source) { publish(); return; }
      try {
        if (backgroundMode === 'smoke') {
          video = document.createElement('video');
          video.className = 'vcard-page-background-video is-pending';
          video.loop = true; video.muted = true; video.playsInline = true;
          video.preload = 'auto'; video.disablePictureInPicture = true;
          video.setAttribute('aria-hidden', 'true');
          video.src = source;
          document.body.prepend(video);
          video.load(); sync();
          await vcardMedia.prepareVideo(video, { signal: backgroundSignal,
            readyState: HTMLMediaElement.HAVE_CURRENT_DATA });
          if (backgroundSignal.aborted) return;
          prepared = true;
          video.classList.remove('is-pending'); sync();
        } else {
          await vcardMedia.prepareImage(source, { signal: backgroundSignal });
          if (backgroundSignal.aborted) return;
          root.style.setProperty('--vc-page-background-image', `url(${JSON.stringify(source)})`);
        }
        publish();
      } catch (error) {
        if (error?.name === 'AbortError') return;
        if (video) { video.hidden = true; freezeVCardVideo(video); }
        if (window.VCLife) window.VCLife.reportFault(error, { type: 'Background.Prepare.Fail' }, 'ResourceFailure');
        else console.warn('VCard fixed background failed', error);
      }
    };
    publish();
    sync();
  })();
  (() => {
    const schemeScope = new AbortController();
    const { signal: schemeSignal } = schemeScope;
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) schemeScope.abort();
    }, { signal: schemeSignal });
    const root = document.documentElement;
    const links = Array.from(document.querySelectorAll(':is(a, button)[data-color-scheme]'));
    let currentScheme = 'black';
    window.VCardColorScheme = Object.freeze({ current: () => currentScheme });

    function applyScheme(key, { force = false, persist = true } = {}) {
      if (schemeSignal.aborted) return;
      if (vcardColorSettingsLocked() && !force) return;
      if (key !== "black" && key !== "white") key = "white";

      currentScheme = key;
      root.dataset.colorScheme = currentScheme;

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

    applyScheme('black');
  })();
  (() => {
    const root = document.documentElement;
    const paletteScope = new AbortController();
    const { signal: paletteSignal } = paletteScope;
    const PRESET_STORAGE_KEY = "vcard-preset";
    let textColorValue = "white";
    let accColorValue = "white";
    let accentEnabled = false;
    let currentPreset = '';
    let presetChoice = vcardStorage.local.getItem(PRESET_STORAGE_KEY) === 'auto' ? 'auto' : '';
    let schemeBag = null;
    let startedRunId = null;
    let autoSongStep = 0;
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
    const MONO_ACCENT_LIGHTNESS_PERCENT = 70;
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
    const yellowTintFilter = tintFilter.cloneNode(true);
    yellowTintFilter.id = 'vc-yellow-tint';
    yellowTintFilter.querySelector('feFlood').style.floodColor = 'var(--vc-night-accent, #ffd400)';
    tintSvg.append(yellowTintFilter);
    const accentTintFilter = tintFilter.cloneNode(true);
    accentTintFilter.id = 'vc-accent-tint';
    const accentTintFlood = accentTintFilter.querySelector('feFlood');
    tintSvg.append(accentTintFilter);
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

    const withAccentAdjustments = (color, lightnessPercent = ACCENT_LIGHTNESS_PERCENT) => {
      const saturationFactor = Math.max(0, ACCENT_SATURATION_PERCENT) / 100;
      const lightnessFactor = Math.max(0, lightnessPercent) / 100;
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

    const duoPairsForPage = (page) => {
      const candidates = COLOR_PALETTE
        .filter((color) => color !== page)
        .sort((left, right) => (
          accentContrastScore(page, right) - accentContrastScore(page, left)
        ));
      const variantCount = Math.min(ACCENT_VARIANTS_PER_COLOR, candidates.length);
      return Array.from({ length: ACCENT_VARIANTS_PER_COLOR }, (_, index) => ({
        page, accent: candidates[index % variantCount],
      }));
    };

    let colorBags = null;
    const reservePalettePair = (mode) => {
      if (!colorBags?.[mode]) {
        const random = window.VCPlayer.randomStream('decor.color');
        const key = (pair) => `${pair.page}/${pair.accent}`;
        const pairs = mode === 'mono'
          ? COLOR_PALETTE.map((page) => ({ page, accent: page }))
          : COLOR_PALETTE.flatMap(duoPairsForPage);
        colorBags ||= {};
        colorBags[mode] = new window.VCLifeCore.TShuffleBag(pairs, key, random);
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
      if (isBlackScheme() && currentPreset === 'mono' && !vcardColorSettingsLocked()) {
        color = withAccentAdjustments(effectiveTextColor(), MONO_ACCENT_LIGHTNESS_PERCENT);
      } else if (isBlackScheme() && accentEnabled) {
        if (vcardColorSettingsLocked()) {
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
      }
      root.dataset.accent = accentEnabled ? 'on' : 'off';
      root.style.setProperty("--vc-acc", color);
      accentTintFlood.setAttribute('flood-color', color);
      if (publish) document.dispatchEvent(new CustomEvent("vcardacccolorchange", {
        detail: { color }
      }));
      if (publish) publishAppliedPalette();
    }

    function setAccent(enabled, { persist = true, force = false } = {}) {
      if (vcardColorSettingsLocked() && !force) return;
      accentEnabled = Boolean(enabled);
      syncAccColor();
      document.dispatchEvent(new CustomEvent("vcard:accent-state", {
        detail: { enabled: accentEnabled }
      }));
    }

    document.addEventListener("vcard:set-accent", (event) => {
      setAccent(Boolean(event.detail && event.detail.enabled));
    }, { signal: paletteSignal });


    function setTextColor(color) {
      textColorValue = color;
      if (paletteTransaction) return;
      beginPaletteTransition();
      const effectiveColor = effectiveTextColor();
      root.style.setProperty("--vc-page", effectiveColor);
      root.dataset.authorCommentMuted = isBlackScheme() ? 'on' : 'off';
      tintFlood.setAttribute("flood-color", effectiveColor);
      // Compensate the sRGB multiply tint for still photos only. CrossAni keeps
      // its existing tint and opacity, including its intentional darkening.
      const [tintRed, tintGreen, tintBlue] = hexChannels(effectiveColor);
      const tintLuma = (0.2126 * tintRed + 0.7152 * tintGreen + 0.0722 * tintBlue) / 255;
      root.style.setProperty("--vc-photo-tint-brightness", String(isBlackScheme() && tintLuma > 0 ? 1 / tintLuma : 1));
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
      if (['night', 'mono', 'duo', 'newspaper'].includes(key)) vcardStorage.local.setItem('vcard-last-preset', key);
      if (key) {
        root.dataset.colorPreset = key;
      } else {
        delete root.dataset.colorPreset;
      }
      // Palette setters run before the preset is published; refresh its exception.
      if (sync) syncAccColor();
      document.querySelectorAll("[dd-preset]").forEach((link) => {
        if (link.closest('#vcard-settings-dialog')) return;
        const selected = link.getAttribute("dd-preset") === (presetChoice || key);
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
      presetChoice = 'custom';
      vcardStorage.local.setItem(PRESET_STORAGE_KEY, "custom");
      publishPreset("");
    }

    const presetAvailable = (key) => !paletteSignal.aborted && !vcardColorSettingsLocked()
      && ['auto', 'night', 'mono', 'duo', 'newspaper'].includes(key);
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
      if (persist || key === 'auto') {
        presetChoice = key;
        if (persist) vcardStorage.local.setItem(PRESET_STORAGE_KEY, key);
      }
      if (key === 'auto') {
        publishPreset(currentPreset);
        return;
      }
      if (presetChoice !== 'auto') presetChoice = key;

      beginPaletteTransition();
      paletteTransaction = true;
      try {
        const cycleActiveNight = key === 'night' && currentPreset === 'night'
          && window.VCLife?.scenario?.profileFor?.()?.cyclesNightTone?.() !== false;
        const useNightMono = cycleActiveNight && nightTone !== 'mono';
        document.documentElement.style.removeProperty("--vc-win");
        if (key !== 'night') { nightTone = ''; delete root.dataset.nightTone; }
        if (key === 'newspaper') {
          document.dispatchEvent(new CustomEvent("vcard:set-color-scheme", {
            detail: { key: "white", persist }
          }));
          setPalettePair("black", "black");
          setAccent(false, { persist });
        } else if (key === 'mono') {
          withPalettePair('mono', (pair) => {
            document.dispatchEvent(new CustomEvent("vcard:set-color-scheme", {
              detail: { key: "black", persist }
            }));
            setPalettePair(pair.page, pair.accent);
            setAccent(false, { persist });
          });
        } else if (key === 'duo') {
          withPalettePair('duo', (pair) => {
            document.dispatchEvent(new CustomEvent("vcard:set-color-scheme", {
              detail: { key: "black", persist }
            }));
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
            setPalettePair("white", "white");
            setAccent(false, { persist });
          } else {
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

    const storedPreset = () => {
      const value = vcardStorage.local.getItem(PRESET_STORAGE_KEY);
      return ['auto', 'night', 'mono', 'duo', 'newspaper'].includes(value) ? value : 'duo';
    };

    window.VCardDecoration = Object.freeze({
      beginSong: (runId, period = 1) => {
        if (paletteSignal.aborted || !runId || startedRunId === runId) return false;
        startedRunId = runId;
        if (presetChoice !== 'auto') return false;
        autoSongStep += 1;
        if (autoSongStep % period !== 0) return false;
        if (!schemeBag) {
          schemeBag = new window.VCLifeCore.TShuffleBag(['night', 'mono', 'duo', 'newspaper'],
            (key) => key, window.VCPlayer.randomStream('decor.scheme'));
          schemeBag.last = currentPreset;
          if (schemeBag.remaining[0] === currentPreset) {
            [schemeBag.remaining[0], schemeBag.remaining[1]] = [schemeBag.remaining[1], schemeBag.remaining[0]];
          }
        }
        const reservation = schemeBag.reserve();
        if (!reservation) return false;
        try {
          applyPreset(reservation.item, { persist: false });
          reservation.commit();
        } finally {
          reservation.cancel();
        }
        return true;
      },
      applyShowPreset: (key) => {
        if (presetChoice === 'auto') return false;
        if (!['mono', 'duo'].includes(key) || !presetAvailable(key)) return false;
        if (currentPreset !== key) applyPreset(key, { persist: false });
        return true;
      },
      clearPreset: markCustomPreset,
      current: () => Object.freeze({
        preset: currentPreset, choice: presetChoice || currentPreset, nightTone, paletteReady, autoSongStep,
        colorSettingsLocked: vcardColorSettingsLocked(),
        accent: accentEnabled ? 'on' : 'off',
      }),
      presetAvailable,
      canPreset: presetCommandAvailable,
      applyPreset: applyPresetCommand,
      initializeColors: () => {
        if (paletteSignal.aborted || paletteReady) return;
        const restore = window.VCLife?.scenario.profileFor()?.restoreColorScheme();
        const saved = storedPreset();
        applyPreset(restore ? (saved === 'auto' ? vcardStorage.local.getItem('vcard-last-preset') || 'duo' : saved)
          : 'duo', { persist: false });
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
        const preset = currentPreset || 'duo';
        const before = `${root.style.getPropertyValue('--vc-page')}/${root.style.getPropertyValue('--vc-acc')}`;
        applyPreset(preset, { persist: false });
        const after = `${root.style.getPropertyValue('--vc-page')}/${root.style.getPropertyValue('--vc-acc')}`;
        return { changed: before !== after, reason: reason || 'refresh', preset };
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
      xs: "calc(var(--font-size-base) * 0.6)",
      s: "calc(var(--font-size-base) * 0.8)",
      m: "var(--font-size-base)",
      l: "calc(var(--font-size-base) * 1.2)",
      xl: "calc(var(--font-size-base) * 1.4)"
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
