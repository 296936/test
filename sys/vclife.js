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

  const songIdentity = (preview) => {
    const item = preview?.previousElementSibling?.querySelector('.song__item[data-song]');
    return item ? {
      listId: String(item.dataset.list || ''),
      songId: String(item.dataset.song || ''),
    } : { listId: '', songId: '' };
  };

  class Scope {
    constructor(owner, parent = null) {
      this.owner = owner;
      this.parent = parent;
      this.controller = new AbortController();
      this.children = new Set();
      this.alive = true;
      parent?.children.add(this);
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
      this.controller.abort(reason);
      Array.from(this.children).forEach((child) => child.die(reason));
      this.children.clear();
      this.parent?.children.delete(this);
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
        let frame = 0;
        const done = () => {
          if (frame) cancelAnimationFrame(frame);
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
          frame = requestAnimationFrame(tick);
        };
        signal?.addEventListener('abort', abort, { once: true });
        frame = requestAnimationFrame(tick);
      });
    }
  }

  class CommandQueue {
    constructor() {
      this.tail = Promise.resolve();
      this.pending = 0;
    }

    post(command) {
      this.pending += 1;
      const run = () => Promise.resolve().then(command);
      const result = this.tail.then(run, run);
      this.tail = result.catch(() => {}).finally(() => {
        this.pending = Math.max(0, this.pending - 1);
      });
      return result;
    }
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

  class AudioChannel {
    constructor(audio, life) {
      this.audio = audio;
      this.life = life;
      this.owner = null;
      this.listeners = [];
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
      bind('seeking', () => this.dispatch('seeking'));
      bind('seeked', () => this.dispatch('seeked'));
      bind('timeupdate', () => this.dispatch('timeupdate'));
      bind('ended', () => this.dispatch('ended'));
      bind('error', () => this.dispatch('error'));
    }

    acquire(playback) {
      if (this.owner && this.owner !== playback) this.owner.replaced();
      this.owner = playback;
    }

    release(playback) {
      if (this.owner === playback) this.owner = null;
    }

    dispatch(eventName) {
      const owner = this.owner;
      if (!owner || owner.dead) return;
      this.life.queue.post(() => {
        if (this.owner === owner && !owner.dead) owner.onAudio(eventName);
      });
    }

    dispose() {
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

  class TSongPlayback extends LifeObject {
    constructor(song, runId, reason) {
      super(song, 'SongPlayback');
      this.song = song;
      this.life = song.life;
      this.audio = this.life.audio;
      this.runId = runId;
      this.reason = reason;
      this.state = 'starting';
      this.verseIndex = -1;
      this.lastNaturalVerseIndex = -1;
      this.plan = null;
      this.operation = null;
      this.operationScope = null;
      this.started = false;
      this.ending = false;
    }

    beginOperation(name) {
      this.operationScope?.die('operation-replaced');
      this.operationScope = this.scope.child({ id: `${this.id}:${name}` });
      this.operation = name;
      return this.operationScope;
    }

    cancelOperation(reason = 'operation-cancelled') {
      this.operationScope?.die(reason);
      this.operationScope = null;
      this.operation = null;
    }

    start() {
      if (this.dead || !this.audio) return Promise.resolve(false);
      this.life.audioChannel.acquire(this);
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
      return Promise.resolve(playRequest).then(() => this.life.queue.post(() => {
        if (this.dead) return false;
        this.started = true;
        this.state = 'playing';
        this.song.environment.onPlaying(this);
        const pending = this.pendingVerseDetail;
        this.pendingVerseDetail = null;
        if (pending) this.verse(pending);
        this.life.publish();
        return true;
      })).catch((error) => {
        if (!this.dead) this.life.queue.post(() => this.failed(error));
        console.warn('VCLife cannot start audio', error);
        return false;
      });
    }

    resume() {
      if (this.dead || !this.audio) return Promise.resolve(false);
      this.song.environment.onResume(this);
      let request;
      try {
        request = this.audio.play();
      } catch (error) {
        this.failed(error);
        return Promise.reject(error);
      }
      return Promise.resolve(request).catch((error) => {
        if (!this.dead) this.life.queue.post(() => this.failed(error));
        console.warn('VCLife cannot resume audio', error);
        return false;
      });
    }

    pause() {
      if (this.dead || !this.audio || this.audio.paused) return;
      this.audio.pause();
    }

    verse(detail = {}) {
      if (this.dead || detail.preview !== this.song.preview) return;
      const index = Number.isInteger(detail.index) ? detail.index : -1;
      if (index < 0) return;
      if (!this.started) {
        this.pendingVerseDetail = detail;
        return;
      }
      if (index === this.verseIndex && !detail.seeked) return;
      const natural = !detail.seeked;
      if (natural && index !== this.lastNaturalVerseIndex) {
        this.life.globalVerseCount += 1;
        this.lastNaturalVerseIndex = index;
      }
      this.verseIndex = index;
      this.plan = this.life.scenario.planVerse(this, detail, this.life.globalVerseCount);
      this.song.environment.onVerse(this, detail, this.plan);
      this.life.publish();
    }

    preEnd(detail = {}) {
      if (this.dead || detail.preview !== this.song.preview) return;
      this.song.environment.onVersePreEnd(this, detail, this.plan);
    }

    onAudio(eventName) {
      if (this.dead) return;
      if (eventName === 'playing') {
        this.state = 'playing';
        this.song.environment.onPlaying(this);
      } else if (eventName === 'pause') {
        this.state = 'paused';
        this.song.environment.onPause(this);
      } else if (eventName === 'waiting') {
        this.state = 'waiting';
        this.song.environment.onWaiting(this);
      } else if (eventName === 'seeking') {
        this.cancelOperation('seek');
        this.song.environment.onSeek(this);
      } else if (eventName === 'seeked') {
        this.song.environment.onSeeked(this);
      } else if (eventName === 'timeupdate') {
        this.song.environment.onTick(this);
      } else if (eventName === 'ended') {
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
      const operation = this.beginOperation('song-end');
      this.song.environment.onEnd(this, operation.signal).then(() => this.life.queue.post(() => {
        if (this.dead || !operation.alive) return;
        this.operation = null;
        this.state = 'ended';
        this.song.environment.onEnded(this);
        this.life.publish();
        this.life.completeHandler?.({ preview: this.song.preview, trackRunId: this.runId });
      })).catch((error) => {
        if (error?.name !== 'AbortError') console.error('VCLife song ending failed', error);
      });
    }

    failed(error) {
      this.state = 'failed';
      this.song.environment.onFailed(this, error);
      this.life.publish();
    }

    replaced() {
      this.die('playback-replaced');
    }

    die(reason = 'playback-died') {
      if (this.dead) return;
      this.cancelOperation(reason);
      this.life.audioChannel.release(this);
      super.die(reason);
    }

    snapshot() {
      return {
        ...super.snapshot(),
        runId: this.runId,
        state: this.state,
        verseIndex: this.verseIndex,
        operation: this.operation,
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
    }

    close() {
      this.opened = false;
      this.cancelAutoStart('song-closed');
      if (this.playback?.ending) {
        this.playback.cancelOperation('song-closed');
        this.playback.ending = false;
        this.playback.state = 'ended';
      }
      this.environment.onClose({ current: this.life.playingSong === this });
    }

    scheduleAutoStart(delay, start) {
      this.cancelAutoStart('auto-start-replaced');
      const scope = this.scope.child({ id: `${this.id}:auto-start` });
      this.autoStartScope = scope;
      this.life.publish();
      return this.life.transitionClock.wait(delay, scope.signal).then(() => {
        if (!scope.alive || !this.opened || this.autoStartScope !== scope) return false;
        this.autoStartScope = null;
        scope.die('auto-start-complete');
        return start();
      }).catch((error) => {
        if (error?.name !== 'AbortError') throw error;
        return false;
      });
    }

    cancelAutoStart(reason = 'auto-start-cancelled') {
      this.autoStartScope?.die(reason);
      this.autoStartScope = null;
    }

    start(reason) {
      this.cancelAutoStart('play-started');
      this.playback?.die('new-playback');
      this.playback = new TSongPlayback(this, this.life.nextRunId++, reason);
      return this.playback.start();
    }

    die(reason = 'song-died') {
      if (this.dead) return;
      this.cancelAutoStart(reason);
      this.playback?.die(reason);
      this.environment?.die(reason);
      super.die(reason);
    }

    snapshot() {
      return {
        ...super.snapshot(),
        ...this.identity,
        opened: this.opened,
        autoStartPending: Boolean(this.autoStartScope?.alive),
        environment: this.environment?.snapshot?.() || null,
        playback: this.playback?.snapshot?.() || null,
      };
    }
  }

  class TVCLife extends LifeObject {
    constructor({ config, audio, scenario }) {
      super(null, 'VCLife');
      this.config = config;
      this.audio = audio;
      this.scenario = scenario;
      this.scenario.life = this;
      this.queue = new CommandQueue();
      this.lifeClock = new Clock('LifeClock', () => performance.now() / 1000);
      this.playbackClock = new Clock('PlaybackClock', () => this.audio?.currentTime || 0);
      this.transitionClock = new Clock('TransitionClock', () => performance.now() / 1000);
      this.visualWorld = new VisualWorld(() => window.VCardPortal);
      this.audioChannel = new AudioChannel(audio, this);
      this.songs = new Map();
      this.openedSong = null;
      this.playingSong = null;
      this.nextRunId = 1;
      this.globalVerseCount = 0;
      this.completeHandler = null;
      this.motionAllowed = document.documentElement.dataset.visBri !== '0';
      this.scenario.onPageReload(this);
      this.publish();
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
      song.open({
        current: this.playingSong === song
          && Boolean(song.playback && !song.playback.dead)
          && !['ended', 'failed'].includes(song.playback.state),
      });
      this.publish();
      return true;
    }

    close(preview) {
      const song = this.songs.get(preview);
      if (!song) return;
      song.close();
      if (this.openedSong === song) this.openedSong = null;
      this.publish();
    }

    start(preview, { reason = 'click', autoReady = false } = {}) {
      const song = this.songFor(preview);
      if (!song) return Promise.resolve(false);
      if (!song.opened) this.open(preview);
      if (reason === 'auto' && !autoReady) {
        const delay = Math.max(0, Number(this.config.settings?.autostartdelay) || 0);
        if (delay > 0) {
          return song.scheduleAutoStart(delay, () => this.start(preview, {
            reason: 'auto', autoReady: true,
          }));
        }
      }
      song.cancelAutoStart('manual-or-ready-start');
      if (this.playingSong && this.playingSong !== song) {
        this.playingSong.playback?.die('another-song-started');
      }
      this.playingSong = song;
      const request = song.start(reason);
      this.publish();
      return request;
    }

    toggle(preview) {
      const song = this.songFor(preview);
      const playback = song?.playback;
      if (song === this.playingSong && playback && !playback.dead && !this.audio?.ended) {
        return this.audio?.paused ? playback.resume() : playback.pause();
      }
      return this.start(preview, { reason: 'click' });
    }

    resume() {
      this.playingSong?.cancelAutoStart('manual-resume');
      return this.playingSong?.playback?.resume();
    }

    pause() {
      this.playingSong?.cancelAutoStart('manual-pause');
      return this.playingSong?.playback?.pause();
    }

    verse(detail) {
      this.playingSong?.playback?.verse(detail);
    }

    preEnd(detail) {
      this.playingSong?.playback?.preEnd(detail);
    }

    setCompleteHandler(handler) {
      this.completeHandler = typeof handler === 'function' ? handler : null;
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
        handlerSet: this.scenario.name,
        lifeId: this.id,
        phase: autoStartPending
          ? 'auto-wait'
          : (activePlayback?.state || (this.openedSong ? 'ready' : 'closed')),
        playback: activePlayback?.state || 'idle',
        trackRunId: activePlayback?.runId || 0,
        verseIndex: activePlayback?.verseIndex ?? -1,
        verseNumber: (activePlayback?.verseIndex ?? -1) + 1,
        globalVerseNumber: this.globalVerseCount,
        verseHandler: 'OnVerseStart',
        operation: activePlayback?.operation || (autoStartPending ? 'auto-start' : null),
        listId: identity.listId,
        songId: identity.songId,
        conditions: [],
        effects: copy(activePlayback?.plan?.effects || []),
        portalFrame: copy(activePlayback?.plan?.portalFrame || null),
        pulse: { effects: [], waapi: 0, glow: 0, motion: this.motionAllowed ? 'on' : 'off' },
        clocks: {
          life: this.lifeClock.now(),
          playback: this.playbackClock.now(),
          transition: this.transitionClock.now(),
        },
        commandQueue: { pending: this.queue.pending },
        openedSong: this.openedSong?.snapshot() || null,
        playingSong: this.playingSong?.snapshot() || null,
        portal: this.visualWorld.snapshot(),
      });
    }

    publish() {
      document.dispatchEvent(new CustomEvent('vcard:vcplayer-state', {
        detail: this.snapshot(),
      }));
    }

    dispose() {
      if (this.dead) return;
      this.songs.forEach((song) => song.die('page-died'));
      this.songs.clear();
      this.audioChannel.dispose();
      this.scenario.dispose?.();
      super.die('page-died');
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
    TVCLife,
    VisualWorld,
    copy,
    freeze,
    songIdentity,
  });
})();
