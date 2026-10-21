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

    requiresIntro() { return true; }

    previewFrame() {
      return { styles: ['vc', 's_alarm'], mask: 'off', pick: 'shuffle-bag' };
    }

    initialFrame(environment) {
      return environment.playback.sourceScope === 'global' || environment.song.environment.songTVAbsent
        ? { mediaType: 'play-ani' } : this.previewFrame();
    }

    chooseSource(releaseKey, player = false) {
      const previous = this.sourceRun;
      const scope = player ? 'global' : previous?.count >= 3
        ? previous.scope === 'global' ? 'song' : 'global'
        : this.life.random.stream(`shows.source.${releaseKey}`).next('source-kind') < 0.5 ? 'song' : 'global';
      this.sourceRun = { scope, count: previous?.scope === scope ? previous.count + 1 : 1 };
      return scope;
    }

    onSongOpen(environment) {
      if ((environment.playback?.sourceScope || environment.sourceScope) === 'global'
        || environment.song.environment.songTVAbsent) {
        environment.playAni.show({ phase: 'start', motion: 'static' });
      }
    }

    onSongStart(environment) {
      if (environment.playback.sourceScope === 'global'
        || environment.song.environment.songTVAbsent) {
        environment.playAni.show({ phase: 'play', motion: 'animated' });
      }
    }

    async onSongEnd(environment, playback, signal) {
      if (signal.aborted || playback.dead) return;
      if (playback.sourceScope === 'global' || environment.song.environment.songTVAbsent) {
        environment.playAni.show({ phase: 'finish', motion: 'animated', fade: 2, unfade: 2 });
      }
      await playback.life.transitionClock.wait(5, signal);
    }

    onStopped(environment) {
      if (environment.playback.sourceScope === 'global'
        || environment.song.environment.songTVAbsent) {
        environment.playAni.show({ phase: 'finish', motion: 'static' });
      }
    }

    planDisplay(plan, natural = true, playback = null) {
      const current = Number(this.life.globalSlideCount) || 0;
      const globalSlideNumber = natural ? current + 1 : Math.max(1, current);
      const colorSlide = globalSlideNumber > 0 && globalSlideNumber % 9 === 0;
      const frame = colorSlide
        ? { source: 'img', styles: ['s_burn'], mask: 'off', pick: 'shuffle-bag', glow: 8, glowPulse: true, glowPulses: 2 }
        : { source: 'img', styles: ['vc', 's_alarm'], mask: playback?.sourceScope === 'global' ? 'off' : 'optional', pick: 'shuffle-bag', glow: 0 };
      const cross = plan.effects.find((effect) => effect.name === 'CrossImg');
      return immutablePlan({ ...plan, globalSlideNumber, conditions: [{ function: 'EveryNthGlobSlide', arguments: [9], active: colorSlide }],
        portalFrame: { ...frame, ...(plan.first && cross ? {
          fade: frame.fade ?? cross.fade, unfade: frame.unfade ?? cross.unfade,
        } : {}) } });
    }

    preparePreview(environment, sourceScope) {
      environment.songTVAbsent = environment.portal()?.hasSongTV?.(environment.song.preview) === false;
      environment.sourceScope = environment.songTVAbsent ? 'song'
        : sourceScope || this.chooseSource(environment.song.identity.releaseKey);
      if (sourceScope) window.VCardDecoration?.applyShowPreset?.(environment.sourceScope === 'global' ? 'mono' : 'duo');
      if (environment.sourceScope === 'global' || environment.songTVAbsent) environment.portal()?.openIdle?.(environment.song.preview);
    }

    showPreview(environment, source) {
      return environment.portal()?.openIdle?.(environment.song.preview,
        environment.sourceScope === 'global' || environment.songTVAbsent
          ? { mediaType: 'play-ani' } : source ? this.previewFrame() : null);
    }

    launchSource(playback) {
      return playback.launch === 'portal' ? 'song' : playback.launch === 'player' ? 'global' : null;
    }

    configurePlayback(environment, { changingProfile, reuse, launchSource }) {
      const playback = environment.playback;
      const songEnvironment = environment.song.environment;
      playback.sourceScope = songEnvironment.songTVAbsent ? 'song'
        : reuse ? songEnvironment.sourceScope : changingProfile ? playback.sourceScope
          : launchSource || this.chooseSource(environment.song.identity.releaseKey);
      window.VCardDecoration?.applyShowPreset?.(playback.sourceScope === 'global' ? 'mono' : 'duo');
    }

    sourceReady(environment) {
      if (environment.playback.sourceScope === 'song' && !environment.song.environment.songTVAbsent && !environment.lastPlan) {
        environment.portal()?.holdSongPreview?.();
      }
    }

    selectResumeSource(preview, surface) {
      const life = this.life;
      const song = life.playingSong;
      const playback = song?.playback;
      if (song?.environment?.songTVAbsent) return;
      const source = surface === 'player' ? 'global' : surface === 'portal' ? 'song' : null;
      if (!source || !audio.paused || preview !== song?.preview || !playback
          || playback.dead || !['paused', 'playing'].includes(playback.state)) return;
      if (playback.sourceScope !== source) playback.playbackEnvironment?.nextShow(true);
      window.VCardDecoration?.applyShowPreset?.(source === 'global' ? 'mono' : 'duo');
    }
  }

  runtime.start({ Profile: VCPlay, playConstants: { CROSS_PERIOD: 0 } });
})();
