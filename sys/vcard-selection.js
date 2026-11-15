(() => {
  'use strict';

  const SELECTION_MEMORY_TTL = 86400;

  class TSelectionMemory {
    constructor(life, options = {}) {
      this.life = life;
      this.catalog = options.catalog || window.VCardCatalog;
      this.catalogVersion = typeof window.VCardBuild?.CatalogVersion === 'string'
        ? window.VCardBuild.CatalogVersion : null;
      this.storage = options.storage || window.VCardStorage?.local;
      this.key = 'vcard-selection-memory';
      this.channelKey = options.storageKey?.(this.key) || window.VCardStorage?.key?.(this.key) || this.key;
      this.pageSessionId = window.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.epoch = '0000000000000:initial';
      this.recent = [];
      this.lastPlayedAt = 0;
      this.resetReason = '';
      this.entriesByKey = new Map((this.catalog?.entries || []).map((entry) => [entry.entryKey, entry]));
      const saved = this.read();
      this.merge(saved);
      this.expire();
      try { this.channel = new BroadcastChannel(this.channelKey); } catch (_error) { this.channel = null; }
      const receive = (saved) => life.queue.post(() => {
        const incoming = this.normalize(saved);
        if (!incoming) return;
        const changed = this.merge(saved);
        if (changed) life.publish();
        // Different builds can have different valid key sets. Merge known
        // events, but do not echo a foreign catalog's pruning back endlessly.
        if ((saved?.catalogVersion === undefined || saved.catalogVersion === this.catalogVersion)
          && JSON.stringify(this.state()) !== JSON.stringify(incoming)) this.save();
      }, { type: 'Selection.Remote', owner: life, scope: life.scope });
      if (this.channel) this.channel.onmessage = (event) => receive(event.data);
      window.addEventListener('storage', (event) => {
        if (event.key === this.channelKey && event.newValue) {
          try { receive(JSON.parse(event.newValue)); } catch (_error) { /* Ignore malformed external state. */ }
        }
      }, { signal: life.scope.signal });
      life.scope.signal.addEventListener('abort', () => this.channel?.close(), { once: true });
      // Persist the current catalog and pruned/migrated keys during bootstrap,
      // even when no new Playback.Start has occurred yet.
      if (JSON.stringify(saved) !== JSON.stringify(this.state())) this.save();
    }

    normalize(saved) {
      if (![1, 2].includes(saved?.version) || !Array.isArray(saved.recent)) return null;
      if (saved.epoch !== undefined && (typeof saved.epoch !== 'string' || !/^\d{13}:[A-Za-z0-9-]+$/.test(saved.epoch))) return null;
      const records = saved.recent.flatMap((record, index) => {
        const entry = this.entriesByKey.get(record?.entryKey);
        if (!entry || !Number.isFinite(record.startedAt) || record.startedAt < 0) return [];
        return [{ songId: entry.songId, releaseKey: entry.releaseKey, entryKey: entry.entryKey,
          listId: entry.listId, startedAt: record.startedAt,
          eventId: typeof record.eventId === 'string' ? record.eventId : `legacy:${record.startedAt}:${index}:${entry.entryKey}`,
          pageSessionId: typeof record.pageSessionId === 'string' ? record.pageSessionId : 'legacy' }];
      });
      const recent = [...new Map(records.map((record) => [record.eventId, record])).values()]
        .sort((left, right) => left.startedAt - right.startedAt || (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0)).slice(-5);
      return { version: 2, catalogVersion: this.catalogVersion,
        epoch: typeof saved.epoch === 'string' ? saved.epoch : '0000000000000:initial',
        lastPlayedAt: Math.max(Number.isFinite(saved.lastPlayedAt) ? saved.lastPlayedAt : 0,
          ...recent.map((record) => record.startedAt)), recent };
    }

    read() {
      try { return JSON.parse(this.storage?.getItem(this.key) || 'null'); } catch (_error) { return null; }
    }

    state() {
      return { version: 2, catalogVersion: this.catalogVersion,
        epoch: this.epoch, lastPlayedAt: this.lastPlayedAt, recent: this.recent };
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
        navigator.locks.request(this.channelKey, { signal: this.life.scope.signal }, () => this.life.queue.post(write,
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
        eventId, pageSessionId: this.pageSessionId });
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

  class TPlaylistSelector {
    constructor(entries = [], memory = null, random = null, entriesForPlayback = null) {
      this.entriesForPlayback = entriesForPlayback;
      this.memory = memory;
      this.invalid = new Set();
      this.allEntries = entries.filter((entry) => entry.playable);
      this.entries = this.filteredEntries();
      this.random = random;
      this.preparedBag = null;
      this.epoch = memory?.epoch;
      this.reservation = null;
      this.round = 1;
    }

    get bag() {
      if (!this.preparedBag) {
        this.preparedBag = new TShuffleBag(
          [...new Map(this.allEntries.map((entry) => [entry.releaseKey, entry])).values()],
          (entry) => entry.releaseKey, this.random);
      }
      return this.preparedBag;
    }

    get remaining() {
      if (!this.preparedBag) return this.entries.filter((entry) => !this.invalid.has(entry.releaseKey));
      const allowed = new Set(this.entries.map((entry) => entry.releaseKey));
      return this.bag.remaining.filter((entry) => allowed.has(entry.releaseKey) && !this.invalid.has(entry.releaseKey));
    }

    filteredEntries() {
      return [...new Map((this.entriesForPlayback?.() || window.VCardPlaylistFilter?.playbackEntries?.() || this.allEntries)
        .filter((entry) => entry.playable)
        .map((entry) => [entry.releaseKey, entry])).values()];
    }

    restartRound() {
      this.preparedBag?.refill();
      this.round += 1;
      this.epoch = this.memory?.epoch;
    }

    started(identity) {
      // A manual first start belongs to this pass too. Resume never calls this.
      if (this.epoch !== this.memory?.epoch) this.restartRound();
      const key = identity.releaseKey;
      if (!this.allEntries.some((entry) => entry.releaseKey === key)) return;
      this.bag.remaining = this.bag.remaining.filter((entry) => entry.releaseKey !== key);
      this.bag.last = key;
    }

    reserve() {
      this.reservation?.cancel();
      this.memory?.expire();
      if (this.epoch !== this.memory?.epoch) this.restartRound();
      this.entries = this.filteredEntries();
      const available = this.entries.filter((entry) => !this.invalid.has(entry.releaseKey));
      if (!available.length) return null;
      const byKey = new Map(available.map((entry) => [entry.releaseKey, entry]));
      const allow = (entry) => byKey.has(entry.releaseKey);
      if (!this.bag.remaining.some(allow)) this.restartRound();
      const recent = this.memory?.recent || [];
      const rank = (candidate) => {
        const entry = byKey.get(candidate.releaseKey);
        if (!entry) return Infinity;
        const matches = recent.filter((record) => record.songId === entry.songId);
        if (!matches.length) return 0;
        const latest = matches[matches.length - 1];
        const ageRank = recent.indexOf(latest) / 10;
        if (matches.every((record) => record.releaseKey !== entry.releaseKey && record.listId !== entry.listId)) return 10 + ageRank;
        if (latest.releaseKey !== entry.releaseKey && latest.listId !== entry.listId) return 20 + ageRank;
        if (latest.releaseKey !== entry.releaseKey) return 30 + ageRank;
        return 40 + ageRank;
      };
      const bestRank = Math.min(...this.bag.remaining.filter(allow).map(rank));
      const picked = this.bag.reserve({
        refill: false, cancelToFront: true, allow,
        prefer: (entry) => rank(entry) === bestRank,
      });
      if (!picked) return null;
      const finish = (consume) => {
        const result = consume ? picked.commit() : picked.cancel();
        if (this.reservation === reservation) this.reservation = null;
        return result;
      };
      const reservation = { entry: byKey.get(picked.item.releaseKey),
        reason: bestRank === 0 ? 'fresh-song' : bestRank < 30 ? 'alternate-album'
          : bestRank < 40 ? 'alternate-release' : 'unavoidable-repeat',
        commit: () => finish(true), cancel: () => finish(false) };
      this.reservation = reservation;
      return reservation;
    }

    reset({ restart = false } = {}) {
      this.reservation?.cancel();
      this.entries = this.filteredEntries();
      if (restart) this.restartRound();
    }
  }

  window.VCardSelectionCore = Object.freeze({ TSelectionMemory, TShuffleBag, TPlaylistSelector, SELECTION_MEMORY_TTL });
})();
