(() => {
  'use strict';

  const copy = (value) => (
    value === undefined ? undefined : JSON.parse(JSON.stringify(value))
  );

  const freeze = (value) => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze);
    return Object.freeze(value);
  };

  const cleanupAll = (actions) => {
    let failure = null;
    for (const action of actions) {
      try { action(); }
      catch (error) { failure ||= error; }
    }
    if (failure) throw failure;
  };

  const songIdentity = (preview) => {
    const entry = window.VCardCatalogView?.forPreview(preview);
    if (entry) return {
      listId: entry.listId,
      songId: entry.localId,
      sourceSongId: entry.songId,
      releaseId: entry.releaseId,
      releaseKey: entry.releaseKey,
      entryKey: entry.entryKey,
    };
    const item = preview?.previousElementSibling?.querySelector('.song__item[data-song]');
    return item ? {
      listId: String(item.dataset.list || ''),
      songId: String(item.dataset.song || ''),
    } : { listId: '', songId: '' };
  };

  class TRandomHub {
    constructor(context = null, seed = null) {
      this.context = context;
      this.seedSource = Number.isInteger(seed) && seed >= 0 && seed <= 0xFFFFFFFF
        ? 'diagnostic' : 'generated';
      if (this.seedSource === 'diagnostic') this.seed = seed;
      else {
        try { this.seed = window.crypto.getRandomValues(new Uint32Array(1))[0]; }
        catch (_error) { this.seed = (Date.now() ^ Math.floor(Math.random() * 4294967296)) >>> 0; }
      }
      this.streams = new Map();
      this.decisions = [];
      this.lastDecisions = new Map();
      this.nextDecisionId = 1;
      this.traceErrors = 0;
    }

    stream(name) {
      if (this.streams.has(name)) return this.streams.get(name);
      let state = this.seed ^ 2166136261;
      for (const character of name) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
      const hub = this;
      const stream = { name, draws: 0, last: null,
        decision: (detail) => hub.recordDecision(name, detail),
        finishDecision: (decision, result, detail) => {
          try {
            if (decision) Object.assign(decision, detail, { result, finishedAt: performance.now() / 1000,
              finishedContext: hub.context?.() || null });
          } catch (_error) { hub.traceErrors += 1; }
        },
        next(reason = '') {
        state = (state + 0x6D2B79F5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
        const result = ((value ^ (value >>> 14)) >>> 0) / 4294967296;
        this.draws += 1;
        this.last = { name, draw: this.draws, value: result, reason };
        return result;
      } };
      this.streams.set(name, stream);
      return stream;
    }

    recordDecision(owner, detail) {
      try {
        const context = this.context?.() || null;
        const decision = { id: this.nextDecisionId++, owner, at: performance.now() / 1000,
          context, ...detail, origin: detail?.origin || (context && { ...context }) };
        this.decisions.push(decision);
        if (this.decisions.length > 200) this.decisions.shift();
        this.lastDecisions.delete(owner);
        this.lastDecisions.set(owner, decision);
        if (this.lastDecisions.size > 200) this.lastDecisions.delete(this.lastDecisions.keys().next().value);
        return decision;
      } catch (_error) { this.traceErrors += 1; return null; }
    }

    traceSnapshot() { return copy(this.decisions); }

    snapshot() {
      return { seed: this.seed, seedSource: this.seedSource, streams: [...this.streams].map(([name, stream]) =>
        ({ name, draws: stream.draws, last: stream.last && { ...stream.last } })),
        decisionCount: this.nextDecisionId - 1, traceErrors: this.traceErrors,
        lastDecisions: copy([...this.lastDecisions.values()]) };
    }
  }

  const SELECTION_MEMORY_TTL = 86400;

  class TSelectionMemory {
    constructor(life) {
      this.life = life;
      this.catalog = window.VCardCatalog;
      this.storage = window.VCardStorage?.local;
      this.key = 'vcard-selection-memory';
      this.pageSessionId = window.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.epoch = '0000000000000:initial';
      this.recent = [];
      this.lastPlayedAt = 0;
      this.resetReason = '';
      this.entriesByKey = new Map((this.catalog?.entries || []).map((entry) => [entry.entryKey, entry]));
      this.merge(this.read());
      this.expire();
      try { this.channel = new BroadcastChannel(this.key); } catch (_error) { this.channel = null; }
      const receive = (saved) => life.queue.post(() => {
        const incoming = this.normalize(saved);
        if (!incoming) return;
        const changed = this.merge(saved);
        if (changed) life.publish();
        if (JSON.stringify(this.state()) !== JSON.stringify(incoming)) this.save();
      }, { type: 'Selection.Remote', owner: life, scope: life.scope });
      if (this.channel) this.channel.onmessage = (event) => receive(event.data);
      window.addEventListener('storage', (event) => {
        if (event.key === this.key && event.newValue) {
          try { receive(JSON.parse(event.newValue)); } catch (_error) { /* Ignore malformed external state. */ }
        }
      }, { signal: life.scope.signal });
      life.scope.signal.addEventListener('abort', () => this.channel?.close(), { once: true });
    }

    normalize(saved) {
      if (![1, 2].includes(saved?.version) || !Array.isArray(saved.recent)) return null;
      if (saved.epoch !== undefined && (typeof saved.epoch !== 'string' || !/^\d{13}:[A-Za-z0-9-]+$/.test(saved.epoch))) return null;
      const records = saved.recent.flatMap((record, index) => {
        const entry = this.entriesByKey.get(record?.entryKey);
        if (!entry || !Number.isFinite(record.startedAt) || record.startedAt < 0) return [];
        return [{ songId: entry.songId, releaseKey: entry.releaseKey, entryKey: entry.entryKey,
          listId: entry.listId, startedAt: record.startedAt, mode: record.mode === 'MAN' ? 'MAN' : 'AUTO',
          eventId: typeof record.eventId === 'string' ? record.eventId : `legacy:${record.startedAt}:${index}:${entry.entryKey}`,
          pageSessionId: typeof record.pageSessionId === 'string' ? record.pageSessionId : 'legacy' }];
      });
      const recent = [...new Map(records.map((record) => [record.eventId, record])).values()]
        .sort((left, right) => left.startedAt - right.startedAt || (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0)).slice(-5);
      return { version: 2, epoch: typeof saved.epoch === 'string' ? saved.epoch : '0000000000000:initial',
        lastPlayedAt: Math.max(Number.isFinite(saved.lastPlayedAt) ? saved.lastPlayedAt : 0,
          ...recent.map((record) => record.startedAt)), recent };
    }

    read() {
      try { return JSON.parse(this.storage?.getItem(this.key) || 'null'); } catch (_error) { return null; }
    }

    state() {
      return { version: 2, epoch: this.epoch, lastPlayedAt: this.lastPlayedAt, recent: this.recent };
    }

    merge(saved) {
      const incoming = this.normalize(saved);
      if (!incoming || incoming.epoch < this.epoch) return false;
      const before = JSON.stringify(this.state());
      if (incoming.epoch > this.epoch) {
        this.epoch = incoming.epoch;
        this.recent = [];
        this.lastPlayedAt = 0;
        this.resetReason = 'remote-epoch';
        document.dispatchEvent(new CustomEvent('vcard:selection-memory-reset'));
      }
      const records = [...this.recent, ...incoming.recent];
      this.recent = [...new Map(records.map((record) => [record.eventId, record])).values()]
        .sort((left, right) => left.startedAt - right.startedAt || (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0)).slice(-5);
      this.lastPlayedAt = Math.max(this.lastPlayedAt, incoming.lastPlayedAt);
      return before !== JSON.stringify(this.state());
    }

    expire() {
      if (this.lastPlayedAt && Date.now() - this.lastPlayedAt > SELECTION_MEMORY_TTL * 1000) this.reset('expired');
    }

    save() {
      const write = () => {
        if (this.life.dead) return;
        this.merge(this.read());
        this.storage?.setItem(this.key, JSON.stringify(this.state()));
        // Reconcile once more for browsers without origin-wide write locks.
        if (this.merge(this.read())) this.storage?.setItem(this.key, JSON.stringify(this.state()));
        this.channel?.postMessage(this.state());
        if (this.life.selectionMemory === this) this.life.publish();
      };
      if (navigator.locks?.request) {
        navigator.locks.request(this.key, { signal: this.life.scope.signal }, () => this.life.queue.post(write,
          { type: 'Selection.Save', owner: this.life, scope: this.life.scope }))
          .catch((error) => { if (error?.name !== 'AbortError' && !this.life.dead) write(); });
      } else write();
    }

    record(playback) {
      const entry = this.entriesByKey.get(playback.song.identity.entryKey);
      if (!entry) return;
      this.merge(this.read());
      this.expire();
      this.lastPlayedAt = Date.now();
      const eventId = `${this.pageSessionId}:${playback.runId}`;
      if (this.recent.some((record) => record.eventId === eventId)) return;
      this.recent.push({ songId: entry.songId, releaseKey: entry.releaseKey,
        entryKey: entry.entryKey, listId: entry.listId, startedAt: this.lastPlayedAt,
        mode: this.life.selectionMode ? 'AUTO' : 'MAN', eventId, pageSessionId: this.pageSessionId });
      this.recent = this.recent.slice(-5);
      this.save();
    }

    reset(reason = 'mode-change') {
      this.merge(this.read());
      this.epoch = `${String(Math.max(Date.now(), Number.parseInt(this.epoch, 10) + 1)).padStart(13, '0')}:${this.pageSessionId}`;
      this.recent = [];
      this.lastPlayedAt = 0;
      this.resetReason = reason;
      document.dispatchEvent(new CustomEvent('vcard:selection-memory-reset'));
      this.save();
    }

    contains(songId) {
      this.expire();
      return this.recent.some((entry) => entry.songId === songId);
    }

    containsList(listId) {
      this.expire();
      return this.recent.some((entry) => entry.listId === listId);
    }
  }

  class TShuffleBag {
    constructor(items, key = (item) => item, random = null) {
      this.items = [...items];
      this.key = key;
      this.random = random;
      this.last = null;
      this.reservation = null;
      this.invalid = new Set();
      this.refill();
    }

    refill() {
      this.remaining = this.shuffle(this.items.filter((item) => !this.invalid.has(this.key(item))));
      if (this.remaining.length > 1 && this.key(this.remaining[0]) === this.last) {
        [this.remaining[0], this.remaining[1]] = [this.remaining[1], this.remaining[0]];
      }
    }

    shuffle(items) {
      const shuffled = [...items];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = Math.floor((this.random ? this.random.next('shuffle') : Math.random()) * (index + 1));
        [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
      }
      return shuffled;
    }

    update(items) {
      const previous = new Set(this.items.map(this.key));
      const byKey = new Map(items.filter((item) => !this.invalid.has(this.key(item)))
        .map((item) => [this.key(item), item]));
      const unique = [...byKey.values()];
      if (this.reservation && !unique.some((item) => this.key(item) === this.key(this.reservation.item))) {
        this.reservation.cancel();
      }
      this.items = unique;
      // Append new candidates through the same shuffle, preserving this pass.
      const additions = this.shuffle(unique.filter((item) => !previous.has(this.key(item))));
      this.remaining = [...this.remaining.map((item) => byKey.get(this.key(item))).filter((item) => item !== undefined), ...additions];
    }

    invalidate(item) {
      const key = this.key(item);
      this.invalid.add(key);
      const failedReservation = this.reservation && this.key(this.reservation.item) === key ? this.reservation : null;
      this.items = this.items.filter((candidate) => this.key(candidate) !== key);
      this.remaining = this.remaining.filter((candidate) => this.key(candidate) !== key);
      failedReservation?.fail();
    }

    reserve({ allow = () => true, prefer = () => true, refill = true, origin = null, cancelToFront = false } = {}) {
      if (this.reservation) throw new Error('Shuffle bag already has a reservation');
      if (!this.remaining.some(allow) && refill) this.refill();
      const item = this.remaining.find((candidate) => allow(candidate) && prefer(candidate)) ?? this.remaining.find(allow);
      if (item === undefined) return null;
      const before = this.remaining.length;
      const detail = { type: 'shuffle-bag', selected: this.key(item),
        draw: this.random?.draws || 0, remainingBefore: before,
        fallback: !prefer(item), result: 'Reserve' };
      if (origin) detail.origin = { ...origin };
      if (window.document?.documentElement?.dataset.debug === 'on') {
        detail.candidates = this.remaining.map((candidate) => ({ key: this.key(candidate),
          reason: !allow(candidate) ? 'disallowed' : (!prefer(candidate) ? 'not-preferred' : 'eligible') }));
      }
      const decision = this.random?.decision?.(detail);
      let active = true;
      const finish = (result) => {
        if (!active) return false;
        active = false;
        if (result === 'Commit') {
          this.last = this.key(item);
          this.remaining = this.remaining.filter((candidate) => this.key(candidate) !== this.last);
        } else if (result === 'Cancel' && cancelToFront) {
          const index = this.remaining.findIndex((candidate) => this.key(candidate) === this.key(item));
          if (index > 0) this.remaining.unshift(this.remaining.splice(index, 1)[0]);
        }
        this.reservation = null;
        this.random?.finishDecision?.(decision, result, { remainingAfter: this.remaining.length,
          ...(result === 'Cancel' ? { cancelPosition: cancelToFront ? 'front' : 'preserved' } : {}) });
        return true;
      };
      this.reservation = { item, decisionId: decision?.id || 0,
        commit: () => finish('Commit'), cancel: () => finish('Cancel'), fail: () => finish('Failure') };
      return this.reservation;
    }
  }

  class TAutopilotSelector {
    constructor(entries = [], memory = null, random = null) {
      this.memory = memory;
      this.entries = [...new Map(entries.filter((entry) => entry.playable)
        .map((entry) => [entry.releaseKey, entry])).values()];
      this.invalid = new Set();
      this.bag = new TShuffleBag(this.entries, (entry) => entry.releaseKey, random);
      this.epoch = memory?.epoch;
      this.reservation = null;
    }

    get remaining() { return this.bag.remaining; }

    reserve(currentReleaseKey) {
      this.reservation?.cancel();
      this.memory?.expire();
      if (this.epoch !== this.memory?.epoch) {
        this.bag.refill();
        this.epoch = this.memory?.epoch;
      }
      const available = this.entries.filter((entry) => !this.invalid.has(entry.releaseKey));
      const picked = this.bag.reserve({
        cancelToFront: true,
        allow: (entry) => !this.invalid.has(entry.releaseKey) && (available.length === 1 || entry.releaseKey !== currentReleaseKey),
        prefer: (entry) => !this.memory?.contains(entry.songId),
      });
      if (!picked) return null;
      const finish = (consume) => {
        const result = consume ? picked.commit() : picked.cancel();
        if (this.reservation === reservation) this.reservation = null;
        return result;
      };
      const reservation = { entry: picked.item, commit: () => finish(true), cancel: () => finish(false) };
      this.reservation = reservation;
      return reservation;
    }

    reset() {
      this.reservation?.cancel();
      this.bag.refill();
      this.epoch = this.memory?.epoch;
    }
  }

  class Scope {
    constructor(owner, parent = null) {
      this.owner = owner;
      this.parent = parent;
      this.controller = new AbortController();
      this.children = new Set();
      this.alive = true;
      if (parent && !parent.alive) this.die('owner-died');
      else parent?.children.add(this);
    }

    get signal() {
      return this.controller.signal;
    }

    child(owner) {
      return new Scope(owner, this);
    }

    die(reason = 'scope-died') {
      if (!this.alive) return;
      this.alive = false;
      const children = [...this.children];
      this.children.clear();
      this.parent?.children.delete(this);
      cleanupAll([() => this.controller.abort(reason), ...children.map((child) => () => child.die(reason))]);
    }
  }

  class Clock {
    constructor(name, now) {
      this.name = name;
      this.read = now;
    }

    now() {
      const value = Number(this.read());
      return Number.isFinite(value) ? value : 0;
    }

    wait(duration, signal = null) {
      const seconds = Math.max(0, Number(duration) || 0);
      if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
      if (seconds === 0) return Promise.resolve();
      const target = this.now() + seconds;
      return new Promise((resolve, reject) => {
        let timer = 0;
        const done = () => {
          if (timer) window.clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
        };
        const abort = () => {
          done();
          reject(new DOMException('Aborted', 'AbortError'));
        };
        const tick = () => {
          if (signal?.aborted) return abort();
          if (this.now() >= target) {
            done();
            resolve();
            return;
          }
          const remaining = Math.max(0, target - this.now());
          timer = window.setTimeout(tick, Math.max(1, Math.min(1000, remaining * 1000)));
        };
        signal?.addEventListener('abort', abort, { once: true });
        timer = window.setTimeout(tick, seconds * 1000);
      });
    }
  }

  class CommandQueue {
    constructor({ onError = null, onComplete = null } = {}) {
      this.jobs = [];
      this.current = null;
      this.last = null;
      this.nextId = 1;
      this.closed = false;
      this.scheduled = false;
      this.coalesced = 0;
      this.onError = onError;
      this.onComplete = onComplete;
    }

    get pending() { return this.jobs.length; }

    job(command, { type = 'Runtime.Command', owner = null, scope = null, coalesce = false } = {}) {
      return { id: this.nextId++, type, owner, scope, coalesce, command, queuedAt: performance.now() / 1000 };
    }

    execute(job) {
      if (this.closed || job.owner?.dead || job.scope?.signal.aborted) {
        job.resolve?.(false);
        return false;
      }
      this.current = job;
      try {
        // Awaiting long work here would block Pause and lose user activation.
        const result = job.command();
        job.resolve?.(result);
        return result;
      } catch (error) {
        job.failed = true;
        this.onError?.(error, job);
        job.reject?.(error);
        return false;
      } finally {
        this.last = { id: job.id, type: job.type, owner: job.owner?.id || '', queuedAt: job.queuedAt };
        try { this.onComplete?.(); }
        catch (error) { this.onError?.(error, job); }
        finally { this.current = null; }
      }
    }

    drain() {
      if (this.current) return;
      while (this.jobs.length && !this.closed) this.execute(this.jobs.shift());
    }

    run(command, options = {}) {
      if (this.current) return this.post(command, options);
      this.drain();
      return this.execute(this.job(command, options));
    }

    post(command, options = {}) {
      if (this.closed) return Promise.resolve(false);
      const job = this.job(command, options);
      const result = new Promise((resolve, reject) => {
        Object.assign(job, { resolve, reject });
        const previous = this.jobs[this.jobs.length - 1];
        if (job.coalesce && previous?.coalesce && previous.type === job.type
          && previous.owner === job.owner && previous.scope === job.scope) {
          // Never move an observation across another command or owner boundary.
          this.jobs.pop();
          previous.resolve(false);
          this.coalesced += 1;
        }
        this.jobs.push(job);
      });
      // The runtime records failures even when an event source has no caller.
      result.catch((error) => {
        if (!job.failed && !job.owner?.dead && !job.scope?.signal.aborted) this.onError?.(error, job);
      });
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => { this.scheduled = false; this.drain(); });
      }
      return result;
    }

    close() {
      this.closed = true;
      this.jobs.splice(0).forEach((job) => job.resolve(false));
    }
  }

  class TVCLifeStatsStore {
    constructor({ key = 'aliswb:vclife:stats', version = 1, storage = null } = {}) {
      this.key = key;
      this.version = version;
      this.storage = storage || window.VCardStorage?.local || (() => {
        try {
          return window.localStorage;
        } catch (_error) {
          return null;
        }
      })();
    }

    empty() {
      return {
        version: this.version,
        lifetime: { counters: {}, last: {} },
        sessions: [],
        currentSession: null,
      };
    }

    normalize(value) {
      if (!value || value.version !== this.version) return this.empty();
      return {
        version: this.version,
        lifetime: {
          counters: { ...(value.lifetime?.counters || {}) },
          last: { ...(value.lifetime?.last || {}) },
        },
        sessions: Array.isArray(value.sessions) ? value.sessions.slice(-10) : [],
        currentSession: value.currentSession && typeof value.currentSession === 'object'
          ? value.currentSession
          : null,
      };
    }

    load() {
      if (!this.storage) return this.empty();
      try {
        return this.normalize(JSON.parse(this.storage.getItem(this.key) || 'null'));
      } catch (_error) {
        return this.empty();
      }
    }

    save(value) {
      if (!this.storage) return false;
      try {
        return this.storage.setItem(this.key, JSON.stringify(this.normalize(value))) !== false;
      } catch (_error) {
        return false;
      }
    }
  }

  class TVCLifeStats {
    constructor(life, { store = null, now = () => Date.now() } = {}) {
      this.life = life;
      this.now = now;
      this.store = store || new TVCLifeStatsStore();
      this.state = this.store.load();
      this.events = [];
      this.observations = new Map();
      this.nextObservationId = 1;
      this.playbackSample = null;
      this.archiveInterruptedSession();
      this.beginSession();
    }

    archiveInterruptedSession() {
      const session = this.state.currentSession;
      if (!session) return;
      this.state.sessions.push({
        ...session,
        endedAt: session.updatedAt || session.startedAt,
        endReason: 'interrupted',
      });
      this.state.sessions = this.state.sessions.slice(-10);
      this.state.currentSession = null;
    }

    beginSession() {
      const at = this.now();
      this.session = {
        id: `${at}-${Math.random().toString(36).slice(2, 10)}`,
        startedAt: at,
        updatedAt: at,
        counters: {},
        last: {},
        openedWithoutStart: 0,
      };
      this.state.currentSession = this.session;
    }

    previousSession() {
      return this.state.sessions.at(-1) || null;
    }

    counter(name, scope = 'session') {
      const source = scope === 'lifetime' ? this.state.lifetime : this.session;
      return Number(source?.counters?.[name]) || 0;
    }

    last(name, scope = 'session') {
      const source = scope === 'lifetime' ? this.state.lifetime : this.session;
      return source?.last?.[name] || null;
    }

    elapsedSince(name, scope = 'session', at = this.now()) {
      const event = this.last(name, scope);
      const timestamp = Number(event?.at);
      return Number.isFinite(timestamp) ? Math.max(0, (at - timestamp) / 1000) : Infinity;
    }

    bump(name, amount = 1) {
      const increment = Number(amount) || 0;
      this.session.counters[name] = this.counter(name) + increment;
      this.state.lifetime.counters[name] = this.counter(name, 'lifetime') + increment;
    }

    resetPlaybackSample() {
      this.playbackSample = null;
    }

    samplePlayback(playback, audio, sampledAt = performance.now()) {
      const runId = Number(playback?.runId) || 0;
      const position = Number(audio?.currentTime);
      const active = Boolean(
        playback
        && !playback.dead
        && playback.state === 'playing'
        && audio
        && !audio.paused
        && !audio.ended
        && !audio.seeking
        && Number.isFinite(position)
      );
      if (!active) {
        this.resetPlaybackSample();
        return 0;
      }
      const previous = this.playbackSample;
      this.playbackSample = { runId, position, sampledAt };
      if (!previous || previous.runId !== runId) return 0;
      const audioDelta = position - previous.position;
      const wallDelta = Math.max(0, (sampledAt - previous.sampledAt) / 1000);
      const playbackRate = Math.max(0.1, Number(audio.playbackRate) || 1);
      const maximumNaturalDelta = wallDelta * playbackRate + 1;
      if (audioDelta <= 0 || audioDelta > maximumNaturalDelta) return 0;
      this.bump('playTime', audioDelta);
      return audioDelta;
    }

    record(type, detail = {}, { counter = '', persist = true } = {}) {
      const at = this.now();
      const event = { type, at, detail: copy(detail) || {} };
      this.events.push(event);
      if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
      this.session.last[type] = event;
      this.state.lifetime.last[type] = event;
      this.session.updatedAt = at;
      if (counter) this.bump(counter);
      this.state.currentSession = this.session;
      if (persist) this.store.save(this.state);
      return event;
    }

    songOpened(song) {
      const observation = {
        id: `${this.session.id}:${this.nextObservationId++}`,
        ...song.identity,
        openedAt: this.now(),
        startedAt: null,
        closedAt: null,
      };
      this.observations.set(song.id, observation);
      this.session.openedWithoutStart = this.openedWithoutStart();
      this.record('Song.Open', observation, { counter: 'songsOpened' });
    }

    songClosed(song) {
      const observation = this.observations.get(song.id);
      if (observation) {
        observation.closedAt = this.now();
        this.observations.delete(song.id);
      }
      this.session.openedWithoutStart = this.openedWithoutStart();
      this.record('Song.Close', observation || song.identity, {
        counter: observation && observation.startedAt === null
          ? 'songsClosedWithoutStart'
          : '',
      });
    }

    playbackStarted(playback) {
      const song = playback.song;
      const observation = this.observations.get(song.id);
      if (observation && observation.startedAt === null) observation.startedAt = this.now();
      this.session.openedWithoutStart = this.openedWithoutStart();
      this.record('Playback.Start', {
        ...song.identity,
        runId: playback.runId,
        reason: playback.reason,
      }, { counter: 'songsStarted' });
    }

    playbackEnded(playback) {
      this.record('Playback.End', {
        ...playback.song.identity,
        runId: playback.runId,
      }, { counter: 'songsCompleted' });
    }

    verseEntered(playback, detail = {}) {
      this.record('Verse.Enter', {
        ...playback.song.identity,
        runId: playback.runId,
        index: Number(detail.index),
      }, { counter: 'versesEntered', persist: false });
    }

    slideShown({ kind = '', globalSlideNumber = 0, decision = null } = {}) {
      this.record('Slide.Show', {
        kind,
        globalSlideNumber,
        decision: decision ? copy(decision) : null,
      }, {
        counter: 'slidesShown',
        persist: false,
      });
      if (kind === 'cassette') this.bump('cassetteSlidesShown');
      else if (kind === 'image') this.bump('imageSlidesShown');
    }

    decorationChanged(kind, detail = {}) {
      return this.record(`Decoration.${kind}.Change`, detail, {
        counter: `decoration${kind}Changes`,
      });
    }

    openedWithoutStart() {
      return Array.from(this.observations.values()).filter(
        (item) => item.startedAt === null && item.closedAt === null
      ).length;
    }

    finish(reason = 'page-died') {
      if (!this.session || this.session.endedAt) return;
      this.session.updatedAt = this.now();
      this.session.endedAt = this.session.updatedAt;
      this.session.endReason = reason;
      this.session.openedWithoutStart = this.openedWithoutStart();
      this.state.sessions.push(copy(this.session));
      this.state.sessions = this.state.sessions.slice(-10);
      this.state.currentSession = null;
      this.store.save(this.state);
    }

    snapshot() {
      return {
        session: copy(this.session),
        lifetime: copy(this.state.lifetime),
        previousSession: copy(this.previousSession()),
        openObservations: copy(Array.from(this.observations.values())),
        recentEvents: copy(this.events.slice(-20)),
      };
    }
  }

  class TDecorationProfile {
    constructor(life, { name = 'none' } = {}) {
      this.life = life;
      this.name = name;
      this.lastEvaluationAt = 0;
    }

    get stats() {
      return this.life.stats;
    }

    evaluate(reason = 'Life.Tick', detail = {}) {
      this.lastEvaluationAt = Date.now();
      return { reason, detail, changed: false };
    }

    onEvent(event) {
      return this.evaluate(event.type, event.detail);
    }

    onTick(context = {}) {
      return this.evaluate('Life.Tick', context);
    }

    changed(kind, detail = {}) {
      const event = this.stats.decorationChanged(kind, detail);
      this.life.scenario.onLifeEvent?.(event, this.life);
      this.life.publish();
      return event;
    }

    snapshot() {
      return { name: this.name, lastEvaluationAt: this.lastEvaluationAt };
    }

    dispose() {}
  }

  class VisualWorld {
    constructor(resolvePortal) {
      this.resolvePortal = resolvePortal;
    }

    get portal() {
      return this.resolvePortal?.() || null;
    }

    snapshot() {
      return this.portal?.current?.() || null;
    }
  }

  class LifeObject {
    constructor(owner, kind, scope = null) {
      this.owner = owner || null;
      this.kind = kind;
      this.id = `${kind}-${LifeObject.nextId++}`;
      this.scope = scope || owner?.scope?.child(this) || new Scope(this);
      this.bornAt = performance.now() / 1000;
      this.dead = false;
    }

    die(reason = 'object-died') {
      if (this.dead) return;
      this.dead = true;
      this.scope.die(reason);
    }

    snapshot() {
      return {
        id: this.id,
        kind: this.kind,
        owner: this.owner?.id || '',
        alive: !this.dead && this.scope.alive,
      };
    }
  }
  LifeObject.nextId = 1;

  class TOperation extends LifeObject {
    constructor(owner, name) {
      super(owner, 'Operation');
      this.name = name;
      this.status = 'Running';
      this.startedAt = this.bornAt;
      this.finishedAt = null;
      this.result = null;
      this.error = null;
      (owner.operations ||= new Set()).add(this);
      this.scope.signal.addEventListener('abort', () => this.cancel(this.scope.signal.reason), { once: true });
      if (this.scope.signal.aborted) this.cancel('owner-died');
    }

    finish(status, result = null, error = null) {
      if (this.status !== 'Running') return false;
      this.status = status;
      this.finishedAt = performance.now() / 1000;
      this.dead = true;
      this.owner.operations.delete(this);
      cleanupAll([
        () => {
          this.result = copy(result);
          this.error = error ? { name: String(error.name || 'Error'), message: String(error.message || error) } : null;
        },
        () => this.scope.die(status),
        () => { this.owner.lastOperation = this.snapshot(); },
      ]);
      return true;
    }

    complete(result = null) { return this.finish('Completed', result); }
    fail(error) {
      return error?.name === 'AbortError' ? this.cancel('aborted') : this.finish('Failed', null, error);
    }
    cancel(reason = 'operation-cancelled') { return this.finish('Cancelled', { reason: String(reason || '') }); }
    die(reason = 'operation-died') { this.cancel(reason); }

    snapshot() {
      return { ...super.snapshot(), name: this.name, status: this.status,
        startedAt: this.startedAt, finishedAt: this.finishedAt,
        result: copy(this.result), error: copy(this.error) };
    }
  }

  class AudioChannel {
    constructor(audio, life) {
      this.audio = audio;
      this.life = life;
      this.owner = null;
      this.generation = 0;
      this.source = '';
      this.listeners = [];
      this.metadataOperation = null;
      this.metadata = { stage: 'idle' };
      this.bind();
    }

    bind() {
      if (!this.audio) return;
      const bind = (name, handler) => {
        this.audio.addEventListener(name, handler);
        this.listeners.push([name, handler]);
      };
      bind('playing', () => this.dispatch('playing'));
      bind('pause', () => {
        if (!this.audio.ended) this.dispatch('pause');
      });
      bind('waiting', () => this.dispatch('waiting'));
      // A stalled download can still leave enough buffered data to play.
      // Only waiting confirms that playback needs more data.
      bind('seeking', () => this.dispatch('seeking'));
      bind('seeked', () => this.dispatch('seeked'));
      bind('timeupdate', () => this.dispatch('timeupdate'));
      bind('ended', () => this.dispatch('ended'));
      bind('error', () => this.dispatch('error'));
    }

    acquire(playback) {
      if (this.owner && this.owner !== playback) this.owner.replaced();
      this.owner = playback;
      this.generation += 1;
      this.source = this.audio?.src || '';
      this.metadataOperation?.cancel('audio-owner-replaced');
      this.metadataOperation = null;
      this.metadata = { stage: 'idle' };
      if (!this.life.prepareAudio || !this.audio) return;
      const generation = this.generation;
      const source = this.source;
      const operation = new TOperation(playback, 'audio-metadata');
      const scope = operation.scope;
      this.metadataOperation = operation;
      this.metadata = { stage: 'preparing', source };
      const current = () => operation.status === 'Running' && scope.alive && !playback.dead && this.owner === playback
        && generation === this.generation && source === this.audio.src;
      Promise.resolve().then(() => {
        if (!current()) throw new DOMException('Audio owner replaced', 'AbortError');
        return this.life.prepareAudio(this.audio, { signal: scope.signal });
      }).then((result) => this.life.queue.post(() => {
        if (!current()) return;
        this.metadata = { stage: 'ready', source, ...result };
        operation.complete({ source, ...result });
        this.life.publish();
      }, { type: 'Operation.Complete', owner: playback, scope })).catch((error) => {
        if (error?.name === 'AbortError' || !current()) return;
        return this.life.queue.post(() => {
          if (!current()) return;
          this.metadata = { stage: 'failed', source, error: String(error?.message || error) };
          operation.fail(error);
          this.life.reportFault(error, { type: 'Operation.Fail', owner: operation }, 'ResourceFailure');
        }, { type: 'Operation.Fail', owner: playback, scope });
      }).finally(() => {
        operation.cancel('audio-metadata-finished');
        if (this.metadataOperation === operation) this.metadataOperation = null;
      });
    }

    release(playback) {
      if (this.owner === playback) {
        this.metadataOperation?.cancel('audio-owner-released');
        this.metadataOperation = null;
        if (this.metadata.stage === 'preparing') this.metadata = { stage: 'cancelled', source: this.source };
        this.owner = null;
      }
    }

    dispatch(eventName) {
      const owner = this.owner;
      const generation = this.generation;
      if (!owner || owner.dead) return;
      const current = () => this.owner === owner && !owner.dead && this.generation === generation
        && this.source === this.audio.src
        && (!this.audio.currentSrc || this.audio.currentSrc === this.source)
        && (eventName !== 'playing' || !this.audio.paused)
        && (eventName !== 'pause' || this.audio.paused)
        && (eventName !== 'ended' || this.audio.ended)
        && (eventName !== 'error' || Boolean(this.audio.error));
      this.life.queue.post(() => {
        if (current()) owner.onAudio(eventName);
      }, { type: `Audio.${eventName}`, owner, scope: owner.scope, coalesce: eventName === 'timeupdate' });
    }

    snapshot() {
      return {
        owner: this.owner?.id || '', generation: this.generation,
        source: this.audio?.src || '', boundSource: this.source, currentSource: this.audio?.currentSrc || '',
        paused: Boolean(this.audio?.paused), ended: Boolean(this.audio?.ended),
        seeking: Boolean(this.audio?.seeking), readyState: this.audio?.readyState || 0,
        metadata: { ...this.metadata },
        error: this.audio?.error ? { code: this.audio.error.code, message: this.audio.error.message } : null,
      };
    }

    dispose() {
      if (this.owner) this.release(this.owner);
      this.listeners.forEach(([name, handler]) => this.audio?.removeEventListener(name, handler));
      this.listeners.length = 0;
      this.owner = null;
    }
  }

  class TSongEnvironment extends LifeObject {
    constructor(song) {
      super(song, 'SongEnvironment');
      this.song = song;
    }
  }

  class TPlaybackChain extends LifeObject {
    constructor(life) {
      super(life, 'PlaybackChain');
      this.life = life;
      this.phase = 'Idle';
      this.song = null;
      this.playback = null;
      this.pendingPlan = null;
      this.pendingScope = null;
      this.pendingEndsAt = 0;
      this.autoReadyPending = false;
      this.autoReadyEndsAt = 0;
      this.continuationBlocked = false;
      this.lastCountdown = null;
    }

    static get activePhases() {
      return new Set(['AudioPlaying', 'AudioBuffering', 'OutroRunning', 'NextPending']);
    }

    setPhase(phase, { song = this.song, playback = this.playback } = {}) {
      this.phase = phase;
      this.song = song || null;
      this.playback = playback || null;
      this.lastCountdown = null;
      this.publish();
    }

    publish() {
      this.life.publish();
    }

    ready(song, { automatic = false, delay = 0 } = {}) {
      this.cancelPending('song-ready');
      this.autoReadyPending = Boolean(automatic);
      this.autoReadyEndsAt = this.autoReadyPending
        ? this.life.transitionClock.now() + Math.max(0, Number(delay) || 0)
        : 0;
      this.setPhase('ReadyPaused', { song, playback: song?.playback || null });
    }

    starting(song, playback) {
      this.cancelPending('playback-starting');
      this.autoReadyPending = false;
      this.autoReadyEndsAt = 0;
      this.setPhase('Starting', { song, playback });
    }

    playing(playback) {
      this.setPhase('AudioPlaying', { song: playback?.song, playback });
    }

    paused(playback) {
      if (['OutroRunning', 'NextPending', 'FinishedStopped'].includes(this.phase)) return;
      this.setPhase('AudioPaused', { song: playback?.song, playback });
    }

    outro(playback) {
      this.cancelPending('outro-started');
      this.autoReadyEndsAt = 0;
      this.setPhase('OutroRunning', { song: playback?.song, playback });
    }

    reserveNext(playback = this.playback) {
      if (this.pendingPlan || !playback) return this.pendingPlan;
      try {
        this.pendingPlan = this.life.completeHandler?.({
          preview: playback.song.preview,
          trackRunId: playback.runId,
        }) || null;
      } catch (error) {
        this.life.reportFault(error, { type: 'Selection.Reserve', owner: this });
        this.pendingPlan = null;
      }
      return this.pendingPlan;
    }

    stopPendingWait(reason = 'continuation-stopped') {
      this.pendingScope?.die(reason);
      this.pendingScope = null;
      this.pendingEndsAt = 0;
    }

    finishStopped(playback = this.playback, { keepPlan = false } = {}) {
      if (keepPlan) this.stopPendingWait('finished-stopped');
      else this.cancelPending('finished-stopped');
      this.autoReadyPending = false;
      this.autoReadyEndsAt = 0;
      if (playback && !playback.dead) {
        playback.cancelOperation('finished-stopped');
        playback.ending = false;
        playback.state = 'ended';
        playback.environment.onFinalStopped?.(playback);
      }
      this.setPhase('FinishedStopped', {
        song: playback?.song || this.song,
        playback,
      });
    }

    completeOutro(playback) {
      if (this.dead || playback?.dead || this.playback !== playback) return;
      if (this.continuationBlocked) { this.finishStopped(playback); return; }
      const plan = this.reserveNext(playback);
      if (!plan || typeof plan.commit !== 'function') {
        this.finishStopped(playback);
        return;
      }
      this.stopPendingWait('next-wait-replaced');
      const waitOperation = new TOperation(this, 'next-pending');
      this.pendingScope = waitOperation.scope;
      const delay = this.life.staticCassDelay();
      this.pendingEndsAt = this.life.transitionClock.now() + delay;
      this.setPhase('NextPending', { song: playback.song, playback });
      const scope = this.pendingScope;
      this.life.transitionClock.wait(delay, scope.signal).then(() => this.life.queue.post(() => {
        if (!scope.alive || scope !== this.pendingScope || this.phase !== 'NextPending'
          || playback.dead || this.playback !== playback) return;
        const reserved = this.pendingPlan;
        this.pendingPlan = null;
        this.pendingScope = null;
        this.pendingEndsAt = 0;
        const settle = () => {
          if (!this.dead && !playback.dead && this.playback === playback && this.phase === 'NextPending') {
            this.finishStopped(playback);
          }
        };
        try {
          if (!reserved || reserved.commit() === false) {
            this.cancelPlan(reserved);
            settle();
            waitOperation.cancel('commit-refused');
          } else {
            waitOperation.complete();
          }
        } catch (error) {
          waitOperation.fail(error);
          this.cancelPlan(reserved);
          settle();
          throw error;
        } finally {
          scope.die('next-commit-settled');
        }
      }, { type: 'Selection.Commit', owner: this, scope })).catch((error) => {
        if (error?.name !== 'AbortError' && !this.dead) this.life.queue.post(() => {
          if (this.playback !== playback || this.phase !== 'NextPending') return;
          this.life.reportFault(error, { type: 'Selection.Commit', owner: this });
          this.finishStopped(playback);
        }, { type: 'Operation.Fail', owner: this, scope: this.scope });
      });
    }

    cancelPlan(plan) {
      try { plan?.cancel?.(); }
      catch (error) { this.life.reportFault(error, { type: 'Selection.Cancel', owner: this }); }
    }

    cancelPending(reason = 'continuation-cancelled') {
      const plan = this.pendingPlan;
      this.pendingPlan = null;
      this.pendingScope?.die(reason);
      this.pendingScope = null;
      this.pendingEndsAt = 0;
      this.cancelPlan(plan);
    }

    cancelContinuation(reason = 'continuation-cancelled', { settle = true } = {}) {
      this.cancelPending(reason);
      const playback = this.playback;
      if (playback?.ending) {
        playback.cancelOperation(reason);
        playback.ending = false;
        playback.state = 'ended';
      }
      if (settle && ['OutroRunning', 'NextPending'].includes(this.phase)) {
        this.finishStopped(playback);
      }
    }

    stopContinuation(reason = 'continuation-stopped') {
      const playback = this.playback;
      if (!['OutroRunning', 'NextPending'].includes(this.phase)) return false;
      if (this.phase === 'OutroRunning') this.reserveNext(playback);
      this.stopPendingWait(reason);
      this.finishStopped(playback, { keepPlan: true });
      return true;
    }

    resumeContinuation() {
      if (this.phase !== 'FinishedStopped') return false;
      const plan = this.pendingPlan;
      if (!plan || typeof plan.commit !== 'function') return false;
      this.pendingPlan = null;
      this.stopPendingWait('continuation-resumed');
      let committed = false;
      try {
        const result = plan.commit({ automatic: false });
        committed = result !== false;
        return result;
      } finally {
        if (!committed) this.cancelPlan(plan);
      }
    }

    tick() {
      const countdown = this.countdown();
      if (countdown === this.lastCountdown) return;
      this.lastCountdown = countdown;
      this.publish();
    }

    countdown() {
      let endsAt = 0;
      if (this.phase === 'NextPending') endsAt = this.pendingEndsAt;
      else if (this.phase === 'ReadyPaused' && this.autoReadyPending) {
        endsAt = this.autoReadyEndsAt;
      }
      return endsAt
        ? Math.max(0, Math.ceil(endsAt - this.life.transitionClock.now()))
        : 0;
    }

    snapshot() {
      return {
        ...super.snapshot(),
        phase: this.phase,
        action: TPlaybackChain.activePhases.has(this.phase) || this.autoReadyPending
          ? 'pause'
          : 'play',
        autoReadyPending: this.autoReadyPending,
        continuationBlocked: this.continuationBlocked,
        continuationReserved: Boolean(this.pendingPlan),
        countdown: this.countdown(),
        operations: [...(this.operations || [])].map((operation) => operation.snapshot()),
        lastOperation: this.lastOperation || null,
      };
    }

    die(reason = 'playback-chain-died') {
      if (this.dead) return;
      this.cancelPending(reason);
      super.die(reason);
    }
  }

  class TSongPlayback extends LifeObject {
    constructor(song, runId, reason, profile, launch = 'inherit') {
      super(song, 'SongPlayback');
      this.song = song;
      this.life = song.life;
      this.audio = this.life.audio;
      this.runId = runId;
      this.reason = reason;
      this.profile = profile || this.life.scenario;
      this.launch = launch;
      this.state = 'starting';
      this.verseIndex = -1;
      this.lastNaturalVerseIndex = -1;
      this.plan = null;
      this.operation = null;
      this.operationScope = null;
      this.started = false;
      this.ending = false;
      this.playbackEnding = null;
    }

    get environment() { return this.playbackEnvironment || this.song.environment; }

    beginOperation(name) {
      this.cancelOperation('operation-replaced');
      this.operationRecord = new TOperation(this, name);
      this.operationScope = this.operationRecord.scope;
      this.operation = name;
      return this.operationScope;
    }

    cancelOperation(reason = 'operation-cancelled') {
      this.operationRecord?.cancel(reason);
      this.operationRecord = null;
      this.operationScope = null;
      this.operation = null;
    }

    start() {
      if (this.dead || !this.audio) return Promise.resolve(false);
      this.life.audioChannel.acquire(this);
      this.life.playbackChain.starting(this.song, this);
      this.song.environment.onPlaybackStart(this);
      this.life.publish();

      // This call intentionally remains in the trusted UI event call stack.
      // Awaiting it first would make browser autoplay permission unreliable.
      let playRequest;
      try {
        playRequest = this.audio.play();
      } catch (error) {
        this.failed(error);
        return Promise.reject(error);
      }
      return Promise.resolve(playRequest).then(() => !this.dead).catch((error) => {
        if (error?.name === 'AbortError' || this.dead) return false;
        if (!this.dead) this.life.queue.post(() => this.failed(error), { type: 'Playback.Fail', owner: this, scope: this.scope });
        console.warn('VCLife cannot start audio', error);
        return false;
      });
    }

    resume({ surface = null } = {}) {
      if (this.dead || !this.audio) return Promise.resolve(false);
      if (surface && this.audio.paused && this.environment.onProfileChange) {
        const profile = this.life.scenario.profileFor?.(surface, this.profile) || this.profile;
        if (profile !== this.profile) {
          this.environment.onProfileChange(this, profile);
          this.life.lastShowProfile = profile;
          if (this.lastVerseDetail) this.verse({ ...this.lastVerseDetail, seeked: true });
          this.life.publish();
        }
      }
      this.environment.onResume(this);
      let request;
      try {
        request = this.audio.play();
      } catch (error) {
        this.failed(error);
        return Promise.reject(error);
      }
      return Promise.resolve(request).catch((error) => {
        if (error?.name === 'AbortError' || this.dead) return false;
        if (!this.dead) this.life.queue.post(() => this.failed(error), { type: 'Playback.Fail', owner: this, scope: this.scope });
        console.warn('VCLife cannot resume audio', error);
        return false;
      });
    }

    pause() {
      if (this.dead || !this.audio || this.audio.paused) return;
      this.audio.pause();
    }

    verse(detail = {}) {
      if (this.dead || this.state === 'failed' || detail.preview !== this.song.preview) return;
      const index = Number.isInteger(detail.index) ? detail.index : -1;
      if (index < 0) return;
      if (!this.started) {
        this.pendingVerseDetail = detail;
        return;
      }
      if (index === this.verseIndex && !detail.seeked) return;
      this.lastVerseDetail = { ...detail };
      const natural = !detail.seeked;
      if (natural && index !== this.lastNaturalVerseIndex) {
        this.life.globalVerseCount += 1;
        this.lastNaturalVerseIndex = index;
        this.life.event('Verse.Enter', { playback: this, detail });
      }
      this.verseIndex = index;
      this.plan = this.profile.planVerse(this, detail, this.life.globalVerseCount);
      this.environment.onVerse(this, detail, this.plan);
      this.life.publish();
    }

    onAudio(eventName) {
      if (this.dead || this.state === 'failed') return;
      if (eventName === 'playing') {
        if (this.started && this.state === 'playing') return;
        const firstStart = !this.started;
        this.started = true;
        this.state = 'playing';
        this.life.playbackChain.playing(this);
        if (firstStart) this.life.event('Playback.Start', { playback: this, song: this.song });
        this.environment.onPlaying(this);
        const pending = this.pendingVerseDetail;
        this.pendingVerseDetail = null;
        if (pending) this.verse(pending);
      } else if (eventName === 'pause') {
        if (this.state === 'paused') return;
        this.state = 'paused';
        this.life.playbackChain.paused(this);
        this.environment.onPause(this);
      } else if (eventName === 'waiting') {
        if (this.audio.paused || ['waiting', 'ending', 'ended', 'failed'].includes(this.state)) return;
        this.state = 'waiting';
        this.life.playbackChain.setPhase('AudioBuffering', { song: this.song, playback: this });
        this.life.stats.resetPlaybackSample();
        this.environment.onWaiting(this);
      } else if (eventName === 'seeking') {
        this.life.stats.resetPlaybackSample();
        this.cancelOperation('seek');
        this.environment.onSeek(this);
      } else if (eventName === 'seeked') {
        this.environment.onSeeked(this);
      } else if (eventName === 'timeupdate') {
        this.life.stats.samplePlayback(this, this.audio);
        this.environment.onTick(this);
        return;
      } else if (eventName === 'ended') {
        if (this.ending) return;
        this.end();
      } else if (eventName === 'error') {
        this.failed(this.audio?.error || new Error('Audio failed'));
      }
      this.life.publish();
    }

    end() {
      if (this.dead || this.ending) return;
      this.ending = true;
      this.state = 'ending';
      this.playbackEnding = this.profile.createEnding?.(this) || null;
      if (this.playbackEnding?.requiresOutro !== false) this.life.playbackChain.outro(this);
      this.life.event('Playback.End', { playback: this, song: this.song });
      const operation = this.beginOperation('song-end');
      Promise.resolve().then(() => {
        if (this.dead || !operation.alive) return;
        return this.playbackEnding
          ? this.playbackEnding.run(operation.signal)
          : this.environment.onEnd(this, operation.signal);
      }).then(() => this.life.queue.post(() => {
        if (this.dead || !operation.alive) return;
        this.playbackEnding?.settleFinal();
        this.operationRecord?.complete();
        this.cancelOperation('song-end-complete');
        this.state = 'ended';
        this.environment.onEnded(this);
        this.life.playbackChain.completeOutro(this);
      }, { type: 'Operation.Complete', owner: this, scope: operation })).catch((error) => {
        if (error?.name !== 'AbortError' && !this.dead && operation.alive) {
          this.life.queue.post(() => {
            if (this.dead || !operation.alive) return;
            this.life.reportFault(error, { type: 'Outro.Fail', owner: this }, 'ComponentFailure');
            this.operationRecord?.fail(error);
            this.cancelOperation('outro-failed');
            this.state = 'ended';
            try {
              this.environment.onFinalStopped?.(this);
            } catch (fallbackError) {
              this.life.reportFault(fallbackError, { type: 'Outro.Fallback', owner: this }, 'ComponentFailure');
            }
            this.life.playbackChain.completeOutro(this);
          }, { type: 'Operation.Fail', owner: this, scope: operation });
        }
      });
    }

    failed(error) {
      if (this.dead || this.state === 'failed') return;
      if (error === this.audio?.error || error?.name === 'NotSupportedError') {
        this.life.autopilotSelector.invalid.add(this.song.identity.releaseKey);
      }
      this.life.recordPlaybackResult(this, 'failed');
      this.cancelOperation('operation-failed');
      this.life.reportFault(error, { type: 'Playback.Fail', owner: this },
        error === this.audio?.error ? 'ResourceFailure' : 'ComponentFailure');
      this.state = 'failed';
      this.life.playbackChain.setPhase('Failed', { song: this.song, playback: this });
      this.environment.onFailed(this, error);
      this.life.publish();
    }

    replaced() {
      this.die('playback-replaced');
    }

    die(reason = 'playback-died') {
      if (this.dead) return;
      cleanupAll([
        () => this.life.recordPlaybackResult(this, reason),
        () => this.cancelOperation(reason),
        () => this.life.audioChannel.release(this),
        () => this.playbackEnvironment?.die(reason),
        () => super.die(reason),
      ]);
    }

    snapshot() {
      return {
        ...super.snapshot(),
        runId: this.runId,
        profile: this.profile.name,
        launch: this.launch,
        state: this.state,
        verseIndex: this.verseIndex,
        operation: this.operation,
        environment: this.playbackEnvironment?.snapshot() || null,
        operations: [...(this.operations || [])].map((operation) => operation.snapshot()),
        lastOperation: this.lastOperation || null,
      };
    }
  }

  class TSong extends LifeObject {
    constructor(life, preview) {
      super(life, 'Song');
      this.life = life;
      this.preview = preview;
      this.identity = songIdentity(preview);
      this.environment = life.scenario.createEnvironment(this);
      this.playback = null;
      this.opened = false;
      this.autoStartScope = null;
    }

    open({ current = false } = {}) {
      const wasOpened = this.opened;
      this.opened = true;
      this.cancelAutoStart('song-opened');
      const background = Boolean(
        this.life.playingSong
        && this.life.playingSong !== this
        && this.life.playingSong.playback
        && !this.life.playingSong.playback.dead
        && !['ended', 'failed'].includes(this.life.playingSong.playback.state)
      );
      this.environment.onOpen({ current, background });
      if (!wasOpened) this.life.event('Song.Open', { song: this });
    }

    close() {
      const wasOpened = this.opened;
      this.opened = false;
      this.cancelAutoStart('song-closed');
      if (this.playback?.ending) {
        this.playback.cancelOperation('song-closed');
        this.playback.ending = false;
        this.playback.state = 'ended';
      }
      this.environment.onClose({ current: this.life.playingSong === this });
      if (wasOpened) this.life.event('Song.Close', { song: this });
    }

    scheduleAutoStart(delay, start) {
      this.cancelAutoStart('auto-start-replaced');
      const operation = new TOperation(this, 'auto-start');
      const scope = operation.scope;
      this.autoStartScope = scope;
      this.life.publish();
      return this.life.transitionClock.wait(delay, scope.signal).then(() => this.life.queue.post(() => {
        if (!scope.alive || !this.opened || this.autoStartScope !== scope) return false;
        this.autoStartScope = null;
        operation.complete();
        return start();
      }, { type: 'Playback.AutoStart', owner: this, scope })).catch((error) => {
        if (error?.name !== 'AbortError') throw error;
        return false;
      });
    }

    cancelAutoStart(reason = 'auto-start-cancelled') {
      this.autoStartScope?.die(reason);
      this.autoStartScope = null;
    }

    start(reason, historyIndex = -1, profile = null, launch = 'inherit') {
      this.cancelAutoStart('play-started');
      this.playback?.die('new-playback');
      this.playback = new TSongPlayback(this, this.life.nextRunId++, reason, profile, launch);
      this.playback.historyIndex = historyIndex;
      return this.playback.start();
    }

    die(reason = 'song-died') {
      if (this.dead) return;
      cleanupAll([
        () => this.cancelAutoStart(reason),
        () => this.playback?.die(reason),
        () => this.environment?.die(reason),
        () => super.die(reason),
      ]);
    }

    snapshot() {
      return {
        ...super.snapshot(),
        ...this.identity,
        opened: this.opened,
        autoStartPending: Boolean(this.autoStartScope?.alive),
        operations: [...(this.operations || [])].map((operation) => operation.snapshot()),
        lastOperation: this.lastOperation || null,
        environment: this.environment?.snapshot?.() || null,
        playback: this.playback?.snapshot?.() || null,
      };
    }
  }

  class TVCLife extends LifeObject {
    constructor({ audio, scenario, prepareAudio = null, randomSeed = null }) {
      super(null, 'VCLife');
      this.audio = audio;
      this.prepareAudio = prepareAudio;
      this.scenario = scenario;
      this.scenario.life = this;
      this.revision = 0;
      this.publishedAt = null;
      this.dirty = false;
      this.lastError = null;
      this.queue = new CommandQueue({
        onError: (error, command) => this.reportFault(error, command),
        onComplete: () => this.flushPublication(),
      });
      this.lifeClock = new Clock('LifeClock', () => performance.now() / 1000 - this.bornAt);
      this.playbackClock = new Clock('PlaybackClock', () => this.audio?.currentTime || 0);
      this.transitionClock = new Clock('TransitionClock', () => performance.now() / 1000);
      this.visualWorld = new VisualWorld(() => window.VCardPortal);
      this.audioChannel = new AudioChannel(audio, this);
      this.playbackChain = new TPlaybackChain(this);
      this.songs = new Map();
      this.openedSong = null;
      this.playingSong = null;
      this.nextRunId = 1;
      this.playbackHistory = { entries: [], order: [], cursor: -1 };
      this.globalVerseCount = 0;
      this.globalSlideCount = 0;
      this.completeHandler = null;
      this.random = new TRandomHub(() => ({ commandId: this.queue.current?.id || null,
        event: this.queue.current?.type || null, revision: this.revision,
        runId: this.playingSong?.playback?.runId || null,
        launch: this.playingSong?.playback?.launch || null,
        profile: this.playingSong?.playback?.profile?.name || null,
        entryKey: this.playingSong?.identity?.entryKey || null }), randomSeed);
      this.selectionMode = window.VCardStorage?.local.getItem('vcard-autopilot') !== 'off';
      this.selectionMemory = new TSelectionMemory(this);
      this.autopilotSelector = new TAutopilotSelector(window.VCardCatalog?.entries, this.selectionMemory,
        this.random.stream('songs.auto'));
      this.motionAllowed = document.documentElement.dataset.visBri !== '0';
      this.pageVisible = !document.hidden;
      this.imagesVisible = document.documentElement.dataset.imagesVisible !== 'off';
      this.pageSuspended = false;
      const statsStore = this.scenario.createStatsStore?.(this) || null;
      this.stats = new TVCLifeStats(this, { store: statsStore });
      this.decorationProfile = this.scenario.createDecorationProfile?.(this)
        || new TDecorationProfile(this);
      this.lifeTickTimer = 0;
      this.event('Page.Reload');
      this.scenario.onPageReload(this);
      this.scheduleLifeTick();
    }

    event(type, detail = {}, options = {}) {
      let event;
      if (type === 'Song.Open') {
        this.stats.songOpened(detail.song);
        event = this.stats.last(type);
      } else if (type === 'Song.Close') {
        this.stats.songClosed(detail.song);
        event = this.stats.last(type);
      } else if (type === 'Playback.Start') {
        this.recordPlaybackHistory(detail.playback);
        this.selectionMemory.record(detail.playback);
        this.stats.playbackStarted(detail.playback);
        event = this.stats.last(type);
      } else if (type === 'Playback.End') {
        this.recordPlaybackResult(detail.playback, 'ended');
        this.stats.playbackEnded(detail.playback);
        event = this.stats.last(type);
      } else if (type === 'Verse.Enter') {
        this.stats.verseEntered(detail.playback, detail.detail);
        event = this.stats.last(type);
      } else if (type === 'Slide.Show') {
        this.stats.slideShown(detail);
        event = this.stats.last(type);
      } else {
        event = this.stats.record(type, detail, options);
      }
      this.decorationProfile?.onEvent?.(event);
      this.scenario.onLifeEvent?.(event, this);
      return event;
    }

    scheduleLifeTick() {
      if (this.dead || this.lifeTickTimer) return;
      this.lifeTickTimer = window.setTimeout(() => {
        this.lifeTickTimer = 0;
        if (this.dead) return;
        this.queue.post(() => {
          if (this.dead) return;
          const playback = this.playingSong?.playback;
          const playTimeAdded = this.stats.samplePlayback(playback, this.audio);
          const result = this.decorationProfile?.onTick?.({
            now: Date.now(),
            stats: this.stats,
            playTimeAdded,
          });
          this.scenario.onLifeTick?.(this);
          this.playbackChain.tick();
          if (result?.changed) this.publish();
        }, { type: 'Life.Tick', owner: this, scope: this.scope, coalesce: true })
          .finally(() => this.scheduleLifeTick()).catch(() => {});
      }, 1000);
    }

    songFor(preview) {
      if (!preview) return null;
      let song = this.songs.get(preview);
      if (!song || song.dead) {
        song = new TSong(this, preview);
        this.songs.set(preview, song);
      }
      return song;
    }

    open(preview) {
      const song = this.songFor(preview);
      if (!song) return false;
      if (this.openedSong && this.openedSong !== song) this.openedSong.close();
      this.openedSong = song;
      const current = this.playingSong === song
          && Boolean(song.playback && !song.playback.dead)
          && !['ended', 'failed'].includes(song.playback.state);
      song.open({ current });
      const anotherPlaying = this.playingSong && this.playingSong !== song
        && this.playingSong.playback && !this.playingSong.playback.dead
        && !['ended', 'failed'].includes(this.playingSong.playback.state);
      if (!current && !anotherPlaying) this.playbackChain.ready(song);
      this.publish();
      return true;
    }

    close(preview) {
      const song = this.songs.get(preview);
      if (!song) return;
      song.close();
      if (this.openedSong === song) this.openedSong = null;
      if (this.playbackChain.song === song) {
        if (['OutroRunning', 'NextPending', 'FinishedStopped'].includes(this.playbackChain.phase)) {
          this.playbackChain.cancelContinuation('song-closed', { settle: false });
          this.playbackChain.setPhase('Idle', { song: null, playback: null });
        } else if (this.playbackChain.phase === 'ReadyPaused') {
          this.playbackChain.setPhase('Idle', { song: null, playback: null });
        }
      }
      this.publish();
    }

    start(preview, { reason = 'click', autoReady = false, historyIndex = -1, surface = null } = {}) {
      const song = this.songFor(preview);
      if (!song) return Promise.resolve(false);
      if (reason === 'auto' && this.playbackChain.continuationBlocked) return Promise.resolve(false);
      if (reason !== 'auto') this.playbackChain.continuationBlocked = false;
      const inheritedProfile = this.playingSong?.playback?.profile || this.lastShowProfile;
      const profile = this.scenario.profileFor?.(surface, inheritedProfile) || this.scenario;
      if (reason !== 'auto' && this.autopilotSelector.invalid.delete(song.identity.releaseKey)) {
        this.audio?.load();
      }
      if (!song.opened) this.open(preview);
      if (reason === 'auto' && !autoReady) {
        const requestedDelay = Number(this.scenario.autoStartDelay?.());
        const delay = Number.isFinite(requestedDelay) && requestedDelay >= 0
          ? requestedDelay
          : 0;
        if (delay > 0) {
          this.playbackChain.ready(song, { automatic: true, delay });
          return song.scheduleAutoStart(delay, () => this.start(preview, {
            reason: 'auto', autoReady: true, historyIndex, surface,
          }));
        }
      }
      song.cancelAutoStart('manual-or-ready-start');
      if (this.playingSong && this.playingSong !== song) {
        this.playingSong.playback?.die('another-song-started');
      }
      this.playingSong = song;
      if (this.audio && !this.audio.paused) this.audio.pause();
      this.lastShowProfile = profile;
      const launch = surface === 'player' || surface === 'portal' ? surface : 'inherit';
      const request = song.start(reason, historyIndex, profile, launch);
      this.publish();
      return request;
    }

    toggle(preview, { surface = 'player' } = {}) {
      const song = this.songFor(preview);
      const playback = song?.playback;
      if (['OutroRunning', 'NextPending'].includes(this.playbackChain.phase)) {
        this.playbackChain.stopContinuation('manual-pause');
        return false;
      }
      if (song?.autoStartScope?.alive) {
        song.cancelAutoStart('manual-pause');
        this.playbackChain.ready(song);
        return false;
      }
      if (song === this.playingSong && playback && !playback.dead) {
        if (this.playbackChain.continuationBlocked
          && (this.audio?.paused || this.playbackChain.phase === 'FinishedStopped')) {
          this.playbackChain.continuationBlocked = false;
          this.publish();
        }
        if (this.playbackChain.phase === 'FinishedStopped') {
          if (this.playbackChain.resumeContinuation()) return true;
        }
        if (this.playbackChain.phase === 'FinishedStopped' || this.audio?.ended || ['ended', 'failed'].includes(playback.state)) {
          try { this.audio.currentTime = 0; } catch (_error) {}
          return this.start(preview, { reason: 'restart', surface });
        }
        return this.audio?.paused ? playback.resume({ surface }) : playback.pause();
      }
      return this.start(preview, { reason: 'click', surface });
    }

    resume({ surface = 'player' } = {}) {
      const song = this.openedSong || this.playingSong;
      if (this.playbackChain.continuationBlocked) {
        this.playbackChain.continuationBlocked = false;
        this.publish();
      }
      song?.cancelAutoStart('manual-resume');
      if (this.playbackChain.phase === 'FinishedStopped') {
        if (this.playbackChain.resumeContinuation()) return true;
      }
      if (this.playbackChain.phase === 'FinishedStopped' || this.audio?.ended || ['ended', 'failed'].includes(song?.playback?.state)) {
        try { this.audio.currentTime = 0; } catch (_error) {}
        return song ? this.start(song.preview, { reason: 'restart', surface: 'player' }) : false;
      }
      return song?.playback?.resume({ surface }) || (song ? this.start(song.preview, { reason: 'click', surface: surface || 'player' }) : false);
    }

    pause() {
      const song = this.openedSong || this.playingSong;
      song?.cancelAutoStart('manual-pause');
      if (['OutroRunning', 'NextPending'].includes(this.playbackChain.phase)) {
        this.playbackChain.stopContinuation('manual-pause');
        return false;
      }
      if (this.playbackChain.phase === 'ReadyPaused') {
        this.playbackChain.ready(song);
        return false;
      }
      return this.playingSong?.playback?.pause();
    }

    stop() {
      this.pause();
      this.playbackChain.continuationBlocked = true;
      this.publish();
    }

    cancelContinuation(reason = 'navigation', { settle = true } = {}) {
      if (reason === 'explicit-next-navigation' && this.playbackChain.continuationBlocked) {
        this.playbackChain.continuationBlocked = false;
        this.publish();
      }
      this.openedSong?.cancelAutoStart(reason);
      this.playbackChain.cancelContinuation(reason, { settle });
    }

    staticCassDelay() {
      const value = Number(this.scenario.staticCassDelay?.());
      return Number.isFinite(value) && value >= 0 ? value : 0;
    }

    pageReloadTime() {
      return Math.max(0, this.lifeClock.now());
    }

    verse(detail) {
      this.playingSong?.playback?.verse(detail);
    }

    setCompleteHandler(handler) {
      this.completeHandler = typeof handler === 'function' ? handler : null;
    }

    recordPlaybackHistory(playback) {
      const history = this.playbackHistory;
      const entry = { ...playback.song.identity, runId: playback.runId,
        profile: playback.profile.name, reason: playback.reason, startedAt: Date.now(), result: null };
      const entryIndex = history.entries.push(entry) - 1;
      const position = playback.historyIndex;
      const target = history.entries[history.order[position]];
      if (Number.isInteger(position) && target && target.entryKey === entry.entryKey) {
        history.order[position] = entryIndex;
        history.cursor = position;
      } else {
        history.order.splice(history.cursor + 1);
        history.order.push(entryIndex);
        history.cursor = history.order.length - 1;
      }
    }

    recordPlaybackResult(playback, result) {
      const entry = this.playbackHistory.entries.find((item) => item.runId === playback.runId);
      if (entry && !entry.result) { entry.result = result; entry.finishedAt = Date.now(); }
    }

    previousHistory() {
      const history = this.playbackHistory;
      const index = history.cursor - 1;
      const entry = history.entries[history.order[index]];
      return entry ? freeze({ ...entry, index }) : null;
    }

    get renderingActive() { return this.pageVisible && this.imagesVisible && !this.pageSuspended; }

    setRenderingState({ pageVisible = this.pageVisible, imagesVisible = this.imagesVisible,
      suspended = this.pageSuspended } = {}) {
      const previous = this.renderingActive;
      this.pageVisible = Boolean(pageVisible);
      this.imagesVisible = Boolean(imagesVisible);
      this.pageSuspended = Boolean(suspended);
      if (previous !== this.renderingActive) {
        (this.playingSong || this.openedSong)?.environment?.onRenderingChanged?.(this.renderingActive);
      }
      this.publish();
    }

    setMotionAllowed(allowed) {
      this.motionAllowed = Boolean(allowed);
      this.scenario.setMotionAllowed?.(this.motionAllowed);
      this.publish();
    }

    snapshot() {
      const selectedSong = this.openedSong || this.playingSong;
      const playback = selectedSong?.playback;
      const identity = selectedSong?.identity || { listId: '', songId: '' };
      const activePlayback = playback && !playback.dead
        && !['ended', 'failed'].includes(playback.state)
        ? playback
        : null;
      const autoStartPending = Boolean(selectedSong?.autoStartScope?.alive);
      return freeze({
        revision: this.revision,
        buildIdentity: copy(window.VCardBuild || null),
        storage: copy(window.VCardStorage?.snapshot?.() || null),
        environment: copy(window.VCardEnvironment?.snapshot?.() || null),
        commandId: this.queue.current?.id || this.queue.last?.id || 0,
        publishedAt: this.publishedAt,
        handlerSet: this.scenario.name,
        scenario: copy(this.scenario.snapshot?.() || null),
        showProfile: copy((playback?.profile || this.lastShowProfile)?.snapshot?.() || null),
        lifeId: this.id,
        phase: this.playbackChain.phase,
        pageVisible: this.pageVisible,
        imagesVisible: this.imagesVisible,
        selectionMode: this.selectionMode ? 'AUTO' : 'MAN',
        trackPlay: window.VCardTrackPlay?.current?.() || null,
        manualSelection: window.VCardManualSelection?.current?.() || null,
        settingsOperations: window.VCardSettingsContext?.operations?.() || null,
        renderingActive: this.renderingActive,
        serviceWorker: window.VCardServiceWorker?.snapshot?.() || null,
        playlist: window.VCardPlaylist?.current?.() || null,
        textScale: window.VCardTextScale?.current?.() || 'm',
        volumeBoost: window.VCardVolumeBoost?.current?.() || null,
        colorScheme: window.VCardColorScheme?.current?.() || null,
        colorSettings: window.VCardDecoration?.current?.() || null,
        background: {
          mode: window.VCardBackgroundControl?.current?.() || null,
          brightness: window.VCardBrightness?.current?.() || null,
        },
        portalLayout: window.VCardPortalLayout?.current?.(window.VCardSongControls?.currentPreview?.()) || null,
        playbackChain: this.playbackChain.snapshot(),
        audio: this.audioChannel.snapshot(),
        playbackHistory: { count: this.playbackHistory.entries.length,
          cursor: this.playbackHistory.cursor, previous: this.previousHistory() },
        autopilotSelection: { candidates: this.autopilotSelector.entries.length,
          remaining: this.autopilotSelector.remaining.length,
          reserved: this.autopilotSelector.reservation?.entry.releaseKey || null },
        selectionMemory: { recent: this.selectionMemory.recent.map((entry) => ({ ...entry,
          source: entry.pageSessionId === this.selectionMemory.pageSessionId ? 'local' : 'remote' })),
          ttlSeconds: SELECTION_MEMORY_TTL,
          lastPlayedAt: this.selectionMemory.lastPlayedAt, epoch: this.selectionMemory.epoch,
          pageSessionId: this.selectionMemory.pageSessionId, resetReason: this.selectionMemory.resetReason },
        invalidReleaseKeys: [...this.autopilotSelector.invalid],
        random: this.random.snapshot(),
        playback: activePlayback?.state || 'idle',
        trackRunId: activePlayback?.runId || 0,
        verseIndex: activePlayback?.verseIndex ?? -1,
        verseNumber: (activePlayback?.verseIndex ?? -1) + 1,
        globalVerseNumber: this.globalVerseCount,
        globalSlideNumber: this.globalSlideCount,
        pageReloadTime: this.pageReloadTime(),
        verseHandler: 'OnVerseStart',
        operation: activePlayback?.operation || (autoStartPending ? 'auto-start' : null),
        listId: identity.listId,
        songId: identity.songId,
        conditions: copy(activePlayback?.plan?.conditions || []),
        effects: copy(activePlayback?.plan?.effects || []),
        portalFrame: copy(activePlayback?.plan?.portalFrame || null),
        pulse: { effects: [], waapi: 0, glow: 0, motion: this.motionAllowed ? 'on' : 'off' },
        clocks: {
          life: this.lifeClock.now(),
          playback: this.playbackClock.now(),
          transition: this.transitionClock.now(),
        },
        commandQueue: { pending: this.queue.pending, closed: this.queue.closed, coalesced: this.queue.coalesced, current: this.queue.current ? {
          id: this.queue.current.id, type: this.queue.current.type, owner: this.queue.current.owner?.id || '',
        } : null, last: this.queue.last, lastError: this.lastError },
        openedSong: this.openedSong?.snapshot() || null,
        playingSong: this.playingSong?.snapshot() || null,
        stats: this.stats?.snapshot() || null,
        decoration: this.decorationProfile?.snapshot?.() || null,
        portal: this.visualWorld.snapshot(),
      });
    }

    publish() {
      if (this.dead || this.queue.closed) return;
      if (this.queue.current) this.dirty = true;
      else this.queue.run(() => { this.dirty = true; },
        { type: 'State.Publish', owner: this, scope: this.scope });
    }

    flushPublication() {
      if (!this.dirty || this.dead || this.queue.closed) return;
      this.dirty = false;
      this.revision += 1;
      this.publishedAt = new Date().toISOString();
      const snapshot = this.snapshot();
      document.dispatchEvent(new CustomEvent('vcard:vcplayer-state', {
        detail: snapshot,
      }));
      document.dispatchEvent(new CustomEvent('vcard:playback-chain-state', {
        detail: freeze({ ...snapshot.playbackChain, revision: snapshot.revision }),
      }));
    }

    reportFault(error, command = {}, kind = 'ComponentFailure', notify = true) {
      if (error?.name === 'AbortError' || this.dead) return;
      const message = String(error?.message || error);
      const owner = command.owner?.id || '';
      const repeated = this.lastError?.kind === kind && this.lastError.message === message && this.lastError.owner === owner;
      this.lastError = freeze({ kind, message, count: repeated ? this.lastError.count + 1 : 1,
        buildIdentity: copy(window.VCardBuild || null),
        commandId: command.id || this.queue.current?.id || 0,
        type: command.type || this.queue.current?.type || 'Runtime.Failure',
        owner, revision: this.revision, at: new Date().toISOString() });
      if (!repeated) console.error('VCLife command failed', JSON.stringify(this.lastError));
      if (notify) this.publish();
    }

    dispose() {
      if (this.dead) return;
      this.queue.close();
      const timer = this.lifeTickTimer;
      this.lifeTickTimer = 0;
      const songs = [...this.songs.values()];
      this.songs.clear();
      let failure = null;
      for (const cleanup of [
        () => super.die('page-died'),
        () => this.audio?.pause(),
        () => { if (timer) window.clearTimeout(timer); },
        () => this.stats?.finish('page-died'),
        ...songs.map((song) => () => song.die('page-died')),
        () => this.audioChannel.dispose(),
        () => this.playbackChain.die('page-died'),
        () => this.decorationProfile?.dispose?.(),
        () => this.scenario.dispose?.(),
      ]) {
        try { cleanup(); }
        catch (error) { failure ||= error; }
      }
      if (failure) console.error('VCLife dispose failed', String(failure?.message || failure));
    }
  }

  window.VCLifeCore = Object.freeze({
    AudioChannel,
    Clock,
    CommandQueue,
    LifeObject,
    Scope,
    TSong,
    TSongEnvironment,
    TSongPlayback,
    TOperation,
    TPlaybackChain,
    TAutopilotSelector,
    TSelectionMemory,
    TShuffleBag,
    TRandomHub,
    TDecorationProfile,
    TVCLife,
    TVCLifeStats,
    TVCLifeStatsStore,
    VisualWorld,
    copy,
    freeze,
    songIdentity,
  });
})();
