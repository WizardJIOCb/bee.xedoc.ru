(() => {
  const METRIKA_COUNTER_ID = 112046844;

  document.querySelectorAll('input, textarea').forEach((field) => field.classList.add('ym-disable-keys'));
  window.dataLayer = window.dataLayer || [];
  (function loadMetrika(m, e, t, r, i, k, a) {
    m[i] = m[i] || function queueMetrikaCall() { (m[i].a = m[i].a || []).push(arguments); };
    m[i].l = 1 * new Date();
    for (let j = 0; j < document.scripts.length; j += 1) {
      if (document.scripts[j].src === r) return;
    }
    k = e.createElement(t);
    a = e.getElementsByTagName(t)[0];
    k.async = true;
    k.src = r;
    a.parentNode.insertBefore(k, a);
  })(window, document, 'script', `https://mc.yandex.ru/metrika/tag.js?id=${METRIKA_COUNTER_ID}`, 'ym');

  window.ym(METRIKA_COUNTER_ID, 'init', {
    ssr: true,
    webvisor: true,
    clickmap: true,
    ecommerce: 'dataLayer',
    referrer: document.referrer,
    url: window.location.href,
    accurateTrackBounce: true,
    trackLinks: true,
  });

  const trackGoal = (goal, params = {}) => {
    if (!/^[a-z][a-z0-9_]{1,79}$/.test(goal) || typeof window.ym !== 'function') return;
    window.ym(METRIKA_COUNTER_ID, 'reachGoal', goal, {
      source_path: window.location.pathname,
      ...params,
    });
  };

  // Kept public for manual verification from the browser console without exposing user data.
  window.pchelaMetrika = { counterId: METRIKA_COUNTER_ID, reachGoal: trackGoal };

  const pendingGoal = document.body.dataset.metrikaGoal;
  if (pendingGoal) {
    const role = document.body.dataset.metrikaRole;
    trackGoal(pendingGoal, role ? { role } : {});
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('ym_goal');
    cleanUrl.searchParams.delete('ym_role');
    window.history.replaceState(window.history.state, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
  }

  const linkPlacement = (element) => {
    if (element.closest('.site-header')) return 'header';
    if (element.closest('.site-footer')) return 'footer';
    if (element.closest('.hero')) return 'hero';
    if (element.closest('.final-cta')) return 'final_cta';
    if (element.closest('.role-panel')) return 'role_panel';
    if (element.closest('.request-card')) return 'request_card';
    return 'content';
  };

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const lotButton = target.closest('[data-lot-choice]');
    if (lotButton) {
      const supplier = document.querySelector('[data-apiary-id]');
      trackGoal('lot_request_start', {
        apiary_id: supplier?.dataset.apiaryId || 'unknown',
        specific_lot: '1',
      });
    }

    const link = target.closest('a[href]');
    if (!link) return;
    const destination = new URL(link.href, window.location.href);
    if (destination.origin !== window.location.origin) return;

    if (destination.pathname === '/register') {
      trackGoal('registration_cta_click', {
        role: destination.searchParams.get('role') === 'buyer' ? 'buyer' : 'supplier',
        placement: linkPlacement(link),
      });
    }

    const apiaryCard = link.closest('.apiary-card[data-apiary-id]');
    if (apiaryCard && destination.pathname.startsWith('/suppliers/')) {
      trackGoal('supplier_card_open', {
        apiary_id: apiaryCard.dataset.apiaryId || 'unknown',
        placement: linkPlacement(link),
      });
    }
  });

  const catalogFormParams = (form) => {
    const data = new FormData(form);
    const filterNames = ['from', 'radius', 'q', 'variety', 'form', 'max_price', 'min_stock', 'verified', 'lab'];
    const filtersCount = filterNames.filter((name) => String(data.get(name) || '').trim()).length;
    return {
      form_source: window.location.pathname === '/' ? 'home' : 'catalog',
      filters_count: filtersCount,
      has_query: String(data.get('q') || '').trim() ? '1' : '0',
    };
  };

  document.addEventListener('submit', (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form) return;
    const action = new URL(form.action || window.location.href, window.location.href);
    if (action.origin !== window.location.origin) return;

    if (action.pathname === '/catalog') {
      const data = new FormData(form);
      if (form.classList.contains('sort-form')) {
        const sort = String(data.get('sort') || 'recommended');
        trackGoal('catalog_sort', { sort: ['distance', 'price', 'stock'].includes(sort) ? sort : 'recommended' });
      } else {
        trackGoal('catalog_search', catalogFormParams(form));
      }
    }

    if (action.pathname === '/register') {
      const role = String(new FormData(form).get('role')) === 'buyer' ? 'buyer' : 'supplier';
      trackGoal('registration_submit', { role });
    }

    if (action.pathname === '/login') trackGoal('login_submit');

    if (action.pathname === '/inquiries') {
      const data = new FormData(form);
      const volume = Number(data.get('volume_kg')) || 0;
      const volumeBucket = volume <= 50 ? '1_50' : volume <= 300 ? '51_300' : volume <= 1000 ? '301_1000' : '1001_plus';
      trackGoal('inquiry_submit', {
        apiary_id: String(data.get('apiary_id') || 'unknown'),
        specific_lot: Number(data.get('lot_id')) > 0 ? '1' : '0',
        volume_bucket: volumeBucket,
      });
    }
  });

  const supplierPage = document.querySelector('.supplier-main[data-apiary-id]');
  if (supplierPage) {
    trackGoal('supplier_view', {
      apiary_id: supplierPage.dataset.apiaryId || 'unknown',
      demo: supplierPage.dataset.apiaryDemo || '0',
      verified: supplierPage.dataset.apiaryVerified || '0',
      has_lots: Number(supplierPage.dataset.apiaryLots) > 0 ? '1' : '0',
    });
  }

  if (window.location.pathname === '/register') {
    const role = document.querySelector('input[name="role"]')?.value === 'buyer' ? 'buyer' : 'supplier';
    trackGoal('registration_start', { role });
  }

  if (window.location.pathname === '/future_partner_join') trackGoal('join_page_view', { audience: 'supplier' });
  if (window.location.pathname === '/future_retail_join') trackGoal('join_page_view', { audience: 'buyer' });

  let visibleSeconds = 0;
  let maxScrollDepth = 0;
  let engagedSent = false;
  let publicationReadSent = false;
  const publication = document.querySelector('.publication-article[data-publication-id]');
  const updateScrollDepth = () => {
    const scrollable = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const depth = scrollable === 0 ? 100 : Math.round((window.scrollY / scrollable) * 100);
    maxScrollDepth = Math.max(maxScrollDepth, Math.min(100, depth));
  };
  updateScrollDepth();
  window.addEventListener('scroll', updateScrollDepth, { passive: true });
  const engagementTimer = window.setInterval(() => {
    if (!document.hidden) visibleSeconds += 1;
    if (!engagedSent && visibleSeconds >= 30 && maxScrollDepth >= 25) {
      engagedSent = true;
      trackGoal('engaged_visit', { depth_bucket: maxScrollDepth >= 75 ? '75_plus' : maxScrollDepth >= 50 ? '50_74' : '25_49' });
    }
    if (publication && !publicationReadSent && visibleSeconds >= 45 && maxScrollDepth >= 60) {
      publicationReadSent = true;
      trackGoal('publication_read', {
        publication_id: publication.dataset.publicationId || 'unknown',
        kind: publication.dataset.publicationKind || 'unknown',
      });
    }
    if (engagedSent && (!publication || publicationReadSent)) window.clearInterval(engagementTimer);
  }, 1000);

  const menuButton = document.querySelector('[data-menu-button]');
  const menu = document.querySelector('[data-menu]');
  if (menuButton && menu) {
    menuButton.addEventListener('click', () => {
      const open = menu.classList.toggle('open');
      menuButton.setAttribute('aria-expanded', String(open));
    });
  }

  document.querySelectorAll('[data-auto-submit]').forEach((element) => {
    element.addEventListener('change', () => element.form?.requestSubmit());
  });

  const filterButton = document.querySelector('[data-filter-button]');
  const filterPanel = document.querySelector('[data-filter-panel]');
  if (filterButton && filterPanel) {
    filterButton.addEventListener('click', () => {
      filterPanel.classList.toggle('open');
      filterButton.textContent = filterPanel.classList.contains('open') ? 'Скрыть фильтры' : 'Настроить фильтры';
    });
  }

  document.querySelectorAll('[data-lot-choice]').forEach((button) => {
    button.addEventListener('click', () => {
      const select = document.querySelector('[data-lot-select]');
      if (select) select.value = button.dataset.lotChoice;
    });
  });

  document.querySelectorAll('[data-dialog-open]').forEach((button) => {
    button.addEventListener('click', () => document.getElementById(button.dataset.dialogOpen)?.showModal());
  });
  document.querySelectorAll('[data-dialog-close]').forEach((button) => {
    button.addEventListener('click', () => button.closest('dialog')?.close());
  });
  document.querySelectorAll('dialog').forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!window.confirm(form.dataset.confirm || 'Подтвердить действие?')) event.preventDefault();
    });
  });

  document.querySelectorAll('[data-bar-width]').forEach((bar) => {
    bar.style.width = `${Math.max(0, Math.min(100, Number(bar.dataset.barWidth) || 0))}%`;
  });
  document.querySelectorAll('[data-chart-height]').forEach((bar) => {
    bar.style.height = `${Math.max(0, Math.min(100, Number(bar.dataset.chartHeight) || 0))}%`;
  });

  document.querySelectorAll('[data-rich-editor]').forEach((editor) => {
    const surface = editor.querySelector('[data-editor-surface]');
    const output = editor.querySelector('[data-editor-output]');
    if (!surface || !output) return;
    const sync = () => { output.value = surface.innerHTML; };
    editor.querySelectorAll('[data-editor-command]').forEach((button) => {
      button.addEventListener('click', () => {
        surface.focus();
        document.execCommand(button.dataset.editorCommand, false);
        sync();
      });
    });
    editor.querySelectorAll('[data-editor-block]').forEach((button) => {
      button.addEventListener('click', () => {
        surface.focus();
        document.execCommand('formatBlock', false, button.dataset.editorBlock);
        sync();
      });
    });
    editor.querySelector('[data-editor-link]')?.addEventListener('click', () => {
      const url = window.prompt('Вставьте адрес ссылки (https://…)');
      if (!url) return;
      surface.focus();
      document.execCommand('createLink', false, url);
      sync();
    });
    surface.addEventListener('input', sync);
    editor.closest('form')?.addEventListener('submit', sync);
  });

  const eventFields = document.querySelector('[data-event-fields]');
  document.querySelectorAll('input[name="kind"]').forEach((input) => {
    input.addEventListener('change', () => {
      if (eventFields) eventFields.hidden = document.querySelector('input[name="kind"]:checked')?.value !== 'event';
    });
  });

  document.querySelectorAll('[data-mention-search]').forEach((input) => {
    input.addEventListener('input', () => {
      const query = input.value.trim().toLocaleLowerCase('ru');
      const list = document.querySelector(`[data-mention-list="${input.dataset.mentionSearch}"]`);
      list?.querySelectorAll('[data-mention-label]').forEach((label) => {
        label.hidden = Boolean(query && !label.dataset.mentionLabel.includes(query));
      });
    });
  });

  document.querySelectorAll('[data-file-dropzone]').forEach((dropzone) => {
    const input = dropzone.querySelector('input[type="file"]');
    const summary = dropzone.querySelector('[data-file-summary]');
    const updateSummary = () => {
      const files = Array.from(input.files || []);
      summary.textContent = files.length ? `${files.length} файл(а): ${files.map((file) => file.name).join(', ')}` : 'Можно выбрать несколько файлов';
      dropzone.classList.toggle('has-files', files.length > 0);
    };
    input?.addEventListener('change', updateSummary);
    dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragging'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
    dropzone.addEventListener('drop', (event) => {
      event.preventDefault();
      dropzone.classList.remove('dragging');
      if (input && event.dataTransfer?.files.length) {
        input.files = event.dataTransfer.files;
        updateSummary();
      }
    });
  });
})();
