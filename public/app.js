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
})();
