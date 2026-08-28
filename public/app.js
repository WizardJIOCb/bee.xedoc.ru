(() => {
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
