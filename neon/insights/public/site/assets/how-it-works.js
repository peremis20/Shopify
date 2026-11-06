// How It Works: 4 step walkthrough
(() => {
  const STEPS = [
    { title: 'Connect your site', long: 'Sign up and connect your website plus Google Search Console in a few clicks. No code, no plugins to configure, no developer needed.', points: ['One click connection for popular platforms', 'Secure read access to Search Console & Analytics', 'Your data is only ever used for your site'] },
    { title: 'DashPatrol finds opportunities', long: 'DashPatrol studies your pages, your competitors and the searches your customers type, then builds a plan ranked by what will bring in the most customers fastest.', points: ['Keyword and competitor research', 'Full site health scan', 'A clear, prioritized weekly plan'] },
    { title: 'It does the work', long: 'Each week DashPatrol improves pages, drafts articles, adds internal links and fixes problems. A second AI checks everything, and you choose what gets published.', points: ['Page improvements and broken link fixes', 'Articles drafted in your voice', 'Every change undoable in one click'] },
    { title: 'You see the results', long: 'Every change is measured against your real Google numbers. What helps is kept, what doesn’t is undone, and you get a plain report of visits, searches and sales.', points: ['Weekly report in plain words', 'Rank tracking for every target search', 'Changes kept only when they help'] }
  ];
  const CHECK = '<svg class="check" width="16" height="16" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" fill="none" stroke="#a6f04f" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const detail = document.getElementById('hw-detail');
  if (!detail) return;
  const buttons = Array.from(document.querySelectorAll('.hw-step'));
  const out = (k) => detail.querySelector(`[data-cur="${k}"]`);
  let i = 0;

  function render() {
    const s = STEPS[i];
    buttons.forEach((b, k) => {
      const on = k === i;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    out('n').textContent = String(i + 1);
    out('title').textContent = s.title;
    out('long').textContent = s.long;
    const list = out('points');
    list.textContent = '';
    s.points.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'hw-point';
      row.innerHTML = CHECK;
      row.append(p);
      list.append(row);
    });
  }
  const set = (k) => { i = k; render(); };

  buttons.forEach((b, k) => b.addEventListener('click', () => set(k)));
  detail.querySelector('[data-go="prev"]').addEventListener('click', () => set((i + 3) % 4));
  detail.querySelector('[data-go="next"]').addEventListener('click', () => set((i + 1) % 4));
})();
