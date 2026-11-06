// FAQ: single-open accordion + live search (matches question or answer text)
(() => {
  const items = Array.from(document.querySelectorAll('.faq-item'));
  const input = document.getElementById('faq-search');
  const empty = document.getElementById('faq-empty');
  if (!items.length || !input) return;
  let open = 0; // index of the open item, -1 for none

  const data = items.map((el) => ({
    el,
    btn: el.querySelector('.faq-item__q'),
    ans: el.querySelector('.faq-item__a'),
    text: (el.querySelector('.faq-item__text').lastChild.textContent + ' ' + el.querySelector('.faq-item__a').textContent).toLowerCase(),
  }));

  const render = () => {
    const ql = input.value.trim().toLowerCase();
    let shown = 0;
    data.forEach((d, i) => {
      const match = !ql || d.text.includes(ql);
      d.el.hidden = !match;
      if (match) shown++;
      const isOpen = open === i;
      d.el.classList.toggle('is-open', isOpen);
      d.btn.setAttribute('aria-expanded', String(isOpen));
      d.ans.hidden = !isOpen;
    });
    empty.hidden = shown !== 0;
  };

  data.forEach((d, i) => d.btn.addEventListener('click', () => { open = open === i ? -1 : i; render(); }));
  input.addEventListener('input', render);
  render();
})();
