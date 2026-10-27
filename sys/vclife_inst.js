(() => {
  'use strict';

  const runtime = window.VCLifeShow;
  const audio = document.querySelector('audio[data-shared-player="true"]');
  if (!runtime || !audio) {
    window.VCardBootstrap?.setState('Failed', new Error('VCLifeShow or shared audio is unavailable'));
    return;
  }
  const immutablePlan = runtime.immutablePlan;
  // Direct implementation of the agreed instance VCPlay.
  class VCPlay extends runtime.Profile {
    usesTV() { return true; }
    preloadScopes(entry) { return entry.hasShow ? ['song'] : []; }

    requiresIntro() { return true; }

    previewFrame() {
      return { styles: ['vc', 's_alarm'], mask: 'off', pick: 'shuffle-bag' };
    }

    initialFrame(environment) {
      return environment.song.environment.songTVAbsent
        ? { mediaType: 'play-ani' } : this.previewFrame();
    }

    onSongOpen(environment) {
      if (environment.song.environment.songTVAbsent) {
        environment.playAni.show({ phase: 'start', motion: 'static' });
      }
    }

    onSongStart(environment) {
      if (environment.song.environment.songTVAbsent) {
        environment.playAni.show({ phase: 'play', motion: 'animated' });
      }
    }

    async onSongEnd(environment, playback, signal) {
      if (signal.aborted || playback.dead) return;
      if (environment.song.environment.songTVAbsent) {
        environment.playAni.show({ phase: 'finish', motion: 'animated', fade: 2, unfade: 2 });
      }
      await playback.life.transitionClock.wait(5, signal);
    }

    onStopped(environment) {
      if (environment.song.environment.songTVAbsent) {
        environment.playAni.show({ phase: 'finish', motion: 'static' });
      }
    }

    planDisplay(plan, natural = true, playback = null) {
      const current = Number(this.life.globalSlideCount) || 0;
      const globalSlideNumber = natural ? current + 1 : Math.max(1, current);
      const frame = { source: 'img', styles: ['vc', 's_alarm'], mask: 'optional', pick: 'shuffle-bag', glow: 0 };
      const cross = plan.effects.find((effect) => effect.name === 'CrossImg');
      return immutablePlan({ ...plan, globalSlideNumber, conditions: [],
        portalFrame: { ...frame, ...(plan.first && cross ? {
          fade: frame.fade ?? cross.fade, unfade: frame.unfade ?? cross.unfade,
        } : {}) } });
    }

    preparePreview(environment, sourceScope) {
      environment.songTVAbsent = environment.portal()?.hasSongTV?.(environment.song.preview) === false;
      environment.sourceScope = 'song';
      if (sourceScope) window.VCardDecoration?.applyShowPreset?.('duo');
      if (environment.songTVAbsent) environment.portal()?.openIdle?.(environment.song.preview);
    }

    showPreview(environment, source) {
      return environment.portal()?.openIdle?.(environment.song.preview,
        environment.songTVAbsent
          ? { mediaType: 'play-ani' } : source ? this.previewFrame() : null);
    }

    configurePlayback(environment) {
      environment.playback.sourceScope = 'song';
      window.VCardDecoration?.applyShowPreset?.('duo');
    }

    sourceReady(environment) {
      if (!environment.song.environment.songTVAbsent && !environment.lastPlan) {
        environment.portal()?.holdSongPreview?.();
      }
    }

  }

  runtime.start({ Profile: VCPlay, playConstants: { CROSS_PERIOD: 0 } });
})();
