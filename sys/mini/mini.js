(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('mini-data').textContent);
  const prefix = `vcard:${encodeURIComponent(data.instance)}:`;
  const profileKey = `vcard-mini:${encodeURIComponent(data.instance)}:profile-v1`;
  const selectionKey = `${prefix}vcard-user-playlists`;
  const cacheName = `${prefix}media-v1`;
  const siteRoot = new URL('../', location.href);
  const audio = document.getElementById('audio');
  const content = document.getElementById('content');
  const screen = document.getElementById('screen');
  const navSlots = document.querySelectorAll('header [data-mini-nav]');
  const navLabels = Object.fromEntries([...navSlots].map(node => [node.dataset.miniNav, node.dataset.miniLabel]));
  const playButton = document.getElementById('play');
  const playLabel = playButton.dataset.playLabel ?? playButton.textContent;
  const pauseLabel = playButton.dataset.pauseLabel ?? 'PAUSE';
  const seek = document.getElementById('seek');
  const volume = document.getElementById('volume');
  const clock = document.getElementById('time');
  const currentClock = document.getElementById('current-time');
  const totalClock = document.getElementById('total-time');
  const status = document.getElementById('status');
  const textCache = new Map();
  const cacheJobs = new Map();
  const historyQueue = [];
  let historyCursor = -1;
  let pendingHistoryIndex = null;
  let confirmedRun = -1;
  let selectionState = null;
  let saved = {};
  try {
    const stored = localStorage.getItem(profileKey);
    saved = JSON.parse(stored || '{}');
    if (stored === null) {
      const legacy = JSON.parse(localStorage.getItem(`${prefix}tvcm-profile-v1`) || '{}');
      if (legacy && !Array.isArray(legacy) && legacy.version === 1) {
        saved = legacy;
        localStorage.setItem(profileKey, JSON.stringify(saved));
      }
    }
  } catch (_) { }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) || saved.version !== 1) saved = {};
  const preferences = { ...data.defaults, ...(saved.preferences || {}) };
  const fontFamilies = [['Fairfax', 'Fairfax'], ['serif', 'С засечками'], ['sans-serif', 'Без засечек'], ['monospace', 'Моноширинный'], ['system-ui', 'Системный интерфейсный']];
  preferences.fontFamily = fontFamilies.some(([value]) => value === preferences.fontFamily) ? preferences.fontFamily : 'Fairfax';
  const themes = [['auto','<АВТО>'], ['night','НОЧЬ'], ['mono','МОНО'], ['duo','ДУО'], ['newspaper','ГАЗЕТА']];
  preferences.theme = ({system:'auto', light:'newspaper', dark:'night'})[preferences.theme] || preferences.theme;
  if (!themes.some(([key]) => key === preferences.theme)) preferences.theme = 'auto';
  preferences.fontSize = Math.max(14, Math.min(36, Number(preferences.fontSize) || 20));
  const excluded = saved.excluded && typeof saved.excluded === 'object' && !Array.isArray(saved.excluded) ? saved.excluded : {};
  let userLists = Array.isArray(saved.lists) ? saved.lists.filter(l => l && typeof l.id === 'string' && l.id.startsWith('user-') && typeof l.title === 'string' && Array.isArray(l.songs)).map(l => ({...l, songs: l.songs.filter(k => Object.prototype.hasOwnProperty.call(data.songs, k)), user:true})) : [];
  const releaseFor = key => {
    const song = data.songs[key];
    return song ? JSON.stringify([song.song.toLowerCase(), song.release.toLowerCase()]) : key;
  };
  const keyForRelease = new Map(Object.keys(data.songs).map(key => [releaseFor(key), key]));
  function readSelection() {
    const stored = localStorage.getItem(selectionKey);
    if (stored === null) return false;
    const value = JSON.parse(stored);
    if (value?.version !== 1 || !Array.isArray(value.lists) || !value.excluded
        || typeof value.excluded !== 'object' || Array.isArray(value.excluded)) return false;
    userLists = value.lists.filter(list => list && /^user-[a-z0-9-]+$/.test(list.id)
      && typeof list.name === 'string' && list.name.trim() && Array.isArray(list.releases))
      .map(list => ({id:list.id, title:list.name, user:true,
        songs:list.releases.map(key => keyForRelease.get(key)).filter(Boolean),
        missingReleases:list.releases.filter(key => typeof key === 'string' && !keyForRelease.has(key))}));
    for (const id of Object.keys(excluded)) delete excluded[id];
    for (const [id, keys] of Object.entries(value.excluded)) {
      if (Array.isArray(keys)) excluded[id] = keys.filter(key => typeof key === 'string')
        .map(key => data.playlists.find(list => list.id === id)?.songs
          .find(songKey => releaseFor(songKey) === key) || keyForRelease.get(key) || key);
    }
    return true;
  }
  function writeSelection() {
    localStorage.setItem(selectionKey, JSON.stringify({version:1,
      lists:userLists.map(list => ({id:list.id, name:list.title,
        releases:[...new Set([...list.songs.map(releaseFor), ...(list.missingReleases || [])])]})),
      excluded:Object.fromEntries(Object.entries(excluded).map(([id, keys]) =>
        [id, Array.isArray(keys) ? [...new Set(keys.map(releaseFor))] : []]))}));
  }
  try { if (!readSelection()) writeSelection(); } catch (_) { /* Keep the local selection usable. */ }
  let route;
  let current = null;
  let currentTimes = [];
  let lyricsVerses = [];
  let playingList = '';
  let playbackLaunch = 'manual';
  let analyticsRun = 0;
  let paintRevision = 0;
  let activeVerse = -1;
  let manualScrollUntil = 0;
  let cacheGeneration = 0;
  let preloadRunning = false;
  let swReady = null;
  let statusTimer;
  let volumeContext = null;
  let volumeGain = null;
  let refreshSettingsCache = null;
  const cacheChannel = (() => {
    try { return new BroadcastChannel(`${cacheName}:control`); } catch (_) { return null; }
  })();
  const cancelCacheJobs = () => {
    cacheGeneration++;
    cacheJobs.forEach(job => job.abort.abort());
  };
  cacheChannel?.addEventListener('message', event => {
    if (event.data?.type === 'clear') {
      cancelCacheJobs();
    }
    if (event.data?.type === 'cleared') refreshSettingsCache?.();
  });
  // Native volume is sufficient on desktop. Engines that keep it read-only
  // get a gain node only after a volume-slider gesture, never at page startup.
  volume.addEventListener('input', async () => {
    const value = Number(volume.value) / 100;
    try {
      if (!volumeContext) {
        audio.volume = value;
        if (Math.abs(audio.volume - value) < 0.001) return;
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) throw new Error('Volume unavailable');
        volumeContext = new Context();
      }
      await volumeContext.resume();
      if (volumeContext.state !== 'running') throw new Error('Volume suspended');
      if (!volumeGain) {
        const source = volumeContext.createMediaElementSource(audio);
        volumeGain = volumeContext.createGain();
        source.connect(volumeGain).connect(volumeContext.destination);
      }
      volumeGain.gain.setTargetAtTime(Number(volume.value) / 100, volumeContext.currentTime, 0.02);
    } catch (_) { message('Регулятор недоступен. Используйте кнопки громкости устройства.'); }
  });
  const allLists = () => [...userLists, ...data.playlists];
  const listById = id => allLists().find(l => l.id === id);
  const selected = (list, key) => !(Array.isArray(excluded[list.id]) && excluded[list.id].includes(key));
  const playable = list => (list?.songs || []).filter(key => selected(list, key) && data.songs[key]?.audio);
  function selection() {
    if (selectionState) return selectionState;
    const entries = Object.values(data.songs).map(song => ({
      miniKey:song.key, listId:song.list, localId:song.id, songId:song.song,
      releaseId:song.release, releaseKey:releaseFor(song.key),
      entryKey:JSON.stringify([song.list.toLowerCase(), song.song.toLowerCase(), song.release.toLowerCase()]),
      playable:Boolean(song.audio),
    }));
    const byKey = new Map(entries.map(entry => [entry.miniKey, entry]));
    const scope = new AbortController();
    const life = { scope, dead:false, publish() {},
      queue:{post:work => Promise.resolve().then(() => { if (!life.dead) return work(); })} };
    const storage = {
      getItem(key) { try { return localStorage.getItem(prefix + key); } catch (_) { return null; } },
      setItem(key, value) { try { localStorage.setItem(prefix + key, value); } catch (_) {} },
    };
    const { TSelectionMemory, TPlaylistSelector } = window.VCardSelectionCore;
    const memory = new TSelectionMemory(life, {catalog:{entries}, storage, storageKey:key => prefix + key});
    life.selectionMemory = memory;
    const selector = new TPlaylistSelector(entries, memory, null,
      () => playbackQueue().map(item => byKey.get(item.key)).filter(Boolean));
    selectionState = {memory, selector, byKey, life, scope};
    return selectionState;
  }
  const persist = () => {
    try {
      writeSelection();
      localStorage.setItem(profileKey, JSON.stringify({version:1, preferences}));
    }
    catch (_) { message('Хранилище браузера недоступно: изменения действуют до закрытия страницы.'); }
  };
  window.addEventListener('storage', event => {
    if (event.key !== selectionKey && event.key !== null) return;
    try {
      if (!readSelection()) {
        userLists = [];
        for (const id of Object.keys(excluded)) delete excluded[id];
      }
      selectionState?.selector.reset();
      render();
    } catch (_) { message('Не удалось прочитать общий выбор песен.'); }
  });
  function message(text) {
    clearTimeout(statusTimer);
    status.textContent = text;
    if (text) statusTimer = setTimeout(() => { status.textContent = ''; }, 5000);
  }
  const palette = ['#ffa6c1','#00e3c8','#ecbe24','#adc2ff','#ffae89','#5ed4ff','#95db6c','#e4a9ff',
    '#ffaaa6','#00deeb','#c6ce3f','#c6b9ff','#ffb259','#92caff','#55e39b','#ff9fe5',
    '#ffa8b3','#00e0da','#dbc62d','#b9beff','#ffb076','#7ecfff','#78df83','#f99dfb',
    '#ffac98','#00dbfc','#afd555','#d3b2ff','#fbb62b','#a1c6ff','#20e4b2','#ffa3d1'];
  let schemeBag = [];
  let activeTheme = '';
  let pageColor = '';
  function renewColors() {
    const root = document.documentElement;
    let scheme = preferences.theme;
    if (scheme === 'auto') {
      if (!schemeBag.length) {
        schemeBag = themes.slice(1).map(([key]) => key);
        for (let i = schemeBag.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [schemeBag[i], schemeBag[j]] = [schemeBag[j], schemeBag[i]];
        }
      }
      if (schemeBag.length > 1 && schemeBag[schemeBag.length - 1] === activeTheme) {
        [schemeBag[0], schemeBag[schemeBag.length - 1]] = [schemeBag[schemeBag.length - 1], schemeBag[0]];
      }
      scheme = schemeBag.pop();
    }
    activeTheme = scheme;
    const candidates = palette.filter(color => color !== pageColor);
    pageColor = candidates[Math.floor(Math.random() * candidates.length)];
    let ink = pageColor, accent = pageColor, paper = '#000';
    if (scheme === 'night') { ink = '#fff'; accent = '#ffd400'; }
    else if (scheme === 'newspaper') { paper = '#fff'; ink = accent = '#000'; }
    else if (scheme === 'duo') {
      const rgb = color => color.slice(1).match(/\w\w/g).map(channel => parseInt(channel, 16));
      const base = rgb(pageColor);
      const distance = color => rgb(color).reduce((sum, channel, i) => sum + (channel-base[i]) ** 2, 0);
      const contrasting = palette.filter(color => color !== pageColor)
        .sort((a,b) => distance(b) - distance(a)).slice(0,3);
      accent = contrasting[Math.floor(Math.random() * contrasting.length)];
    }
    root.dataset.theme = scheme;
    root.style.setProperty('--paper', paper);
    root.style.setProperty('--ink', ink);
    root.style.setProperty('--accent', accent);
    const channels = color => color.slice(1).match(/\w\w/g).map(value => parseInt(value, 16));
    const expand = color => color.length === 4 ? '#' + [...color.slice(1)].map(value => value + value).join('') : color;
    const foreground = channels(expand(ink)), background = channels(expand(paper));
    const muted = '#' + foreground.map((value, i) => Math.round(value * 0.55 + background[i] * 0.45)
      .toString(16).padStart(2, '0')).join('');
    root.style.setProperty('--muted', muted);
  }
  function applyPreferences() {
    document.documentElement.style.fontSize = `${preferences.fontSize}px`;
    document.documentElement.style.lineHeight = String(data.lineHeight || 1.35);
    document.documentElement.style.fontFamily = preferences.fontFamily === 'Fairfax' ? '"Fairfax", monospace' : preferences.fontFamily;
  }
  renewColors();
  applyPreferences();
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  function action(text, run) {
    const button = el('button', text);
    button.type = 'button';
    button.addEventListener('click', run);
    return button;
  }
  function href(view) {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    if (view.list) url.searchParams.set('list', view.list);
    if (view.song) {
      const song = data.songs[view.song];
      url.searchParams.set('song', song.id);
      if (listById(view.list)?.user) url.searchParams.set('entry', song.key);
    }
    if (['opt','map'].includes(view.kind)) url.searchParams.set('view', view.kind);
    return url.href;
  }
  function readRoute() {
    const params = new URL(location.href).searchParams;
    const list = listById(params.get('list'));
    const song = list?.songs.find(key => key === params.get('entry') || data.songs[key]?.id === params.get('song'));
    return {kind: ['opt','map'].includes(params.get('view')) ? params.get('view') : song ? 'song' : list ? 'list' : 'root', list:list?.id || '', song:song || ''};
  }
  function link(text, view) {
    const node = el('a', text);
    node.href = href(view);
    if (view.kind === 'map') {
      node.title = 'Карта релизов';
      node.setAttribute('aria-label', node.title);
    }
    node.addEventListener('click', event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      go(view);
    });
    return node;
  }
  function go(view, replace = false) {
    history[replace ? 'replaceState' : 'pushState']({}, '', href(view));
    route = view;
    content.scrollTop = 0;
    render();
  }
  window.addEventListener('popstate', () => { route = readRoute(); content.scrollTop = 0; render(); });
  function navigation() {
    const navLink = (text, view) => {
      const node = link(text, view);
      if (view.kind === route.kind) node.setAttribute('aria-current', 'page');
      return node;
    };
    const lists = document.createDocumentFragment();
    lists.append(navLink(navLabels.lists ?? 'Списки', {kind:'root'}));
    const full = el('a', navLabels.full ?? 'FULL');
    full.title = 'Открыть полное представление';
    full.setAttribute('aria-label', full.title);
    const fullUrl = new URL(siteRoot);
    for (const key of ['list','song']) {
      const value = new URL(href(route)).searchParams.get(key);
      if (value) fullUrl.searchParams.set(key, value);
    }
    full.setAttribute('href', `../${fullUrl.search}`);
    const list = listById(route.list);
    if (list) lists.append(document.createTextNode(' > '), navLink(list.user ? list.title : list.id.toUpperCase(), {kind:'list', list:list.id}));
    const song = data.songs[route.song];
    if (song) lists.append(document.createTextNode(' > '), navLink(song.song, {kind:'song', list:list?.id || song.list, song:song.key}));
    for (const slot of navSlots) {
      const kind = slot.dataset.miniNav;
      if (kind === 'opt') slot.replaceChildren(navLink(navLabels.opt ?? 'Настройки', {...route, kind:'opt'}));
      else if (kind === 'map') slot.replaceChildren(navLink(navLabels.map ?? 'RMAP', {...route, kind:'map'}));
      else if (kind === 'lists') slot.replaceChildren(lists);
      else if (kind === 'full') slot.replaceChildren(full);
    }
  }
  function checkbox(label, checked, mixed, change) {
    const node = el('input');
    node.type = 'checkbox';
    node.checked = checked;
    node.indeterminate = mixed;
    node.setAttribute('aria-label', label);
    node.addEventListener('change', () => { change(node.checked); persist(); selectionState?.selector.reset(); render(); });
    return node;
  }
  function setAll(list, value) { excluded[list.id] = value ? [] : [...list.songs]; }
  function selectionActions(list) {
    const bar = el('div', undefined, 'list-actions list-actions--selection');
    const selectAll = value => { (list ? [list] : allLists()).forEach(l => setAll(l, value)); persist(); selectionState?.selector.reset(); render(); };
    bar.innerHTML = data.listActionsHtml || '';
    const handlers = {
      SELECT_ALL: () => selectAll(true),
      CLEAR_ALL: () => selectAll(false),
      ADD_LIST: saveList,
      REMOVE_LIST: () => removeList(list),
    };
    bar.querySelectorAll('[data-list-action]').forEach(button => {
      const name = button.dataset.listAction;
      if (handlers[name]) button.addEventListener('click', handlers[name]);
      if (name === 'REMOVE_LIST') button.disabled = !list?.user;
    });
    return bar;
  }
  async function dialog(title, body, yes = 'Да') {
    const box = document.getElementById('list-dialog');
    if (box.open) return false;
    document.getElementById('dialog-title').textContent = title;
    document.getElementById('dialog-body').replaceChildren(body);
    document.getElementById('dialog-yes').textContent = yes;
    box.returnValue = '';
    const result = new Promise(resolve => box.addEventListener('close', () => resolve(box.returnValue === 'yes'), {once:true}));
    box.showModal();
    body.querySelector?.('input')?.focus();
    return result;
  }
  async function saveList() {
    const seen = new Set();
    const keys = allLists().flatMap(l => l.songs.filter(k => selected(l, k))).filter(k => {
      const s = data.songs[k];
      const identity = `${s.song}/${s.release}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
    if (!keys.length) { message('Нет отмеченных песен.'); return; }
    const field = el('input');
    field.type = 'text'; field.maxLength = 80; field.required = true;
    field.setAttribute('aria-label', 'Имя списка');
    const form = el('label', 'Имя списка'); form.append(field);
    if (!await dialog('Добавить список', form, 'Далее')) return;
    const title = field.value.trim();
    if (!title) return;
    const existing = userLists.find(l => l.title.toLocaleLowerCase() === title.toLocaleLowerCase());
    const body = el('div');
    body.append(el('p', keys.map(k => { const s = data.songs[k]; return `${s.list}/${s.id}`; }).join(' ')),
      el('p', `Сохранить эти релизы в список «${title}»?${existing ? ' Существующий список будет заменён.' : ''}`));
    if (!await dialog(existing ? 'Заменить список?' : 'Сохранить список?', body)) return;
    const item = {id:existing?.id || `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`, title, songs:keys, user:true};
    userLists = [item, ...userLists.filter(l => l.id !== item.id)];
    delete excluded[item.id];
    persist();
    go({kind:'list', list:item.id});
  }
  async function removeList(list) {
    if (!list?.user || !await dialog('Удалить список?', el('p', `Убрать плейлист «${list.title}»?`))) return;
    userLists = userLists.filter(l => l.id !== list.id);
    delete excluded[list.id];
    if (playingList === list.id) playingList = current?.list || '';
    selectionState?.selector.reset();
    persist();
    go({kind:'root'});
  }
  async function render() {
    screen.dataset.view = route.kind;
    if (route.kind !== 'song') window.VCardAnalytics?.leave();
    refreshSettingsCache = null;
    const revision = ++paintRevision;
    navigation();
    screen.replaceChildren();
    lyricsVerses = [];
    activeVerse = -1;
    if (route.kind === 'opt') { settings(); return; }
    if (route.kind === 'map') {
      if (data.rmapHtml) {
        const map = document.createElement('template');
        map.innerHTML = data.rmapHtml;
        for (const anchor of map.content.querySelectorAll('a[data-list][data-song]')) {
          const list = data.playlists.find(p => p.id === anchor.dataset.list);
          const key = list?.songs.find(k => data.songs[k].id === anchor.dataset.song);
          if (key) {
            const replacement = link('', {kind:'song', list:list.id, song:key});
            replacement.append(...anchor.childNodes);
            anchor.replaceWith(replacement);
          }
        }
        screen.append(map.content);
        return;
      }
      return;
    }
    if (route.kind === 'root') {
      const ul = el('ul');
      for (const list of allLists()) {
        const count = list.songs.filter(k => selected(list, k)).length;
        const row = el('li', undefined, 'entry');
        row.append(checkbox(`Выбрать плейлист ${list.title}`, count === list.songs.length && count > 0, count > 0 && count < list.songs.length, value => setAll(list, value)),
          link(list.title, {kind:'list', list:list.id}), el('small', `${count}/${list.songs.length}`));
        ul.append(row);
      }
      screen.append(ul, selectionActions());
    } else if (route.kind === 'list') {
      const list = listById(route.list);
      if (!list) { go({kind:'root'}, true); return; }
      const ul = el('ul');
      for (const key of list.songs) {
        const song = data.songs[key];
        const row = el('li', undefined, 'entry entry--song');
        row.append(checkbox(`Выбрать песню ${song.title}`, selected(list, key), false, value => {
          const items = new Set(Array.isArray(excluded[list.id]) ? excluded[list.id] : []);
          value ? items.delete(key) : items.add(key);
          excluded[list.id] = [...items];
        }), link(song.title, {kind:'song', list:list.id, song:key}));
        ul.append(row);
      }
      screen.append(ul, selectionActions(list));
    } else if (route.kind === 'song') {
      const song = data.songs[route.song];
      if (!song) { go({kind:'root'}, true); return; }
      window.VCardAnalytics?.open({song_id:song.song, release_id:song.release, playlist_id:route.list});
      choose(song, route.list);
      const lyrics = el('div', 'Загрузка текста…', 'lyrics');
      screen.append(el('h1', song.title, 'song-title'), lyrics);
      try {
        const html = await loadText(song);
        if (revision !== paintRevision) return;
        lyrics.replaceChildren();
        let verse = null;
        for (const line of html.split(/<br\s*\/?>/i)) {
          const fragment = document.createElement('template');
          fragment.innerHTML = line;
          for (const node of fragment.content.querySelectorAll('[src],[href],[poster]')) {
            for (const name of ['src','href','poster']) {
              const value = node.getAttribute(name);
              if (value && !value.startsWith('#')) node.setAttribute(name, new URL(value, siteRoot).href);
            }
          }
          const plain = fragment.content.textContent.trim();
          const boundary = !plain || /^\*\s*\*\s*\*$/.test(plain) || plain === '-*-' || /^\d{4}(?:\s*[-–—]\s*(?:\d{4}|\d{2}))?$/.test(plain);
          if (boundary) {
            verse = null;
            if (plain && plain !== '-*-') { const separator = el('div', undefined, 'text-note'); separator.append(fragment.content); lyrics.append(separator); }
            continue;
          }
          if (!verse) { verse = el('div', undefined, 'verse'); lyrics.append(verse); lyricsVerses.push(verse); }
          else verse.append(el('br'));
          verse.append(fragment.content);
        }
        track(true);
      } catch (_) { if (revision === paintRevision) lyrics.textContent = 'Текст не загрузился. Откройте песню ещё раз.'; }
    }
  }
  async function loadText(song) {
    const playlist = data.playlists.find(p => p.id === song.list);
    const key = playlist.text;
    let pending = textCache.get(key);
    if (!pending) {
      pending = window.VCardCrypt?.protectedUrl(key) ? window.VCardCrypt.json(key)
        : fetch(key).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
      pending.catch(() => { if (textCache.get(key) === pending) textCache.delete(key); });
    }
    textCache.delete(key);
    textCache.set(key, pending);
    while (textCache.size > 3) textCache.delete(textCache.keys().next().value);
    const texts = await pending;
    if (typeof texts[song.textKey] !== 'string') throw new Error('Missing lyrics');
    return texts[song.textKey];
  }
  function choose(song, list, launch = 'manual', restart = false) {
    playingList = list || song.list;
    if (current?.key === song.key && !restart) return;
    const reservation = selectionState?.selector.reservation;
    if (reservation && reservation.entry.releaseKey !== releaseFor(song.key)) reservation.cancel();
    if (!restart) pendingHistoryIndex = null;
    if (current) renewColors();
    playbackLaunch = launch;
    analyticsRun++;
    current = song;
    currentTimes = (song.track.match(/\d+:\d{2}/g) || []).map(t => { const [m,s] = t.split(':').map(Number); return m * 60 + s; });
    audio.pause();
    audio.removeAttribute('src');
    if (song.audio && !window.VCardCrypt?.protectedUrl(song.audio)) audio.src = song.audio;
    audio.load();
    if (window.VCardCrypt?.protectedUrl(song.audio)) {
      window.VCardCrypt.audioUrl(song.audio, {current:true}).then(source => {
        if (current?.key !== song.key || audio.hasAttribute('src')) return;
        audio.src = source;
        audio.load();
      }).catch(() => message('Не удалось подготовить защищённый MP3.'));
    }
    document.getElementById('now').textContent = song.title;
    playButton.disabled = !song.audio;
    seek.disabled = true;
    syncPlayer();
    navigation();
    ensureWorker();
  }
  function following(direction = 1) {
    const queue = playbackQueue();
    if (!queue.length) return null;
    const identity = current && releaseFor(current.key);
    if (direction < 0) {
      for (let index = historyCursor - 1; index >= 0; index--) {
        const entry = queue.find(item => item.id === historyQueue[index]);
        if (entry) return {...entry, historyIndex:index};
      }
      return null;
    }
    if (direction > 0 && preferences.shuffle) {
      const reservation = selection().selector.reserve();
      return reservation ? queue.find(item => item.id === reservation.entry.releaseKey) || null : null;
    }
    const index = queue.findIndex(item => item.id === identity);
    return queue[index < 0 ? (direction < 0 ? queue.length - 1 : 0) : (index + direction + queue.length) % queue.length];
  }
  function playbackQueue() {
    const seen = new Set();
    return allLists().flatMap(list => playable(list).flatMap(key => {
      const id = releaseFor(key);
      if (seen.has(id)) return [];
      seen.add(id);
      return [{key, list:list.id, id}];
    }));
  }
  async function start() {
    if (!current?.audio) {
      const list = listById(route.list);
      const key = playable(list)[0];
      const entry = key ? {key, list:list.id} : playbackQueue()[0];
      const song = data.songs[entry?.key];
      if (!song) { message('Нет отмеченных песен для воспроизведения.'); return; }
      choose(song, entry.list);
      go({kind:'song', list:entry.list, song:song.key});
    }
    // Invoke play in the user gesture; neither cache nor text loading gates it.
    const expected = current.key;
    selectionState?.selector.invalid.delete(releaseFor(current.key));
    volumeContext?.resume().catch(() => {});
    if (window.VCardCrypt?.protectedUrl(current.audio)) {
      try {
        const source = await window.VCardCrypt.audioUrl(current.audio, {current:true});
        if (current?.key !== expected) return;
        if (audio.getAttribute('src') !== source) { audio.src = source; audio.load(); }
      } catch (_) { message('Не удалось расшифровать MP3. Откройте песню ещё раз.'); return; }
    }
    audio.play().catch(error => { if (current?.key === expected && error.name !== 'AbortError') message(`Не удалось начать воспроизведение. Нажмите ${playLabel} ещё раз.`); });
  }
  function advance(direction, automatic = false) {
    const entry = following(direction);
    if (!entry) { message('Нет отмеченных песен для перехода.'); return; }
    const next = data.songs[entry.key];
    const list = entry.list;
    pendingHistoryIndex = entry.historyIndex ?? null;
    choose(next, list, automatic ? 'automatic' : 'manual', true);
    go({kind:'song', list, song:next.key});
    playbackLaunch = automatic ? 'automatic' : 'manual';
    start();
  }
  playButton.addEventListener('click', () => audio.paused ? start() : audio.pause());
  document.getElementById('prev').addEventListener('click', () => advance(-1));
  document.getElementById('next').addEventListener('click', () => advance(1));
  audio.addEventListener('ended', () => {
    if (current?.audio) cacheMedia(current.audio).catch(() => {});
    if (preferences.autoNext) advance(1, true);
  });
  audio.addEventListener('error', () => {
    if (!current) return;
    const selector = selectionState?.selector;
    selector?.invalid.add(releaseFor(current.key));
    selector?.reservation?.cancel();
    message(`Аудио недоступно. Проверьте соединение и нажмите ${playLabel}.`);
  });
  const time = seconds => `${Math.floor((Number.isFinite(seconds) ? seconds : 0) / 60).toString().padStart(2,'0')}:${Math.floor((Number.isFinite(seconds) ? seconds : 0) % 60).toString().padStart(2,'0')}`;
  function syncPlayer() {
    playButton.textContent = audio.paused ? playLabel : pauseLabel;
    playButton.title = audio.paused ? 'Воспроизвести песню' : 'Приостановить воспроизведение';
    playButton.setAttribute('aria-label', playButton.title);
    document.getElementById('prev').disabled = !current;
    document.getElementById('next').disabled = !current;
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    seek.disabled = !duration;
    seek.value = duration ? Math.round(audio.currentTime / duration * 1000) : 0;
    currentClock.textContent = time(audio.currentTime);
    totalClock.textContent = ` / ${time(duration)}`;
    clock.title = `${time(audio.currentTime)} / ${time(duration)}`;
  }
  for (const event of ['play','pause','loadedmetadata','durationchange','emptied']) audio.addEventListener(event, syncPlayer);
  audio.addEventListener('timeupdate', () => { syncPlayer(); track(); });
  audio.addEventListener('playing', () => {
    if (current && confirmedRun !== analyticsRun) {
      const state = selection();
      const identity = state.byKey.get(current.key);
      if (identity) {
        const reservation = state.selector.reservation;
        if (reservation?.entry.releaseKey === identity.releaseKey) reservation.commit();
        else reservation?.cancel();
        state.selector.started(identity);
        state.memory.record({song:{identity}, runId:analyticsRun});
        if (pendingHistoryIndex !== null) historyCursor = pendingHistoryIndex;
        else {
          historyQueue.splice(historyCursor + 1);
          historyQueue.push(identity.releaseKey);
          if (historyQueue.length > 100) historyQueue.shift();
          historyCursor = historyQueue.length - 1;
        }
        pendingHistoryIndex = null;
        confirmedRun = analyticsRun;
      }
    }
    const next = data.songs[following()?.key];
    if (next?.audio) {
      const task = window.VCardCrypt?.protectedUrl(next.audio)
        ? window.VCardCrypt.audioUrl(next.audio) : cacheMedia(next.audio);
      task.catch(() => {});
    }
  });
  window.VCardAnalytics?.bindAudio(audio, () => current && ({song_id:current.song,
    release_id:current.release, playlist_id:playingList, run_id:analyticsRun,
    launch_type:playbackLaunch}));
  seek.addEventListener('input', () => {
    if (Number.isFinite(audio.duration)) audio.currentTime = Number(seek.value) / 1000 * audio.duration;
    manualScrollUntil = 0;
    track(true);
  });
  for (const event of ['wheel','touchstart','pointerdown']) content.addEventListener(event, () => { manualScrollUntil = Date.now() + 4000; }, {passive:true});
  function track(force = false) {
    if (!current || route.kind !== 'song' || route.song !== current.key) return;
    let index = -1;
    currentTimes.forEach((t,i) => { if (audio.currentTime >= t) index = i; });
    if (index === activeVerse && !force) return;
    activeVerse = index;
    const verses = lyricsVerses;
    verses.forEach((v,i) => v.classList.toggle('active', i === index));
    const verse = verses[index];
    if (!verse || !preferences.tracking || Date.now() < manualScrollUntil) return;
    const y = verse.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop - Math.max(12,(content.clientHeight - verse.offsetHeight) / 2);
    content.scrollTo({top:Math.max(0,y), behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
  }
  function setting(label, node) {
    node.setAttribute('aria-label', label);
    const boundary = label.lastIndexOf(' ');
    const row = el('label', boundary < 0 ? '' : label.slice(0,boundary + 1), 'setting');
    const tail = el('span', label.slice(boundary + 1), 'setting-tail');
    tail.append(document.createTextNode(' '), node);
    row.append(tail);
    screen.append(row);
  }
  function settings() {
    const theme = el('select');
    for (const [value,label] of themes) {
      const option = el('option', label); option.value = value; theme.append(option);
    }
    theme.value = preferences.theme;
    theme.addEventListener('change', () => { preferences.theme = theme.value; persist(); renewColors(); });
    setting('Цветовая схема', theme);
    const font = el('select');
    for (const [value,label] of fontFamilies) {
      const option = el('option', label); option.value = value; font.append(option);
    }
    font.value = preferences.fontFamily;
    font.addEventListener('change', () => { preferences.fontFamily = font.value; persist(); applyPreferences(); });
    setting('Шрифт', font);
    const size = el('select');
    for (const value of [16,18,20,24,28,32,36]) { const option = el('option', `${value}`); option.value = value; size.append(option); }
    size.value = preferences.fontSize;
    size.addEventListener('change', () => { preferences.fontSize = Number(size.value); persist(); applyPreferences(); });
    setting('Размер шрифта', size);
    for (const [name,label] of [['tracking','Сопровождение куплета'],['autoNext','Следующая песня автоматически'],['shuffle','Перемешивать песни']]) {
      const input = el('input'); input.type = 'checkbox'; input.checked = Boolean(preferences[name]);
      input.addEventListener('change', () => {
        preferences[name] = input.checked;
        selectionState?.selector.reset();
        persist();
      });
      setting(label, input);
    }
    screen.append(el('h2', 'Кэш (общий с полной версией)'));
    const info = el('p', 'Загрузка информации о кэше…');
    screen.append(info);
    let infoRevision = 0;
    const refreshCacheInfo = async () => {
      const revision = ++infoRevision;
      try {
        const cache = await caches.open(cacheName);
        const entries = await cache.keys();
        let bytes = 0;
        for (const key of entries) {
          const response = await cache.match(key);
          if (!response) continue;
          const length = Number(response.headers.get('Content-Length'));
          bytes += length > 0 ? length : (await response.blob()).size;
        }
        if (info.isConnected && revision === infoRevision) info.textContent = `${entries.length} файлов · ${(bytes / 1048576).toFixed(1)} МБ`;
      } catch (_) { if (info.isConnected && revision === infoRevision) info.textContent = 'Кэш недоступен в этом браузере.'; }
    };
    refreshCacheInfo();
    refreshSettingsCache = refreshCacheInfo;
    const tools = el('div', undefined, 'list-actions');
    tools.append(action('ПрогрузитьВсё', async () => {
      if (preloadRunning) return;
      infoRevision++;
      preloadRunning = true;
      const generation = cacheGeneration;
      const urls = [...new Set([...Object.values(data.songs).map(s => s.audio).filter(Boolean), ...data.playlists.map(p => p.text)])];
      let count = 0;
      try {
        for (const url of urls) {
          if (generation !== cacheGeneration) break;
          await cacheMedia(url);
          info.textContent = `Прогружено ${++count}/${urls.length}`;
        }
      } catch (_) { info.textContent = `Прогружено ${count}/${urls.length}. Загрузка остановлена из-за ошибки.`; }
      finally { preloadRunning = false; }
    }), action('Очистить', async () => {
      infoRevision++;
      cancelCacheJobs();
      cacheChannel?.postMessage({type:'clear'});
      const jobs = [...cacheJobs.values()];
      jobs.forEach(j => j.abort.abort());
      await Promise.allSettled(jobs.map(j => j.promise));
      try {
        await caches.delete(cacheName);
        cacheChannel?.postMessage({type:'cleared'});
        info.textContent = 'Кэш очищен.';
      }
      catch (_) { info.textContent = 'Не удалось очистить кэш.'; }
    }));
    screen.append(tools);
  }
  function ensureWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return Promise.resolve();
    if (!swReady) swReady = navigator.serviceWorker.register(new URL(`sw.js?inst=${encodeURIComponent(data.instance)}`, siteRoot).href, {scope:siteRoot.href, updateViaCache:'none'}).catch(() => {});
    return swReady;
  }
  function cacheMedia(raw) {
    if (!('caches' in window)) return Promise.resolve();
    const url = new URL(raw, document.baseURI).href;
    if (cacheJobs.has(url)) return cacheJobs.get(url).promise;
    const abort = new AbortController();
    const generation = cacheGeneration;
    const promise = (async () => {
      await ensureWorker();
      const cache = await caches.open(cacheName);
      const cached = await cache.match(url);
      if (cached?.ok && cached.status === 200 && !cached.headers.has('Content-Range')) return;
      const response = await fetch(url, {signal:abort.signal});
      if (!response.ok || response.status !== 200 || response.headers.has('Content-Range')) throw new Error('Incomplete media');
      // A full response is written only after download completes, independently of playback.
      const blob = await response.blob();
      if (!abort.signal.aborted && generation === cacheGeneration) await cache.put(url, new Response(blob, {headers:{'Content-Type':response.headers.get('Content-Type') || 'application/octet-stream', 'Content-Length':String(blob.size)}}));
    })().finally(() => { if (cacheJobs.get(url)?.promise === promise) cacheJobs.delete(url); });
    cacheJobs.set(url, {promise, abort});
    return promise;
  }
  window.addEventListener('pagehide', event => {
    if (!event.persisted) {
      cancelCacheJobs(); cacheChannel?.close();
      if (selectionState) {
        selectionState.selector.reservation?.cancel();
        selectionState.life.dead = true;
        selectionState.scope.abort();
      }
    }
  });
  route = readRoute();
  render();
})();
