(() => {
  'use strict';

  const core = window.VCLifeCore;
  const config = window.VCardUI?.vcPlayer;
  const audio = document.querySelector('audio[data-shared-player="true"]');
  if (!core || !config || config.format !== 'aliswb-vcplayer-5' || !audio) return;

  const abortError = (error) => error?.name === 'AbortError';
  const selectScenario = (program) => {
    let selected = '';
    const visit = (nodes) => {
      (nodes || []).forEach((node) => {
        if (node.type === 'if' && node.condition?.function === 'Chance') {
          const percent = Math.max(0, Math.min(100, Number(node.condition.arguments?.[0]) || 0));
          visit(Math.random() * 100 < percent ? node.then : node.else);
        } else if (node.type === 'vcpSet') {
          selected = String(node.name || '');
        }
      });
    };
    visit(program);
    return selected;
  };

  class CassObj extends core.LifeObject {
    constructor(environment) {
      super(environment, 'CassObj');
      this.environment = environment;
      this.motion = 'static';
      this.phase = 'start';
    }

    show({ phase = this.phase, motion = this.motion, fade = null } = {}) {
      if (this.dead) return;
      this.phase = phase;
      this.motion = motion;
      this.environment.portal()?.showCassette?.({ phase, motion, fade });
    }

    snapshot() {
      return { ...super.snapshot(), phase: this.phase, motion: this.motion };
    }
  }

  class V1SongEnvironment extends core.TSongEnvironment {
    constructor(song) {
      super(song);
      this.cassette = new CassObj(this);
      this.firstVerseShown = false;
      this.lastPlan = null;
    }

    portal() {
      return this.song.life.visualWorld.portal;
    }

    onOpen({ current, background }) {
      if (current) return;
      if (background) {
        this.portal()?.openIdle?.(this.song.preview, [{
          type: 'effect',
          effect: { name: 'Cassette', phase: 'start', motion: 'static' },
        }]);
        return;
      }
      this.portal()?.open?.(this.song.preview);
      this.cassette.show({ phase: 'start', motion: 'static' });
    }

    onClose({ current }) {
      if (current) return;
      this.portal()?.closeIdle?.(this.song.preview);
      this.portal()?.close?.(this.song.preview);
    }

    onPlaybackStart() {
      this.portal()?.closeIdle?.(this.song.preview);
      this.portal()?.open?.(this.song.preview);
      this.portal()?.start?.(this.song.preview);
      this.portal()?.beforeFirstVerse?.(true);
      this.firstVerseShown = false;
      this.lastPlan = null;
      this.cassette.show({ phase: 'play', motion: 'animated' });
    }

    onPlaying() {
      this.portal()?.playing?.();
    }

    onPause() {
      this.portal()?.pause?.();
    }

    onResume() {
      this.portal()?.resume?.();
    }

    onWaiting() {
      this.portal()?.waiting?.();
    }

    onSeek() {
      this.portal()?.seek?.();
    }

    onSeeked() {
      this.portal()?.seeked?.();
    }

    onTick() {
      this.portal()?.tick?.();
    }

    onVerse(playback, detail, plan) {
      this.lastPlan = plan;
      const signal = playback.scope.signal;
      this.portal()?.applyVerse?.(plan, signal).then((applied) => {
        playback.life.queue.post(() => {
          if (applied && !playback.dead && !signal.aborted) this.firstVerseShown = true;
        });
      }).catch((error) => {
        if (!abortError(error)) console.error('VCLife verse transition failed', error);
      });
    }

    onVersePreEnd(_playback, detail, plan) {
      if (!plan) return;
      this.portal()?.preEnd?.(detail, plan);
    }

    async onEnd(playback, signal) {
      this.portal()?.ended?.();
      this.cassette.show({ phase: 'finish', motion: 'animated', fade: 1 });
      await playback.life.transitionClock.wait(1, signal);
      await playback.life.transitionClock.wait(5, signal);
      this.cassette.show({ phase: 'finish', motion: 'static' });
      await playback.life.transitionClock.wait(5, signal);
    }

    onEnded() {
      this.portal()?.ended?.();
    }

    onFailed() {
      this.portal()?.failed?.();
    }

    snapshot() {
      return {
        ...super.snapshot(),
        cassette: this.cassette.snapshot(),
        firstVerseShown: this.firstVerseShown,
      };
    }

    die(reason = 'environment-died') {
      if (this.dead) return;
      this.cassette.die(reason);
      super.die(reason);
    }
  }

  class VCLifeV1 {
    constructor(settings) {
      this.name = 'VCLifeV1';
      this.settings = settings;
      this.life = null;
    }

    onPageReload() {
      // The TVCLife constructor owns Page.Reload state, including GlobVerseCount.
    }

    createEnvironment(song) {
      return new V1SongEnvironment(song);
    }

    planVerse(playback, detail, globalVerseCount) {
      const burn = globalVerseCount > 0 && globalVerseCount % 5 === 0;
      const first = playback.verseIndex === 0 && !playback.song.environment.firstVerseShown;
      return {
        preview: detail.preview,
        index: detail.index,
        globalVerseNumber: globalVerseCount,
        seeked: Boolean(detail.seeked),
        startsAt: Number.isFinite(Number(detail.startsAt)) ? Number(detail.startsAt) : null,
        endsAt: Number.isFinite(Number(detail.endsAt)) ? Number(detail.endsAt) : null,
        verseHandler: 'OnVerseStart',
        bindings: [],
        conditions: [{ function: 'EveryNthGlobVerse', arguments: [5], active: burn }],
        effects: [
          { name: 'CrossImg', lead: 1, unfade: 1, fade: 1 },
          { name: 'CrossAni', lead: 3, unfade: 3, fade: 5 },
        ],
        portalFrame: burn ? {
          source: 'set_img', styles: ['s_burn'], mask: 'off', pick: 'shuffle-bag', glow: 5,
          ...(first ? { fade: 1 } : {}),
        } : {
          source: 'set_img', styles: ['vc', 's_alarm'], mask: 'required', pick: 'shuffle-bag', glow: 0,
          ...(first ? { fade: 1 } : {}),
        },
      };
    }

    setMotionAllowed(allowed) {
      this.life?.visualWorld.portal?.setMotionAllowed?.(allowed);
    }
  }

  const scenarioName = selectScenario(config.onPageReload) || 'V1';
  const scenarios = { V1: () => new VCLifeV1(config) };
  const createScenario = scenarios[scenarioName];
  if (!createScenario) {
    console.error(`VCLife: unknown scenario ${scenarioName}`);
    return;
  }
  const life = new core.TVCLife({ config, audio, scenario: createScenario() });
  window.VCLife = life;
  window.VCPlayer = Object.freeze({
    config: { ...config, activeHandlerSet: scenarioName },
    open: (preview) => life.open(preview),
    close: (preview) => life.close(preview),
    start: (preview, options) => life.start(preview, options),
    resume: () => life.resume(),
    pause: () => life.pause(),
    toggle: (preview) => life.toggle(preview),
    verse: (detail) => life.verse(detail),
    preEnd: (detail) => life.preEnd(detail),
    setCompleteHandler: (handler) => life.setCompleteHandler(handler),
    current: () => life.snapshot(),
    diagnostics: Object.freeze({ current: () => life.snapshot() }),
    dispose: () => life.dispose(),
  });

  document.addEventListener('vcard:visualization-state', (event) => {
    life.setMotionAllowed(Number(event.detail?.brightnessLevel) > 0);
  });
  window.addEventListener('pagehide', () => life.dispose(), { once: true });
  if (config.debug) console.info('VCLifeV1 ready', life.snapshot());
})();
