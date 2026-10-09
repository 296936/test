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
  const VCPLAYER_FLOW = Object.freeze({
    STATIC_CASS_DELAY: 10,
  });
  const VC_DECOR = Object.freeze({
    COLOR_CHANGE_PERIOD: 120,
    BACK_CHANGE_PERIOD: 180,
  });
  // Implemented edition of the active prose above # ~ in docs/tvc_scen.md.
  const VCPLAY_IMPLEMENTED_VERSION = 'VCPlayV4';
  try {
    ['STATIC_CASS_DELAY'].forEach((name) => {
      if (!Number.isFinite(VCPLAYER_FLOW[name]) || VCPLAYER_FLOW[name] < 0) {
        throw new Error(`VCPlayer constant ${name} must be a finite non-negative number`);
      }
    });
    ['COLOR_CHANGE_PERIOD', 'BACK_CHANGE_PERIOD'].forEach((name) => {
      if (!Number.isFinite(VC_DECOR[name]) || VC_DECOR[name] <= 0) {
        throw new Error(`VCDecor constant ${name} must be a positive finite number`);
      }
    });
  } catch (error) {
    window.VCardBootstrap?.setState('Failed', error);
    return;
  }
  class CassObj extends core.LifeObject {
    constructor(environment) {
      super(environment, 'CassObj');
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
      this.environment.portal()?.showCassette?.({ phase, motion, fade, unfade });
    }

    snapshot() {
      return { ...super.snapshot(), phase: this.phase, motion: this.motion };
    }
  }

  class TCassSlidePolicy {
    constructor({ probability, minSlides, maxSlides, random, stream = null, enabled = true }) {
      this.enabled = enabled;
      this.probability = probability;
      this.minSlides = minSlides;
      this.maxSlides = maxSlides;
      this.random = random;
      this.stream = stream;
      this.tracedDecision = null;
      this.nonCassSlidesSinceCass = 0;
      this.nextDecisionId = 1;
      this.reservation = null;
      this.lastDecision = null;
    }

    reserveNext({ natural = true, imagesAvailable = true, origin = null } = {}) {
      const gapBefore = this.nonCassSlidesSinceCass;
      if (!natural) {
        return Object.freeze({
          id: 0,
          natural: false,
          kind: imagesAvailable ? 'image' : 'cassette',
          reason: 'restore',
          fallback: imagesAvailable ? 'none' : 'cassette',
          gapBefore,
          randomValue: null,
        });
      }
      if (this.reservation) {
        throw new Error('TCassSlidePolicy already has a reserved decision');
      }
      let kind = 'image';
      let reason = 'cooldown';
      let randomValue = null;
      if (!imagesAvailable) {
        kind = 'cassette';
        reason = 'no-show';
      } else if (this.enabled && gapBefore >= this.maxSlides) {
        kind = 'cassette';
        reason = 'forced';
      } else if (this.enabled && gapBefore >= this.minSlides) {
        randomValue = this.random();
        kind = randomValue < this.probability ? 'cassette' : 'image';
        reason = 'probability';
      }
      const traceStream = this.stream?.();
      this.tracedDecision = traceStream?.decision({ type: 'slide-kind', selected: kind,
        reason, gapBefore, randomValue, draw: traceStream.draws, result: 'Reserve',
        ...(origin ? { origin: { ...origin } } : {}) });
      const decision = Object.freeze({
        id: this.tracedDecision?.id || this.nextDecisionId++,
        natural: true,
        kind,
        reason,
        fallback: imagesAvailable ? 'none' : 'cassette',
        gapBefore,
        randomValue,
      });
      this.reservation = decision;
      return decision;
    }

    canCommit(decision) {
      return Boolean(decision?.natural && this.reservation?.id === decision.id);
    }

    commit(decision) {
      if (!this.canCommit(decision)) return false;
      this.nonCassSlidesSinceCass = decision.kind === 'cassette'
        ? 0
        : this.nonCassSlidesSinceCass + 1;
      this.lastDecision = { ...decision, committed: true };
      this.stream?.()?.finishDecision(this.tracedDecision, 'Commit', { gapAfter: this.nonCassSlidesSinceCass });
      this.tracedDecision = null;
      this.reservation = null;
      return true;
    }

    cancel(decision) {
      if (!decision?.natural) return false;
      if (!this.reservation || this.reservation.id !== decision.id) return false;
      this.lastDecision = { ...decision, committed: false };
      const tracedDecision = this.tracedDecision;
      this.tracedDecision = null;
      this.reservation = null;
      this.stream?.()?.finishDecision(tracedDecision, 'Cancel', { gapAfter: this.nonCassSlidesSinceCass });
      return true;
    }

    reset() {
      if (this.reservation) this.cancel(this.reservation);
      this.nonCassSlidesSinceCass = 0;
      this.reservation = null;
      this.lastDecision = null;
    }

    snapshot() {
      return {
        enabled: this.enabled,
        probability: this.probability,
        unit: 'natural-slide',
        scope: 'profile-page-life',
        minSlides: this.minSlides,
        maxSlides: this.maxSlides,
        nonCassSlidesSinceCass: this.nonCassSlidesSinceCass,
        reservation: this.reservation ? { ...this.reservation } : null,
        lastDecision: this.lastDecision ? { ...this.lastDecision } : null,
      };
    }
  }

  // One pending visible slide owns both its policy choice and scene resource.
  // Committed resources belong to the scene; cancellation never clears them.
  class TSlidePublication {
    constructor(owner, { ordinal, natural, decision, plan, entry = false }) {
      this.owner = owner;
      this.generation = owner.generation;
      this.ordinal = ordinal;
      this.natural = natural;
      this.decision = decision;
      this.plan = plan;
      this.kind = decision.kind;
      this.entry = entry;
      this.state = 'Reserved';
      this.resource = null;
      this.promise = null;
      this.preparation = null;
      this.reason = null;
      this.controller = new AbortController();
      this.renderScope = owner.renderScope;
      this.parentSignal = this.renderScope.signal;
      this.onAbort = () => this.cancel('render-scope-ended');
      this.parentSignal.addEventListener('abort', this.onAbort, { once: true });
      if (this.parentSignal.aborted) this.onAbort();
    }

    get terminal() {
      return ['Committed', 'Cancelled', 'Failed'].includes(this.state);
    }

    current() {
      return !this.terminal && !this.owner.dead
        && this.owner.publication === this
        && this.generation === this.owner.generation;
    }

    finish(state, reason = null) {
      if (this.terminal) return false;
      this.state = state;
      this.reason = reason;
      this.parentSignal.removeEventListener('abort', this.onAbort);
      let cleanupError = null;
      if (state !== 'Committed') {
        for (const cleanup of [
          () => this.preparation?.cancel(reason),
          () => this.controller.abort(),
          () => this.owner.playback.profile.cassSlidePolicy.cancel(this.decision),
          () => this.resource && this.owner.portal()?.cancelVerseDisplay?.(this.resource, reason),
        ]) {
          try { cleanup(); }
          catch (error) { cleanupError ||= error; }
        }
      }
      this.owner.lastPublication = this.snapshot();
      if (cleanupError) this.owner.playback.life.reportFault(cleanupError,
        { type: 'Slide.Cleanup', owner: this.owner }, 'ComponentFailure');
      return true;
    }

    cancel(reason) { return this.finish('Cancelled', reason); }
    fail(reason) { return this.finish('Failed', reason); }

    reject(error, operation = null) {
      if (abortError(error)) {
        this.cancel('operation-aborted');
        return Promise.resolve(false);
      }
      const life = this.owner.playback.life;
      return life.queue.post(() => {
        if (!this.current()) return false;
        operation?.fail(error);
        this.fail(error?.message || 'slide-operation-failed');
        life.reportFault(error, { type: 'Operation.Fail', owner: operation || this.owner },
          'ComponentFailure');
        return false;
      }, { type: 'Operation.Fail', owner: this.owner, scope: this.renderScope });
    }

    prepare() {
      if (this.promise) return this.promise;
      if (!this.current()) return Promise.resolve(false);
      this.state = 'Preparing';
      const operation = new core.TOperation(this.owner, 'slide-prepare');
      this.preparation = operation;
      this.promise = Promise.resolve().then(() => {
        if (!this.current()) return null;
        return this.owner.portal()?.prepareVerseDisplay?.({ kind: this.kind, plan: this.plan },
          operation.scope.signal);
      }).then(async (resource) => {
        const ready = await this.owner.playback.life.queue.post(() => {
          if (!this.current() || operation.status !== 'Running') return false;
          if (!resource) {
            // Exhausted media is an expected unavailable candidate, not an
            // exception in the controller. Preserve the existing main layer.
            operation.complete({ available: false, ordinal: this.ordinal });
            this.fail('preparation-unavailable');
            return false;
          }
          this.resource = resource;
          this.state = 'Ready';
          operation.complete({ available: true, ordinal: this.ordinal,
            resourceId: resource.id });
          return true;
        }, { type: 'Operation.Complete', owner: operation, scope: operation.scope });
        if (!ready && resource) {
          this.owner.portal()?.cancelVerseDisplay?.(resource, 'stale-publication');
        }
        return Boolean(ready);
      }).catch((error) => this.reject(error, operation));
      return this.promise;
    }

    async show() {
      if (!await this.prepare() || !this.current()) return false;
      this.state = 'Transitioning';
      const applied = await this.owner.portal()?.showVerseDisplay?.(
        this.resource, this.owner.timing(), this.controller.signal,
        (commitSurface) => this.owner.confirmDisplay(this, commitSurface)
      );
      if (!applied && this.current()) {
        // A paused commit retains a usable reservation for the existing retry.
        if (!this.entry && audio.paused && !this.resource.cancelled) this.state = 'Ready';
        else this.fail('surface-not-published');
      }
      return Boolean(applied);
    }

    snapshot() {
      return { type: 'SlidePublication', owner: this.owner.id,
        state: this.state, generation: this.generation, ordinal: this.ordinal,
        natural: this.natural, entry: this.entry, kind: this.kind,
        startsAt: this.plan.displayStartsAt, endsAt: this.plan.displayEndsAt,
        globalSlideNumber: this.plan.globalSlideNumber,
        color: Boolean(this.plan.conditions?.some((condition) =>
          condition.function === 'EveryNthGlobSlide' && condition.active)),
        preparation: this.preparation?.snapshot() ?? null,
        decision: { ...this.decision }, resourceId: this.resource?.id ?? null,
        physicalIndex: this.resource?.reservation?.index ?? null, reason: this.reason };
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
      this.publication = null;
      this.lastPublication = null;
      this.renderScope = this.scope.child({ id: `${this.id}:render` });
      this.scope.signal.addEventListener('abort', () => this.die('playback-scope-ended'), { once: true });
    }

    portal() {
      return this.environment.portal();
    }

    timing() {
      const available = Math.max(0, this.step);
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
      return Math.max(0, Math.min(
        this.count - 1,
        Math.floor(Math.max(0, now - this.startsAt) / this.step)
      ));
    }

    reserveSlotDecision(natural = true, ordinal = this.ordinal) {
      const plan = this.displayPlan(natural, ordinal);
      return this.playback.profile.cassSlidePolicy.reserveNext({ natural,
        origin: plan.decisionOrigin,
        imagesAvailable: Boolean(this.playback.showSource)
          && this.portal()?.hasVerseImages?.(plan) !== false });
    }

    displayPlan(natural = true, ordinal = this.ordinal, fallback = 'none') {
      const slotOrdinal = Math.max(0, Math.min(this.count - 1, ordinal));
      const displayStartsAt = this.step > 0
        ? this.startsAt + slotOrdinal * this.step
        : this.startsAt;
      const displayEndsAt = this.step > 0
        ? Math.min(this.endsAt, displayStartsAt + this.step)
        : this.endsAt;
      const plan = this.playback.profile.planDisplay(this.plan, natural, this.playback);
      return {
        ...plan,
        showFallback: fallback,
        decisionOrigin: this.decisionOrigin
          ? { ...this.decisionOrigin, slideOrdinal: slotOrdinal } : null,
        ...(!natural && this.plan.restoring && plan.portalFrame ? {
          portalFrame: { ...plan.portalFrame, pick: 'keep', keepPhysicalIndex: true },
        } : {}),
        displayStartsAt,
        displayEndsAt,
      };
    }

    clearReservation(reason = 'slot-reservation-cleared') {
      this.publication?.cancel(reason);
      this.publication = null;
    }

    createPublication(ordinal, natural, decision, entry = false) {
      const publication = new TSlidePublication(this, { ordinal, natural, decision, entry,
        plan: this.displayPlan(natural, ordinal, decision.fallback) });
      this.publication = publication;
      return publication;
    }

    confirmDisplay(publication, commitSurface) {
      return this.playback.life.queue.post(() => {
        const { plan, natural, kind, decision, ordinal, entry } = publication;
        if (!publication.current() || publication.state !== 'Transitioning'
          || this.playback.state === 'failed' || !this.playback.life.renderingActive
          || (natural && !this.playback.profile.cassSlidePolicy.canCommit(decision))) return false;
        if (!commitSurface()) return false;
        // The folder reservation is consumed only by an actual image commit.
        if (kind === 'image') {
          this.playback.showSelectionOperation?.complete(this.playback.showSource);
          if (this.playback.song.environment.showClaimed) {
            this.playback.song.environment.showOperation?.complete(this.playback.showSource);
          }
        }
        this.playback.plan = plan;
        this.slotKind = kind;
        this.ordinal = ordinal;
        this.busy = false;
        if (entry) this.environment.firstVerseShown = true;
        this.playback.profile.commitDisplay(plan, natural, kind, decision);
        publication.finish('Committed');
        this.publication = null;
        this.playback.life.publish();
        return true;
      }, { type: 'Slide.Commit', owner: this, scope: this.renderScope });
    }

    reserve(ordinal = this.ordinal + 1) {
      const requested = Math.max(0, Math.min(this.count - 1, ordinal));
      if (this.dead || !this.playback.life.renderingActive || !this.plan || requested <= this.ordinal) {
        return Promise.resolve(false);
      }
      if (this.publication && this.publication.ordinal !== requested) {
        this.clearReservation('superseded-slot');
      }
      if (this.publication) return this.publication.prepare();
      return this.createPublication(requested, true, this.reserveSlotDecision(true, requested)).prepare();
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
      this.count = Number.isInteger(plan.slidesInVerse) && plan.slidesInVerse >= 1
        ? plan.slidesInVerse
        : 1;
      this.startsAt = Number(plan.startsAt);
      this.endsAt = Number(plan.endsAt);
      const validRange = Number.isFinite(this.startsAt)
        && Number.isFinite(this.endsAt)
        && this.endsAt > this.startsAt;
      this.step = validRange ? (this.endsAt - this.startsAt) / this.count : 0;
      this.ordinal = this.targetOrdinal(Number(audio.currentTime) || 0);
      const initialOrdinal = this.ordinal;
      if (!this.playback.life.renderingActive) { this.busy = false; return false; }
      this.busy = true;
      await this.playback.showSourcePromise;
      if (this.dead || generation !== this.generation) return false;
      const choice = this.reserveSlotDecision(!plan.seeked);
      const decision = plan.restoring && plan.restoreKind
        ? Object.freeze({ ...choice, kind: plan.restoreKind }) : choice;
      const publication = this.createPublication(initialOrdinal, !plan.seeked, decision, true);
      try {
        const applied = await publication.show();
        if (this.dead || generation !== this.generation) return false;
        this.busy = false;
        if (applied && this.ordinal < this.count - 1) this.reserve(this.ordinal + 1);
        return applied;
      } catch (error) {
        await publication.reject(error);
        if (generation === this.generation) this.busy = false;
        return false;
      }
    }

    async advance(ordinal = this.ordinal + 1) {
      if (this.dead || !this.playback.life.renderingActive || !this.plan || this.busy) return;
      const generation = this.generation;
      const target = Math.max(0, Math.min(this.count - 1, ordinal));
      if (target <= this.ordinal) return;
      if (target > this.ordinal + 1) {
        // A throttled tab crossed several positions. Discard the choice made
        // for a stale boundary and choose once for the actual position.
        this.clearReservation('skipped-slot');
      }
      this.busy = true;
      let publication = null;
      try {
        if (!this.publication) this.reserve(target);
        publication = this.publication;
        const applied = publication ? await publication.show() : false;
        if (this.dead || generation !== this.generation) return;
        if (!applied) {
          if (!audio.paused || publication?.terminal) this.clearReservation('slot-apply-failed');
          return;
        }
        // Publish only the current position after a throttled interval.
        if (this.ordinal < this.count - 1) this.reserve(this.ordinal + 1);
      } catch (error) {
        await publication?.reject(error);
        if (generation === this.generation) this.clearReservation('slot-transition-failed');
      } finally {
        if (generation === this.generation) this.busy = false;
      }
    }

    update() {
      if (
        this.dead
        || !this.playback.life.renderingActive
        || !this.plan
        || this.busy
        || audio.paused
        || audio.ended
        || this.step <= 0
      ) return;
      const now = Number(audio.currentTime) || 0;
      const target = this.targetOrdinal(now);
      if (target > this.ordinal) {
        this.advance(target);
        return;
      }
      const timing = this.timing();
      if (this.ordinal >= this.count - 1) return;
      const nextBoundary = this.startsAt + (this.ordinal + 1) * this.step;
      if (now >= nextBoundary - timing.lead) this.advance(this.ordinal + 1);
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
      return {
        ...super.snapshot(),
        verse: this.plan?.index ?? -1,
        slidesCount: this.count,
        slideOrdinal: this.ordinal,
        slotKind: this.slotKind,
        publication: this.publication?.snapshot() ?? null,
        lastPublication: this.lastPublication,
        operations: [...(this.operations || [])].map((operation) => operation.snapshot()),
        lastOperation: this.lastOperation ?? null,
        reservedSlotKind: this.publication?.kind || '',
        reservedDecision: this.publication && !this.publication.entry ? { ...this.publication.decision } : null,
        entryDecision: this.publication?.entry ? { ...this.publication.decision } : null,
        reservedSlideNumber: this.publication?.plan.globalSlideNumber ?? null,
        nextAt: this.plan && this.step > 0
          ? (this.ordinal < this.count - 1
            ? this.startsAt + (this.ordinal + 1) * this.step
            : this.endsAt)
          : null,
        reserved: Boolean(this.publication && !this.publication.terminal),
        busy: this.busy,
      };
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
      this.pending = null;
      this.active = null;
      this.lastCue = null;
      this.nextCueId = 1;
      this.scope.signal.addEventListener('abort', () => this.die('playback-scope-ended'), { once: true });
    }

    portal() {
      return this.environment.portal();
    }

    scheduleHandsAni(anchorAt, effect = {}, detail = {}) {
      const boundaryAt = Number(anchorAt);
      if (this.dead || !Number.isFinite(boundaryAt)) return null;
      const lead = Math.max(0, Number(effect.lead) || 0);
      const unfade = Math.max(0, Number(effect.unfade) || 0);
      const fade = Math.max(0, Number(effect.fade) || 0);
      const cue = {
        id: this.nextCueId++,
        name: 'HandsAni',
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
          : 0.5,
      };
      if (this.pending) this.portal()?.cancelOverlay?.(this.pending, 'superseded');
      this.pending = cue;
      this.update();
      return cue;
    }

    update() {
      if (this.dead || !this.playback.life.renderingActive || audio.paused || audio.ended) return;
      const now = Number(audio.currentTime) || 0;
      if (this.active?.overlayStatus
        && this.active.overlayStatus !== 'active') {
        this.lastCue = { ...this.active, status: this.active.overlayStatus };
        this.active = null;
      }
      if (this.active && now >= this.active.endsAt) {
        this.portal()?.cancelOverlay?.(this.active, 'completed');
        this.lastCue = { ...this.active, status: 'completed' };
        this.active = null;
      }
      const cue = this.pending;
      if (!cue) return;
      if (cue.overlayStatus === 'active') {
        this.active = cue;
        this.pending = null;
        this.lastCue = { ...cue, status: 'active' };
        return;
      }
      if (cue.overlayStatus && !['preparing', 'ready'].includes(cue.overlayStatus)) {
        this.lastCue = { ...cue, status: cue.overlayStatus };
        this.pending = null;
        return;
      }
      if (now >= cue.endsAt) {
        this.portal()?.cancelOverlay?.(cue, 'missed');
        this.lastCue = { ...cue, status: 'missed' };
        this.pending = null;
        return;
      }
      if (this.active) {
        if (now < cue.startsAt) return;
        this.lastCue = { ...cue, status: 'skipped-active-overlay' };
        this.pending = null;
        return;
      }
      if (!cue.overlayStatus && !this.portal()?.prepareOverlay?.(cue, () => this.update())) {
        this.lastCue = { ...cue, status: 'skipped' };
        this.pending = null;
        return;
      }
      if (now < cue.startsAt) return;
      if (!this.portal()?.showOverlay?.(cue)) {
        this.portal()?.cancelOverlay?.(cue, 'skipped');
        this.lastCue = { ...cue, status: 'rejected' };
        this.pending = null;
        return;
      }
      if (cue.overlayStatus === 'active') {
        this.active = cue;
        this.pending = null;
      }
      this.lastCue = { ...cue, status: cue.overlayStatus || 'preparing' };
    }

    suspend() {
      if (this.pending) {
        this.portal()?.cancelOverlay?.(this.pending, 'rendering-suspended');
        delete this.pending.overlayStatus;
      }
      if (!this.active) return;
      const cue = this.active;
      this.portal()?.cancelOverlay?.(cue, 'rendering-suspended');
      if (!cue.handsAniShown) delete cue.handsAniSource;
      if (!this.pending) this.pending = cue;
      delete cue.overlayStatus;
      this.active = null;
    }

    reset(reason = 'overlay-timeline-reset') {
      if (this.active) this.portal()?.cancelOverlay?.(this.active, reason);
      if (this.pending) this.portal()?.cancelOverlay?.(this.pending, reason);
      this.active = null;
      this.pending = null;
    }

    snapshot() {
      return {
        ...super.snapshot(),
        pending: this.pending ? { ...this.pending, status: this.pending.overlayStatus || 'scheduled' } : null,
        active: this.active ? { ...this.active, status: 'active' } : null,
        lastCue: this.lastCue ? { ...this.lastCue } : null,
      };
    }

    die(reason = 'overlay-timeline-died') {
      if (this.dead) return;
      this.reset(reason);
      super.die(reason);
    }
  }

  class TShowSongEnvironment extends core.TSongEnvironment {
    constructor(song) {
      super(song);
      this.cassette = new CassObj(this);
    }

    portal() { return this.song.life.visualWorld.portal; }

    onOpen({ current }) {
      if (current) return;
      this.prepareShow();
    }

    prepareShow(sourceScope = null) {
      this.showOperation?.cancel('show-replaced');
      const profile = this.song.life.lastShowProfile;
      this.sourceScope = sourceScope || profile.chooseSource(this.song.identity.releaseKey);
      // Opening a card prepares its preview without changing the page palette.
      if (sourceScope) window.VCardDecoration?.applyShowPreset?.(this.sourceScope === 'global' ? 'mono' : 'duo');
      this.showClaimed = false;
      if (this.sourceScope === 'global') this.portal()?.openIdle?.(this.song.preview);
      const operation = this.showOperation = new core.TOperation(this, 'preview-show');
      this.showPromise = this.portal()?.prepareIdleShow?.(this.song.preview, {
        profile: profile.name, sourceScope: this.sourceScope,
        releaseId: this.song.identity.releaseId, releaseKey: this.song.identity.releaseKey,
        origin: { event: sourceScope ? 'Show.Next' : 'Song.Open', entryKey: this.song.identity.entryKey },
        signal: operation.scope.signal,
        isCurrent: () => !this.dead && this.showOperation === operation && !operation.scope.signal.aborted,
      }).then((source) => this.song.life.queue.post(() => {
        if (operation.scope.signal.aborted || this.dead) return null;
        this.showSource = source;
        if (this.song.opened && !this.showClaimed) this.portal()?.openIdle?.(this.song.preview, this.sourceScope === 'song' && source
          ? { styles: ['vc', 's_alarm'], mask: 'off', pick: 'shuffle-bag' } : null);
        this.song.life.publish();
        return source;
      }, { type: 'Show.PreviewSelected', owner: this, scope: operation.scope })).catch((error) => {
        if (!operation.scope.signal.aborted) {
          operation.fail(error);
          this.song.life.reportFault(error, { type: 'Show.PreviewSelected', owner: this }, 'ComponentFailure');
        }
        return null;
      });
      return this.showPromise;
    }

    onClose({ current }) {
      if (current) return;
      this.showOperation?.cancel('song-closed');
      this.showPromise = null;
      this.portal()?.closeIdle?.(this.song.preview);
      this.portal()?.close?.(this.song.preview);
    }

    onPlaybackStart(playback) {
      playback.playbackEnvironment = new TShowPlaybackEnvironment(playback);
      playback.playbackEnvironment.onPlaybackStart(playback);
    }

    onRenderingChanged(active) {
      const environment = this.song.playback?.playbackEnvironment;
      if (environment && !environment.dead) environment.onRenderingChanged(active);
      else this.portal()?.setRenderingActive?.(active);
    }

    snapshot() {
      return { ...super.snapshot(), cassette: this.cassette.snapshot(),
        sourceScope: this.sourceScope || null, showSource: this.showSource || null,
        playbackEnvironment: this.song.playback?.playbackEnvironment?.snapshot() || null };
    }

    die(reason = 'environment-died') {
      if (this.dead) return;
      this.showOperation?.cancel(reason);
      this.cassette.die(reason);
      super.die(reason);
    }
  }

  class TShowPlaybackEnvironment extends core.LifeObject {
    constructor(playback) {
      super(playback, 'PlaybackEnvironment');
      this.playback = playback;
      this.song = playback.song;
      this.cassette = new CassObj(this);
      this.firstVerseShown = false;
      this.grayUntilEnd = false;
      this.lastPlan = null;
      this.slideTimeline = null;
      this.overlayTimeline = null;
      this.frame = 0;
      this.renderTick = () => {
        this.frame = 0;
        if (!this.canRender()) return;
        this.onTick();
        this.syncRenderFrame();
      };
      this.scope.signal.addEventListener('abort', () => this.die('playback-scope-ended'), { once: true });
    }

    canRender() {
      return !this.dead && this.song.life.renderingActive
        && this.song.playback?.state === 'playing' && !audio.paused && !audio.ended;
    }

    syncRenderFrame() {
      if (!this.canRender()) {
        if (this.frame) window.VCardRenderScheduler.cancel(this.frame);
        this.frame = 0;
      } else if (!this.frame) {
        this.frame = window.VCardRenderScheduler.request(this.renderTick, { owner: this, priority: 5 });
      }
    }

    portal() {
      return this.song.life.visualWorld.portal;
    }

    onPlaybackStart(playback, changingProfile = false) {
      const songEnvironment = this.song.environment;
      const launchSource = playback.launch === 'portal' ? 'song'
        : playback.launch === 'player' ? 'global' : null;
      const reuse = !changingProfile && !songEnvironment.showClaimed && songEnvironment.showPromise
        && (!launchSource || songEnvironment.sourceScope === launchSource);
      songEnvironment.showClaimed = true;
      playback.sourceScope = reuse ? songEnvironment.sourceScope
        : changingProfile ? playback.sourceScope
          : launchSource || playback.profile.chooseSource(this.song.identity.releaseKey);
      window.VCardDecoration?.applyShowPreset?.(playback.sourceScope === 'global' ? 'mono' : 'duo');
      if (!changingProfile) {
        this.portal()?.closeIdle?.(this.song.preview);
        this.portal()?.open?.(this.song.preview, { keepImage: playback.sourceScope === 'song' });
        this.portal()?.start?.(this.song.preview);
      }
      // Keep the published show while its replacement is being prepared.
      if (!changingProfile) playback.showSource = null;
      playback.showSelectionOperation = new core.TOperation(playback, 'show-selection');
      playback.showSelectionScope = playback.showSelectionOperation.scope;
      const operation = playback.showSelectionOperation;
      if (!reuse) songEnvironment.showOperation?.cancel('playback-selected-show');
      playback.showSourcePromise = reuse ? songEnvironment.showPromise : this.portal()?.selectPlaybackShow?.(this.song.preview, {
        profile: playback.profile.name,
        sourceScope: playback.sourceScope,
        releaseId: this.song.identity.releaseId,
        releaseKey: this.song.identity.releaseKey,
        origin: { commandId: this.song.life.queue.current?.id || null,
          event: this.song.life.queue.current?.type || 'Playback.Start',
          revision: this.song.life.revision, runId: playback.runId,
          launch: playback.launch,
          profile: playback.profile.name, entryKey: this.song.identity.entryKey },
        signal: operation.scope.signal,
        isCurrent: () => !operation.scope.signal.aborted && !playback.dead
          && playback.state !== 'failed' && this.song.playback === playback
          && playback.showSelectionOperation === operation,
      });
      playback.showSourcePromise = playback.showSourcePromise?.then((source) => this.song.life.queue.post(() => {
        if (!playback.dead && playback.state !== 'failed' && this.song.playback === playback
          && playback.showSelectionOperation === operation && operation.status === 'Running') {
          playback.showSource = source;
          if (reuse) this.portal()?.closeIdle?.(this.song.preview);
          if (playback.sourceScope === 'song' && !this.lastPlan) this.portal()?.holdSongPreview?.();
          if (!source) operation.complete(null);
          this.song.life.publish();
        }
        return source;
      }, { type: 'Show.Selected', owner: playback, scope: operation.scope }));
      if (!changingProfile && playback.sourceScope === 'global') this.portal()?.beforeFirstVerse?.(true);
      else if (!changingProfile) this.portal()?.holdSongPreview?.();
      if (!changingProfile) this.firstVerseShown = false;
      this.lastPlan = null;
      this.slideTimeline?.die('playback-restarted');
      this.slideTimeline = new TVerseSlideTimeline(this, playback);
      this.overlayTimeline?.die('playback-restarted');
      this.overlayTimeline = new TOverlayTimeline(this, playback);
      if (!changingProfile) playback.profile.onSongStart(this);
      else if (audio.paused) this.portal()?.pause?.();
      else this.portal()?.playing?.();
    }

    nextShow(changeSource = false) {
      const playback = this.playback;
      if (this.dead || playback.dead || playback.state === 'failed' || playback.state === 'ended') return false;
      playback.showSelectionOperation?.cancel('next-show');
      if (changeSource) playback.sourceScope = playback.sourceScope === 'global' ? 'song' : 'global';
      this.onPlaybackStart(playback, true);
      if (playback.lastVerseDetail) playback.verse({ ...playback.lastVerseDetail, seeked: true });
      return true;
    }

    onPlaying() {
      this.portal()?.playing?.();
      this.syncRenderFrame();
    }

    onPause() {
      this.portal()?.pause?.();
      this.syncRenderFrame();
    }

    onResume() {
      this.portal()?.resume?.();
      this.syncRenderFrame();
    }

    onProfileChange(playback, profile) {
      // Replace only visual work. Audio ownership, clocks and history survive.
      this.slideTimeline?.die('profile-changed');
      this.overlayTimeline?.die('profile-changed');
      playback.showSelectionOperation?.cancel('profile-changed');
      playback.cancelOperation('profile-changed');
      playback.profile = profile;
      this.onPlaybackStart(playback, true);
    }

    onWaiting() {
      this.portal()?.waiting?.();
      this.syncRenderFrame();
    }

    onSeek() {
      this.slideTimeline?.reset('seek');
      this.overlayTimeline?.reset('seek');
      this.portal()?.seek?.();
    }

    onSeeked() {
      this.portal()?.seeked?.();
    }

    onTick() {
      this.slideTimeline?.update();
      this.overlayTimeline?.update();
      if (this.song.life.renderingActive) this.portal()?.tick?.();
    }

    onRenderingChanged(active) {
      this.portal()?.setRenderingActive?.(active);
      this.syncRenderFrame();
      if (this.song.playback?.state === 'failed') return;
      if (!active) {
        this.slideTimeline?.suspend();
        this.overlayTimeline?.suspend();
      } else {
        if (!this.lastPlan && this.song.playback?.profile.requiresIntro()) {
          const started = this.song.playback?.started && !audio.ended;
          if (started) this.playback.profile.onSongStart(this);
          else this.playback.profile.onSongOpen(this);
        }
        if (this.lastPlan && !['ended', 'failed'].includes(this.song.playback?.state)) {
          const shown = this.song.playback?.plan;
          const now = Number(audio.currentTime) || 0;
          const restoreKind = shown && now >= shown.displayStartsAt && now < shown.displayEndsAt
            ? this.slideTimeline?.slotKind : '';
          this.slideTimeline?.enter({ ...this.lastPlan, seeked: true, restoring: true, restoreKind });
        }
        this.overlayTimeline?.update();
      }
    }

    onVerse(playback, detail, plan) {
      this.lastPlan = plan;
      this.slideTimeline?.enter(plan);
      const handsAni = (plan?.effects || []).find((effect) => effect?.name === 'HandsAni');
      if (handsAni && Number.isFinite(Number(detail?.endsAt))) {
        this.overlayTimeline?.scheduleHandsAni(detail.endsAt, handsAni, {
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
      playback.showSelectionOperation?.cancel('song-ended-before-show');
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
      playback.showSelectionScope?.die('playback-failed');
      this.slideTimeline?.die('playback-failed');
      this.overlayTimeline?.die('playback-failed');
      this.portal()?.failed?.();
      this.syncRenderFrame();
    }

    snapshot() {
      return {
        ...super.snapshot(),
        cassette: this.cassette.snapshot(),
        firstVerseShown: this.firstVerseShown,
        grayUntilEnd: this.grayUntilEnd,
        sourceScope: this.playback.sourceScope,
        showSource: this.song.playback?.showSource || null,
        showSelection: this.portal()?.selectionSnapshot?.(this.song.preview) || null,
        renderScheduled: Boolean(this.frame),
        slideTimeline: this.slideTimeline?.snapshot() || null,
        overlayTimeline: this.overlayTimeline?.snapshot() || null,
      };
    }

    die(reason = 'environment-died') {
      if (this.dead) return;
      if (this.frame) window.VCardRenderScheduler.cancel(this.frame);
      this.frame = 0;
      this.slideTimeline?.die(reason);
      this.slideTimeline = null;
      this.overlayTimeline?.die(reason);
      this.overlayTimeline = null;
      this.cassette.die(reason);
      super.die(reason);
    }
  }

  class TDecorationSchedule {
    constructor(life) {
      this.life = life;
      this.colorBoundary = 0;
      this.backgroundBoundary = 0;
      this.pending = null;
      this.lastCompleted = null;
      this.sequence = 0;
    }

    take(time, colorPeriod, backgroundPeriod) {
      const colorBoundary = Math.floor(time / colorPeriod);
      const backgroundBoundary = Math.floor(time / backgroundPeriod);
      const due = { color: colorBoundary > this.colorBoundary,
        background: backgroundBoundary > this.backgroundBoundary };
      this.colorBoundary = colorBoundary;
      this.backgroundBoundary = backgroundBoundary;
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
      this.colorPeriod = VC_DECOR.COLOR_CHANGE_PERIOD;
      this.backgroundPeriod = VC_DECOR.BACK_CHANGE_PERIOD;
      this.schedule = new TDecorationSchedule(life);
      this.lastResult = null;
    }

    onEvent(event) {
      if (event?.type === 'Page.Reload') {
        this.schedule.colorBoundary = 0;
        this.schedule.backgroundBoundary = 0;
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
      const due = this.schedule.take(pageReloadTime, this.colorPeriod, this.backgroundPeriod);
      const colorDue = due.color;
      const backgroundDue = due.background;
      const decoration = window.VCardDecoration;
      const autopilot = decoration?.autopilotEnabled?.() !== false;
      if (!autopilot) {
        this.lastResult = { changed: false, reason: 'autopilot-off' };
        return this.lastResult;
      }

      let color = null;
      let background = null;
      if (colorDue && !backgroundDue) {
        color = decoration?.refreshActiveColor?.({ reason: 'VCDecor' }) || {
          changed: false,
          reason: 'decoration-control-unavailable',
        };
      }
      if (backgroundDue) {
        background = decoration?.refreshBackground?.({ reason: 'VCDecor',
          commitColor: colorDue ? () => decoration?.refreshActiveColor?.({ reason: 'VCDecor' }) : null }) || {
          changed: false,
          reason: 'background-control-unavailable',
        };
      }
      const result = {
        changed: Boolean(color?.changed || background?.changed),
        pending: Boolean(background?.pending),
        reason: colorDue || backgroundDue ? 'period-reached' : 'period-pending',
        color,
        background: background ? (({ completion, ...state }) => state)(background) : null,
      };
      if (colorDue || backgroundDue) {
        this.lastResult = this.schedule.observe({ ...result, completion: background?.completion },
          (settled) => { this.lastResult = settled; });
      }
      return result;
    }

    snapshot() {
      return {
        ...super.snapshot(),
        colorPeriod: this.colorPeriod,
        backgroundPeriod: this.backgroundPeriod,
        constants: { ...VC_DECOR },
        colorBoundary: this.schedule.colorBoundary,
        backgroundBoundary: this.schedule.backgroundBoundary,
        pendingChange: this.schedule.pending ? { ...this.schedule.pending } : null,
        lastCompletedChange: this.schedule.lastCompleted ? { ...this.schedule.lastCompleted } : null,
        autopilot: window.VCardDecoration?.autopilotEnabled?.() !== false,
        lastResult: this.lastResult ? { ...this.lastResult } : null,
        colorBags: window.VCardDecoration?.colorBagSnapshot?.() || null,
      };
    }
  }

  class VCShowScenarios {
    constructor() { this.name = VCPLAY_IMPLEMENTED_VERSION; this.life = null; this.profile = null; }
    onPageReload() {
      this.life.lastShowProfile = this.profileFor();
    }
    profileFor() {
      if (!this.profile) this.profile = new VCPlay(this.life);
      return this.profile;
    }
    createEnvironment(song) { return new TShowSongEnvironment(song); }
    createDecorationProfile(life) { return new VCDecor(life); }
    staticCassDelay() { return VCPLAYER_FLOW.STATIC_CASS_DELAY; }
    autoStartDelay() { return this.staticCassDelay(); }
    setMotionAllowed(allowed) { this.life?.visualWorld.portal?.setMotionAllowed?.(allowed); }
    snapshot() {
      return { version: VCPLAY_IMPLEMENTED_VERSION, playerConstants: { ...VCPLAYER_FLOW },
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

  // Direct implementation of the active VCPlay scenario; # ~ is inactive archive.
  class VCPlay {
    constructor(life) {
      this.name = 'VCPlay';
      this.sourceRun = null;
      this.life = life;
      this.handsBags = new Map();
      this.handsStarts = new Map();
      this.cassSlidePolicy = new TCassSlidePolicy({
        enabled: false,
        probability: 0, minSlides: 0, maxSlides: 0,
        random: () => this.life.random.stream('slides.VCPlay').next('cassette-probability'),
        stream: () => this.life.random.stream('slides.VCPlay'),
      });
    }

    context(playback, extra = {}) {
      return { verse: (playback?.verseIndex ?? -1) + 1,
        globalVerseNumber: this.life.globalVerseCount,
        globalSlideNumber: this.life.globalSlideCount,
        isCurrentSong: Boolean(playback), isPlaying: !audio.paused && !audio.ended,
        isPaused: audio.paused, isFirstVerse: playback?.verseIndex === 0,
        ...extra };
    }

    requiresIntro() { return true; }

    chooseSource(releaseKey, player = false) {
      const previous = this.sourceRun;
      const scope = player ? 'global' : previous?.count >= 3
        ? previous.scope === 'global' ? 'song' : 'global'
        : this.life.random.stream(`shows.source.${releaseKey}`).next('source-kind') < 0.5 ? 'song' : 'global';
      this.sourceRun = { scope, count: previous?.scope === scope ? previous.count + 1 : 1 };
      return scope;
    }

    onSongOpen(environment) {
      if ((environment.playback?.sourceScope || environment.sourceScope) === 'global') environment.cassette.show({ phase: 'start', motion: 'static' });
    }

    onSongStart(environment) {
      if (environment.playback.sourceScope === 'global') environment.cassette.show({ phase: 'play', motion: 'animated' });
    }

    async onSongEnd(environment, playback, signal) {
      if (signal.aborted || playback.dead) return;
      if (playback.sourceScope === 'global') environment.cassette.show({ phase: 'finish', motion: 'animated', fade: 2, unfade: 2 });
      await playback.life.transitionClock.wait(5, signal);
    }

    onStopped(environment) {
      if (environment.playback.sourceScope === 'global') environment.cassette.show({ phase: 'finish', motion: 'static' });
    }

    planVerse(playback, detail, globalVerseCount) {
      const context = this.context(playback, { globalVerseNumber: globalVerseCount,
        isLastVerse: Boolean(detail.isLastVerse) });
      const effects = [{ name: 'CrossImg', lead: 2, unfade: 2, fade: 2 }];
      if (!detail.isLastVerse) effects.push({ name: 'HandsAni', lead: 3, unfade: 3, fade: 5, opacity: 0.8 });
      return immutablePlan({ preview: detail.preview, index: detail.index,
        globalVerseNumber: globalVerseCount, context,
        slidesInVerse: 2,
        seeked: Boolean(detail.seeked),
        startsAt: Number.isFinite(Number(detail.startsAt)) ? Number(detail.startsAt) : null,
        endsAt: Number.isFinite(Number(detail.endsAt)) ? Number(detail.endsAt) : null,
        verseHandler: 'OnVerseStart', bindings: [], conditions: [], effects,
        profile: this.name, ruleSource: VCPLAY_IMPLEMENTED_VERSION,
        first: playback.verseIndex === 0 && !playback.environment.firstVerseShown });
    }

    createEnding(playback) {
      return new TPlaybackEnding(playback, true);
    }

    planDisplay(plan, natural = true, playback = null) {
      const current = Number(this.life.globalSlideCount) || 0;
      const globalSlideNumber = natural ? current + 1 : Math.max(1, current);
      const colorSlide = globalSlideNumber > 0 && globalSlideNumber % 9 === 0;
      const frame = colorSlide
        ? { source: 'img', styles: ['s_burn'], mask: 'off', pick: 'shuffle-bag', glow: 8, glowPulse: true, glowPulses: 2 }
        : { source: 'img', styles: ['vc', 's_alarm'], mask: playback?.sourceScope === 'global' ? 'off' : 'required', pick: 'shuffle-bag', glow: 0 };
      const cross = plan.effects.find((effect) => effect.name === 'CrossImg');
      return immutablePlan({ ...plan, globalSlideNumber, conditions: [{ function: 'EveryNthGlobSlide', arguments: [9], active: colorSlide }],
        portalFrame: { ...frame, ...(plan.first && cross ? {
          fade: frame.fade ?? cross.fade, unfade: frame.unfade ?? cross.unfade,
        } : {}) } });
    }

    commitDisplay(plan, natural = true, kind = '', decision = null) {
      if (!natural || !this.life) return;
      if (!this.cassSlidePolicy.commit(decision)) throw new Error('Show profile cannot commit an unreserved cassette decision');
      this.life.globalSlideCount = Math.max(Number(this.life.globalSlideCount) || 0, Number(plan?.globalSlideNumber) || 0);
      this.life.event('Slide.Show', { kind, globalSlideNumber: this.life.globalSlideCount, decision });
    }

    reserveHands(collection, items, origin = null) {
      if (!this.handsBags.has(collection)) this.handsBags.set(collection,
        new core.TShuffleBag([...new Set(items)], (item) => item,
          this.life.random.stream(`hands.${this.name}`)));
      const bag = this.handsBags.get(collection);
      const reservation = bag.reserve({ origin });
      if (!reservation) return null;
      return { ...reservation, invalidate: () => {
        bag.invalidate(reservation.item);
      } };
    }

    handsStart(source, duration, showDuration, minimumGap) {
      const maximum = Math.max(0, duration - showDuration);
      const stream = this.life.random.stream(`hands.${this.name}`);
      const previous = this.handsStarts.get(source);
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
      this.handsStarts.set(source, result);
      return result;
    }

    snapshot() {
      return { name: this.name, ruleSource: VCPLAY_IMPLEMENTED_VERSION,
        sourceRun: this.sourceRun, slidesInVerse: 2,
        handsBags: [...this.handsBags].map(([collection, bag]) => ({
          collection, total: bag.items.length, remaining: bag.remaining.length,
          reserved: bag.reservation?.item || null, last: bag.last, invalid: bag.invalid.size,
        })),
        cassSlidePolicy: this.cassSlidePolicy.snapshot() };
    }
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
  const selectResumeSource = (preview, surface) => {
    const song = life.playingSong;
    const playback = song?.playback;
    const source = surface === 'player' ? 'global' : surface === 'portal' ? 'song' : null;
    if (!source || !audio.paused || preview !== song?.preview || !playback
        || playback.dead || !['paused', 'playing'].includes(playback.state)) return;
    if (playback.sourceScope !== source) playback.playbackEnvironment?.nextShow(true);
    window.VCardDecoration?.applyShowPreset?.(source === 'global' ? 'mono' : 'duo');
  };
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
    'Song.CopyLink': (input) => window.VCardSettingsContext?.copyLink(input) || false,
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
    if (type === 'Song.CopyLink') return Boolean(window.VCardSettingsContext?.canCopyLink(input));
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
      'Verse.Play', 'Playlist.Select', 'Catalog.ShowMap'].includes(input.type)) {
      return playbackCommands[input.type](input);
    }
    return command(input.type, () => commandAvailable(input) ? playbackCommands[input.type](input) : false);
  };
  window.VCCommands = Object.freeze({ available: commandAvailable, dispatch: dispatchCommand });
  window.VCPlayer = Object.freeze({
    nextShow: (changeSource = false) => command(changeSource ? 'Show.ChangeSource' : 'Show.Next', () => {
      const song = life.openedSong || life.playingSong;
      if (!song) return false;
      const environment = song.playback?.playbackEnvironment;
      if (environment && !song.playback.dead && !['ended', 'failed'].includes(song.playback.state)) return environment.nextShow(changeSource);
      life.visualWorld.portal?.close?.(song.preview);
      const source = song.playback?.sourceScope || song.environment.sourceScope;
      song.environment.prepareShow(changeSource ? (source === 'global' ? 'song' : 'global') : source);
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
    releaseAvailable: (releaseKey) => !life.autopilotSelector.invalid.has(releaseKey),
    randomStream: (name) => life.random.stream(name),
    reserveHands: (collection, items, origin) => life.playingSong?.playback?.profile?.reserveHands?.(collection, items, origin),
    handsStart: (...args) => life.playingSong?.playback?.profile?.handsStart?.(...args),
    reserveAutoNext: (releaseKey) => life.queue.current
      ? life.autopilotSelector.reserve(releaseKey)
      : command('Selection.Reserve', () => life.autopilotSelector.reserve(releaseKey)),
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
  ['vcard:mono-color-state', 'vcard:accent-state', 'vcard:random-color-state'].forEach((eventName) => {
    document.addEventListener(eventName, () => {
      if (life.queue.current) life.publish();
      else command('Color.Settings', () => life.publish());
    }, { signal: life.scope.signal });
  });
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
  document.addEventListener('vcard:manual-selection-state', () => {
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
  let selectionMode = window.VCardStorage?.local.getItem('vcard-autopilot') !== 'off';
  document.addEventListener('vcard:autopilot-state', (event) => {
    const enabled = Boolean(event.detail?.enabled);
    if (enabled === selectionMode) return;
    selectionMode = enabled;
    life.selectionMode = enabled;
    command('Selection.Reset', () => {
      life.cancelContinuation('selection-mode-changed');
      life.autopilotSelector.reset();
      life.selectionMemory.reset();
      life.playbackHistory = { entries: [], order: [], cursor: -1 };
      const playback = life.playingSong?.playback;
      if (playback?.started && !playback.dead) {
        playback.historyIndex = -1;
        life.recordPlaybackHistory(playback);
        life.selectionMemory.record(playback);
      }
      life.publish();
    });
  }, { signal: life.scope.signal });
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
})();
