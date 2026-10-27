(() => {
  'use strict';

  // User lists reference catalog releases. The catalog, media and lyric owners
  // remain canonical; displaying another membership never clones those owners.
  class TUserPlaylists {
    constructor({ storage, catalog, builtinIds, tabs, sections, previewFor, titleFor }) {
      Object.assign(this, { storage, catalog, builtinIds, tabs, sections, previewFor, titleFor });
      this.key = 'vcard-user-playlists';
      this.lists = [];
      this.excluded = new Map();
      this.controls = new Map();
      this.customEntries = new Map();
      this.members = new Map();
      this.origins = new Map();
      this.mounted = '';
      this.current = '';
      this.dialog = null;
      this.scope = new AbortController();
      const { signal } = this.scope;
      this.byRelease = null;
      this.read();
      if (!storage.getItem(this.key)) {
        try {
          const old = JSON.parse(storage.getItem('vcard-playlist-filter'));
          for (const id of old?.disabled || []) this.excluded.set(id,
            new Set(catalog.forList(id).map((entry) => entry.releaseKey)));
        } catch (_) { /* The initial selection includes every catalog release. */ }
      }
      this.renderTabs();
      document.addEventListener('change', (event) => {
        const input = event.target;
        if (input.matches('[data-song-check]')) {
          const id = input.closest('.list')?.id;
          this.setSong(id, input.dataset.songCheck, input.checked);
        } else if (input.matches('[data-playlist-check]')) {
          this.setList(input.dataset.playlistCheck, input.checked);
        } else if (input.matches('[data-checks-master]')) {
          for (const id of this.listIds) this.setList(id, input.dataset.checksMaster === 'left', false);
          this.changed();
        }
      }, { signal });
      document.addEventListener('click', (event) => {
        const command = event.target.closest('[data-user-list-action]');
        if (!command) return;
        event.preventDefault();
        if (this.dialog?.open || window.VCardBootstrap?.state !== 'Interactive') return;
        if (command.dataset.userListAction === 'save') this.saveDialog(command);
        else if (this.isUser(this.current)) this.removeDialog(command);
      }, { signal });
      window.addEventListener('storage', (event) => {
        if (event.key !== window.VCardStorage.key(this.key)) return;
        this.dialog?.close();
        this.restoreCards();
        this.read();
        this.renderTabs();
        this.onCatalogChange?.();
        this.project(this.current);
        this.notify();
      }, { signal });
      window.addEventListener('pagehide', (event) => {
        if (event.persisted) return;
        this.dialog?.close(); this.scope.abort();
      }, { signal });
      this.sync();
    }

    get listIds() { return [...this.lists.map((list) => list.id), ...this.builtinIds]; }
    isUser(id) { return this.lists.some((list) => list.id === id); }
    hasList(id) { return this.builtinIds.includes(id) || this.isUser(id); }
    list(id) { return this.lists.find((list) => list.id === id); }
    entries(id) {
      if (!this.isUser(id)) return this.catalog.forList(id);
      if (!this.byRelease) {
        this.byRelease = new Map();
        for (const entry of this.catalog.entries) {
          const previous = this.byRelease.get(entry.releaseKey);
          if (!previous || !previous.playable && entry.playable) this.byRelease.set(entry.releaseKey, entry);
        }
      }
      if (!this.customEntries.has(id)) this.customEntries.set(id,
        Object.freeze(this.list(id).releases.map((key) => this.byRelease.get(key)).filter(Boolean)));
      return this.customEntries.get(id);
    }
    selected(id, key) { return !this.excluded.get(id)?.has(key); }
    allows(entry, id = entry.listId) {
      if (!this.members.has(id)) this.members.set(id, new Set(this.entries(id)));
      return this.members.get(id).has(entry) && this.selected(id, entry.releaseKey);
    }
    playbackEntries() {
      const unique = new Map();
      for (const id of this.listIds) for (const entry of this.entries(id)) {
        if (this.selected(id, entry.releaseKey)) unique.set(entry.releaseKey, entry);
      }
      return [...unique.values()];
    }
    contextFor(entry, preferred = '') {
      if (this.hasList(preferred) && this.allows(entry, preferred)) return preferred;
      return this.listIds.find((id) => this.allows(entry, id)) || entry.listId;
    }
    read() {
      let value;
      try { value = JSON.parse(this.storage.getItem(this.key)); } catch (_) { }
      this.lists = [];
      this.excluded = new Map();
      if (!value || value.version !== 1) return;
      const ids = new Set(this.builtinIds);
      const names = new Set();
      for (const list of Array.isArray(value.lists) ? value.lists : []) {
        if (!list || !/^user-[a-z0-9-]+$/.test(list.id) || ids.has(list.id)
            || typeof list.name !== 'string' || !list.name.trim() || !Array.isArray(list.releases)) continue;
        const name = list.name.trim().slice(0, 80);
        if (names.has(name.toLocaleLowerCase())) continue;
        ids.add(list.id); names.add(name.toLocaleLowerCase());
        this.lists.push({ id: list.id, name,
          releases: [...new Set(list.releases.filter((key) => typeof key === 'string'))] });
      }
      if (value.excluded && typeof value.excluded === 'object') {
        for (const [id, keys] of Object.entries(value.excluded)) {
          if (ids.has(id) && Array.isArray(keys)) this.excluded.set(id,
            new Set(keys.filter((key) => typeof key === 'string')));
        }
      }
    }
    persist() {
      const saved = this.storage.setItem(this.key, JSON.stringify({ version: 1,
        lists: this.lists, excluded: Object.fromEntries([...this.excluded].map(([id, keys]) => [id, [...keys]])) }));
      if (saved) this.storage.removeItem('vcard-playlist-filter');
      return saved;
    }
    notify() { document.dispatchEvent(new CustomEvent('vcard:playlist-filter-change')); }
    changed() { this.persist(); this.sync(); this.notify(); }
    setSong(id, key, checked) {
      if (!this.hasList(id)) return;
      if (!this.excluded.has(id)) this.excluded.set(id, new Set());
      if (checked) this.excluded.get(id).delete(key);
      else this.excluded.get(id).add(key);
      this.changed();
    }
    setList(id, checked, notify = true) {
      if (!this.hasList(id)) return;
      this.excluded.set(id, checked ? new Set() : new Set(this.entries(id).map((entry) => entry.releaseKey)));
      if (notify) this.changed();
    }
    sync() {
      for (const input of document.querySelectorAll('[data-playlist-check]')) {
        const entries = this.entries(input.dataset.playlistCheck);
        const count = entries.filter((entry) => this.selected(input.dataset.playlistCheck, entry.releaseKey)).length;
        input.checked = entries.length > 0 && count === entries.length;
        input.indeterminate = count > 0 && count < entries.length;
        input.setAttribute('aria-checked', input.indeterminate ? 'mixed' : String(input.checked));
      }
      for (const input of document.querySelectorAll('[data-checks-master]')) {
        input.checked = input.dataset.checksMaster === 'left';
        input.indeterminate = false;
        const hint = input.checked ? 'Отметить все песни' : 'Снять все отметки';
        input.setAttribute('aria-label', hint); input.closest('label').title = hint;
      }
      for (const [input, entry] of this.controls) {
        input.checked = this.selected(input.closest('.list')?.id || entry.listId, entry.releaseKey);
      }
      for (const button of document.querySelectorAll('[data-user-list-action="remove"]')) {
        button.disabled = !this.isUser(this.current);
      }
    }
    renderTabs() {
      this.customEntries.clear(); this.members.clear();
      for (let i = this.tabs.length - 1; i >= 0; i--) {
        if (!this.tabs[i].hasAttribute('data-user-list')) continue;
        this.tabs[i].remove(); this.tabs.splice(i, 1);
      }
      for (let i = this.sections.length - 1; i >= 0; i--) {
        if (!this.sections[i].hasAttribute('data-user-list')) continue;
        this.sections[i].remove(); this.sections.splice(i, 1);
      }
      document.querySelectorAll('.tabs__check[data-user-list]').forEach((node) => node.remove());
      for (const list of this.lists) {
        const section = document.createElement('section');
        section.className = 'list list--flow block-mid'; section.id = list.id;
        section.dataset.userList = ''; section.style.display = 'none';
        this.sections[0].before(section); this.sections.push(section);
        for (const group of document.querySelectorAll('.tabs-selector__inner')) {
          const tab = document.createElement('a');
          tab.className = 'tabs__item tabs__item--user'; tab.dataset.userList = '';
          tab.setAttribute('list', list.id); tab.href = `#${list.id}`;
          const caption = document.createElement('span'); caption.className = 'tabs__caption';
          const name = document.createElement('span'); name.className = 'tabs__label'; name.textContent = list.name;
          const count = document.createElement('sup'); count.textContent = String(this.entries(list.id).length);
          caption.append(name, count); tab.append(caption);
          group.querySelector('.tabs-block').insertBefore(tab, group.querySelector('.tabs__item:not([data-user-list])'));
          this.tabs.push(tab);
          const label = document.createElement('label'); label.className = 'tabs__check'; label.dataset.userList = '';
          const check = document.createElement('input'); check.type = 'checkbox'; check.dataset.playlistCheck = list.id;
          check.setAttribute('aria-label', `Выбрать песни списка ${list.name}`); label.append(check);
          const checks = group.querySelector('.tabs__checks');
          checks.insertBefore(label, checks.querySelector('.tabs__check:not([data-user-list])'));
        }
      }
      this.sync();
    }
    prepareCheck(entry, title) {
      if (title.querySelector('[data-song-check]')) return;
      const input = document.createElement('input');
      input.type = 'checkbox'; input.className = 'song__selection'; input.dataset.songCheck = entry.releaseKey;
      input.setAttribute('aria-label', `Выбрать песню ${entry.title}`);
      title.prepend(input); this.controls.set(input, entry);
    }
    restoreCards() {
      for (const [node, marker] of this.origins) {
        this.moveCard(node, marker.parentElement, marker); marker.remove();
      }
      this.origins.clear(); this.mounted = '';
    }
    moveCard(node, parent, before = null) {
      // State-preserving DOM moves keep the active portal's video alive.
      if (parent.moveBefore) parent.moveBefore(node, before);
      else parent.insertBefore(node, before);
    }
    project(id) {
      this.current = id;
      if (this.mounted !== id) {
        this.restoreCards();
        if (this.isUser(id)) {
          const section = this.sections.find((node) => node.id === id);
          for (const entry of this.entries(id)) {
            const preview = this.previewFor(entry);
            const title = this.titleFor(entry);
            if (!title?.classList.contains('song__title')) continue;
            for (const node of [title, preview]) {
              const marker = document.createComment('User list: canonical card origin');
              node.before(marker); this.origins.set(node, marker); this.moveCard(node, section);
            }
          }
          this.mounted = id;
        }
      }
      for (const entry of this.entries(id)) {
        const title = this.titleFor(entry);
        if (title?.classList.contains('song__title')) this.prepareCheck(entry, title);
      }
      this.sync();
    }
    openDialog(trigger) {
      const dialog = document.createElement('dialog'); dialog.className = 'vcard-list-dialog';
      dialog.setAttribute('aria-label', 'Пользовательский плейлист');
      dialog.addEventListener('close', () => {
        dialog.remove();
        if (this.dialog !== dialog) return;
        this.dialog = null;
        window.VCardUserActivity?.setMenu(false);
        if (trigger.isConnected) trigger.focus({ preventScroll: true });
        document.dispatchEvent(new CustomEvent('vcard:user-list-dialog', { detail: { open: false } }));
      }, { once: true });
      document.body.append(dialog); this.dialog = dialog; dialog.showModal();
      window.VCardUserActivity?.setMenu(true);
      document.dispatchEvent(new CustomEvent('vcard:user-list-dialog', { detail: { open: true } }));
      return dialog;
    }
    confirmation(dialog, text, entries, commit) {
      dialog.replaceChildren();
      if (entries) {
        const releases = document.createElement('p'); releases.className = 'vcard-list-dialog__releases';
        releases.textContent = entries.map((entry) => `${entry.listId}/${entry.localId}`).join(' ');
        dialog.append(releases);
      }
      const question = document.createElement('p'); question.textContent = text; dialog.append(question);
      const yes = document.createElement('button'); yes.type = 'button'; yes.textContent = 'ДА';
      const no = document.createElement('button'); no.type = 'button'; no.textContent = 'НЕТ';
      const commands = document.createElement('div'); commands.className = 'vcard-list-dialog__commands';
      commands.append(yes, no); dialog.append(commands);
      no.addEventListener('click', () => dialog.close());
      yes.addEventListener('click', () => {
        const error = commit();
        if (!error) dialog.close();
        else { const message = document.createElement('p'); message.setAttribute('role', 'alert'); message.textContent = error; dialog.append(message); }
      });
      no.focus();
    }
    saveDialog(trigger) {
      const entries = this.playbackEntries();
      const dialog = this.openDialog(trigger);
      if (!entries.length) {
        const text = document.createElement('p'); text.textContent = 'Нет отмеченных песен.';
        const close = document.createElement('button'); close.textContent = 'ЗАКРЫТЬ'; close.onclick = () => dialog.close();
        dialog.append(text, close); close.focus(); return;
      }
      const form = document.createElement('form');
      const label = document.createElement('label'); label.textContent = 'Имя плейлиста';
      const input = document.createElement('input'); input.type = 'text'; input.required = true; input.maxLength = 80;
      input.autocomplete = 'off'; label.append(input);
      const next = document.createElement('button'); next.type = 'submit'; next.textContent = 'ДАЛЕЕ';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'ОТМЕНА';
      cancel.onclick = () => dialog.close(); form.append(label, next, cancel); dialog.append(form); input.focus();
      form.addEventListener('submit', (event) => {
        event.preventDefault(); const name = input.value.trim();
        if (!name) { input.setCustomValidity('Введите имя списка'); input.reportValidity(); return; }
        const existing = this.lists.find((list) => list.name.toLocaleLowerCase() === name.toLocaleLowerCase());
        const question = existing ? `Заменить плейлист ${existing.name} и сохранить эти релизы в список ${name}?`
          : `Сохранить эти релизы в список ${name}?`;
        this.confirmation(dialog, question, entries, () => {
          const before = JSON.stringify({ lists: this.lists, excluded: [...this.excluded].map(([id, keys]) => [id, [...keys]]) });
          const id = existing?.id || `user-${crypto.randomUUID()}`;
          const list = { id, name, releases: entries.map((entry) => entry.releaseKey) };
          if (existing) this.lists[this.lists.findIndex((item) => item.id === id)] = list;
          else this.lists.unshift(list);
          this.excluded.set(id, new Set());
          if (!this.persist()) {
            const previous = JSON.parse(before); this.lists = previous.lists;
            this.excluded = new Map(previous.excluded.map(([key, keys]) => [key, new Set(keys)]));
            this.persist();
            return 'Не удалось сохранить в хранилище браузера. Список не изменён.';
          }
          this.restoreCards(); this.renderTabs(); this.onCatalogChange?.(id); this.notify();
          return '';
        });
      });
      input.addEventListener('input', () => input.setCustomValidity(''));
    }
    removeDialog(trigger) {
      const list = this.list(this.current); if (!list) return;
      const dialog = this.openDialog(trigger);
      this.confirmation(dialog, `Убрать из списка плейлист ${list.name}?`, null, () => {
        const before = this.lists; const excluded = this.excluded.get(list.id);
        this.lists = this.lists.filter((item) => item !== list); this.excluded.delete(list.id);
        if (!this.persist()) {
          this.lists = before; if (excluded) this.excluded.set(list.id, excluded);
          this.persist();
          return 'Не удалось изменить хранилище браузера. Список не удалён.';
        }
        this.restoreCards(); this.renderTabs(); this.onCatalogChange?.(); this.notify();
        return '';
      });
    }
  }
  window.TUserPlaylists = TUserPlaylists;
})();
