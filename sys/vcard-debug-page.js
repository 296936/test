(() => {
  'use strict';

  const scope = new AbortController();
  let renderFrame = 0;
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    scope.abort();
    if (renderFrame) cancelAnimationFrame(renderFrame);
  }, { signal: scope.signal });

  const manifestNode = document.getElementById('vcard-debug-manifest');
  const table = document.getElementById('vcard-debug-resources');
  const build = document.getElementById('vcard-debug-build');
  const summary = document.getElementById('vcard-debug-summary');
  const status = document.getElementById('vcard-debug-status');
  const session = document.getElementById('vcard-debug-session');
  const checkButton = document.getElementById('vcard-debug-check');
  const snapshotButton = document.getElementById('vcard-debug-snapshot');
  const SNAPSHOT_KEY = 'vcard-debug-media-cache-snapshot-v1';
  const SESSION_REPORT_KEY = 'vcard-media-cache-session-v1';
  const CACHE_NAME = 'vcard-media-v1';
  const MAX_CONCURRENT_CHECKS = 6;

  const decisionsInput = document.getElementById('vcard-debug-decisions-input');
  const decisionsStatus = document.getElementById('vcard-debug-decisions-status');
  document.getElementById('vcard-debug-decisions-show')?.addEventListener('click', () => {
    try {
      if (decisionsInput.value.length > 1048576) throw new Error('Журнал превышает 1 МБ.');
      const payload = JSON.parse(decisionsInput.value);
      if (!Array.isArray(payload?.decisions)) throw new Error('Ожидается объект с массивом decisions.');
      const entries = payload.decisions.slice(-200);
      const fragment = document.createDocumentFragment();
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Некорректная запись решения.');
        const row = document.createElement('tr');
        const context = entry.context;
        const describeContext = (value) => value
          ? `${value.event || '—'} / #${value.commandId ?? '—'} / Run ${value.runId ?? '—'} / Launch ${value.launch ?? '—'}`
          : '—';
        const values = [entry.id, entry.owner,
          entry.origin ? `${describeContext(entry.origin)} → ${describeContext(context)}` : describeContext(context),
          entry.result, entry.selected ?? entry.reason ?? '—',
          `${entry.remainingBefore ?? '—'} → ${entry.remainingAfter ?? '—'}`];
        for (const value of values) {
          const cell = document.createElement('td');
          cell.textContent = String(value ?? '—');
          row.append(cell);
        }
        const cell = document.createElement('td');
        const details = document.createElement('details');
        const label = document.createElement('summary');
        label.textContent = 'JSON';
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(entry, null, 2);
        details.append(label, pre);
        cell.append(details);
        row.append(cell);
        fragment.append(row);
      }
      document.getElementById('vcard-debug-decisions').replaceChildren(fragment);
      const { decisions, ...context } = payload;
      document.getElementById('vcard-debug-decisions-context').textContent = JSON.stringify(context, null, 2);
      decisionsStatus.textContent = `Показано ${entries.length} решений · сборка ${payload.build || '—'} · seed ${payload.seed ?? '—'}.`;
    } catch (error) {
      decisionsStatus.textContent = `Не удалось прочитать журнал: ${error.message}`;
    }
  }, { signal: scope.signal });

  if (!manifestNode || !table || !checkButton || !snapshotButton) return;

  let manifest;
  try {
    manifest = JSON.parse(manifestNode.textContent || '{}');
  } catch (_error) {
    status.textContent = 'Не удалось прочитать манифест медиа.';
    return;
  }

  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  const previousSnapshot = (() => {
    try {
      const value = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || 'null');
      return value && value.states ? value : null;
    } catch (_error) {
      return null;
    }
  })();
  const states = new Map(resources.map((resource) => [resource.url, 'unchecked']));
  let isChecking = false;

  const sessionReport = (() => {
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_REPORT_KEY) || 'null');
      return value && Array.isArray(value.resources) ? value : null;
    } catch (_error) {
      return null;
    }
  })();

  const renderSessionSources = () => {
    if (!session) return;
    if (!sessionReport) {
      session.textContent = 'Список источников последней страницы пока не записан.';
      return;
    }
    const loaded = sessionReport.resources.filter((resource) => resource.source !== 'cached');
    if (!loaded.length) {
      session.textContent = 'Последняя страница получила все медиа из кэша VCard.';
      return;
    }
    const paths = loaded.map((resource) => {
      try {
        return new URL(resource.url).pathname.replace(/^\//, '');
      } catch (_error) {
        return resource.url;
      }
    });
    session.textContent = `Не из кэша VCard при открытии последней страницы: ${paths.join(', ')}.`;
  };

  const formatBytes = (value) => {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let amount = bytes / 1024;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024;
      unit += 1;
    }
    return `${amount.toFixed(amount >= 100 ? 0 : 1)} ${units[unit]}`;
  };

  const labelForState = (state) => ({
    cached: 'в кэше',
    excluded: 'служебный каталог',
    missing: 'нет полного ответа',
    unknown: 'не определено',
    unchecked: 'не проверено',
  }[state] || 'не определено');

  const labelForScope = (scope) => scope === 'song' ? 'песня' : 'встроенный';

  const render = () => {
    const fragment = document.createDocumentFragment();
    let cachedCount = 0;
    let cachedBytes = 0;
    let missingCount = 0;
    let excludedCount = 0;
    let checkedCount = 0;

    resources.forEach((resource) => {
      const current = states.get(resource.url) || 'unchecked';
      const previous = previousSnapshot?.states?.[resource.url] || 'unchecked';
      const row = document.createElement('tr');
      const cells = [labelForScope(resource.scope), resource.kind, resource.path, formatBytes(resource.size)];
      cells.forEach((value, index) => {
        const cell = document.createElement('td');
        cell.textContent = value;
        if (index === 2) cell.className = 'vcard-cache-debug__path';
        row.appendChild(cell);
      });

      const currentCell = document.createElement('td');
      currentCell.textContent = labelForState(current);
      currentCell.className = `vcard-cache-debug__state--${current}`;
      row.appendChild(currentCell);

      const previousCell = document.createElement('td');
      previousCell.textContent = labelForState(previous);
      previousCell.className = `vcard-cache-debug__state--${previous}`;
      if (previous === 'cached' && current === 'missing') {
        previousCell.textContent = 'был в кэше → исчез';
        previousCell.className = 'vcard-cache-debug__state--lost';
      }
      row.appendChild(previousCell);
      fragment.appendChild(row);

      if (current !== 'unchecked') checkedCount += 1;
      if (current === 'cached') {
        cachedCount += 1;
        cachedBytes += Number(resource.size) || 0;
      }
      if (current === 'missing') missingCount += 1;
      if (current === 'excluded') excludedCount += 1;
    });
    table.replaceChildren(fragment);
    summary.replaceChildren(
      summaryItem('Всего', `${resources.length} / ${formatBytes(resources.reduce((sum, resource) => sum + (Number(resource.size) || 0), 0))}`),
      summaryItem('Проверено', `${checkedCount}/${resources.length}`),
      summaryItem('В кэше', `${cachedCount} / ${formatBytes(cachedBytes)}`),
      summaryItem('Нет полного ответа', String(missingCount)),
      summaryItem('Служебные каталоги', String(excludedCount)),
      summaryItem('Прошлый снимок', previousSnapshot ? new Date(previousSnapshot.savedAt).toLocaleString('ru-RU') : 'нет')
    );
    snapshotButton.disabled = checkedCount !== resources.length || isChecking;
  };

  const summaryItem = (name, value) => {
    const wrapper = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = name;
    description.textContent = value;
    wrapper.append(term, description);
    return wrapper;
  };

  const cacheState = async (resource) => {
    if (resource.kind === 'catalog') return 'excluded';
    if (!('caches' in window)) return 'unknown';
    try {
      const cache = await caches.open(CACHE_NAME);
      const request = new Request(new URL(resource.url, document.baseURI).href);
      const response = await cache.match(request);
      return response?.ok && response.status !== 206 && !response.headers.has('Content-Range')
        ? 'cached' : 'missing';
    } catch (_error) {
      return 'unknown';
    }
  };

  const inspectCache = async () => {
    if (scope.signal.aborted || isChecking) return;
    isChecking = true;
    checkButton.disabled = true;
    checkButton.textContent = 'Проверяем…';
    status.textContent = 'Проверка управляемого кэша VCard: сеть не используется.';
    render();

    let cursor = 0;
    let completed = 0;
    const scheduleRender = () => {
      if (renderFrame || scope.signal.aborted) return;
      renderFrame = requestAnimationFrame(() => {
        renderFrame = 0;
        if (scope.signal.aborted) return;
        status.textContent = `Проверка кэша VCard: ${completed}/${resources.length}.`;
        render();
      });
    };
    const worker = async () => {
      while (cursor < resources.length && !scope.signal.aborted) {
        const resource = resources[cursor];
        cursor += 1;
        const result = await cacheState(resource);
        if (scope.signal.aborted) return;
        states.set(resource.url, result);
        completed += 1;
        scheduleRender();
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_CHECKS, resources.length) }, worker));
    if (scope.signal.aborted) return;
    if (renderFrame) { cancelAnimationFrame(renderFrame); renderFrame = 0; }
    isChecking = false;
    checkButton.disabled = false;
    checkButton.textContent = 'Проверить локальный кэш';
    status.textContent = 'Проверка завершена. Сеть не использовалась.';
    render();
  };

  snapshotButton.addEventListener('click', () => {
    const snapshot = {
      savedAt: new Date().toISOString(),
      generatedAt: manifest.generatedAt || '',
      states: Object.fromEntries(states),
    };
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
      status.textContent = 'Снимок сохранён локально в браузере.';
    } catch (_error) {
      status.textContent = 'Не удалось сохранить снимок в localStorage.';
    }
  }, { signal: scope.signal });

  checkButton.addEventListener('click', inspectCache, { signal: scope.signal });
  build.textContent = `Сборка: ${manifest.generatedAt || 'неизвестно'} · медиа: ${resources.length}`;
  renderSessionSources();
  render();
  inspectCache();
})();
