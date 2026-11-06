// Sign In: validation, show/hide password, simulated login and Google sign in
(() => {
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const form = document.getElementById('signin-form');
  if (!form) return;
  const done = document.getElementById('signin-done');
  const email = document.getElementById('email');
  const pw = document.getElementById('pw');
  const pwWrap = document.getElementById('pw-wrap');
  const emailErr = document.getElementById('email-err');
  const pwErr = document.getElementById('pw-err');
  const toggle = document.getElementById('pw-toggle');
  const submitBtn = document.getElementById('signin-submit');
  const googleBtn = document.getElementById('google');
  const controls = [email, pw, toggle, submitBtn, googleBtn];
  let timer = null;

  const setErr = (input, box, errEl, msg) => {
    errEl.textContent = msg;
    box.classList.toggle('is-invalid', !!msg);
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  };
  const setLoading = (on) => {
    submitBtn.textContent = on ? 'Signing in…' : 'Sign In →';
    controls.forEach((c) => { c.disabled = on; });
    form.setAttribute('aria-busy', String(on));
  };
  const start = (delay) => {
    if (timer) return; // already signing in
    const shownEmail = email.value.trim();
    setLoading(true);
    timer = setTimeout(() => {
      timer = null;
      setLoading(false);
      done.querySelector('[data-bind="email"]').textContent = shownEmail;
      form.hidden = true;
      done.hidden = false;
      done.querySelector('h2').focus();
    }, delay);
  };

  email.addEventListener('input', () => setErr(email, email, emailErr, ''));
  pw.addEventListener('input', () => setErr(pw, pwWrap, pwErr, ''));

  toggle.addEventListener('click', () => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
    toggle.setAttribute('aria-pressed', String(show));
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (timer) return;
    const eMsg = EMAIL_RE.test(email.value.trim()) ? '' : 'Enter a valid email address.';
    const pMsg = pw.value.length < 6 ? 'Password must be at least 6 characters.' : '';
    setErr(email, email, emailErr, eMsg);
    setErr(pw, pwWrap, pwErr, pMsg);
    if (eMsg) return email.focus();
    if (pMsg) return pw.focus();
    start(900);
  });

  googleBtn.addEventListener('click', () => {
    if (timer) return;
    // Like the prototype: use a demo address only when the field is empty
    if (!email.value.trim()) email.value = 'owner@gmail.com';
    else if (!EMAIL_RE.test(email.value.trim())) { setErr(email, email, emailErr, 'Enter a valid email address.'); return email.focus(); }
    setErr(email, email, emailErr, '');
    setErr(pw, pwWrap, pwErr, '');
    start(700);
  });

  document.getElementById('signout').addEventListener('click', () => {
    clearTimeout(timer);
    timer = null;
    setLoading(false);
    pw.value = '';
    done.hidden = true;
    form.hidden = false;
    email.focus();
  });

  submitBtn.disabled = false; // enabled once this script is running
})();
