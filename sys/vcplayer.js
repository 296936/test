(() => {
  'use strict';

  const config = window.VCardUI?.vcPlayer;
  if (!config || config.format !== 'aliswb-vcplayer-4') return;

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
      this.chainName = String(settings?.verseChain || '');
    }

    conditionValue(condition, verseNumber) {
      const functionName = String(condition?.function || '');
      const number = Math.max(1, Number(condition?.arguments?.[0]) || 1);
      if (functionName === 'AfterVerseN') return verseNumber === number;
      if (functionName === 'EveryNthVerse') return verseNumber > 0 && verseNumber % number === 0;
      return false;
    }

    evaluate(program, verseNumber, output, conditions = []) {
      (program || []).forEach((node) => {
        if (node.type === 'if') {
          const active = this.conditionValue(node.condition, verseNumber);
          output.conditions.push({ ...copy(node.condition), active });
          this.evaluate(
            active ? node.then : node.else,
            verseNumber,
            output,
            [...conditions, { ...node.condition, active }]
          );
        } else if (node.type === 'pulseEffect' && node.binding) {
          output.bindings.push(copy(node.binding));
        } else if (node.type === 'portalFrame' && node.frame) {
          output.portalFrame = copy(node.frame);
        } else if (node.type === 'effect' && node.effect) {
          output.effects.push({
            ...copy(node.effect),
            conditions: conditions.map((condition) => condition.label),
          });
        }
      });
    }

    plan(detail = {}) {
      const chain = this.settings.verseChains?.[this.chainName];
      const index = Number.isInteger(detail.index) ? detail.index : -1;
      const output = {
        preview: detail.preview || null,
        index,
        seeked: Boolean(detail.seeked),
        startsAt: Number.isFinite(Number(detail.startsAt)) ? Number(detail.startsAt) : null,
        endsAt: Number.isFinite(Number(detail.endsAt)) ? Number(detail.endsAt) : null,
        verseChain: chain ? this.chainName : '',
        portalFrame: null,
        bindings: [],
        effects: [],
        conditions: [],
      };
      if (chain && index >= 0) this.evaluate(chain.program, index + 1, output);
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
        Promise.resolve(runner(controller.signal, epoch)).then(complete, (error) => {
          if (!controller.signal.aborted) console.warn(`VCPlayer ${name} failed`, error);
          complete();
        });
      } catch (error) {
        if (!controller.signal.aborted) console.warn(`VCPlayer ${name} failed`, error);
        complete();
      }
      return controller.signal;
    }

    wait(seconds, signal) {
      return new Promise((resolve) => {
        if (signal.aborted) {
          resolve(false);
          return;
        }
        const timer = window.setTimeout(() => resolve(true), Math.max(0, Number(seconds) || 0) * 1000);
        signal.addEventListener('abort', () => {
          window.clearTimeout(timer);
          resolve(false);
        }, { once: true });
      });
    }

    open(preview) {
      if (!preview) return false;
      this.cancelOperation();
      this.phase = 'opening';
      if (this.preview && this.preview !== preview && this.audio && !this.audio.paused) {
        this.audio.pause();
      }
      this.pulse.dispose();
      this.preview = preview;
      this.playback = 'idle';
      this.trackRunId = 0;
      this.verseIndex = -1;
      this.plan = null;
      this.portal()?.open?.(preview);
      this.phase = 'ready';
      this.publish();
      return true;
    }

    close(preview = this.preview) {
      if (!this.preview || (preview && preview !== this.preview)) return false;
      this.phase = 'closing';
      this.cancelOperation();
      if (this.audio && !this.audio.paused) this.audio.pause();
      this.pulse.dispose();
      this.portal()?.close?.(this.preview);
      this.preview = null;
      this.phase = 'closed';
      this.playback = 'idle';
      this.trackRunId = 0;
      this.verseIndex = -1;
      this.plan = null;
      this.publish();
      return true;
    }

    start(preview = this.preview) {
      if (!preview || !this.audio) return Promise.resolve(false);
      if (preview !== this.preview) this.open(preview);
      this.cancelOperation();
      this.trackRunId += 1;
      this.verseIndex = -1;
      this.plan = null;
      this.phase = 'starting';
      this.playback = 'starting';
      this.pulse.dispose();
      this.portal()?.start?.(preview);
      this.publish();
      // Must remain in the trusted click call stack.
      const request = this.audio.play();
      if (!request?.catch) return Promise.resolve(true);
      return request.then(() => true).catch((error) => {
        if (preview !== this.preview) return false;
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
      this.cancelOperation();
      this.phase = 'paused';
      this.playback = 'paused';
      this.pulse.pause();
      this.portal()?.pause?.();
      this.publish();
    }

    toggle(preview = this.preview) {
      if (!preview || preview !== this.preview || !this.audio) return;
      if (!this.audio.paused && !this.audio.ended) this.pause();
      else if (this.trackRunId && !this.audio.ended) this.resume();
      else this.start(preview);
    }

    verse(detail = {}) {
      if (!this.trackRunId || detail.preview !== this.preview) return;
      const index = Number.isInteger(detail.index) ? detail.index : -1;
      if (index < 0) return;
      if (index === this.verseIndex && !detail.seeked) return;
      const plan = this.planner.plan(detail);
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
        this.portal()?.beforeFirstVerse?.(!this.audio.paused && !this.audio.ended);
        this.phase = this.audio.paused ? 'paused' : 'cassette-playing';
        this.publish();
      }
    }

    async end() {
      if (!this.trackRunId || !this.preview || this.phase === 'ending') return;
      const preview = this.preview;
      const runId = this.trackRunId;
      const portalSettings = this.settings.portal?.settings || {};
      this.phase = 'ending';
      this.playback = 'ended';
      this.pulse.dispose();
      this.beginOperation('finish', async (signal) => {
        this.portal()?.finishAnimated?.(Number(portalSettings.FinishFade) || 0);
        if (!await this.wait(portalSettings.FinishAnimatedDuration, signal)) return;
        this.portal()?.finishStatic?.();
        if (!await this.wait(portalSettings.FinishStaticDuration, signal)) return;
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
        phase: this.phase,
        playback: this.playback,
        trackRunId: this.trackRunId,
        verseIndex: this.verseIndex,
        verseNumber: this.verseIndex >= 0 ? this.verseIndex + 1 : 0,
        verseChain: String(this.plan?.verseChain || this.planner.chainName || ''),
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
      this.phase = 'closed';
      this.playback = 'idle';
    }
  }

  const player = new VCPlayer(config, audio);
  window.VCPlayer = Object.freeze({
    config,
    open: (preview) => player.open(preview),
    close: (preview) => player.close(preview),
    start: (preview) => player.start(preview),
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
