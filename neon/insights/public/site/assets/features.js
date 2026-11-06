// Activity log: per row Undo / Redo with a live count of active changes
document.querySelectorAll('[data-activity-log]').forEach((log) => {
  const rows = Array.from(log.querySelectorAll('.f-row'));
  const count = log.querySelector('[data-active-count]');
  const update = () => {
    count.textContent = String(rows.filter((r) => !r.classList.contains('is-undone')).length);
  };
  rows.forEach((row) => {
    const btn = row.querySelector('.f-row__btn');
    const title = row.querySelector('.f-row__title');
    const label = () => `${btn.textContent}: ${title ? title.textContent : ''}`;
    btn.setAttribute('aria-label', label());
    btn.addEventListener('click', () => {
      const undone = row.classList.toggle('is-undone');
      btn.textContent = undone ? 'Redo' : 'Undo';
      btn.setAttribute('aria-label', label());
      update();
    });
  });
  update();
});
