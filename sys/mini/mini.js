(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('mini-data').textContent);
  const prefix = `vcard:${encodeURIComponent(data.instance)}:`;
  const profileKey = `vcard-mini:${encodeURIComponent(data.instance)}:profile-v1`;
  const cacheName = `${prefix}media-v1`;
  const siteRoot = new URL('../', location.href);
  const audio = document.getElementById('audio');
  const content = document.getElementById('content');
  const screen = document.getElementById('screen');
  const nav = document.getElementById('navigation');
  const playButton = document.getElementById('play');
  const seek = document.getElementById('seek');
  const volume = document.getElementById('volume');
  const clock = document.getElementById('time');
  const currentClock = document.getElementById('current-time');
  const totalClock = document.getElementById('total-time');
  const status = document.getElementById('status');
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  const textCache = new Map();
  const cacheJobs = new Map();
  const historyQueue = [];
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
  preferences.theme = ['system', 'light', 'dark'].includes(preferences.theme) ? preferences.theme : 'system';
  preferences.fontSize = Math.max(14, Math.min(36, Number(preferences.fontSize) || 20));
  const excluded = saved.excluded && typeof saved.excluded === 'object' && !Array.isArray(saved.excluded) ? saved.excluded : {};
  let userLists = Array.isArray(saved.lists) ? saved.lists.filter(l => l && typeof l.id === 'string' && l.id.startsWith('user-') && typeof l.title === 'string' && Array.isArray(l.songs)).map(l => ({...l, songs: l.songs.filter(k => Object.prototype.hasOwnProperty.call(data.songs, k)), user:true})) : [];
  let route;
  let current = null;
  let currentTimes = [];
  let lyricsVerses = [];
  let playingList = '';
  let paintRevision = 0;
  let activeVerse = -1;
  let manualScrollUntil = 0;
  let nextCandidate = null;
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
  const persist = () => {
    try { localStorage.setItem(profileKey, JSON.stringify({version:1, preferences, excluded, lists:userLists})); }
    catch (_) { message('Хранилище браузера недоступно: изменения действуют до закрытия страницы.'); }
  };
  function message(text) {
    clearTimeout(statusTimer);
    status.textContent = text;
    if (text) statusTimer = setTimeout(() => { status.textContent = ''; }, 5000);
  }
  function applyPreferences() {
    document.documentElement.dataset.theme = preferences.theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : preferences.theme;
    document.documentElement.style.fontSize = `${preferences.fontSize}px`;
  }
  systemTheme.addEventListener('change', applyPreferences);
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
    nav.replaceChildren(link('OPT', {...route, kind:'opt'}), document.createTextNode(' | '), link('MAP', {...route, kind:'map'}), document.createTextNode(' | '), link('ROOT', {kind:'root'}));
    const full = el('a', 'FULL');
    const fullUrl = new URL(siteRoot);
    for (const key of ['list','song']) {
      const value = new URL(href(route)).searchParams.get(key);
      if (value) fullUrl.searchParams.set(key, value);
    }
    full.href = fullUrl.href;
    nav.append(document.createTextNode(' | '), full);
    const list = listById(route.list || playingList);
    if (list) nav.append(document.createTextNode(' > '), link(list.title, {kind:'list', list:list.id}));
    const song = data.songs[route.song || ((!route.list || list?.songs.includes(current?.key)) ? current?.key : '')];
    if (song) nav.append(document.createTextNode(' > '), link(song.id, {kind:'song', list:list?.id || song.list, song:song.key}));
  }
  function checkbox(label, checked, mixed, change) {
    const node = el('input');
    node.type = 'checkbox';
    node.checked = checked;
    node.indeterminate = mixed;
    node.setAttribute('aria-label', label);
    node.addEventListener('change', () => { change(node.checked); persist(); nextCandidate = null; render(); });
    return node;
  }
  function setAll(list, value) { excluded[list.id] = value ? [] : [...list.songs]; }
  function selectionActions(list) {
    const bar = el('div', undefined, 'list-actions');
    bar.append(action('ВыбратьВсе', () => { (list ? [list] : allLists()).forEach(l => setAll(l, true)); persist(); nextCandidate = null; render(); }),
      action('ДобавитьСписок', saveList));
    const remove = action('УдалитьСписок', () => removeList(list));
    remove.disabled = !list?.user;
    bar.append(remove);
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
    nextCandidate = null;
    persist();
    go({kind:'root'});
  }
  async function render() {
    refreshSettingsCache = null;
    const revision = ++paintRevision;
    navigation();
    screen.replaceChildren();
    lyricsVerses = [];
    activeVerse = -1;
    if (route.kind === 'opt') { settings(); return; }
    if (route.kind === 'map') {
      if (data.mapHtml) {
        const map = document.createElement('template');
        map.innerHTML = data.mapHtml;
        for (const anchor of map.content.querySelectorAll('a[data-list][data-song]')) {
          const list = data.playlists.find(p => p.id === anchor.dataset.list);
          const key = list?.songs.find(k => data.songs[k].id === anchor.dataset.song);
          if (key) anchor.replaceWith(link(data.songs[key].id, {kind:'song', list:list.id, song:key}));
        }
        screen.append(map.content);
        return;
      }
      for (const group of data.map || []) {
        const list = data.playlists.find(p => p.id === group.list);
        if (!list) continue;
        const section = el('section', undefined, 'map-group');
        const flow = el('p', `(${list.short || list.id}) `);
        for (const key of list.songs) flow.append(link(data.songs[key].id, {kind:'song', list:list.id, song:key}), document.createTextNode(' '));
        section.append(el('h2', group.title), flow);
        screen.append(section);
      }
      return;
    }
    if (route.kind === 'root') {
      screen.append(el('h2', 'Плейлисты'));
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
      screen.append(el('h2', list.title));
      const ul = el('ul');
      for (const key of list.songs) {
        const song = data.songs[key];
        const row = el('li', undefined, 'entry');
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
      choose(song, route.list);
      screen.append(el('h2', song.title));
      const lyrics = el('div', 'Загрузка текста…', 'lyrics');
      screen.append(lyrics);
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
            if (plain) { const separator = el('div', undefined, 'text-note'); separator.append(fragment.content); lyrics.append(separator); }
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
      pending = fetch(key).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
      pending.catch(() => { if (textCache.get(key) === pending) textCache.delete(key); });
    }
    textCache.delete(key);
    textCache.set(key, pending);
    while (textCache.size > 3) textCache.delete(textCache.keys().next().value);
    const texts = await pending;
    if (typeof texts[song.textKey] !== 'string') throw new Error('Missing lyrics');
    return texts[song.textKey];
  }
  function choose(song, list) {
    playingList = list || song.list;
    if (current?.key === song.key) return;
    current = song;
    currentTimes = (song.track.match(/\d+:\d{2}/g) || []).map(t => { const [m,s] = t.split(':').map(Number); return m * 60 + s; });
    nextCandidate = null;
    audio.pause();
    audio.removeAttribute('src');
    if (song.audio) audio.src = song.audio;
    audio.load();
    document.getElementById('now').textContent = song.title;
    playButton.disabled = !song.audio;
    seek.disabled = true;
    syncPlayer();
    navigation();
    ensureWorker();
  }
  function following(direction = 1) {
    const list = listById(playingList) || listById(current?.list);
    const keys = playable(list);
    if (!keys.length) return null;
    if (direction < 0 && preferences.shuffle && historyQueue.length) {
      const previous = historyQueue.pop();
      if (keys.includes(previous)) return data.songs[previous];
    }
    if (direction > 0 && preferences.shuffle) {
      if (nextCandidate && keys.includes(nextCandidate) && nextCandidate !== current?.key) return data.songs[nextCandidate];
      const options = keys.filter(k => k !== current?.key);
      nextCandidate = options.length ? options[Math.floor(Math.random() * options.length)] : keys[0];
      return data.songs[nextCandidate];
    }
    const index = keys.indexOf(current?.key);
    return data.songs[keys[index < 0 ? (direction < 0 ? keys.length - 1 : 0) : (index + direction + keys.length) % keys.length]];
  }
  function start() {
    if (!current?.audio) {
      const list = listById(route.list) || data.playlists.find(p => playable(p).length);
      const song = data.songs[playable(list)[0]];
      if (!song) { message('Нет отмеченных песен для воспроизведения.'); return; }
      choose(song, list.id);
      go({kind:'song', list:list.id, song:song.key});
    }
    // Invoke play in the user gesture; neither cache nor text loading gates it.
    const expected = current.key;
    volumeContext?.resume().catch(() => {});
    audio.play().catch(error => { if (current?.key === expected && error.name !== 'AbortError') message('Не удалось начать воспроизведение. Нажмите PLAY ещё раз.'); });
  }
  function advance(direction) {
    const next = following(direction);
    if (!next) { message('Нет отмеченных песен для перехода.'); return; }
    if (current && direction > 0) historyQueue.push(current.key);
    if (historyQueue.length > 100) historyQueue.shift();
    const list = playingList;
    choose(next, list);
    go({kind:'song', list, song:next.key});
    start();
  }
  playButton.addEventListener('click', () => audio.paused ? start() : audio.pause());
  document.getElementById('prev').addEventListener('click', () => advance(-1));
  document.getElementById('next').addEventListener('click', () => advance(1));
  audio.addEventListener('ended', () => {
    if (current?.audio) cacheMedia(current.audio).catch(() => {});
    if (preferences.autoNext) advance(1);
  });
  audio.addEventListener('error', () => { if (current) message('Аудио недоступно. Проверьте соединение и нажмите PLAY.'); });
  const time = seconds => `${Math.floor((Number.isFinite(seconds) ? seconds : 0) / 60).toString().padStart(2,'0')}:${Math.floor((Number.isFinite(seconds) ? seconds : 0) % 60).toString().padStart(2,'0')}`;
  function syncPlayer() {
    playButton.textContent = audio.paused ? 'PLAY' : 'PAUSE';
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
    const next = following();
    if (next?.audio) cacheMedia(next.audio).catch(() => {});
  });
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
    screen.append(el('h2', 'Настройки'));
    const theme = el('select');
    for (const [value,label] of [['system','Система'],['light','Светлая'],['dark','Тёмная']]) {
      const option = el('option', label); option.value = value; theme.append(option);
    }
    theme.value = preferences.theme;
    theme.addEventListener('change', () => { preferences.theme = theme.value; persist(); applyPreferences(); });
    setting('Тема', theme);
    const size = el('select');
    for (const value of [16,18,20,24,28,32,36]) { const option = el('option', `${value}`); option.value = value; size.append(option); }
    size.value = preferences.fontSize;
    size.addEventListener('change', () => { preferences.fontSize = Number(size.value); persist(); applyPreferences(); });
    setting('Размер шрифта', size);
    for (const [name,label] of [['tracking','Сопровождение куплета'],['autoNext','Следующая песня автоматически'],['shuffle','Перемешивать песни']]) {
      const input = el('input'); input.type = 'checkbox'; input.checked = Boolean(preferences[name]);
      input.addEventListener('change', () => { preferences[name] = input.checked; nextCandidate = null; persist(); });
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
    if (!event.persisted) { cancelCacheJobs(); cacheChannel?.close(); }
  });
  route = readRoute();
  render();
})();
