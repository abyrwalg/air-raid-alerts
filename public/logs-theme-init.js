try {
  const preference = localStorage.getItem('aiLogsTheme');
  document.documentElement.dataset.theme = ['system', 'light', 'dark'].includes(
    preference,
  )
    ? preference
    : 'system';
} catch {
  document.documentElement.dataset.theme = 'system';
}
