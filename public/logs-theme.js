const choices = new Set(['system', 'light', 'dark']);

export function initializeTheme(
  selector,
  { root = document.documentElement, storage, media } = {},
) {
  let choice = 'system';
  if (storage === undefined) {
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
  }
  if (media === undefined) {
    try {
      media = window.matchMedia('(prefers-color-scheme: light)');
    } catch {
      media = null;
    }
  }
  try {
    const saved = storage?.getItem('aiLogsTheme');
    if (choices.has(saved)) choice = saved;
  } catch {
    // The preference control remains usable when browser storage is blocked.
  }

  const apply = () => {
    root.dataset.theme = choice;
    selector.value = choice;
  };
  apply();
  selector.addEventListener('change', () => {
    choice = choices.has(selector.value) ? selector.value : 'system';
    apply();
    try {
      storage?.setItem('aiLogsTheme', choice);
    } catch {
      // Keep the current-page preference even if it cannot be persisted.
    }
  });
  media?.addEventListener?.('change', () => {
    if (choice === 'system') apply();
  });
}
