(() => {
  'use strict';

  const config = window.VCardUI?.vcPlayer;
  if (!config || config.format !== 'aliswb-vcplayer-5') return;
  const selectHandlerSet = (program) => {
    let selected = '';
    const run = (nodes) => {
      (nodes || []).forEach((node) => {
        if (node.type === 'if' && node.condition?.function === 'Chance') {
          const percent = Number(node.condition.arguments?.[0]) || 0;
          run(Math.random() * 100 < percent ? node.then : node.else);
        } else if (node.type === 'vcpSet') {
          selected = String(node.name || '');
        }
      });
    };
    run(program);
    return selected;
  };
  const handlerSet = selectHandlerSet(config.onPageReload);
  const selectedHandlers = handlerSet
    ? config.handlerSets?.[handlerSet]
    : config.handlers;
  if (!selectedHandlers) {
    console.error(`VCPlayer: unknown handler set ${handlerSet}`);
    return;
  }
  const activeConfig = { ...config, handlers: selectedHandlers, activeHandlerSet: handlerSet };

  const root = document.documentElement;
  const audio = document.querySelector('audio[data-shared-player="true"]');
  const copy = (value) => JSON.parse(JSON.stringify(value));
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

  const registerPulseProperties = () => {
    if (!window.CSS?.registerProperty) return;
    [
      ['--vc-pulse-image-brightness', '1'],
      ['--vc-pulse-image-contrast', '1'],
      ['--vc-pulse-mask-brightness', '1'],
      ['--vc-pulse-mask-opacity', '1'],
    ].forEach(([name, initialValue]) => {
      try {
        CSS.registerProperty({ name, syntax: '<number>', inherits: true, initialValue });
      } catch (_error) { }
    });
    try {
      CSS.registerProperty({
        name: '--vc-pulse-verse-color',
        syntax: '<percentage>',
        inherits: false,
        initialValue: '0%',
      });
    } catch (_error) { }
  };

  class VersePlanner {
    constructor(settings) {
      this.settings = settings || {};
      this.globalVerseNumber = 0;
      this.lastGlobalVerseKey = '';
    }

    conditionValue(condition, verseNumber, context = {}) {
      const functionName = String(condition?.function || '');
      if (functionName === 'Variable') {
        const actual = String(condition.name || '').startsWith('Settings.')
          ? this.settings.settings?.[String(condition.name).slice(9)]
          : context[condition.name];
        if (condition.operator === 'not') return !actual;
        if (condition.operator === 'truthy') return Boolean(actual);
        if (condition.operator === '==') return actual === condition.value;
        if (condition.operator === '!=') return actual !== condition.value;
        if (condition.operator === '>') return actual > condition.value;
        if (condition.operator === '<') return actual < condition.value;
        if (condition.operator === '>=') return actual >= condition.value;
        if (condition.operator === '<=') return actual <= condition.value;
        return false;
      }
      const number = Math.max(1, Number(condition?.arguments?.[0]) || 1);
      if (functionName === 'AfterVerseN') return verseNumber === number;
      if (functionName === 'EveryNthVerse') return verseNumber > 0 && verseNumber % number === 0;
      if (functionName === 'EveryNthGlobVerse') {
        const globalVerseNumber = Number(context.globalVerseNumber) || 0;
        return globalVerseNumber > 0 && globalVerseNumber % number === 0;
      }
      return false;
    }

    evaluate(program, verseNumber, output, conditions = [], context = {}) {
      (program || []).forEach((node) => {
        if (node.type === 'if') {
          const active = this.conditionValue(node.condition, verseNumber, context);
          output.conditions.push({ ...copy(node.condition), active });
          this.evaluate(
            active ? node.then : node.else,
            verseNumber,
            output,
            [...conditions, { ...node.condition, active }],
            context
          );
        } else if (node.type === 'pulseEffect' && node.binding) {
          output.bindings.push(copy(node.binding));
        } else if (node.type === 'portalFrame' && node.frame) {
          output.portalFrame = copy(node.frame);
          output.commands.push(copy(node));
        } else if (node.type === 'effect' && node.effect) {
          output.effects.push({
            ...copy(node.effect),
            conditions: conditions.map((condition) => condition.label),
          });
          output.commands.push(copy(node));
        } else if (node.type === 'wait') {
          output.commands.push(copy(node));
        }
      });
    }

    handler(name, context = {}) {
      const output = {
        conditions: [], bindings: [], portalFrame: null, effects: [], commands: [],
      };
      this.evaluate(
        this.settings.handlers?.[name] || [],
        Number(context.verse) || 0,
        output,
        [],
        context
      );
      return output;
    }

    plan(detail = {}) {
      const index = Number.isInteger(detail.index) ? detail.index : -1;
      const globalVerseKey = index >= 0
        ? `${Number(detail.trackRunId) || 0}:${index}`
        : '';
      if (globalVerseKey && globalVerseKey !== this.lastGlobalVerseKey) {
        this.globalVerseNumber += 1;
        this.lastGlobalVerseKey = globalVerseKey;
      }
      const globalVerseNumber = this.globalVerseNumber;
      const output = {
        preview: detail.preview || null,
        index,
        globalVerseNumber,
        seeked: Boolean(detail.seeked),
        startsAt: Number.isFinite(Number(detail.startsAt)) ? Number(detail.startsAt) : null,
        endsAt: Number.isFinite(Number(detail.endsAt)) ? Number(detail.endsAt) : null,
        verseHandler: 'OnVerseStart',
        portalFrame: null,
        bindings: [],
        effects: [],
        conditions: [],
        commands: [],
      };
      if (index >= 0) this.evaluate(
        this.settings.handlers?.OnVerseStart || [], index + 1, output, [], {
          songId: songIdentity(detail.preview).songId,
          trackRunId: Number(detail.trackRunId) || 0,
          verse: index + 1,
          globalVerseNumber,
          startsAt: Number(detail.startsAt) || 0,
          endsAt: Number(detail.endsAt) || 0,
          reason: detail.seeked ? 'seek' : 'boundary',
        }
      );
      return output;
    }
  }

  class PulseRuntime {
    constructor(settings, sharedAudio) {
      this.settings = settings || {};
      this.audio = sharedAudio;
      this.animations = [];
      this.glows = [];
      this.currentVerse = null;
      this.currentBindings = [];
      this.motionAllowed = root.dataset.visBri !== '0';
      registerPulseProperties();
    }

    source(name) {
      const entries = Object.entries(this.settings.pulseSources || {});
      return entries.find(([key]) => key.toLowerCase() === String(name || '').toLowerCase())?.[1] || null;
    }

    progressFrames(source, duration) {
      const hold = Math.max(0, Math.min(0.95, Number(source.peakHold || 0) / Math.max(duration, 0.001)));
      if (source.shape === 'rise') {
        return [{ offset: 0, value: 0 }, { offset: 1 - hold, value: 1 }, { offset: 1, value: 1 }];
      }
      if (source.shape === 'fall') {
        return [{ offset: 0, value: 1 }, { offset: hold, value: 1 }, { offset: 1, value: 0 }];
      }
      return [
        { offset: 0, value: 0 },
        { offset: Math.max(0, 0.5 - hold / 2), value: 1 },
        { offset: Math.min(1, 0.5 + hold / 2), value: 1 },
        { offset: 1, value: 0 },
      ];
    }

    durationFor(source, detail) {
      if (source.period !== 'verse') return Math.max(0.001, Number(source.period) || 2.4);
      return Math.max(0.001, Number(detail.endsAt) - Number(detail.startsAt));
    }

    mappedFrames(source, binding, duration, mapper) {
      const values = Array.isArray(binding.values) && binding.values.length > 1
        ? binding.values.map((value) => Number(value) || 0)
        : [Number(binding.min) || 0, Number(binding.max) || 0];
      if (binding.curve === 'mirror-steps' || binding.curve === 'steps') {
        const sequence = binding.curve === 'mirror-steps'
          ? [...values, ...values.slice().reverse()]
          : values;
        return sequence.map((value, index) => ({
          offset: sequence.length === 1 ? 1 : index / (sequence.length - 1),
          easing: 'steps(1, end)',
          ...mapper(value),
        }));
      }
      const minimum = values[0];
      const maximum = values.at(-1);
      return this.progressFrames(source, duration).map(({ value, ...frame }) => ({
        ...frame,
        ...mapper(minimum + (maximum - minimum) * value),
      }));
    }

    target(binding, detail) {
      if (binding.target === 'verse') return detail.verse || null;
      const image = detail.preview?.querySelector('.song__preview-image');
      const layer = image?.closest('.vcard-portal-motion-layer');
      if (binding.target === 'portal.image') return image || null;
      return layer?.querySelector(':scope > .vcard-portal-mask-overlay.is-ready') || null;
    }

    glowTarget(mask) {
      if (!(mask instanceof HTMLCanvasElement) || !mask.width || !mask.height) return null;
      const glow = document.createElement('canvas');
      glow.className = 'vcard-portal-mask-glow';
      glow.width = mask.width;
      glow.height = mask.height;
      glow.style.setProperty('--vc-pulse-mask-glow-radius', '14px');
      glow.getContext('2d')?.drawImage(mask, 0, 0);
      mask.parentNode?.insertBefore(glow, mask);
      this.glows.push(glow);
      return glow;
    }

    startBinding(binding, detail) {
      const source = this.source(binding.source);
      let target = this.target(binding, detail);
      if (!source || !target || !this.motionAllowed) return;
      const duration = this.durationFor(source, detail);
      let frames;
      if (binding.target === 'portal.mask' && binding.property === 'glow') {
        target = this.glowTarget(target);
        if (!target) return;
        frames = this.mappedFrames(source, binding, duration, (value) => ({
          opacity: Math.max(0, Math.min(1, value / 10)),
        }));
      } else if (binding.target === 'portal.image' && binding.property === 'glow') {
        target = target.closest('.vcard-portal-motion-layer') || target;
        frames = this.mappedFrames(source, binding, duration, (value) => ({
          filter: `drop-shadow(0 0 ${Math.max(0, value)}px var(--vc-acc))`,
        }));
      } else if (binding.target === 'verse' && binding.property === 'color') {
        frames = this.mappedFrames(source, binding, duration, (value) => ({
          '--vc-pulse-verse-color': `${Math.max(0, Math.min(1, value)) * 100}%`,
        }));
      } else if (binding.target === 'verse' && binding.property === 'weight') {
        frames = this.mappedFrames(source, binding, duration, (value) => ({
          fontWeight: String(400 + 600 * Math.max(0, Math.min(1, value))),
          WebkitTextStrokeWidth: `${0.045 * Math.max(0, Math.min(1, value))}em`,
        }));
      } else if (binding.target === 'verse' && binding.property === 'glow') {
        frames = this.mappedFrames(source, binding, duration, (value) => ({
          textShadow: `0 0 ${Math.max(0, value)}px currentColor`,
        }));
      } else if (binding.target === 'verse') {
        frames = this.mappedFrames(source, binding, duration, (value) => ({
          filter: `brightness(${value})`,
        }));
      } else {
        const property = binding.target === 'portal.image'
          ? (binding.property === 'contrast'
            ? '--vc-pulse-image-contrast'
            : '--vc-pulse-image-brightness')
          : (binding.property === 'opacity'
            ? '--vc-pulse-mask-opacity'
            : '--vc-pulse-mask-brightness');
        frames = this.mappedFrames(source, binding, duration, (value) => ({ [property]: String(value) }));
      }
      const animation = target.animate(frames, {
        duration: duration * 1000,
        iterations: source.period === 'verse' ? 1 : Infinity,
        easing: binding.curve === 'smooth' ? 'ease-in-out' : 'linear',
        fill: 'both',
      });
      // Every verse begins at its own minimum. No phase is restored.
      animation.currentTime = 0;
      if (this.audio?.paused) animation.pause();
      this.animations.push({ animation, binding, target });
    }

    start(detail, bindings) {
      this.disposeVerse();
      this.currentVerse = detail || null;
      this.currentBindings = Array.isArray(bindings) ? bindings : [];
      if (!detail || !this.motionAllowed) return;
      this.currentBindings.forEach((binding) => this.startBinding(binding, detail));
    }

    pause() {
      this.animations.forEach(({ animation }) => animation.pause());
    }

    resume() {
      if (!this.motionAllowed) return;
      this.animations.forEach(({ animation }) => animation.play());
    }

    clearAnimations() {
      this.animations.splice(0).forEach(({ animation }) => animation.cancel());
      this.glows.splice(0).forEach((glow) => glow.remove());
    }

    setMotionAllowed(allowed) {
      this.motionAllowed = Boolean(allowed);
      if (!this.motionAllowed) this.clearAnimations();
      else if (this.currentVerse) this.start(this.currentVerse, this.currentBindings);
    }

    diagnostics() {
      const effects = this.currentBindings.map((binding) => {
        const active = this.animations.find((entry) => entry.binding === binding);
        const target = this.currentVerse ? this.target(binding, this.currentVerse) : null;
        let status = 'idle';
        if (this.currentVerse && !this.motionAllowed) status = 'motion-off';
        else if (this.currentVerse && !target) status = 'no-target';
        else if (active?.animation.playState === 'paused') status = 'paused';
        else if (active && !['idle', 'finished'].includes(active.animation.playState)) status = 'running';
        return {
          source: binding.source,
          target: binding.target,
          property: binding.property,
          status,
        };
      });
      return {
        effects,
        waapi: this.animations.filter(({ animation }) => animation.playState !== 'idle').length,
        glow: this.glows.length,
        motion: this.motionAllowed ? 'on' : 'off',
      };
    }

    disposeVerse() {
      this.currentVerse = null;
      this.currentBindings = [];
      this.clearAnimations();
    }

    dispose() {
      this.disposeVerse();
    }
  }

  class VCPlayer {
    constructor(settings, sharedAudio) {
      this.settings = settings || {};
      this.audio = sharedAudio;
      this.planner = new VersePlanner(settings);
      this.pulse = new PulseRuntime(settings, sharedAudio);
      this.preview = null;
      this.phase = 'closed';
      this.playback = 'idle';
      this.trackRunId = 0;
      this.verseIndex = -1;
      this.plan = null;
      this.operation = 'idle';
      this.epoch = 0;
      this.abortController = null;
      this.completeHandler = null;
      this.openPreview = null;
      this.pendingStart = 0;
      this.startReady = false;
      this.pendingVerseDetail = null;
      this.openCommands = [];
      this.startCommands = [];
      this.idleCommands = [];
      this.bindAudio();
    }

    portal() {
      return window.VCardPortal || null;
    }

    cancelOperation() {
      this.epoch += 1;
      this.abortController?.abort();
      this.abortController = null;
      this.operation = 'idle';
    }

    beginOperation(name, runner) {
      this.cancelOperation();
      const epoch = this.epoch;
      const controller = new AbortController();
      this.abortController = controller;
      this.operation = name;
      this.publish();
      const complete = () => {
        if (epoch !== this.epoch || this.abortController !== controller) return;
        this.abortController = null;
        this.operation = 'idle';
        this.publish();
      };
      try {
        return Promise.resolve(runner(controller.signal, epoch)).then((value) => {
          complete();
          return value;
        }, (error) => {
          if (!controller.signal.aborted) console.warn(`VCPlayer ${name} failed`, error);
          complete();
          return false;
        });
      } catch (error) {
        if (!controller.signal.aborted) console.warn(`VCPlayer ${name} failed`, error);
        complete();
        return Promise.resolve(false);
      }
    }

    wait(seconds, signal) {
      return new Promise((resolve) => {
        if (signal.aborted) {
          resolve(false);
          return;
        }
        const onAbort = () => {
          window.clearTimeout(timer);
          resolve(false);
        };
        const timer = window.setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve(true);
        }, Math.max(0, Number(seconds) || 0) * 1000);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }

    async runCommands(commands, context = {}, signal = null) {
      for (const command of commands || []) {
        if (signal?.aborted) return false;
        if (command.type === 'wait') {
          if (!signal || !await this.wait(command.duration, signal)) return false;
        } else if (command.type === 'effect' && command.effect?.name === 'Cassette') {
          this.portal()?.showCassette?.(command.effect);
        } else if (command.type === 'portalFrame') {
          const ready = await (this.portal()?.showFrame?.(
            context.preview || this.preview, command.frame, signal
          ) ?? false);
          if (!ready) return false;
        }
      }
      return !signal?.aborted;
    }

    runHandler(name, context = {}, signal = null) {
      const commands = this.planner.handler(name, context).commands;
      if (name === 'OnSongOpen' && !context.isCurrentSong) this.openCommands = commands;
      if (name === 'OnSongStart') this.startCommands = commands;
      return this.runCommands(commands, context, signal);
    }

    open(preview) {
      if (!preview) return false;
      this.openPreview = preview;
      if (preview === this.preview && this.trackRunId && !this.audio?.ended) {
        this.runHandler('OnSongOpen', {
          preview,
          songId: songIdentity(preview).songId,
          trackRunId: this.trackRunId,
          isCurrentSong: true,
          isPlaying: !this.audio.paused,
          isPaused: this.audio.paused,
        });
        this.publish();
        return true;
      }
      if (preview !== this.preview && this.trackRunId && !this.audio?.ended) {
        // A different card may be inspected while the shared audio keeps
        // playing its original song. This idle surface owns no audio state.
        this.idleCommands = this.planner.handler('OnSongOpen', {
          preview,
          songId: songIdentity(preview).songId,
          trackRunId: 0,
          isCurrentSong: false,
          isPlaying: false,
          isPaused: true,
        }).commands;
        this.portal()?.openIdle?.(preview, this.idleCommands);
        this.publish();
        return true;
      }
      this.cancelOperation();
      this.phase = 'opening';
      this.pulse.dispose();
      this.preview = preview;
      this.playback = 'idle';
      this.trackRunId = 0;
      this.startReady = false;
      this.pendingVerseDetail = null;
      this.openCommands = [];
      this.startCommands = [];
      this.verseIndex = -1;
      this.plan = null;
      this.portal()?.open?.(preview);
      this.beginOperation('open', (signal) => this.runHandler(
        'OnSongOpen', {
          preview,
          songId: songIdentity(preview).songId,
          trackRunId: this.trackRunId,
          isCurrentSong: false,
          isPlaying: false,
          isPaused: true,
        }, signal
      ));
      this.phase = 'ready';
      this.publish();
      return true;
    }

    close(preview = this.preview) {
      if (!preview || preview !== this.openPreview) return false;
      if (preview === this.preview && this.operation === 'auto-start-delay') {
        this.cancelOperation();
        this.phase = 'ready';
        this.playback = 'idle';
      }
      if (preview !== this.preview) {
        this.portal()?.closeIdle?.(preview);
        this.idleCommands = [];
      }
      this.openPreview = null;
      // A collapsed preview is not the end of the background track.
      this.publish();
      return true;
    }

    start(preview = this.preview, options = {}) {
      if (!preview || !this.audio) return Promise.resolve(false);
      const reason = String(options.reason || 'click');
      if (preview !== this.preview) {
        const idleCommands = this.idleCommands;
        this.portal()?.closeIdle?.(preview);
        this.cancelOperation();
        this.pulse.dispose();
        this.portal()?.close?.(this.preview);
        this.preview = preview;
        this.portal()?.open?.(preview);
        this.openCommands = idleCommands;
        this.idleCommands = [];
        this.runCommands(idleCommands, { preview });
      }
      this.openPreview = preview;
      const autoStartDelay = Math.max(
        0,
        Number(this.settings.settings?.autostartdelay) || 0
      );
      if (reason === 'auto' && autoStartDelay > 0 && !options.autoDelayComplete) {
        this.phase = 'auto-wait';
        this.playback = 'idle';
        this.publish();
        return this.beginOperation('auto-start-delay', async (signal) => {
          if (!await this.wait(autoStartDelay, signal)) return false;
          return (
            !signal.aborted
            && preview === this.preview
            && preview === this.openPreview
          );
        }).then((ready) => {
          if (!ready) return false;
          return this.start(preview, { ...options, autoDelayComplete: true });
        });
      }
      this.cancelOperation();
      this.trackRunId += 1;
      this.startReady = false;
      this.pendingVerseDetail = null;
      this.startCommands = [];
      this.verseIndex = -1;
      this.plan = null;
      this.phase = 'starting';
      this.playback = 'starting';
      this.pulse.dispose();
      this.portal()?.start?.(preview);
      this.publish();
      const startToken = ++this.pendingStart;
      // Must remain in the trusted click call stack.
      let request;
      try {
        request = this.audio.play();
      } catch (error) {
        this.pendingVerseDetail = null;
        this.phase = 'ready';
        this.playback = 'failed';
        this.portal()?.failed?.();
        this.publish();
        return Promise.resolve(false);
      }
      const onStarted = async () => {
        if (startToken !== this.pendingStart || preview !== this.preview) return false;
        const ready = await this.beginOperation('start', (signal) => this.runHandler('OnSongStart', {
          preview,
          songId: songIdentity(preview).songId,
          trackRunId: this.trackRunId,
          reason,
        }, signal));
        if (!ready || startToken !== this.pendingStart || preview !== this.preview) return false;
        this.startReady = true;
        const pending = this.pendingVerseDetail;
        this.pendingVerseDetail = null;
        if (pending) this.verse(pending);
        return true;
      };
      if (!request?.catch) return onStarted();
      return request.then(onStarted).catch((error) => {
        if (startToken !== this.pendingStart || preview !== this.preview) return false;
        this.pendingVerseDetail = null;
        this.phase = 'ready';
        this.playback = 'failed';
        this.portal()?.failed?.();
        this.publish();
        console.warn('VCPlayer cannot start audio', error);
        return false;
      });
    }

    resume() {
      if (!this.preview || !this.audio) return Promise.resolve(false);
      if (!this.trackRunId || this.audio.ended) return this.start(this.preview);
      this.phase = 'starting';
      this.playback = 'starting';
      this.portal()?.resume?.();
      this.publish();
      const request = this.audio.play();
      return request?.then ? request.then(() => true).catch(() => false) : Promise.resolve(true);
    }

    pause() {
      if (!this.preview || !this.audio) return;
      if (!this.audio.paused) this.audio.pause();
      this.applyPause();
    }

    applyPause() {
      if (!this.preview || !['starting', 'cassette-playing', 'verse-playing', 'waiting'].includes(this.phase)) {
        return;
      }
      this.phase = 'paused';
      this.playback = 'paused';
      this.pulse.pause();
      this.portal()?.pause?.();
      this.publish();
    }

    toggle(preview = this.preview) {
      if (!preview || !this.audio) return;
      if (preview !== this.preview) {
        this.start(preview);
        return;
      }
      if (!this.audio.paused && !this.audio.ended) this.pause();
      else if (this.trackRunId && !this.audio.ended) this.resume();
      else this.start(preview);
    }

    verse(detail = {}) {
      if (!this.trackRunId || detail.preview !== this.preview) return;
      if (!this.startReady) {
        this.pendingVerseDetail = detail;
        return;
      }
      const index = Number.isInteger(detail.index) ? detail.index : -1;
      if (index < 0) return;
      if (index === this.verseIndex && !detail.seeked) return;
      const plan = this.planner.plan({ ...detail, trackRunId: this.trackRunId });
      if (
        index === 0
        && plan.portalFrame
        && this.openCommands.some((command) => command.type === 'portalFrame')
        && !this.startCommands.some((command) => (
          command.type === 'effect' && command.effect?.name === 'Cassette'
        ))
      ) plan.portalFrame.keepPhysicalIndex = true;
      this.verseIndex = index;
      this.plan = plan;
      this.beginOperation('verse', async (signal, epoch) => {
        this.pulse.disposeVerse();
        const ready = await (this.portal()?.applyVerse?.(plan, signal) ?? true);
        if (!ready || signal.aborted || epoch !== this.epoch || detail.preview !== this.preview) return;
        this.pulse.start(detail, plan.bindings);
        this.phase = this.audio?.paused ? 'paused' : 'verse-playing';
        this.playback = this.audio?.paused ? 'paused' : 'playing';
        this.publish();
      });
    }

    preEnd(detail = {}) {
      if (!this.plan || detail.preview !== this.preview || detail.index !== this.verseIndex) return;
      this.portal()?.preEnd?.(detail, this.plan);
    }

    seek() {
      if (!this.trackRunId || !this.preview) return;
      this.cancelOperation();
      this.pulse.disposeVerse();
      this.verseIndex = -1;
      this.plan = null;
      this.phase = 'seeking';
      this.portal()?.seek?.();
      this.publish();
    }

    seeked() {
      if (!this.trackRunId || !this.preview) return;
      this.portal()?.seeked?.();
      const text = this.preview.querySelector('.song__preview-text[data-track-band]');
      const first = String(text?.dataset.trackBand || '').split('-').map((value) => {
        const parts = value.trim().split(':').map(Number);
        return parts.some((part) => !Number.isFinite(part))
          ? NaN
          : parts.reduce((total, part) => total * 60 + part, 0);
      }).find(Number.isFinite);
      if (Number.isFinite(first) && Number(this.audio?.currentTime) < first) {
        const commands = this.audio.paused
          ? this.openCommands : this.startCommands;
        this.beginOperation('restore-start', (signal) => this.runCommands(
          commands,
          { preview: this.preview },
          signal
        ));
        this.phase = this.audio.paused ? 'paused' : 'cassette-playing';
        this.publish();
      }
    }

    async end() {
      if (!this.trackRunId || !this.preview || this.phase === 'ending') return;
      const preview = this.preview;
      const runId = this.trackRunId;
      this.phase = 'ending';
      this.playback = 'ended';
      this.pulse.dispose();
      this.beginOperation('finish', async (signal) => {
        if (!await this.runHandler('OnSongEnd', {
          preview, songId: songIdentity(preview).songId, trackRunId: runId,
        }, signal)) return;
        if (signal.aborted || preview !== this.preview || runId !== this.trackRunId) return;
        this.phase = 'ended';
        this.publish();
        this.completeHandler?.({ preview, trackRunId: runId });
      });
    }

    playing() {
      if (!this.preview || !this.trackRunId) return;
      this.playback = 'playing';
      this.phase = this.verseIndex >= 0 ? 'verse-playing' : 'cassette-playing';
      this.portal()?.playing?.();
      this.pulse.resume();
      this.publish();
    }

    waiting() {
      if (!this.preview || !this.trackRunId) return;
      this.playback = 'waiting';
      this.phase = 'waiting';
      this.pulse.pause();
      this.portal()?.waiting?.();
      this.publish();
    }

    failed() {
      if (!this.preview) return;
      this.playback = 'failed';
      this.phase = 'ready';
      this.pulse.pause();
      this.portal()?.failed?.();
      this.publish();
    }

    setCompleteHandler(handler) {
      this.completeHandler = typeof handler === 'function' ? handler : null;
    }

    setMotionAllowed(allowed) {
      this.pulse.setMotionAllowed(allowed);
      this.portal()?.setMotionAllowed?.(allowed);
      this.publish();
    }

    snapshot() {
      const identity = songIdentity(this.preview);
      return freeze({
        handlerSet: this.settings.activeHandlerSet || '',
        phase: this.phase,
        playback: this.playback,
        trackRunId: this.trackRunId,
        verseIndex: this.verseIndex,
        verseNumber: this.verseIndex >= 0 ? this.verseIndex + 1 : 0,
        globalVerseNumber: this.planner.globalVerseNumber,
        verseHandler: String(this.plan?.verseHandler || 'OnVerseStart'),
        operation: this.operation,
        listId: identity.listId,
        songId: identity.songId,
        conditions: copy(this.plan?.conditions || []),
        effects: copy(this.plan?.effects || []),
        portalFrame: copy(this.plan?.portalFrame || null),
        pulse: this.pulse.diagnostics(),
        portal: this.portal()?.current?.() || null,
      });
    }

    publish() {
      document.dispatchEvent(new CustomEvent('vcard:vcplayer-state', {
        detail: this.snapshot(),
      }));
    }

    bindAudio() {
      if (!this.audio) return;
      this.audio.addEventListener('playing', () => this.playing());
      this.audio.addEventListener('pause', () => {
        if (!this.audio.ended) this.applyPause();
      });
      this.audio.addEventListener('waiting', () => this.waiting());
      this.audio.addEventListener('seeking', () => this.seek());
      this.audio.addEventListener('seeked', () => this.seeked());
      this.audio.addEventListener('timeupdate', () => this.portal()?.tick?.());
      this.audio.addEventListener('ended', () => this.end());
      this.audio.addEventListener('error', () => this.failed());
    }

    dispose() {
      this.cancelOperation();
      this.pulse.dispose();
      this.portal()?.close?.(this.preview);
      this.preview = null;
      this.openPreview = null;
      this.phase = 'closed';
      this.playback = 'idle';
    }
  }

  const player = new VCPlayer(activeConfig, audio);
  window.VCPlayer = Object.freeze({
    config: activeConfig,
    open: (preview) => player.open(preview),
    close: (preview) => player.close(preview),
    start: (preview, options) => player.start(preview, options),
    resume: () => player.resume(),
    pause: () => player.pause(),
    toggle: (preview) => player.toggle(preview),
    verse: (detail) => player.verse(detail),
    preEnd: (detail) => player.preEnd(detail),
    setCompleteHandler: (handler) => player.setCompleteHandler(handler),
    current: () => player.snapshot(),
    diagnostics: Object.freeze({ current: () => player.snapshot() }),
    dispose: () => player.dispose(),
  });

  document.addEventListener('vcard:visualization-state', (event) => {
    player.setMotionAllowed(Number(event.detail?.brightnessLevel) > 0);
  });
  window.addEventListener('pagehide', () => player.dispose(), { once: true });
  if (config.debug) console.info('VCPlayer ready', player.snapshot());
})();
