(() => {
  'use strict';

  const core = window.VCLifeCore;
  const audio = document.querySelector('audio[data-shared-player="true"]');
  if (!core || !audio) {
    window.VCardBootstrap?.setState('Failed', new Error(!core ? 'VCLifeCore is unavailable' : 'Shared audio is unavailable'));
    return;
  }

  const abortError = (error) => error?.name === 'AbortError';
  const immutablePlan = (plan) => {
    // The preview is a borrowed DOM binding, not profile-owned rule data.
    const { preview, ...rules } = plan;
    return Object.freeze({ preview, ...core.freeze(rules) });
  };
  let VCPLAYER_FLOW;
  let VCPLAY_PARAMS;
  let VCPlay;
  const PLAYER_DEFAULTS = Object.freeze({
    STATIC_PLAY_ANI_DELAY: 5,
  });
  const PLAY_DEFAULTS = Object.freeze({
    COLOR_CHANGE_PERIOD: 120,
    CROSS_PERIOD: 30,
    CROSS_LEAD: 3,
    CROSS_UNFADE: 3,
    CROSS_FADE: 5,
    CROSS_OPACITY: 0.8,
    CROSS_PLAYBACK_RATE: 1,
    CROSS_START_GAP: 2,
    CROSS_MANUAL_LEAD: 2,
    CROSS_MANUAL_UNFADE: 2,
    CROSS_MANUAL_FADE: 2,
    CROSS_MANUAL_OPACITY: 0.5,
    CROSS_CONTINUOUS_UNFADE: 0,
    CROSS_CONTINUOUS_FADE: 0,
    CROSS_CONTINUOUS_OPACITY: 1,
    IMG_LEAD: 2,
    IMG_UNFADE: 2,
    IMG_FADE: 2,
    SLIDES: 1,
  });
  const VCPLAY_SCENARIO_ID = 'VCPlay';
  class PlayAniObj extends core.LifeObject {
    constructor(environment) {
      super(environment, 'PlayAniObj');
      this.environment = environment;
      this.motion = 'static';
      this.phase = 'start';
    }

    show({
      phase = this.phase, motion = this.motion, fade = null, unfade = fade,
    } = {}) {
      if (this.dead) return;
      this.phase = phase;
      this.motion = motion;
      this.environment.portal()?.showPlayAni?.({ phase, motion, fade, unfade });
    }

    snapshot() {
      return { ...super.snapshot(), phase: this.phase, motion: this.motion };
    }
  }

  class TVerseSlideTimeline extends core.LifeObject {
    constructor(environment, playback) {
      super(playback, 'VerseSlideTimeline');
      this.environment = environment;
      this.playback = playback;
      this.plan = null;
      this.decisionOrigin = null;
      this.generation = 0;
      this.ordinal = 0;
      this.count = 1;
      this.startsAt = 0;
      this.endsAt = 0;
      this.step = 0;
      this.busy = false;
      this.slotKind = '';
      this.pending = null;
      this.lastSlide = null;
      this.renderScope = this.scope.child({ id: `${this.id}:render` });
      this.scope.signal.addEventListener('abort', () => this.die('playback-scope-ended'), { once: true });
    }

    portal() {
      return this.environment.portal();
    }

    timing() {
      const available = Math.max(0, this.slotBoundary(this.ordinal + 1) - this.slotBoundary(this.ordinal));
      const effect = this.plan?.effects?.find((item) => item.name === 'CrossImg');
      const configured = { lead: effect?.lead || 0, unfade: effect?.unfade || 0, fade: effect?.fade || 0 };
      const longest = Math.max(
        configured.lead,
        configured.unfade,
        configured.fade
      );
      const scale = longest > 0 && available < longest
        ? available / longest
        : 1;
      return {
        lead: configured.lead * scale,
        unfade: configured.unfade * scale,
        fade: configured.fade * scale,
      };
    }

    targetOrdinal(now) {
      if (!this.plan || this.step <= 0) return 0;
      if (this.plan.slideBoundaries) {
        return Math.max(0, Math.min(this.count - 1,
          this.plan.slideBoundaries.filter((boundary) => now >= boundary).length - 1));
      }
      return Math.max(0, Math.min(this.count - 1,
        Math.floor(Math.max(0, now - this.startsAt) / this.step)));
    }

    slotBoundary(ordinal) {
      return this.plan?.slideBoundaries?.[ordinal]
        ?? Math.min(this.endsAt, this.startsAt + ordinal * this.step);
    }

    displayPlan(natural = true, ordinal = this.ordinal) {
      const slotOrdinal = Math.max(0, Math.min(this.count - 1, ordinal));
      const plan = this.playback.profile.planDisplay(this.plan, natural, this.playback);
      return {
        ...plan,
        decisionOrigin: this.decisionOrigin
          ? { ...this.decisionOrigin, slideOrdinal: slotOrdinal } : null,
        ...(!natural && this.plan.restoring && plan.portalFrame ? {
          portalFrame: { ...plan.portalFrame, pick: 'keep', keepPhysicalIndex: true },
        } : {}),
        displayStartsAt: this.slotBoundary(slotOrdinal),
        displayEndsAt: this.slotBoundary(slotOrdinal + 1),
      };
    }

    current(slide) {
      return !this.dead && this.pending === slide && !slide.controller.signal.aborted;
    }

    slideSnapshot(slide, outcome = null, reason = null) {
      if (!slide) return null;
      return { ordinal: slide.ordinal, natural: slide.natural, entry: slide.entry, kind: slide.kind,
        ready: slide.ready, outcome, reason, startsAt: slide.plan.displayStartsAt,
        endsAt: slide.plan.displayEndsAt, globalSlideNumber: slide.plan.globalSlideNumber,
        color: Boolean(slide.plan.conditions?.some((condition) => condition.function === 'EveryNthGlobSlide' && condition.active)),
        resourceId: slide.resource?.id ?? null, physicalIndex: slide.resource?.reservation?.index ?? null };
    }

    clearReservation(reason = 'slot-reservation-cleared') {
      const slide = this.pending;
      if (!slide) return;
      this.pending = null;
      slide.scope.signal.removeEventListener('abort', slide.onAbort);
      this.lastSlide = this.slideSnapshot(slide, 'cancelled', reason);
      for (const release of [() => slide.controller.abort(),
        () => slide.resource && this.portal()?.cancelVerseDisplay?.(slide.resource)]) {
        try { release(); }
        catch (error) { this.playback.life.reportFault(error, { type: 'Slide.Cleanup', owner: this }); }
      }
    }

    prepareSlide(ordinal, natural, entry = false, restoreKind = '') {
      const plan = this.displayPlan(natural, ordinal);
      const available = Boolean(this.playback.showSource) && this.portal()?.hasVerseImages?.(plan) !== false;
      const slide = { ordinal, natural, entry, kind: restoreKind || (available ? 'image' : 'hold'),
        plan: { ...plan, showFallback: available ? 'none' : 'hold' },
        controller: new AbortController(), scope: this.renderScope, resource: null, ready: false };
      this.pending = slide;
      slide.onAbort = () => { if (this.current(slide)) this.clearReservation('render-scope-ended'); };
      slide.scope.signal.addEventListener('abort', slide.onAbort, { once: true });
      if (slide.scope.signal.aborted) slide.onAbort();
      slide.promise = Promise.resolve().then(() => !this.current(slide) || slide.kind === 'hold' ? null
        : this.portal()?.prepareVerseDisplay?.({ kind: slide.kind, plan: slide.plan }, slide.controller.signal))
        .then((resource) => {
          if (!this.current(slide)) {
            if (resource) this.portal()?.cancelVerseDisplay?.(resource);
            return false;
          }
          slide.resource = resource;
          if (resource) {
            slide.kind = resource.kind;
            slide.plan = resource.plan;
          }
          slide.ready = slide.kind === 'hold' || Boolean(resource);
          if (!slide.ready) this.clearReservation('preparation-unavailable');
          else this.playback.life.publish();
          return slide.ready;
        }).catch((error) => {
          if (this.current(slide)) {
            this.clearReservation(error?.message || 'slide-failed');
            if (!abortError(error)) this.playback.life.reportFault(error, { type: 'Slide.Prepare', owner: this });
          }
          return false;
        });
      return slide;
    }

    async showSlide(slide) {
      if (!slide || !await slide.promise || !this.current(slide)) return false;
      return this.playback.life.queue.post(() => {
        if (!this.current(slide) || this.playback.state === 'failed'
          || !this.playback.life.renderingActive || audio.paused) return false;
        const { plan, natural, kind, ordinal, entry } = slide;
        if (kind === 'hold') {
          this.ordinal = ordinal;
          this.clearReservation('scenario-no-frames-hold');
          return false;
        }
        if (!this.portal()?.showVerseDisplay?.(slide.resource, this.timing(), slide.controller.signal)) {
          this.clearReservation('surface-not-published');
          return false;
        }
        // The scene has begun showing this resource. CrossFade only frees the old layer.
        this.pending = null;
        slide.scope.signal.removeEventListener('abort', slide.onAbort);
        this.lastSlide = this.slideSnapshot(slide, 'shown');
        this.playback.plan = plan;
        this.slotKind = kind;
        this.ordinal = ordinal;
        if (entry) this.environment.firstVerseShown = true;
        this.playback.profile.commitDisplay(plan, natural, kind);
        this.busy = false;
        this.playback.life.publish();
        return true;
      }, { type: 'Slide.Show', owner: this, scope: slide.scope });
    }

    reserve(ordinal = this.ordinal + 1) {
      const requested = Math.max(0, Math.min(this.count - 1, ordinal));
      // The background loader owns network work. Choose a loading fallback at
      // the actual boundary, rather than freezing it during an early reserve.
      if (this.portal()?.slidesLoading?.(this.playback.song.preview)) return Promise.resolve(false);
      if (this.dead || !this.playback.life.renderingActive || !this.plan || requested <= this.ordinal) {
        return Promise.resolve(false);
      }
      if (this.pending && this.pending.ordinal !== requested) this.clearReservation('superseded-slot');
      return (this.pending || this.prepareSlide(requested, true)).promise;
    }

    async enter(plan) {
      if (this.dead || !plan) return false;
      const generation = ++this.generation;
      this.clearReservation('verse-enter');
      this.plan = plan;
      this.decisionOrigin = { commandId: this.playback.life.queue.current?.id || null,
        event: this.playback.life.queue.current?.type || (plan.seeked ? 'Playback.Seek' : 'Verse.Enter'),
        revision: this.playback.life.revision, runId: this.playback.runId,
        launch: this.playback.launch,
        profile: this.playback.profile.name, entryKey: this.playback.song.identity.entryKey };
      this.count = Number.isInteger(plan.slidesInVerse) && plan.slidesInVerse >= 1 ? plan.slidesInVerse : 1;
      this.startsAt = Number(plan.startsAt);
      this.endsAt = Number(plan.endsAt);
      const validRange = Number.isFinite(this.startsAt) && Number.isFinite(this.endsAt) && this.endsAt > this.startsAt;
      this.step = validRange ? (this.endsAt - this.startsAt) / this.count : 0;
      this.ordinal = this.targetOrdinal(Number(audio.currentTime) || 0);
      const initialOrdinal = this.ordinal;
      if (!this.playback.life.renderingActive) { this.busy = false; return false; }
      this.busy = true;
      try {
        await this.environment.preparation?.ready;
        if (this.dead || generation !== this.generation) return false;
        return await this.showSlide(this.prepareSlide(initialOrdinal, !plan.seeked, true,
          plan.restoring ? plan.restoreKind : ''));
      } catch (error) {
        this.reject(error, generation);
        return false;
      } finally {
        if (generation === this.generation) this.busy = false;
      }
    }

    reject(error, generation) {
      if (this.dead || generation !== this.generation) return;
      this.clearReservation(error?.message || 'slide-failed');
      if (!abortError(error)) this.playback.life.reportFault(error, { type: 'Slide.Show', owner: this });
    }

    async advance(ordinal = this.ordinal + 1) {
      if (this.dead || !this.playback.life.renderingActive || !this.plan || this.busy) return;
      const generation = this.generation;
      const target = Math.max(0, Math.min(this.count - 1, ordinal));
      if (target < this.ordinal || (target === this.ordinal && !this.pending?.entry)) return;
      if (this.pending && this.pending.ordinal !== target) this.clearReservation('skipped-slot');
      this.busy = true;
      try {
        if (!this.pending) this.prepareSlide(target, true);
        await this.showSlide(this.pending);
      } catch (error) {
        this.reject(error, generation);
      } finally {
        if (generation === this.generation) this.busy = false;
      }
    }

    update(now = Number(audio.currentTime) || 0) {
      if (this.dead || !this.playback.life.renderingActive || !this.plan || this.busy
        || audio.paused || audio.ended || this.step <= 0 || this.portal()?.verseDisplayBusy?.()) return;
      const target = this.targetOrdinal(now);
      if (target > this.ordinal || this.pending?.entry) {
        this.advance(target);
        return;
      }
      if (this.ordinal >= this.count - 1) return;
      if (now >= this.slotBoundary(this.ordinal + 1) - this.timing().lead) this.advance(this.ordinal + 1);
      else if (!this.pending) this.reserve(this.ordinal + 1);
    }

    suspend(reason = 'rendering-suspended') {
      if (this.dead) return;
      this.generation += 1;
      this.clearReservation(reason);
      this.renderScope.die(reason);
      this.renderScope = this.scope.child({ id: `${this.id}:render` });
      this.busy = false;
      this.portal()?.cancelVerseFrame?.(reason);
    }

    reset(reason = 'timeline-reset') {
      this.suspend(reason);
      this.plan = null;
      this.slotKind = '';
    }

    snapshot() {
      return { ...super.snapshot(), verse: this.plan?.index ?? -1, slidesCount: this.count,
        timingSource: this.plan?.timingSource || 'TrackBand', startsAt: this.startsAt, endsAt: this.endsAt,
        slideBoundaries: this.plan?.slideBoundaries || null, slideOrdinal: this.ordinal, slotKind: this.slotKind,
        pendingSlide: this.slideSnapshot(this.pending), lastSlide: this.lastSlide,
        reservedSlotKind: this.pending?.kind || '', reservedSlideNumber: this.pending?.plan.globalSlideNumber ?? null,
        nextAt: this.plan && this.step > 0
          ? (this.ordinal < this.count - 1 ? this.slotBoundary(this.ordinal + 1) : this.endsAt) : null,
        reserved: Boolean(this.pending), busy: this.busy };
    }

    die(reason = 'timeline-died') {
      if (this.dead) return;
      this.reset(reason);
      super.die(reason);
    }
  }

  class TOverlayTimeline extends core.LifeObject {
    constructor(environment, playback) {
      super(playback, 'OverlayTimeline');
      this.environment = environment;
      this.playback = playback;
      this.nextCueId = 1;
      this.scope.signal.addEventListener('abort', () => this.die('playback-scope-ended'), { once: true });
    }

    portal() {
      return this.environment.portal();
    }

    scheduleCrossAni(anchorAt, effect = this.playback.profile.crossAniEffect(), detail = {}) {
      const boundaryAt = Number(anchorAt);
      if (this.dead || !effect || !Number.isFinite(boundaryAt)) return null;
      const lead = Math.max(0, Number(effect.lead) || 0);
      const unfade = Math.max(0, Number(effect.unfade) || 0);
      const fade = Math.max(0, Number(effect.fade) || 0);
      const cue = {
        id: this.nextCueId++,
        name: 'CrossAni',
        origin: String(detail.origin || 'scenario'),
        decisionOrigin: { commandId: this.playback.life.queue.current?.id || null,
          event: this.playback.life.queue.current?.type || 'Overlay.Schedule',
          revision: this.playback.life.revision, runId: this.playback.runId,
          launch: this.playback.launch,
          profile: this.playback.profile.name, entryKey: this.playback.song.identity.entryKey },
        verseIndex: Number.isInteger(detail.verseIndex) ? detail.verseIndex : -1,
        startsAt: Math.max(0, boundaryAt - lead),
        boundaryAt,
        fadeOutStartsAt: boundaryAt,
        endsAt: boundaryAt + fade,
        duration: lead + fade,
        unfade,
        fade,
        opacity: Number.isFinite(Number(effect.opacity))
          ? Math.max(0, Math.min(1, Number(effect.opacity)))
          : this.playback.profile.constants.CROSS_OPACITY,
        playbackRate: this.playback.profile.constants.CROSS_PLAYBACK_RATE,
        minimumStartGap: this.playback.profile.constants.CROSS_START_GAP,
      };
      this.portal()?.scheduleOverlay?.(cue, this);
      return cue;
    }

    suspend() { this.portal()?.suspendOverlay?.(this); }

    continuousCrossAni(duration) {
      if (!Number.isFinite(duration) || duration <= 0 || this.dead) return;
      if (this.continuousDuration === duration) return;
      this.reset('continuous-crossani');
      const p = this.playback.profile.constants;
      const cue = { id: this.nextCueId++, name: 'CrossAni', origin: 'NoSongSeries',
        continuous: true, startsAt: 0, boundaryAt: duration,
        fadeOutStartsAt: Math.max(0, duration - p.CROSS_CONTINUOUS_FADE),
        endsAt: duration, duration, unfade: p.CROSS_CONTINUOUS_UNFADE,
        fade: p.CROSS_CONTINUOUS_FADE, opacity: p.CROSS_CONTINUOUS_OPACITY,
        playbackRate: p.CROSS_PLAYBACK_RATE, minimumStartGap: p.CROSS_START_GAP,
        decisionOrigin: { event: 'NoSongSeries', runId: this.playback.runId,
          profile: this.playback.profile.name, entryKey: this.playback.song.identity.entryKey } };
      this.continuousDuration = duration;
      this.portal()?.scheduleOverlay?.(cue, this);
    }

    updatePeriodic(now, force = false) {
      const period = this.playback.profile.crossAniPeriod(this.playback);
      const effect = this.playback.profile.crossAniEffect();
      if (!(period > 0) || !effect || audio.seeking || !this.playback.life.renderingActive) return;
      // Select the current interval or the next one; missed periods never form a queue.
      const boundary = Math.max(1, Math.floor((now - effect.fade) / period) + 1) * period;
      if (!force && this.periodicBoundary === boundary) return;
      this.periodicBoundary = boundary;
      if (Number.isFinite(audio.duration) && boundary >= audio.duration) return;
      this.scheduleCrossAni(boundary, effect, { origin: 'Playback.Period' });
    }

    reset(reason = 'overlay-timeline-reset') {
      this.continuousDuration = 0;
      this.periodicBoundary = 0;
      this.portal()?.resetOverlay?.(this, reason);
    }

    snapshot() {
      return { ...super.snapshot(), ...this.portal()?.overlaySnapshot?.(this) };
    }

    die(reason = 'overlay-timeline-died') {
      if (this.dead) return;
      this.reset(reason);
      super.die(reason);
    }
  }

  // One request survives the handoff from the card preview to its playback.
  class TShowPreparation {
    constructor(owner, profile, sourceScope, origin) {
      this.song = owner.song;
      this.life = this.song.life;
      this.sourceScope = sourceScope;
      this.source = null;
      this.error = null;
      this.progress = { completed: 0, total: 1 };
      this.controller = new AbortController();
      this.onAbort = () => this.cancel('owner-ended');
      this.adopt(owner);
      this.ready = Promise.resolve().then(() => this.current()
        ? profile.prepareSource(owner, {
          profile: profile.name, sourceScope,
          releaseId: this.song.identity.releaseId, releaseKey: this.song.identity.releaseKey,
          origin, signal: this.signal, isCurrent: () => this.current(),
          onProgress: (completed, total) => this.reportProgress(completed, total),
        }) : null).then((source) => {
        if (this.current()) {
          this.source = source;
          this.reportProgress(this.progress.total, this.progress.total);
        }
        return source;
      }).catch((error) => this.failed(error));
    }

    get signal() { return this.controller.signal; }

    reportProgress(completed, total) {
      if (!this.current()) return;
      this.progress = { completed, total };
      // Keep one final unit for preparing the first visible frame.
      const percent = Math.floor(100 * completed / (total + 1));
      if (this.song.preloading) {
        this.life.visualWorld.portal?.setPreloading?.(this.song.preview, true, percent);
      }
    }

    current() {
      return !this.signal.aborted && !this.owner.dead && this.owner.preparation === this;
    }

    adopt(owner) {
      this.owner?.scope.signal.removeEventListener('abort', this.onAbort);
      if (this.owner?.preparation === this) this.owner.preparation = null;
      this.owner = owner;
      owner.preparation = this;
      owner.scope.signal.addEventListener('abort', this.onAbort, { once: true });
      if (owner.scope.signal.aborted) this.cancel('owner-ended');
      return this;
    }

    prepare(apply, type, kind = 'ComponentFailure') {
      const owner = this.owner;
      this.ready = this.ready.then(() => this.life.queue.post(() => {
        if (!this.current() || this.owner !== owner) return false;
        this.reportProgress(this.progress.completed, this.progress.total);
        return apply(this.source);
      }, { type, owner, scope: this })).then(async (result) => {
        if (this.current() && this.owner === owner) {
          await this.life.visualWorld.portal?.completeSongPreload?.(this.song.preview, this.signal);
          if (this.current() && this.owner === owner) {
            this.life.visualWorld.portal?.startSlideLoading?.(this.song.preview);
          }
        }
        return result;
      }).catch((error) => this.failed(error, kind));
      return this.ready;
    }

    failed(error, kind = 'ResourceFailure') {
      if (this.current() && !abortError(error)) {
        const previous = this.error;
        this.error = String(error?.message || error);
        if (previous !== this.error) this.life.reportFault(error, { type: 'Preload.Prepare', owner: this.owner }, kind);
      }
      return false;
    }

    cancel(reason = 'preparation-replaced') {
      this.owner.scope.signal.removeEventListener('abort', this.onAbort);
      if (!this.signal.aborted) this.controller.abort(reason);
    }

    snapshot() {
      return { owner: this.owner.id, sourceScope: this.sourceScope, source: this.source,
        cancelled: this.signal.aborted, error: this.error };
    }
  }

  class TShowSongEnvironment extends core.TSongEnvironment {
    constructor(song) {
      super(song);
      this.playAni = new PlayAniObj(this);
      this.songTVAbsent = false;
    }

    portal() { return this.song.life.visualWorld.portal; }

    onOpen({ current }) {
      const profile = this.song.life.lastShowProfile;
      if (current) return;
      this.prepareShow();
    }

    prepareShow(sourceScope = null) {
      this.preparation?.cancel('show-replaced');
      const profile = this.song.life.lastShowProfile;
      profile.preparePreview(this, sourceScope);
      const request = new TShowPreparation(this, profile, this.sourceScope,
        { event: sourceScope ? 'Show.Next' : 'Song.Open', entryKey: this.song.identity.entryKey });
      return request.prepare((source) => {
        this.showSource = source;
        return this.song.opened ? profile.showPreview(this, source) : true;
      }, 'Show.PreviewReady');
    }

    onClose({ current }) {
      if (current) return;
      this.preparation?.cancel('song-closed');
      this.portal()?.closeIdle?.(this.song.preview);
      this.portal()?.close?.(this.song.preview);
    }

    onPlaybackStart(playback) {
      playback.playbackEnvironment = new TShowPlaybackEnvironment(playback);
      return playback.playbackEnvironment.onPlaybackStart(playback);
    }

    onRenderingChanged(active) {
      const environment = this.song.playback?.playbackEnvironment;
      if (environment && !environment.dead) environment.onRenderingChanged(active);
      else this.portal()?.setRenderingActive?.(active);
    }

    snapshot() {
      return { ...super.snapshot(), playAni: this.playAni.snapshot(),
        sourceScope: this.sourceScope || null, songTVAbsent: this.songTVAbsent, showSource: this.showSource || null,
        preparation: this.preparation?.snapshot() || null,
        playbackEnvironment: this.song.playback?.playbackEnvironment?.snapshot() || null };
    }

    die(reason = 'environment-died') {
      if (this.dead) return;
      this.playAni.die(reason);
      super.die(reason);
    }
  }

  class TShowPlaybackEnvironment extends core.LifeObject {
    constructor(playback) {
      super(playback, 'PlaybackEnvironment');
      this.playback = playback;
      this.song = playback.song;
      this.playAni = new PlayAniObj(this);
      this.firstVerseShown = false;
      this.grayUntilEnd = false;
      this.lastPlan = null;
      this.slideTimeline = null;
      this.overlayTimeline = null;
      this.scope.signal.addEventListener('abort', () => this.die('playback-scope-ended'), { once: true });
    }

    canRender() {
      return !this.dead && this.song.life.renderingActive
        && this.song.playback?.state === 'playing' && !audio.paused && !audio.ended;
    }

    portal() {
      return this.song.life.visualWorld.portal;
    }

    onPlaybackStart(playback, changingProfile = false) {
      const songEnvironment = this.song.environment;
      const launchSource = playback.profile.launchSource(playback);
      const preview = songEnvironment.preparation;
      const reuse = !changingProfile && preview?.current() && !preview.error
        && (!launchSource || songEnvironment.sourceScope === launchSource);
      playback.profile.configurePlayback(this, { changingProfile, reuse, launchSource });
      if (!changingProfile) {
        this.portal()?.closeIdle?.(this.song.preview);
        this.portal()?.open?.(this.song.preview, {
          keepImage: playback.profile.usesTV() && playback.sourceScope === 'song' && !songEnvironment.songTVAbsent,
          frame: playback.profile.usesTV() ? playback.profile.previewFrame() : null,
        });
        this.portal()?.start?.(this.song.preview);
      }
      // Keep the published show while its replacement is being prepared.
      if (!changingProfile) playback.showSource = null;
      this.preparation?.cancel('playback-selected-show');
      if (!reuse) preview?.cancel('playback-selected-show');
      const request = reuse ? preview.adopt(this) : new TShowPreparation(this,
        playback.profile, playback.sourceScope,
        { commandId: this.song.life.queue.current?.id || null,
          event: this.song.life.queue.current?.type || 'Playback.Start',
          revision: this.song.life.revision, runId: playback.runId, launch: playback.launch,
          profile: playback.profile.name, entryKey: this.song.identity.entryKey });
      if (!changingProfile) {
        if (playback.profile.initialFrame(this)?.mediaType === 'play-ani') this.portal()?.beforeFirstVerse?.(true);
        else this.portal()?.holdSongPreview?.();
      }
      if (!changingProfile) {
        this.firstVerseShown = false;
        this.noSeriesPortalShown = false;
      }
      this.lastPlan = null;
      this.slideTimeline?.die('playback-restarted');
      this.slideTimeline = new TVerseSlideTimeline(this, playback);
      this.overlayTimeline?.die('playback-restarted');
      this.overlayTimeline = new TOverlayTimeline(this, playback);
      if (!changingProfile) playback.profile.onSongStart(this);
      else if (audio.paused) this.portal()?.pause?.();
      else this.portal()?.playing?.();
      return request.prepare((source) => {
        playback.showSource = source;
        if (reuse) this.portal()?.closeIdle?.(this.song.preview);
        playback.profile.sourceReady(this);
        this.updateNoSeriesFlag();
        this.song.life.publish();
        return changingProfile ? true : this.portal()?.prepareStart?.(this.song.preview,
          playback.profile.initialFrame(this), request.signal);
      }, 'Show.Ready', 'ResourceFailure');
    }

    nextShow() {
      const playback = this.playback;
      if (this.dead || playback.dead || playback.state === 'failed' || playback.state === 'ended') return false;
      if (!playback.profile.usesTV() || this.song.environment.songTVAbsent) return false;
      this.onPlaybackStart(playback, true);
      if (playback.lastVerseDetail) playback.verse({ ...playback.lastVerseDetail, seeked: true });
      return true;
    }

    onPlaying() {
      window.VCardVisualization?.beginSong?.(this.playback.runId);
      if (this.playback.profile.shouldAdvanceScheme(this.playback)) {
        window.VCardDecoration?.beginSong?.(this.playback.runId, this.playback.profile.schemeChangePeriod());
      }
      this.portal()?.playing?.();
      if (this.presetReapplyRequested) {
        this.presetReapplyRequested = false;
        if (this.lastPlan && !this.updateNoSeriesFlag()) {
          this.slideTimeline?.enter({ ...this.lastPlan, seeked: true, restoring: true,
            restoreKind: this.slideTimeline?.slotKind || 'image' });
        }
      }
    }

    onPause() {
      this.portal()?.pause?.();
    }

    onResume() {
      this.portal()?.resume?.();
    }

    onProfileChange(playback, profile) {
      // Replace only visual work. Audio ownership, clocks and history survive.
      this.slideTimeline?.die('profile-changed');
      this.overlayTimeline?.die('profile-changed');
      playback.cancelOperation('profile-changed');
      playback.profile = profile;
      this.onPlaybackStart(playback, true);
    }

    onWaiting() {
      this.portal()?.waiting?.();
    }

    onSeek() {
      this.estimatedVerseSeeked = true;
      this.slideTimeline?.reset('seek');
      this.overlayTimeline?.reset('seek');
      this.portal()?.seek?.();
    }

    onSeeked() {
      this.portal()?.seeked?.();
      this.overlayTimeline?.updatePeriodic(Number(audio.currentTime) || 0, true);
    }

    updateNoSeriesFlag() {
      if (!this.playback.profile.noSongSeriesFlag(this.playback)) return false;
      if (!this.noSeriesPortalShown) {
        this.noSeriesPortalShown = true;
        document.dispatchEvent(new CustomEvent('vcard:set-images-visible', {
          detail: { visible: true },
        }));
      }
      if (this.slideTimeline?.plan) this.slideTimeline.reset('no-song-series');
      this.overlayTimeline?.continuousCrossAni(Number(audio.duration));
      return true;
    }

    observeTime() {
      const playback = this.playback;
      const noSeriesFlag = this.updateNoSeriesFlag();
      if (!noSeriesFlag) this.overlayTimeline?.updatePeriodic(Number(audio.currentTime) || 0);
      const estimated = playback.profile.estimateVerse(playback);
      if (estimated && !this.estimatedVersePending
        && (estimated.index !== playback.verseIndex || this.estimatedVerseSeeked || !this.lastPlan)) {
        this.estimatedVersePending = true;
        playback.life.queue.post(() => {
          this.estimatedVersePending = false;
          const detail = playback.profile.estimateVerse(playback);
          if (!detail) return;
          const seeked = Boolean(this.estimatedVerseSeeked);
          this.estimatedVerseSeeked = false;
          playback.verse({ ...detail, seeked });
        }, { type: 'Verse.Estimated', owner: playback, scope: playback.scope })
          .catch(() => { this.estimatedVersePending = false; });
      }
    }

    onTimeUpdate() {
      // Keep semantic estimated verse tracking when there is no visible scene.
      // Visible slides and overlays are updated only by the scene frame pass.
      if (!this.portal()?.frameActive?.(this.song.preview)) this.observeTime();
    }

    onTick(now = Number(audio.currentTime) || 0) {
      this.observeTime();
      this.slideTimeline?.update(now);
    }

    onRenderingChanged(active) {
      this.portal()?.setRenderingActive?.(active);
      if (this.song.playback?.state === 'failed') return;
      if (!active) {
        this.slideTimeline?.suspend();
        this.overlayTimeline?.suspend();
      } else {
        if (this.updateNoSeriesFlag()) {
          return;
        }
        if ((!this.lastPlan || !this.playback.profile.usesTV()) && this.song.playback?.profile.requiresIntro()) {
          const started = this.song.playback?.started && !audio.ended;
          if (started) this.playback.profile.onSongStart(this);
          else this.playback.profile.onSongOpen(this);
        }
        if (this.playback.profile.usesTV() && this.lastPlan && !['ended', 'failed'].includes(this.song.playback?.state)) {
          const shown = this.song.playback?.plan;
          const now = Number(audio.currentTime) || 0;
          const restoreKind = shown && now >= shown.displayStartsAt && now < shown.displayEndsAt
            ? this.slideTimeline?.slotKind : '';
          this.slideTimeline?.enter({ ...this.lastPlan, seeked: true, restoring: true, restoreKind });
        }
      }
    }

    onVerse(playback, detail, plan) {
      this.lastPlan = plan;
      if (this.updateNoSeriesFlag()) return;
      if (playback.profile.usesTV()) this.slideTimeline?.enter(plan);
      const crossAni = (plan?.effects || []).find((effect) => effect?.name === 'CrossAni');
      if (crossAni && Number.isFinite(Number(detail?.endsAt))) {
        this.overlayTimeline?.scheduleCrossAni(detail.endsAt, crossAni, {
          origin: 'Verse.End',
          verseIndex: Number.isInteger(detail.index) ? detail.index : -1,
        });
      }
    }

    async onEnd(playback, signal) {
      this.grayUntilEnd = false;
      this.song.life.publish();
      this.slideTimeline?.reset('song-ended');
      this.overlayTimeline?.reset('song-ended');
      this.preparation?.cancel('song-ended-before-show');
      this.portal()?.ended?.();
      await playback.profile.onSongEnd(this, playback, signal);
    }

    showFinal(playback) {
      this.slideTimeline?.reset('finished-stopped');
      this.overlayTimeline?.reset('finished-stopped');
      playback.profile.onStopped(this);
      this.portal()?.ended?.();
    }

    onFinalStopped(playback) {
      if (playback.playbackEnding) playback.playbackEnding.settleFinal();
      else this.showFinal(playback);
    }

    onEnded() {
      this.grayUntilEnd = false;
      this.portal()?.ended?.();
    }

    onFailed(playback) {
      this.grayUntilEnd = false;
      this.preparation?.cancel('playback-failed');
      this.slideTimeline?.die('playback-failed');
      this.overlayTimeline?.die('playback-failed');
      this.portal()?.failed?.();
    }

    snapshot() {
      return {
        ...super.snapshot(),
        playAni: this.playAni.snapshot(),
        firstVerseShown: this.firstVerseShown,
        grayUntilEnd: this.grayUntilEnd,
        sourceScope: this.playback.sourceScope,
        songTVAbsent: this.song.environment.songTVAbsent,
        showPreset: this.playback.showPreset || null,
        showSource: this.song.playback?.showSource || null,
        showSelection: this.portal()?.selectionSnapshot?.(this.song.preview) || null,
        preparation: this.preparation?.snapshot() || null,
        renderScheduled: this.canRender() && Boolean(this.portal()?.current?.().mainTrack.frameScheduled),
        slideTimeline: this.slideTimeline?.snapshot() || null,
        overlayTimeline: this.overlayTimeline?.snapshot() || null,
      };
    }

    die(reason = 'environment-died') {
      if (this.dead) return;
      this.slideTimeline?.die(reason);
      this.slideTimeline = null;
      this.overlayTimeline?.die(reason);
      this.overlayTimeline = null;
      this.playAni.die(reason);
      super.die(reason);
    }
  }

  class TDecorationSchedule {
    constructor(life) {
      this.life = life;
      this.colorBoundary = 0;
      this.pending = null;
      this.lastCompleted = null;
      this.sequence = 0;
    }

    take(time, colorPeriod) {
      const colorBoundary = Math.floor(time / colorPeriod);
      const due = { color: colorBoundary > this.colorBoundary };
      this.colorBoundary = colorBoundary;
      return due;
    }

    observe(result, completed) {
      const { completion, ...state } = result;
      if (!completion) { this.lastCompleted = state; return state; }
      const id = ++this.sequence;
      this.pending = { id, ...state };
      Promise.resolve(completion).catch((error) => ({ changed: false, pending: false,
        reason: 'decoration-failed', error: String(error?.message || error) })).then((settled) => {
        if (!this.life.scope.alive) return;
        return this.life.queue.post(() => {
          if (this.pending?.id !== id) return;
          this.pending = null;
          this.lastCompleted = settled;
          completed(settled);
          this.life.publish();
        }, { type: 'Decoration.Completed', owner: this.life, scope: this.life.scope });
      }).catch(() => {});
      return state;
    }
  }

  class VCDecor extends core.TDecorationProfile {
    constructor(life) {
      super(life, { name: 'VCDecor' });
      this.colorPeriod = VCPLAY_PARAMS.COLOR_CHANGE_PERIOD;
      this.schedule = new TDecorationSchedule(life);
      this.lastResult = null;
    }

    onEvent(event) {
      if (event?.type === 'Page.Reload') {
        this.schedule.colorBoundary = 0;
        this.lastResult = { changed: false, reason: 'page-reload' };
      }
      return super.onEvent(event);
    }

    onTick(context = {}) {
      this.lastEvaluationAt = Number(context.now) || Date.now();
      if (!this.life.pageVisible || this.life.pageSuspended) {
        this.lastResult = { changed: false, reason: 'page-hidden' };
        return this.lastResult;
      }
      const pageReloadTime = this.life?.pageReloadTime?.() || 0;
      const due = this.schedule.take(pageReloadTime, this.colorPeriod);
      const colorDue = due.color;
      const decoration = window.VCardDecoration;
      let color = null;
      if (colorDue) {
        color = decoration?.refreshActiveColor?.({ reason: 'VCDecor' }) || {
          changed: false,
          reason: 'decoration-control-unavailable',
        };
      }
      const result = {
        changed: Boolean(color?.changed),
        pending: false,
        reason: colorDue ? 'period-reached' : 'period-pending',
        color,
      };
      if (colorDue) {
        this.lastResult = this.schedule.observe(result,
          (settled) => { this.lastResult = settled; });
      }
      return result;
    }

    snapshot() {
      return {
        ...super.snapshot(),
        colorPeriod: this.colorPeriod,
        constants: Object.fromEntries(['COLOR_CHANGE_PERIOD']
          .map((name) => [name, VCPLAY_PARAMS[name]])),
        colorBoundary: this.schedule.colorBoundary,
        pendingChange: this.schedule.pending ? { ...this.schedule.pending } : null,
        lastCompletedChange: this.schedule.lastCompleted ? { ...this.schedule.lastCompleted } : null,
        lastResult: this.lastResult ? { ...this.lastResult } : null,
        colorBags: window.VCardDecoration?.colorBagSnapshot?.() || null,
      };
    }
  }

  class VCShowScenarios {
    constructor() { this.name = VCPLAY_SCENARIO_ID; this.life = null; this.profile = null; }
    onPageReload() {
      this.life.lastShowProfile = this.profileFor();
    }
    profileFor() {
      if (!this.profile) this.profile = new VCPlay(this.life);
      return this.profile;
    }
    createEnvironment(song) { return new TShowSongEnvironment(song); }
    createDecorationProfile(life) { return new VCDecor(life); }
    staticPlayAniDelay() { return VCPLAYER_FLOW.STATIC_PLAY_ANI_DELAY; }
    autoStartDelay() { return 0; }
    setMotionAllowed(allowed) { this.life?.visualWorld.portal?.setMotionAllowed?.(allowed); }
    snapshot() {
      return { scenario: VCPLAY_SCENARIO_ID, status: window.VCardBuild?.VCPlay?.status || null, playerConstants: { ...VCPLAYER_FLOW },
        profiles: this.profile ? [this.profile.snapshot()] : [] };
    }
  }

  class TPlaybackEnding extends core.LifeObject {
    constructor(playback, requiresOutro) {
      super(playback, 'PlaybackEnding');
      this.playback = playback;
      this.requiresOutro = requiresOutro;
      this.settled = false;
    }

    run(signal) {
      return this.playback.environment.onEnd(this.playback, signal);
    }

    settleFinal() {
      if (this.dead || this.settled) return;
      this.playback.environment.showFinal(this.playback);
      this.settled = true;
      super.die('ending-settled');
    }
  }


  class TShowProfile {
    constructor(life) {
      this.name = 'VCPlay';
      this.sourceRun = null;
      this.life = life;
      this.constants = VCPLAY_PARAMS;
      this.crossAniBags = new Map();
      this.crossAniStarts = new Map();
    }

    usesTV() { return false; }
    restoreColorScheme() { return false; }
    playHint() { return ''; }
    schemeChangePeriod() { return 1; }
    shouldAdvanceScheme() { return true; }
    cyclesNightTone() { return true; }
    followsColorScheme() { return false; }
    continuationDelay() { return VCPLAYER_FLOW.STATIC_PLAY_ANI_DELAY; }
    preloadScopes(entry) { return entry.hasShow ? ['song'] : []; }
    requiresIntro() { return true; }
    previewFrame() { return { mediaType: 'play-ani' }; }
    initialFrame() { return this.previewFrame(); }

    async prepareSource(environment, options) {
      const portal = environment.portal();
      const preview = environment.song.preview;
      if (this.usesTV()) return portal?.prepareShow?.(preview, {
        ...options, prepareResources: (sources) => portal.prepareSongMedia(preview, sources, options),
      });
      await portal?.prepareSongMedia?.(preview, [], options);
      return null;
    }

    preparePreview(environment) { environment.sourceScope = 'song'; }
    showPreview(environment) { return environment.portal()?.openIdle?.(environment.song.preview, this.previewFrame()); }
    launchSource() { return 'song'; }
    configurePlayback(environment) { environment.playback.sourceScope = 'song'; }
    sourceReady() {}
    selectResumeSource() {}

    onSongOpen(environment) { environment.playAni.show({ phase: 'start', motion: 'static' }); }
    onSongStart(environment) { environment.playAni.show({ phase: 'play', motion: 'animated' }); }
    onSongEnd(environment) { this.onStopped(environment); }
    onStopped(environment) { environment.playAni.show({ phase: 'finish', motion: 'static' }); }

    allowsCrossAni() { return true; }

    crossAniEffect() {
      if (!this.allowsCrossAni(this.life.playingSong)) return null;
      const p = this.constants;
      return p.CROSS_OPACITY > 0 ? { name: 'CrossAni', lead: p.CROSS_LEAD,
        unfade: p.CROSS_UNFADE, fade: p.CROSS_FADE, opacity: p.CROSS_OPACITY } : null;
    }

    crossAniPeriod(playback) {
      const text = playback.song.preview?.querySelector('.song__preview-text');
      return text?.dataset.trackBand?.trim() ? 0 : this.constants.CROSS_PERIOD;
    }

    planVerse(playback, detail, globalVerseCount) {
      const context = this.context(playback, { globalVerseNumber: globalVerseCount,
        isLastVerse: Boolean(detail.isLastVerse) });
      const p = this.constants;
      const effects = this.usesTV()
        ? [{ name: 'CrossImg', lead: p.IMG_LEAD, unfade: p.IMG_UNFADE, fade: p.IMG_FADE }] : [];
      const crossAni = this.crossAniEffect();
      if (!detail.isLastVerse && crossAni) effects.push(crossAni);
      return immutablePlan({ preview: detail.preview, index: detail.index,
        globalVerseNumber: globalVerseCount, context,
        slidesInVerse: p.SLIDES === 1 ? 1
          : detail.timingSource === 'estimated-lines' ? detail.slideBoundaries.length - 1 : p.SLIDES,
        timingSource: detail.timingSource || 'TrackBand',
        ...(p.SLIDES === 1 ? { slideBoundaries: [Number(detail.startsAt), Number(detail.endsAt)] }
          : detail.slideBoundaries ? { slideBoundaries: [...detail.slideBoundaries] } : {}),
        seeked: Boolean(detail.seeked),
        startsAt: Number.isFinite(Number(detail.startsAt)) ? Number(detail.startsAt) : null,
        endsAt: Number.isFinite(Number(detail.endsAt)) ? Number(detail.endsAt) : null,
        verseHandler: 'OnVerseStart', bindings: [], conditions: [], effects,
        profile: this.name, ruleSource: VCPLAY_SCENARIO_ID,
        first: playback.verseIndex === 0 && !playback.environment.firstVerseShown });
    }

    context(playback, extra = {}) {
      return { verse: (playback?.verseIndex ?? -1) + 1,
        globalVerseNumber: this.life.globalVerseCount,
        globalSlideNumber: this.life.globalSlideCount,
        isCurrentSong: Boolean(playback), isPlaying: !audio.paused && !audio.ended,
        isPaused: audio.paused, isFirstVerse: playback?.verseIndex === 0,
        ...extra };
    }

    createEnding(playback) {
      return new TPlaybackEnding(playback, this.usesTV());
    }

    commitDisplay(plan, natural = true, kind = '') {
      if (!natural || !this.life) return;
      this.life.globalSlideCount = Math.max(Number(this.life.globalSlideCount) || 0, Number(plan?.globalSlideNumber) || 0);
      this.life.event('Slide.Show', { kind, globalSlideNumber: this.life.globalSlideCount });
    }

    reserveCrossAni(collection, items, origin = null) {
      if (!this.crossAniBags.has(collection)) this.crossAniBags.set(collection,
        new core.TShuffleBag([...new Set(items)], (item) => item,
          this.life.random.stream(`crossAni.${this.name}`)));
      const bag = this.crossAniBags.get(collection);
      const reservation = bag.reserve({ origin });
      if (!reservation) return null;
      return { ...reservation, invalidate: () => {
        bag.invalidate(reservation.item);
      } };
    }

    crossAniStart(source, duration, showDuration, minimumGap) {
      const maximum = Math.max(0, duration - showDuration);
      const stream = this.life.random.stream(`crossAni.${this.name}`);
      const previous = this.crossAniStarts.get(source);
      let result = stream.next('start-offset') * maximum;
      if (Number.isFinite(previous) && maximum >= minimumGap) {
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const candidate = stream.next('start-offset-retry') * maximum;
          if (Math.abs(candidate - previous) >= minimumGap) {
            result = candidate;
            break;
          }
        }
      }
      this.crossAniStarts.set(source, result);
      return result;
    }

    snapshot() {
      return { name: this.name, ruleSource: VCPLAY_SCENARIO_ID,
        sourceRun: this.sourceRun, usesTV: this.usesTV(), constants: { ...this.constants }, slidesInVerse: this.constants.SLIDES,
        crossAniBags: [...this.crossAniBags].map(([collection, bag]) => ({
          collection, total: bag.items.length, remaining: bag.remaining.length,
          reserved: bag.reservation?.item || null, last: bag.last, invalid: bag.invalid.size,
        })) };
    }

    noSongSeriesFlag() { return false; }
    estimateVerse() { return null; }
  }

  window.VCLifeShow = Object.freeze({
    Profile: TShowProfile,
    immutablePlan,
    start({ Profile = TShowProfile, playerConstants = {}, playConstants = {} } = {}) {
      if (window.VCLife) return window.VCLife;
      VCPlay = Profile;
      VCPLAYER_FLOW = Object.freeze({ ...PLAYER_DEFAULTS, ...playerConstants });
      VCPLAY_PARAMS = Object.freeze({ ...PLAY_DEFAULTS, ...playConstants });
      try {
        for (const [values, defaults] of [[playerConstants, PLAYER_DEFAULTS],
          [playConstants, PLAY_DEFAULTS]]) {
          for (const name of Object.keys(values)) {
            if (!Object.hasOwn(defaults, name)) throw new Error(`Unknown scenario constant ${name}`);
          }
        }
        ['STATIC_PLAY_ANI_DELAY'].forEach((name) => {
          if (!Number.isFinite(VCPLAYER_FLOW[name]) || VCPLAYER_FLOW[name] < 0) {
            throw new Error(`VCPlayer constant ${name} must be a finite non-negative number`);
          }
        });
        ['COLOR_CHANGE_PERIOD', 'CROSS_PLAYBACK_RATE'].forEach((name) => {
          if (!Number.isFinite(VCPLAY_PARAMS[name]) || VCPLAY_PARAMS[name] <= 0) {
            throw new Error(`VCPlay constant ${name} must be a positive finite number`);
          }
        });
        for (const [name, value] of Object.entries(VCPLAY_PARAMS)) {
          if (!Number.isFinite(value) || value < 0) throw new Error(`VCPlay constant ${name} must be finite and non-negative`);
        }
        if (['CROSS_OPACITY', 'CROSS_MANUAL_OPACITY', 'CROSS_CONTINUOUS_OPACITY']
          .some((name) => VCPLAY_PARAMS[name] > 1)
          || !Number.isInteger(VCPLAY_PARAMS.SLIDES) || VCPLAY_PARAMS.SLIDES < 1) {
          throw new Error('VCPlay requires CrossAni opacities in 0..1 and a positive integer SLIDES');
        }
      } catch (error) {
        window.VCardBootstrap?.setState('Failed', error);
        return;
      }

      let life;
      try {
        // Only a build carrying the diagnostic stylesheet accepts a repeatable seed.
        const seedText = document.querySelector(
          'link[href*="vcard-debug.css"], style[data-vcard-source$="vcard-debug.css"]'
        ) ? new URLSearchParams(window.location.search).get('debug-seed') : null;
        const randomSeed = seedText !== null && /^\d{1,10}$/.test(seedText)
          && Number(seedText) <= 0xFFFFFFFF ? Number(seedText) : null;
        life = new core.TVCLife({ audio, scenario: new VCShowScenarios(),
          randomSeed,
          activateAudio: window.VCardMediaLoader?.activateAudio,
          prepareAudio: window.VCardMediaLoader?.prepareAudio });
      } catch (error) {
        window.VCardBootstrap?.setState('Failed', error);
        return;
      }
      window.VCLife = life;
      const command = (type, apply) => life.queue.run(apply, { type, owner: life, scope: life.scope });
      window.VCardEnvironment?.connect((apply) => life.queue.post(() => {
        apply();
        life.setRenderingState({ pageVisible: window.VCardEnvironment.snapshot().visible });
        life.setMotionAllowed(window.VCardMotionPolicy?.snapshot().motionAllowed !== false);
        life.publish();
      }, { type: 'Environment.Change', owner: life, scope: life.scope, coalesce: true }));
      command('Motion.Initial', () => life.setMotionAllowed(window.VCardMotionPolicy?.snapshot().motionAllowed !== false));
      const mediaSessionResumeSong = () => life.playbackChain.phase === 'AudioPaused'
        ? life.playbackChain.song || life.playingSong
        : life.openedSong || life.playingSong;
      const selectResumeSource = (preview, surface) => life.scenario.profileFor().selectResumeSource(preview, surface);
      const playbackCommands = Object.freeze({
        'Song.Open': ({ target }) => life.open(target),
        'Song.Close': ({ target }) => life.close(target),
        'Song.ToggleCard': (input) => window.VCardSongControls?.toggleCard(input) || false,
        'Verse.Play': (input) => window.VCardSongControls?.playVerse(input) || false,
        'Playlist.Select': (input) => window.VCardSongControls?.selectPlaylist(input) || false,
        'Catalog.ShowMap': (input) => window.VCardSongControls?.showMap(input) || false,
        'Playback.Start': ({ target, options }) => life.start(target, options),
        'Playback.Resume': ({ source }) => {
          const surface = source === 'MediaSession' ? null : 'player';
          selectResumeSource((life.openedSong || life.playingSong)?.preview, surface);
          return source === 'MediaSession' && life.playbackChain.phase === 'AudioPaused'
            ? life.toggle(mediaSessionResumeSong()?.preview, { surface: null }) : life.resume({ surface });
        },
        'Playback.Pause': () => life.pause(),
        'Playback.Stop': () => life.stop(),
        'Playback.Seek': ({ position, offset }) => {
          const requested = position ?? audio.currentTime + offset;
          audio.currentTime = Math.min(audio.duration, Math.max(0, requested));
          return true;
        },
        'Playback.CancelContinuation': ({ reason }) => life.cancelContinuation(reason),
        'Playback.Toggle': ({ target, options }) => {
          selectResumeSource(target, options?.surface === undefined ? 'player' : options.surface);
          return life.toggle(target, options);
        },
        'Verse.Enter': ({ detail }) => life.verse(detail),
        'Portal.Close': () => window.VCardPortalContext?.close() || false,
        'Portal.TogglePlayback': (input) => window.VCardPortal?.togglePlayback(input) || false,
        'Portal.StepSize': (input) => window.VCardPortalContext?.stepSize(input) || false,
        'Portal.Expand': (input) => window.VCardPortalContext?.expand(input) || false,
        'Portal.SetSize': (input) => window.VCardPlayerControls?.setSize(input) || false,
        'Portal.ToggleVisibility': (input) => window.VCardPlayerControls?.toggleVisibility(input) || false,
        'Player.Set': (input) => window.VCardPlayerControls?.set(input) || false,
        'Player.Sound': (input) => window.VCardPlayerControls?.setSound(input) || false,
        'Player.Seek': (input) => window.VCardPlayerControls?.seek(input) || false,
        'Player.TogglePlayback': (input) => window.VCardPlayerControls?.togglePlayback(input) || false,
        'Track.Navigate': (input) => window.VCardPlayerControls?.navigate(input) || false,
        'Settings.Close': () => window.VCardSettingsContext?.close() || false,
        'Settings.Toggle': ({ target }) => window.VCardSettingsContext?.toggle(target) || false,
        'Settings.Set': (input) => window.VCardSettingsContext?.set(input) || false,
        'Color.Preset': (input) => window.VCardDecoration?.applyPreset(input) || false,
        'Song.CopyLink': (input) => (input.source === 'SongMap'
          ? window.VCardSongControls?.copyLink(input) : window.VCardSettingsContext?.copyLink(input)) || false,
        'Song.Download': (input) => window.VCardSettingsContext?.download(input) || false,
        'Data.Reset': (input) => window.VCardSettingsContext?.reset(input) || false,
        'MediaCache.Action': (input) => window.VCardSettingsContext?.cache(input) || false,
      });
      const commandAvailable = (input = {}) => {
        const { type, target } = input;
        if (life.dead || life.queue.closed || !Object.hasOwn(playbackCommands, type)) return false;
        if (input.source === 'MediaSession'
          && ['Playback.Resume', 'Playback.Pause', 'Playback.Stop'].includes(type)
          && input.trackRunId !== life.playingSong?.playback?.runId) return false;
        if (type === 'Song.ToggleCard') return Boolean(window.VCardSongControls?.canToggleCard(input));
        if (type === 'Verse.Play') return Boolean(window.VCardSongControls?.canPlayVerse(input));
        if (type === 'Playlist.Select') return Boolean(window.VCardSongControls?.canSelectPlaylist(input));
        if (type === 'Catalog.ShowMap') return Boolean(window.VCardSongControls?.canShowMap(input));
        if (type === 'Portal.Close') return Boolean(window.VCardPortalContext?.available());
        if (type === 'Portal.TogglePlayback') return Boolean(window.VCardPortal?.canTogglePlayback(input));
        if (type === 'Portal.StepSize' || type === 'Portal.Expand') {
          return Boolean(window.VCardPortalContext?.canResize(input));
        }
        if (type === 'Portal.SetSize') return Boolean(window.VCardPlayerControls?.canSetSize(input));
        if (type === 'Portal.ToggleVisibility') return Boolean(window.VCardPlayerControls?.canToggleVisibility(input));
        if (type === 'Player.Set') return Boolean(window.VCardPlayerControls?.canSet(input));
        if (type === 'Player.Sound') return Boolean(window.VCardPlayerControls?.canSetSound(input));
        if (type === 'Player.Seek') return Boolean(window.VCardPlayerControls?.canSeek(input));
        if (type === 'Player.TogglePlayback') return Boolean(window.VCardPlayerControls?.canTogglePlayback(input));
        if (type === 'Track.Navigate') return Boolean(window.VCardPlayerControls?.canNavigate(input));
        if (type === 'Settings.Close') return Boolean(window.VCardSettingsContext?.available());
        if (type === 'Settings.Toggle') return Boolean(window.VCardSettingsContext?.canToggle(target));
        if (type === 'Settings.Set') return Boolean(window.VCardSettingsContext?.canSet(input));
        if (type === 'Color.Preset') return Boolean(window.VCardDecoration?.canPreset(input));
        if (type === 'Song.CopyLink') return Boolean(input.source === 'SongMap'
          ? window.VCardSongControls?.canCopyLink(input) : window.VCardSettingsContext?.canCopyLink(input));
        if (type === 'Song.Download') return Boolean(window.VCardSettingsContext?.canDownload(input));
        if (type === 'Data.Reset') return Boolean(window.VCardSettingsContext?.canReset(input));
        if (type === 'MediaCache.Action') return Boolean(window.VCardSettingsContext?.canCache(input));
        if (type === 'Playback.Stop') {
          return ['ReadyPaused', 'AudioPlaying', 'AudioPaused', 'AudioBuffering',
            'OutroRunning', 'NextPending', 'FinishedStopped'].includes(life.playbackChain.phase);
        }
        if (type === 'Playback.Seek') {
          return ['AudioPlaying', 'AudioPaused'].includes(life.playbackChain.phase)
            && Boolean(life.playingSong?.playback && !life.playingSong.playback.dead)
            && input.trackRunId === life.playingSong.playback.runId
            && Number.isFinite(audio.duration) && audio.duration > 0 && Number.isFinite(audio.currentTime)
            && (Number.isFinite(input.position) && input.offset === undefined
              || input.position === undefined && Number.isFinite(input.offset));
        }
        if (input.source === 'MediaSession' && type === 'Playback.Resume') {
          const song = mediaSessionResumeSong();
          return Boolean(song && window.VCardCatalogView?.forPreview(song.preview)?.playable
            && (['ReadyPaused', 'AudioPaused', 'FinishedStopped'].includes(life.playbackChain.phase)
              || life.playbackChain.phase === 'Idle' && life.openedSong));
        }
        if (input.source === 'MediaSession' && type === 'Playback.Pause') {
          return ['AudioPlaying', 'AudioBuffering', 'OutroRunning', 'NextPending'].includes(life.playbackChain.phase)
            || life.playbackChain.phase === 'ReadyPaused' && life.playbackChain.autoReadyPending;
        }
        if (type === 'Playback.Start' || type === 'Playback.Toggle') {
          return Boolean(window.VCardCatalogView?.forPreview(target)?.playable);
        }
        if (type === 'Song.Open' || type === 'Song.Close') {
          return Boolean(window.VCardCatalogView?.forPreview(target));
        }
        if (type === 'Playback.Resume') return Boolean(life.openedSong || life.playingSong);
        if (type === 'Playback.Pause') return Boolean(life.openedSong || life.playingSong);
        if (type === 'Verse.Enter') return Boolean(life.playingSong?.playback && !life.playingSong.playback.dead);
        return true;
      };
      const dispatchCommand = (input) => {
        if (!commandAvailable(input)) return false;
        // Coordinators retain the gesture stack and order of their queued lifecycle commands.
        if (['Track.Navigate', 'Player.TogglePlayback', 'Portal.TogglePlayback', 'Song.ToggleCard',
          'Verse.Play', 'Playlist.Select', 'Catalog.ShowMap', 'Song.CopyLink'].includes(input.type)) {
          return playbackCommands[input.type](input);
        }
        return command(input.type, () => commandAvailable(input) ? playbackCommands[input.type](input) : false);
      };
      window.VCCommands = Object.freeze({ available: commandAvailable, dispatch: dispatchCommand });
      window.VCPlayer = Object.freeze({
        nextShow: () => command('Show.Next', () => {
          const song = life.openedSong || life.playingSong;
          if (!song) return false;
          const environment = song.playback?.playbackEnvironment;
          if (environment && !song.playback.dead && !['ended', 'failed'].includes(song.playback.state)) return environment.nextShow();
          life.visualWorld.portal?.close?.(song.preview);
          song.environment.prepareShow('song');
          return true;
        }),
        grayShow: () => command('Show.GrayUntilEnd', () => {
          const playback = life.playingSong?.playback;
          const environment = playback?.playbackEnvironment;
          if (!environment || playback.dead || ['ended', 'failed'].includes(playback.state)) return false;
          environment.grayUntilEnd = true;
          environment.slideTimeline?.reset('show-gray');
          if (playback.lastVerseDetail) playback.verse({ ...playback.lastVerseDetail, seeked: true });
          life.publish();
          return true;
        }),
        open: (target) => dispatchCommand({ type: 'Song.Open', target }),
        close: (target) => dispatchCommand({ type: 'Song.Close', target }),
        start: (target, options) => dispatchCommand({ type: 'Playback.Start', target, options }),
        resume: () => dispatchCommand({ type: 'Playback.Resume' }),
        pause: () => dispatchCommand({ type: 'Playback.Pause' }),
        stop: () => dispatchCommand({ type: 'Playback.Stop' }),
        seek: (position) => dispatchCommand({ type: 'Playback.Seek', position,
          trackRunId: life.playingSong?.playback?.runId }),
        cancelContinuation: (reason) => dispatchCommand({ type: 'Playback.CancelContinuation', reason }),
        toggle: (target, options) => dispatchCommand({ type: 'Playback.Toggle', target, options }),
        verse: (detail) => dispatchCommand({ type: 'Verse.Enter', detail }),
        setCompleteHandler: (handler) => life.setCompleteHandler(handler),
        current: () => life.snapshot(),
        previousHistory: () => life.previousHistory(),
        recentSong: (songId) => life.selectionMemory.contains(songId),
        recentPlaylist: (listId) => life.selectionMemory.containsList(listId),
        releaseAvailable: (releaseKey) => !life.playlistSelector.invalid.has(releaseKey),
        randomStream: (name) => life.random.stream(name),
        reserveCrossAni: (collection, items, origin) => life.playingSong?.playback?.profile?.reserveCrossAni?.(collection, items, origin),
        crossAniStart: (...args) => life.playingSong?.playback?.profile?.crossAniStart?.(...args),
        crossAniParameters: () => life.lastShowProfile.constants,
        reserveAutoNext: (releaseKey) => life.queue.current
          ? life.playlistSelector.reserve(releaseKey)
          : command('Selection.Reserve', () => life.playlistSelector.reserve(releaseKey)),
        diagnostics: Object.freeze({ current: () => life.snapshot() }),
        decisionTrace: () => life.random.traceSnapshot(),
        dispose: () => life.dispose(),
      });

      class TMediaSessionBridge {
        constructor(owner) {
          this.owner = owner;
          this.disposed = false;
          this.session = navigator.mediaSession;
          this.actions = [];
          this.lastState = null;
          this.metadataKey = undefined;
          this.positionKey = undefined;
          this.positionSupported = typeof this.session?.setPositionState === 'function';
          if (!this.session) return;
          const playbackAction = (type, data = {}) => {
            const input = { ...data, type, source: 'MediaSession', trusted: false,
              trackRunId: owner.playingSong?.playback?.runId };
            if (!commandAvailable(input)) return;
            if (type === 'Playback.Resume') {
              document.dispatchEvent(new CustomEvent('vcard:prepare-audio-context'));
            }
            dispatchCommand(input);
          };
          const handlers = {
            play: () => playbackAction('Playback.Resume'),
            pause: () => playbackAction('Playback.Pause'),
            stop: () => playbackAction('Playback.Stop'),
            seekto: (detail) => playbackAction('Playback.Seek', { position: detail.seekTime }),
            seekbackward: (detail) => {
              const offset = detail.seekOffset ?? 10;
              if (Number.isFinite(offset) && offset >= 0) playbackAction('Playback.Seek', { offset: -offset });
            },
            seekforward: (detail) => {
              const offset = detail.seekOffset ?? 10;
              if (Number.isFinite(offset) && offset >= 0) playbackAction('Playback.Seek', { offset });
            },
            previoustrack: () => window.VCardPlayerControls?.requestNavigation(-1, 'MediaSession'),
            nexttrack: () => window.VCardPlayerControls?.requestNavigation(1, 'MediaSession'),
          };
          for (const [action, handler] of Object.entries(handlers)) {
            try {
              this.session.setActionHandler(action, (detail) => {
                if (this.disposed || owner.dead || owner.scope.signal.aborted) return;
                try { handler(detail); }
                catch (error) { this.reportFailure(error, `Action.${action}`); }
              });
              this.actions.push(action);
            } catch (error) {
              console.debug(`VCard media session ${action} is unavailable.`, error);
            }
          }
          document.addEventListener('vcard:vcplayer-state', (event) => this.publish(event.detail),
            { signal: owner.scope.signal });
          for (const event of ['timeupdate', 'loadedmetadata', 'durationchange', 'ratechange', 'seeked', 'emptied']) {
            audio.addEventListener(event, () => this.publishPosition(), { signal: owner.scope.signal });
          }
          owner.scope.signal.addEventListener('abort', () => this.dispose(), { once: true });
          this.publish(owner.snapshot());
        }

        reportFailure(error, stage) {
          if (this.disposed || this.owner.dead || this.owner.scope.signal.aborted || error?.name === 'AbortError') return;
          const type = `MediaSession.${stage}`;
          if (error?.name === 'NotSupportedError') {
            console.debug(`VCard ${type} is unavailable.`, error);
            return;
          }
          const owner = { id: type };
          this.owner.queue.post(() => this.owner.reportFault(error, { type, owner }), {
            type, owner, scope: this.owner.scope,
          });
        }

        publish(snapshot) {
          if (!this.session || this.disposed || this.owner.dead || this.owner.scope.signal.aborted) return;
          const chain = snapshot.playbackChain;
          const state = ['AudioPlaying', 'AudioBuffering', 'OutroRunning', 'NextPending'].includes(chain.phase)
            || chain.phase === 'ReadyPaused' && chain.autoReadyPending ? 'playing'
            : ['ReadyPaused', 'AudioPaused', 'FinishedStopped'].includes(chain.phase) ? 'paused' : 'none';
          if (state !== this.lastState) {
            this.lastState = state;
            try { this.session.playbackState = state; }
            catch (error) { this.reportFailure(error, 'State'); }
          }
          this.publishPosition(chain.phase);
          if (typeof MediaMetadata !== 'function') return;
          const playing = ['Starting', 'AudioPlaying', 'AudioPaused', 'AudioBuffering',
            'OutroRunning', 'NextPending', 'FinishedStopped'].includes(chain.phase);
          const song = playing ? snapshot.playingSong || snapshot.openedSong : snapshot.openedSong;
          const entry = window.VCardCatalog?.get(song?.entryKey);
          const key = entry?.entryKey || null;
          if (key === this.metadataKey) return;
          this.metadataKey = key;
          try {
            this.session.metadata = entry ? new MediaMetadata({ title: entry.title, artist: entry.author }) : null;
          } catch (error) { this.reportFailure(error, 'Metadata'); }
        }

        publishPosition(phase = this.owner.playbackChain.phase) {
          if (!this.positionSupported || this.disposed || this.owner.dead || this.owner.scope.signal.aborted) return;
          const valid = ['AudioPlaying', 'AudioPaused'].includes(phase)
            && this.owner.audioChannel.owner === this.owner.playingSong?.playback
            && Number.isFinite(audio.duration) && audio.duration > 0 && Number.isFinite(audio.currentTime)
            && Number.isFinite(audio.playbackRate) && audio.playbackRate !== 0;
          const position = valid ? { duration: audio.duration, playbackRate: audio.playbackRate,
            position: Math.min(audio.duration, Math.max(0, audio.currentTime)) } : null;
          const key = position ? JSON.stringify(position) : null;
          if (key === this.positionKey) return;
          this.positionKey = key;
          try { this.session.setPositionState(position || {}); }
          catch (error) {
            this.positionSupported = false;
            this.reportFailure(error, 'Position');
          }
        }

        dispose() {
          if (this.disposed) return;
          this.disposed = true;
          for (const action of this.actions) {
            try { this.session.setActionHandler(action, null); }
            catch (error) { console.debug(`VCard media session ${action} cleanup failed.`, error); }
          }
          this.actions.length = 0;
          if (this.positionSupported) {
            try { this.session.setPositionState({}); }
            catch (error) { console.debug('VCard media session position cleanup failed.', error); }
          }
          try { this.session.playbackState = 'none'; this.session.metadata = null; }
          catch (error) { console.debug('VCard media session state cleanup failed.', error); }
        }
      }
      life.mediaSessionBridge = new TMediaSessionBridge(life);

      let lastScheme = null;
      document.addEventListener('vcard:preset-state', (event) => {
        const scheme = event.detail?.key;
        if (!scheme || scheme === lastScheme) return;
        lastScheme = scheme;
        const playback = life.playingSong?.playback;
        if (!playback?.profile.followsColorScheme()) return;
        command('Color.Scheme', () => {
          const timeline = playback.environment.slideTimeline;
          if (playback.dead || !timeline?.pending) return;
          timeline.clearReservation('color-scheme-changed');
          timeline.reserve();
        });
      }, { signal: life.scope.signal });
      document.addEventListener('vcard:palette-applied', (event) => {
        command('Decoration.Color.Applied', () => life.decorationProfile.changed('Color', {
          ...event.detail, profile: life.decorationProfile.name,
          pageReloadTime: life.pageReloadTime(),
        }));
      }, { signal: life.scope.signal });

      document.addEventListener('vcard:background-applied', (event) => {
        command('Decoration.Background.Applied', () => life.decorationProfile.changed('Background', {
          ...event.detail, profile: life.decorationProfile.name,
          pageReloadTime: life.pageReloadTime(),
        }));
      }, { signal: life.scope.signal });

      document.addEventListener('vcard:motion-state', (event) => {
        if (life.motionAllowed === event.detail?.motionAllowed) return;
        if (life.queue.current) life.setMotionAllowed(event.detail?.motionAllowed);
        else command('Motion.Change', () => life.setMotionAllowed(event.detail?.motionAllowed));
      }, { signal: life.scope.signal });
      document.addEventListener('vcard:service-worker-state', () => {
        command('ServiceWorker.State', () => life.publish());
      }, { signal: life.scope.signal });
      document.addEventListener('vcard:playlist-selection', () => {
        if (life.queue.current) life.publish();
        else command('Playlist.State', () => life.publish());
      }, { signal: life.scope.signal });
      document.addEventListener('vcard:font-scale-state', () => {
        if (life.queue.current) life.publish();
        else command('Text.Scale', () => life.publish());
      }, { signal: life.scope.signal });
      document.addEventListener('vcard:volume-boost-state', () => {
        if (life.queue.current) life.publish();
        else command('Audio.Boost', () => life.publish());
      }, { signal: life.scope.signal });
      document.addEventListener('vcard:color-scheme-state', () => {
        if (life.queue.current) life.publish();
        else command('Color.Scheme', () => life.publish());
      }, { signal: life.scope.signal });
      document.addEventListener('vcard:accent-state', () => {
        if (life.queue.current) life.publish();
        else command('Color.Settings', () => life.publish());
      }, { signal: life.scope.signal });
      ['vcard:background-state', 'vcard:visualization-state'].forEach((eventName) => {
        document.addEventListener(eventName, () => {
          if (life.queue.current) life.publish();
          else command('Background.State', () => life.publish());
        }, { signal: life.scope.signal });
      });
      document.addEventListener('vcard:trackplay-state', () => {
        if (life.queue.current) life.publish();
        else command('TrackPlay.State', () => life.publish());
      }, { signal: life.scope.signal });
      document.addEventListener('vcard:selection-settings-state', () => {
        if (life.queue.current) life.publish();
        else command('Selection.Settings', () => life.publish());
      }, { signal: life.scope.signal });
      const publishPortalLayout = () => {
        // Visibility publishes after Images.Visibility has updated the lifecycle model.
        const layout = window.VCardPortalLayout?.current(window.VCardSongControls?.currentPreview?.());
        if (!layout || layout.visible !== life.imagesVisible) return;
        if (life.queue.current) life.publish();
        else command('Portal.Layout', () => life.publish());
      };
      ['vcard:portal-state', 'vcard:portal-size'].forEach((eventName) => {
        document.addEventListener(eventName, publishPortalLayout, { signal: life.scope.signal });
      });
      window.addEventListener('error', (event) => {
        command('Browser.Error', () => life.reportFault(event.error || new Error(event.message || 'Browser error'),
          { type: 'Browser.Error', owner: life }, 'ComponentFailure', false));
      }, { signal: life.scope.signal });
      window.addEventListener('unhandledrejection', (event) => {
        command('Browser.Rejection', () => life.reportFault(event.reason, { type: 'Browser.Rejection', owner: life }, 'ComponentFailure', false));
      }, { signal: life.scope.signal });
      window.addEventListener('pagehide', (event) => {
        if (event.persisted) {
          command('Page.Suspend', () => life.setRenderingState({ suspended: true }));
          audio.pause();
        } else life.dispose();
      }, { signal: life.scope.signal });
      window.addEventListener('pageshow', (event) => {
        if (event.persisted) command('Page.Restore', () => life.setRenderingState({ suspended: false, pageVisible: !document.hidden }));
      }, { signal: life.scope.signal });
      document.addEventListener('vcard:images-visible-state', (event) => {
        command('Images.Visibility', () => life.setRenderingState({ imagesVisible: Boolean(event.detail?.visible) }));
      }, { signal: life.scope.signal });
      window.VCardSelectionReady?.();
      window.VCardDecoration?.initializeColors?.();
      window.VCardBootstrap?.setState('RuntimeReady');
      life.publish();
      window.VCardBootstrap?.setState('Interactive');
      return life;
    },
  });
})();
