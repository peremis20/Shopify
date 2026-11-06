// Pricing: expanding questions
(() => {
  // Questions: one open at a time, clicking the open one closes it
  const qs = Array.from(document.querySelectorAll('.pq__btn'));
  qs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const wasOpen = btn.getAttribute('aria-expanded') === 'true';
      qs.forEach((other) => {
        const open = other === btn && !wasOpen;
        other.setAttribute('aria-expanded', String(open));
        document.getElementById(other.getAttribute('aria-controls')).hidden = !open;
      });
    });
  });
})();
