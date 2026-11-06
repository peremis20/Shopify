// Mobile menu toggle
document.querySelectorAll('.nav').forEach((nav) => {
  const btn = nav.querySelector('.nav__toggle');
  if (!btn) return;
  const setOpen = (open) => {
    nav.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.addEventListener('click', () => setOpen(!nav.classList.contains('is-open')));
  // Escape closes the menu and returns focus to the toggle
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) {
      setOpen(false);
      btn.focus();
    }
  });
  // Close the panel when the viewport grows back to desktop width
  const mq = window.matchMedia('(min-width: 960px)');
  const onChange = (e) => { if (e.matches) setOpen(false); };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
});

// Scale the CTA illustration down to fit narrow screens (design width 430 x 250)
document.querySelectorAll('.cta__art').forEach((box) => {
  const stage = box.querySelector('.cta__stage');
  if (!stage) return;
  const fit = () => {
    const s = Math.min(1, box.clientWidth / 430);
    stage.style.transform = `scale(${s})`;
    box.style.height = Math.round(250 * s) + 'px';
  };
  if ('ResizeObserver' in window) new ResizeObserver(fit).observe(box);
  else window.addEventListener('resize', fit);
  fit();
});
