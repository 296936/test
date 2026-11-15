/* Optional GA4 events. Analytics never participates in playback readiness. */
(() => {
  'use strict';
  const node = document.getElementById('vcard-analytics-data');
  if (!node) return;
  const config = JSON.parse(node.textContent);
  const host = location.hostname.toLowerCase();
  if (!/^G-[A-Z0-9]+$/.test(config.measurementId)
      || !config.hosts.includes(host) || location.protocol !== 'https:') return;

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  const common = {site_version:config.view, site_instance:config.instance,
    page_location:location.origin + location.pathname};
  window.gtag('js', new Date());
  window.gtag('config', config.measurementId, {...common,
    allow_google_signals:false, allow_ad_personalization_signals:false});
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(config.measurementId)}`;
  document.head.append(script);

  const metadata = song => ({song_id:String(song?.song_id || ''),
    release_id:String(song?.release_id || ''), playlist_id:String(song?.playlist_id || ''),
    launch_type:song?.launch_type === 'automatic' ? 'automatic' : 'manual'});
  const send = (name, song) => {
    if (!song?.song_id || !song?.release_id) return;
    try { window.gtag('event', name, {...common, ...metadata(song), send_to:config.measurementId}); }
    catch (_) { /* Blocked analytics must never affect the player. */ }
  };
  let opened = '';
  const open = song => {
    const key = JSON.stringify([song?.playlist_id, song?.song_id, song?.release_id]);
    if (key !== opened) { opened = key; send('song_open', song); }
  };
  const bound = new WeakSet();
  const bindAudio = (audio, identity) => {
    if (!audio || bound.has(audio)) return;
    bound.add(audio);
    let run = null;
    let active = false;
    let position = 0;
    let clock = 0;
    let rate = 1;
    const baseline = () => {
      position = audio.currentTime;
      clock = performance.now();
      rate = audio.playbackRate || 1;
    };
    const sample = () => {
      const elapsed = (performance.now() - clock) / 1000;
      const delta = audio.currentTime - position;
      if (active && run && !audio.seeking && elapsed > 0 && delta > 0
          && delta <= elapsed * rate + 0.35) {
        // A seek changes position but contributes no listened time.
        const media = Math.min(delta, elapsed * rate);
        run.seconds += media / rate;
        const ranges = [...run.ranges, [position, position + media]].sort((a, b) => a[0] - b[0]);
        run.ranges = [];
        for (const range of ranges) {
          const previous = run.ranges[run.ranges.length - 1];
          if (previous && range[0] <= previous[1] + 0.05) previous[1] = Math.max(previous[1], range[1]);
          else run.ranges.push(range);
        }
        const covered = run.ranges.reduce((sum, range) => sum + range[1] - range[0], 0);
        if (!run.listened && run.seconds >= 30) {
          run.listened = true; send('song_listen_30s', run.song);
        }
        if (!run.completed && Number.isFinite(audio.duration) && audio.duration > 0
            && covered >= audio.duration * 0.9) {
          run.completed = true; send('song_listen_90pct', run.song);
        }
      }
      baseline();
    };
    const begin = () => {
      const song = identity();
      if (!song?.song_id || !song?.release_id) return;
      const key = JSON.stringify([song.song_id, song.release_id, song.run_id]);
      if (!run || run.key !== key || run.ended) {
        run = {key, song:metadata(song), seconds:0, ranges:[], ended:false};
        send('song_play', run.song);
      }
      active = true;
      baseline();
    };
    audio.addEventListener('playing', begin);
    audio.addEventListener('timeupdate', sample);
    for (const event of ['pause', 'waiting', 'emptied']) {
      audio.addEventListener(event, () => { sample(); active = false; });
    }
    audio.addEventListener('seeking', () => { active = false; baseline(); });
    audio.addEventListener('seeked', () => { baseline(); active = !audio.paused && audio.readyState >= 3; });
    audio.addEventListener('ratechange', baseline);
    audio.addEventListener('ended', () => {
      sample(); active = false;
      if (run) run.ended = true;
    });
    if (!audio.paused && audio.readyState >= 3) begin();
  };
  const fromEntry = entry => entry && ({song_id:entry.songId,
    release_id:entry.releaseId, playlist_id:entry.listId});
  const shareUrl = value => {
    try {
      const url = new URL(value, location.href);
      const entry = window.VCardCatalog?.find(url.searchParams.get('list'), url.searchParams.get('song'));
      send('song_share', fromEntry(entry));
    } catch (_) { }
  };
  window.VCardAnalytics = Object.freeze({open, leave:() => { opened = ''; }, bindAudio, shareUrl});
  if (config.view === 'midi') {
    document.addEventListener('vcard:song-open', event =>
      open(fromEntry(window.VCardCatalogView?.forPreview(event.target))));
    document.addEventListener('vcard:song-close', () => { opened = ''; });
    document.addEventListener('playing', event => {
      const audio = event.target;
      if (!audio.matches?.('audio[data-shared-player]')) return;
      bindAudio(audio, () => {
        const playback = window.VCLife?.playingSong?.playback;
        const entry = window.VCardCatalogView?.forPreview(audio.vcardPlayingPreview);
        return {...fromEntry(entry), run_id:playback?.runId,
          launch_type:playback?.reason === 'auto' ? 'automatic' : 'manual'};
      });
    }, true);
  }
})();
