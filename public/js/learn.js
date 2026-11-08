// Education page: sidebar of topics (each opens to show its subtabs) + article area.
// The address bar tracks what's open (#topic or #topic/sub) so links can be shared.

const list = document.querySelector('#topic-list');
const article = document.querySelector('#article');

// Flat reading order, used for the Previous / Next links.
const ORDER = LEARN.flatMap(t => [{ t }, ...t.subs.map(s => ({ t, s }))]);

function hrefFor(t, s) { return `#${t.id}${s ? '/' + s.id : ''}`; }

function renderNav(openTopic, openSub) {
  list.innerHTML = LEARN.map(t => {
    const open = t === openTopic;
    const subs = t.subs.length && open ? `
      <ol class="subs">${t.subs.map(s => `
        <li><a href="${hrefFor(t, s)}"${s === openSub ? ' aria-current="true"' : ''}>${s.title}</a></li>`).join('')}
      </ol>` : '';
    return `<li class="${open ? 'open' : ''}">
      <a class="topic-link" href="${hrefFor(t)}" aria-expanded="${open}"
         ${open && !openSub ? 'aria-current="true"' : ''}>${t.title}</a>${subs}
    </li>`;
  }).join('');
}

function renderArticle(t, s) {
  const i = ORDER.findIndex(o => o.t === t && o.s === s);
  const prev = ORDER[i - 1], next = ORDER[i + 1];
  const label = o => o.s ? o.s.title : o.t.title;

  const subCards = !s && t.subs.length ? `
    <div class="sub-cards">${t.subs.map(x => `
      <a href="${hrefFor(t, x)}"><strong>${x.title}</strong><span>${x.summary || ''}</span></a>`).join('')}
    </div>` : '';

  article.innerHTML = `
    <p class="crumb">${s ? `<a href="${hrefFor(t)}">${t.title}</a> / ${s.title}` : 'Education'}</p>
    <h1>${s ? s.title : t.title}</h1>
    ${s ? s.body : t.intro}
    ${subCards}
    <nav class="pager" aria-label="Reading order">
      ${prev ? `<a href="${hrefFor(prev.t, prev.s)}">← ${label(prev)}</a>` : '<span></span>'}
      ${next ? `<a href="${hrefFor(next.t, next.s)}">${label(next)} →</a>` : '<a href="search.html">Try the Search Tool →</a>'}
    </nav>`;
}

function route() {
  const [tid, sid] = location.hash.slice(1).split('/');
  const t = LEARN.find(x => x.id === tid) || LEARN[0];
  const s = t.subs.find(x => x.id === sid) || null;
  renderNav(t, s);
  renderArticle(t, s);
  document.title = `SkyBlink · ${s ? s.title : t.title}`;
}

addEventListener('hashchange', () => {
  route();
  article.focus({ preventScroll: true });
  if (article.getBoundingClientRect().top < 0) article.scrollIntoView({ block: 'start' });
});
route();
