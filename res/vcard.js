const email0 = 'ali';

  (() => {
    const indexButtons = Array.from(document.querySelectorAll('.tabs__item'));
    const listSections = Array.from(document.querySelectorAll('.list'));
    const buttons = Array.from(document.querySelectorAll('.song__item'));
    const previews = Array.from(document.querySelectorAll('.song__preview'));
    const audios = () => Array.from(document.querySelectorAll('.song__audio'));
    let autoPlayFromEnded = false;

    const setActiveIndexButton = (activeButton) => {
      indexButtons.forEach((button) => {
        button.classList.toggle('is-active', button === activeButton);
      });
    };

    const showListById = (id) => {
      if (!id) return;
      listSections.forEach((section) => {
        if (section.id === id) {
          section.style.display = '';
        } else {
          section.style.display = 'none';
        }
      });
    };

    const tabsContainer = document.querySelector('.tabs-block');

    const activateList = (targetListId, shouldScroll = true) => {
      const targetButton = indexButtons.find((button) => button.getAttribute('list') === targetListId);
      if (targetButton) setActiveIndexButton(targetButton);
      showListById(targetListId);
      if (shouldScroll && tabsContainer) {
        tabsContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };

    // Initialize visible song from the active button (if any), otherwise show first
    const initialActive = indexButtons.find(b => b.classList.contains('is-active'));
    if (initialActive) {
      const initialId = initialActive.getAttribute('list');
      if (initialId) activateList(initialId, false);
    } else if (listSections.length) {
      showListById(listSections[0].id);
    }

    indexButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const targetListId = button.getAttribute('list');
        if (targetListId) {
          activateList(targetListId);
          return;
        }

        // Fallback: if button has data-page, navigate as before
        if (button.dataset.page) {
          if (tabsContainer) {
            tabsContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
            setTimeout(() => { window.location.href = button.dataset.page; }, 600);
          } else {
            window.location.href = button.dataset.page;
          }
        }
      });
    });

    const resolveSource = (preview, audioEl) => {
      const audioDataSrc = audioEl ? (audioEl.dataset.src || '').trim() : '';
      const audioSrc = audioEl ? (audioEl.getAttribute('src') || '').trim() : '';
      const previewSrc = preview ? (preview.dataset.src || '').trim() : '';
      return audioDataSrc || audioSrc || previewSrc || '';
    };

    const isPlayableSource = (src) => {
      const value = (src || '').trim();
      return !!value && !value.endsWith('/');
    };

    const ensureAudioSource = (preview, audioEl) => {
      if (!preview || !audioEl) return '';
      const src = resolveSource(preview, audioEl);
      if (!src) return '';
      if (!isPlayableSource(src)) {
        audioEl.hidden = true;
        return '';
      }
      preview.dataset.src = src;
      audioEl.dataset.src = src;
      if (audioEl.getAttribute('src') !== src) {
        audioEl.setAttribute('src', src);
        audioEl.load && audioEl.load();
      }
      return src;
    };

    const showPreview = (preview) => {
      if (!preview) return;
      preview.hidden = false;
      requestAnimationFrame(() => preview.classList.add('is-visible'));
    };

    const hidePreview = (preview) => {
      if (!preview) return;
      preview.classList.remove('is-visible');
      const transitionMs = getComputedStyle(preview).transitionDuration
        .split(',')
        .some((duration) => parseFloat(duration) > 0);
      if (!transitionMs) {
        try { preview.hidden = true; } catch (err) { }
        return;
      }
      const onEnd = (e) => {
        if (e && e.target !== preview) return;
        if (preview.classList.contains('is-visible')) {
          preview.removeEventListener('transitionend', onEnd);
          return;
        }
        try { preview.hidden = true; } catch (err) { }
        preview.removeEventListener('transitionend', onEnd);
      };
      preview.addEventListener('transitionend', onEnd);
    };

    const hideAllPreviews = () => {
      previews.forEach(hidePreview);
      buttons.forEach((button) => button.classList.remove('is-active'));
    };

    const hideAndStopAllAudios = () => {
      audios().forEach((audio) => {
        try { audio.pause(); } catch (e) { }
        audio.hidden = true;
        try { audio.currentTime = 0; } catch (e) { }
      });
    };

    const bindAutoAdvance = (audioEl, currentButton) => {
      if (!audioEl || !currentButton) return;
      audioEl.onended = () => {
        const currentIdx = buttons.indexOf(currentButton);
        const nextBtn = buttons[(currentIdx + 1) % buttons.length];
        if (nextBtn) {
          autoPlayFromEnded = true;
          setTimeout(() => {
            try { nextBtn.click(); } catch (e) { }
          }, 5000);
        }
      };
    };

    hideAllPreviews();

    previews.forEach((preview) => {
      const audio = preview.querySelector('.song__audio');
      if (!audio) return;
      audio.preload = 'none';
      const src = ensureAudioSource(preview, audio);
      audio.hidden = !src;
    });

    const openSongButton = (button) => {
      const preview = button.nextElementSibling;
      if (!preview || !preview.classList.contains('song__preview')) return;

      // Toggle behavior: clicking an already open item closes its preview
      if (button.classList.contains('is-active') && preview.classList.contains('is-visible')) {
        hidePreview(preview);
        button.classList.remove('is-active');
        const audioToStop = preview.querySelector('.song__audio');
        if (audioToStop) {
          try { audioToStop.pause(); } catch (e) { }
          audioToStop.hidden = true;
          try { audioToStop.currentTime = 0; } catch (e) { }
        }
        autoPlayFromEnded = false;
        return;
      }

      const shouldAutoPlay = autoPlayFromEnded;
      autoPlayFromEnded = false;
      const targetAudio = preview.querySelector('.song__audio');
      const preservePlayingAudio = !!(
        targetAudio && !targetAudio.paused && !targetAudio.ended && targetAudio.currentTime > 0
      );

      hideAllPreviews();
      if (!preservePlayingAudio) {
        hideAndStopAllAudios();
      }
      showPreview(preview);
      button.classList.add('is-active');

      let audioEl = preview.querySelector('.song__audio');
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.className = 'song__audio';
        audioEl.controls = true;
        audioEl.preload = 'none';
        preview.insertBefore(audioEl, preview.firstChild);
      }
      const audioSrc = ensureAudioSource(preview, audioEl);
      bindAutoAdvance(audioEl, button);

      // Without PLAY button, keep native player visible.
      audioEl.hidden = !audioSrc;

      if (!audioSrc) {
        try { audioEl.pause(); } catch (e) { }
      } else if (preservePlayingAudio) {
        // Keep current playback state.
      } else if (shouldAutoPlay) {
        audioEl.play && audioEl.play().catch(() => { });
      } else {
        // Manual preview open: do not autoplay.
        try { audioEl.pause(); } catch (e) { }
      }

      try {
        requestAnimationFrame(() => button.scrollIntoView({ behavior: 'auto', block: 'start' }));
      } catch (e) { }
    };

    buttons.forEach((button) => {
      button.addEventListener('click', () => openSongButton(button));
    });

    document.querySelectorAll('.news-link, .news-block a[data-list][data-song]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const targetListId = link.dataset.list || '';
        const targetSongId = link.dataset.song || '';
        if (!targetListId || !targetSongId) return;
        activateList(targetListId, false);
        const targetButton = buttons.find((button) => (
          button.dataset.list === targetListId && button.dataset.song === targetSongId
        ));
        if (targetButton) openSongButton(targetButton);
      });
    });
  })();

  // Service Worker Registration
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { });
  }

  // Email copy handler
  (() => {
    const email1 = 's.akp';
    const emailLink = document.getElementById('email-link');
    if (emailLink) {
      emailLink.addEventListener('click', (e) => {
        e.preventDefault();
        const email2 = 'es@gmail.com';
        const email = email0 + email1 + email2;
        navigator.clipboard.writeText(email).then(() => {
          alert('скопирован в буфер обмена');
        }).catch(() => {
          alert('Не удалось скопировать: ' + email);
        });
      });
    }
  })();
  (() => {
    const STORAGE_KEY = "alis-color-scheme";

    const schemes = {
      white: {
        "--vc-win": "silver",
        "--vc-dark": "silver",
        "--vc-text": "black"
      },
      black: {
        "--vc-win": "black",
        "--vc-dark": "black",
        "--vc-text": "white"
      }
    };

    const root = document.documentElement;
    const links = Array.from(document.querySelectorAll(".colorui-block [data-color-scheme]"));

    function applyScheme(key) {
      if (!schemes[key]) key = "white";

      Object.entries(schemes[key]).forEach(([name, value]) => {
        root.style.setProperty(name, value);
      });
      localStorage.setItem(STORAGE_KEY, key);

      links.forEach((link) => {
        link.classList.toggle("is-active", link.dataset.colorScheme === key);
      });
    }

    links.forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        applyScheme(link.dataset.colorScheme);
      });
    });

    applyScheme(localStorage.getItem(STORAGE_KEY) || "black");
  })();
  (() => {
    const STORAGE_KEY = "alis-image-size";

    const sizes = new Set(["off", "s", "l"]);
    const imageClickOrder = ["s", "l"];

    const root = document.documentElement;
    const links = Array.from(document.querySelectorAll(".imageui-block [data-image-size]"));

    function applyImageSize(key) {
      if (!sizes.has(key)) key = "s";

      root.dataset.imageSize = key;
      localStorage.setItem(STORAGE_KEY, key);

      links.forEach((link) => {
        link.classList.toggle("is-active", link.dataset.imageSize === key);
      });
    }

    links.forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        applyImageSize(link.dataset.imageSize);
      });
    });

    document.addEventListener("click", (event) => {
      const image = event.target.closest(".song__preview-image");
      if (!image) return;

      const current = localStorage.getItem(STORAGE_KEY) || "s";
      const index = imageClickOrder.indexOf(current);
      const nextIndex = index >= 0 ? index + 1 : 0;
      applyImageSize(imageClickOrder[nextIndex % imageClickOrder.length]);
    });

    applyImageSize(localStorage.getItem(STORAGE_KEY) || "s");
  })();
  (() => {
    const STORAGE_KEY = "alis-song-scale";

    const fontSizes = {
      s: "20px",
      m: "24px",
      l: "30px"
    };

    const root = document.documentElement;
    const links = Array.from(document.querySelectorAll(".fontui-block [data-song-scale]"));

    function applyScale(key) {
      if (!fontSizes[key]) key = "m";

      root.style.setProperty("--font-size", fontSizes[key]);
      localStorage.setItem(STORAGE_KEY, key);

      links.forEach((link) => {
        link.classList.toggle("is-active", link.dataset.songScale === key);
      });
    }

    links.forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        applyScale(link.dataset.songScale);
      });
    });

    applyScale(localStorage.getItem(STORAGE_KEY) || "m");
  })();

