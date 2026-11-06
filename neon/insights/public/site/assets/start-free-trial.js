// Start Free: 3 step signup with per step validation and a confirmation screen
(() => {
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const STEP_NAMES = ['Account', 'Website', 'Goals'];
  const card = document.getElementById('trial');
  if (!card) return;
  const $ = (id) => document.getElementById(id);
  const name = $('t-name'), email = $('t-email'), pw = $('t-pw'), site = $('t-site');
  const errBox = $('t-err'), back = $('t-back'), next = $('t-next');
  const platformBtns = card.querySelectorAll('[data-platform]');
  const goalBtns = card.querySelectorAll('[data-goal]');
  const inputs = [name, email, pw, site];

  const state = { step: 1, platform: '', loading: false };
  const stripProto = (v) => v.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  // Host part only: drop path, query, fragment and port before checking
  const hostOf = (v) => stripProto(v).split(/[\/?#]/)[0].replace(/:\d+$/, '');

  const setErr = (msg, field) => {
    errBox.textContent = msg;
    errBox.hidden = !msg;
    inputs.forEach((f) => {
      f.setAttribute('aria-invalid', String(f === field));
      if (f === field) f.setAttribute('aria-describedby', 't-err'); else f.removeAttribute('aria-describedby');
    });
    if (field) field.focus();
  };

  // Returns [message, field] or null
  const validate = () => {
    if (state.step === 1) {
      if (!name.value.trim()) return ['Please enter your name.', name];
      if (!EMAIL_RE.test(email.value.trim())) return ['Please enter a valid email address.', email];
      if (pw.value.length < 6) return ['Password must be at least 6 characters.', pw];
    }
    if (state.step === 2) {
      if (/\s/.test(stripProto(site.value)) || !/^[^\s.:]+(\.[^\s.:]+)*\.[\p{L}a-z0-9-]{2,}$/iu.test(hostOf(site.value))) return ['Please enter your website address.', site];
      if (!state.platform) return ['Please pick your platform.', platformBtns[0]];
    }
    if (state.step === 3 && ![...goalBtns].some((b) => b.getAttribute('aria-pressed') === 'true')) return ['Pick at least one focus.', goalBtns[0]];
    return null;
  };

  const focusStep = () => {
    const panel = card.querySelector(`[data-step="${state.step}"]`);
    const target = state.step === 4 ? panel.querySelector('h2') : panel.querySelector('input, button');
    if (target) target.focus();
  };

  const render = () => {
    const s = state.step;
    card.querySelectorAll('[data-step]').forEach((el) => { el.hidden = Number(el.dataset.step) !== s; });
    card.querySelectorAll('[data-in-form]').forEach((el) => { el.hidden = s >= 4; });
    $('step-num').textContent = s;
    $('step-name').textContent = STEP_NAMES[s - 1] || '';
    $('step-bar').style.width = (Math.min(s, 3) / 3 * 100) + '%';
    card.querySelector('[role="progressbar"]').setAttribute('aria-valuenow', String(Math.min(s, 3)));
    back.hidden = !(s > 1 && s < 4);
    back.disabled = state.loading;
    next.disabled = state.loading;
    card.setAttribute('aria-busy', String(state.loading));
    next.textContent = state.loading ? 'Setting up…' : (s === 3 ? 'Start Free →' : 'Continue →');
    if (s === 4) {
      $('t-first').textContent = name.value.trim().split(/\s+/)[0] || 'there';
      $('t-site-shown').textContent = stripProto(site.value);
      $('t-email-shown').textContent = email.value.trim();
    }
  };

  inputs.forEach((el) => el.addEventListener('input', () => setErr('')));
  // Enter in a field acts like pressing Continue
  inputs.forEach((el) => el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); next.click(); }
  }));

  platformBtns.forEach((btn) => btn.addEventListener('click', () => {
    if (state.loading) return;
    state.platform = btn.dataset.platform;
    platformBtns.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    setErr('');
  }));

  goalBtns.forEach((btn) => btn.addEventListener('click', () => {
    if (state.loading) return;
    btn.setAttribute('aria-pressed', String(btn.getAttribute('aria-pressed') !== 'true'));
    setErr('');
  }));

  back.addEventListener('click', () => {
    if (state.loading || state.step <= 1 || state.step >= 4) return;
    state.step -= 1;
    setErr('');
    render();
    focusStep();
  });

  next.addEventListener('click', () => {
    if (state.loading || state.step >= 4) return;
    const err = validate();
    if (err) return setErr(err[0], err[1]);
    if (state.step < 3) { state.step += 1; setErr(''); render(); focusStep(); return; }
    state.loading = true;
    render();
    setTimeout(() => { state.loading = false; state.step = 4; render(); focusStep(); }, 1000);
  });

  render();
})();
