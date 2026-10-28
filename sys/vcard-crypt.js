/* Password-protected songs; persistent caches contain ciphertext only. */
(() => {
  'use strict';
  const node = document.getElementById('vcard-crypt-data');
  if (!node) return;
  const config = JSON.parse(node.textContent);
  const prefix = `vcard:${encodeURIComponent(config.instance)}:`;
  const cacheName = `${prefix}media-v1`;
  const keySlot = `${prefix}crypt-key-v1`;
  const generationSlot = `${prefix}crypt-generation-v1`;
  const utf8 = new TextEncoder();
  const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const encode = value => btoa(String.fromCharCode(...new Uint8Array(value)));
  const objects = new Map();
  const stored = name => { try { return localStorage.getItem(name); } catch (_) { return null; } };
  const forget = name => { try { localStorage.removeItem(name); } catch (_) { } };
  let key;
  let currentAudio = '';
  let disposed = false;
  const decrypt = async (buffer, secret = key) => {
    const bytes = new Uint8Array(buffer);
    if (String.fromCharCode(...bytes.slice(0, 4)) !== 'VCS1') throw new Error('Неверный формат защищённого файла');
    return crypto.subtle.decrypt({name:'AES-GCM', iv:bytes.slice(4, 16), additionalData:utf8.encode('vcard-song-v1')}, secret, bytes.slice(16));
  };
  const importKey = bytes => crypto.subtle.importKey('raw', bytes, 'AES-GCM', true, ['decrypt']);
  const valid = async candidate => {
    try { return new TextDecoder().decode(await decrypt(decode(config.check), candidate)) === 'VCard songs key v1'; }
    catch (_) { return false; }
  };
  const cleanPreviousCache = async () => {
    if (stored(generationSlot) === config.id) return;
    let channel;
    try {
      channel = new BroadcastChannel(`${cacheName}:control`);
      channel.postMessage({type:'clear'});
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        const path = new URL(request.url).pathname;
        if (/\.mp3$/i.test(path) || /\/usr\/texts\//.test(path)) await cache.delete(request);
      }
      channel.postMessage({type:'cleared'});
      localStorage.setItem(generationSlot, config.id);
    } catch (_) { /* Cache may be unavailable; network encryption remains mandatory. */ }
    finally { channel?.close(); }
  };
  const ask = () => new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', 'Ключ доступа к песням');
    dialog.style.cssText = 'color:#fff;background:#161616;border:1px solid #ddd;max-width:90vw;font:18px monospace;padding:1.2em';
    const form = document.createElement('form');
    form.style.textAlign = 'center';
    const label = document.createElement('label');
    label.textContent = 'Ключ доступа к текстам и MP3';
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.required = true;
    input.style.cssText = 'display:block;margin:1em auto;font:inherit;max-width:70vw';
    label.append(input);
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'Открыть';
    submit.style.font = 'inherit';
    const message = document.createElement('p');
    message.setAttribute('role', 'status');
    form.append(label, submit, message);
    if (window.VCardContact) {
      const contact = document.createElement('div');
      contact.style.marginTop = '1em';
      contact.append(window.VCardContact.createLink());
      form.append(contact);
    }
    dialog.append(form);
    dialog.addEventListener('cancel', event => event.preventDefault());
    form.addEventListener('submit', async event => {
      event.preventDefault();
      submit.disabled = true;
      message.textContent = 'Проверка ключа…';
      try {
        const material = await crypto.subtle.importKey('raw', utf8.encode(input.value), 'PBKDF2', false, ['deriveKey']);
        const candidate = await crypto.subtle.deriveKey({name:'PBKDF2', salt:decode(config.salt), iterations:config.iterations, hash:'SHA-256'}, material,
          {name:'AES-GCM', length:256}, true, ['decrypt']);
        if (!await valid(candidate)) throw new Error('Неверный ключ');
        key = candidate;
        try { localStorage.setItem(keySlot, JSON.stringify({id:config.id, key:encode(await crypto.subtle.exportKey('raw', key))})); } catch (_) { }
        input.value = '';
        dialog.close();
        dialog.remove();
        resolve();
      } catch (_) {
        message.textContent = 'Ключ не подошёл. Попробуйте ещё раз.';
        input.select();
      } finally { submit.disabled = false; }
    });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
  const ready = (async () => {
    if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, {once:true}));
    await cleanPreviousCache();
    if (!config.enabled) { forget(keySlot); return; }
    if (!crypto.subtle) throw new Error('Для защищённых песен требуется HTTPS и Web Crypto');
    try {
      const saved = JSON.parse(stored(keySlot) || 'null');
      if (saved?.id === config.id) {
        const candidate = await importKey(decode(saved.key));
        if (await valid(candidate)) key = candidate;
      }
    } catch (_) { }
    if (!key) { forget(keySlot); await ask(); }
  })();
  const protectedUrl = value => config.enabled && /--[a-f0-9]{24}\.(?:mp3|json)(?:[?#]|$)/i.test(String(value));
  const fetchPlain = async (value, options = {}) => {
    await ready;
    const url = new URL(value, document.baseURI).href;
    let cache = null;
    try { cache = await caches.open(cacheName); } catch (_) { }
    let response = await cache?.match(url);
    if (!response?.ok || response.status !== 200) {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), 45000);
      let copy, buffer;
      try {
        response = await fetch(url, {...options, signal:options.signal || timeout.signal});
        if (!response.ok || response.status !== 200) throw new Error(`Загрузка защищённого файла: HTTP ${response.status}`);
        copy = response.clone();
        buffer = await response.arrayBuffer();
      } finally { clearTimeout(timer); }
      const plain = await decrypt(buffer);
      await cache?.put(url, copy).catch(() => {});
      return plain;
    }
    return decrypt(await response.arrayBuffer());
  };
  const retain = source => {
    const url = new URL(source, document.baseURI).href;
    const item = objects.get(url);
    if (item) { objects.delete(url); objects.set(url, item); }
    while (objects.size > 2) {
      const victim = Array.from(objects.keys()).find(k => k !== currentAudio && k !== url);
      if (!victim) break;
      const old = objects.get(victim);
      objects.delete(victim);
      old.then(blob => URL.revokeObjectURL(blob)).catch(() => {});
    }
  };
  const audioUrl = (source, {current = false} = {}) => {
    if (!protectedUrl(source)) return Promise.resolve(source);
    const url = new URL(source, document.baseURI).href;
    if (current) currentAudio = url;
    if (!objects.has(url)) {
      const job = fetchPlain(url).then(bytes => {
        if (disposed) throw new DOMException('Page closed', 'AbortError');
        return URL.createObjectURL(new Blob([bytes], {type:'audio/mpeg'}));
      });
      objects.set(url, job);
      job.catch(() => { if (objects.get(url) === job) objects.delete(url); });
    }
    retain(url);
    return objects.get(url);
  };
  window.VCardCrypt = Object.freeze({ready, enabled:config.enabled, protectedUrl, audioUrl,
    json: async (source, options) => protectedUrl(source)
      ? JSON.parse(new TextDecoder().decode(await fetchPlain(source, options)))
      : fetch(source, options).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
  });
  ready.catch(error => { console.error('VCard access unavailable', error); });
  window.addEventListener('pagehide', event => {
    if (!event.persisted) {
      disposed = true;
      objects.forEach(job => job.then(url => URL.revokeObjectURL(url)).catch(() => {}));
      objects.clear();
    }
  });
})();
