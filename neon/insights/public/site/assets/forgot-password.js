// Forgot Password: email validation, simulated send, "Check your inbox" state
(() => {
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const form = document.getElementById('reset-form');
  if (!form) return;
  const sent = document.getElementById('reset-sent');
  const email = document.getElementById('email');
  const err = document.getElementById('email-err');
  const submitBtn = document.getElementById('reset-submit');
  let timer = null;

  const setErr = (msg) => {
    err.textContent = msg;
    email.setAttribute('aria-invalid', msg ? 'true' : 'false');
  };
  const setLoading = (on) => {
    submitBtn.textContent = on ? 'Sending…' : 'Send Reset Link →';
    submitBtn.disabled = on;
    email.disabled = on;
    form.setAttribute('aria-busy', String(on));
  };

  email.addEventListener('input', () => setErr(''));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (timer) return;
    const value = email.value.trim();
    if (!EMAIL_RE.test(value)) { setErr('Enter a valid email address.'); return email.focus(); }
    setLoading(true);
    timer = setTimeout(() => {
      timer = null;
      setLoading(false);
      document.getElementById('sent-email').textContent = value;
      form.hidden = true;
      sent.hidden = false;
      sent.querySelector('h2').focus();
    }, 800);
  });

  document.getElementById('reset-again').addEventListener('click', () => {
    clearTimeout(timer);
    timer = null;
    setLoading(false);
    email.value = '';
    sent.hidden = true;
    form.hidden = false;
    email.focus();
  });

  submitBtn.disabled = false; // enabled once this script is running
})();
