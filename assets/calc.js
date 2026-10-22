// Schengen 90/180 calculator page. Reads the form, runs schengen.js, renders the result.
// No network, no storage, no cookies: state lives in the form and is gone on reload.
// Strings come from the page (<script type="application/json" id="calc-i18n">), built per
// language by tools/site/build.mjs.
import * as S from './schengen.js';

const $ = (sel, root = document) => root.querySelector(sel);
const I = JSON.parse($('#calc-i18n').textContent);
const lang = document.documentElement.lang || 'en';
const DAY_MS = 86400000;
const dtf = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const nf = new Intl.NumberFormat(lang);
const pr = new Intl.PluralRules(lang);

const form = $('#calc-form');
const list = $('#stays');
const tpl = $('#stay-tpl');
const out = $('#res');
const live = $('#live');
const asOfInput = $('#asof');
const planInput = $('#plan');
const visaBox = $('#visa');
let seq = 0;

// ---- text helpers ---------------------------------------------------------------------------

const NBSP = ' ';
const daysText = (n) => (I.days[pr.select(n)] ?? I.days.other).replace('{n}', nf.format(n)).replace(/(\d) /g, `$1${NBSP}`);
const dateText = (day) => dtf.format(new Date(day * DAY_MS));
const place = (code) => (code === S.AREA ? I.area : I.countries[code] || code);

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}
const dateNode = (day) => el('time', { datetime: S.formatDate(day) }, dateText(day));
const strong = (s) => el('b', {}, s);

/** Fills "{name}" slots in a template with nodes or strings. */
function fill(template, vars) {
  const frag = document.createDocumentFragment();
  let last = 0;
  template.replace(/\{(\w+)\}/g, (m, key, at) => {
    frag.append(template.slice(last, at));
    const v = vars[key];
    frag.append(v instanceof Node ? v.cloneNode(true) : String(v ?? m));
    last = at + m.length;
    return m;
  });
  frag.append(template.slice(last));
  return frag;
}
const plain = (template, vars) => template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));

const ICON = {
  ok: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="m7.8 12.3 2.8 2.8 5.6-5.8"/></svg>',
  near: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2 2.6 19.6h18.8z"/><path d="M12 9.6v4.6M12 17.1v.1"/></svg>',
  out: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="m8.6 8.6 6.8 6.8M15.4 8.6l-6.8 6.8"/></svg>',
};
function status(kind, label) {
  const s = el('span', { class: `status ${kind}` });
  s.innerHTML = ICON[kind]; // static markup, no user input
  s.append(label);
  return s;
}

// ---- rows -----------------------------------------------------------------------------------

function addStay(values = {}, focus = false) {
  const li = tpl.content.firstElementChild.cloneNode(true);
  const k = ++seq;
  li.dataset.k = k;
  for (const input of li.querySelectorAll('input,select')) {
    const id = `${input.name}-${k}`;
    input.id = id;
    const label = li.querySelector(`label[data-for="${input.name}"]`);
    if (label) label.htmlFor = id;
    if (values[input.name] !== undefined) input.value = values[input.name];
  }
  const hint = li.querySelector('.hint');
  hint.id = `exit-hint-${k}`;
  li.querySelector('.err').id = `err-${k}`;
  li.querySelector('[name=exit]').setAttribute('aria-describedby', hint.id);
  list.append(li);
  renumber();
  if (focus) li.querySelector('[name=entry]').focus();
  return li;
}

function renumber() {
  [...list.children].forEach((li, i) => {
    const n = String(i + 1);
    li.querySelector('.stay-title').textContent = plain(I.stay, { n });
    li.querySelector('.remove').setAttribute('aria-label', plain(I.remove, { n }));
  });
}

list.addEventListener('click', (e) => {
  const btn = e.target.closest('.remove');
  if (!btn) return;
  const li = btn.closest('li');
  const next = li.nextElementSibling || li.previousElementSibling;
  li.remove();
  if (!list.children.length) addStay();
  renumber();
  (next && next.isConnected ? next.querySelector('[name=entry]') : list.querySelector('[name=entry]'))?.focus();
  schedule();
});

$('#add').addEventListener('click', () => { addStay({}, true); schedule(); });
$('#clear').addEventListener('click', () => {
  list.replaceChildren();
  addStay({}, true);
  planInput.value = '';
  schedule();
});
$('#example').addEventListener('click', () => {
  // European Commission, short-stay calculator user manual, section 6 (visa holder example):
  // 80 days used; a trip from 19 June 2024 may last 20 days, until 8 July 2024.
  list.replaceChildren();
  addStay({ entry: '2024-01-01', exit: '2024-01-10', country: 'FR' });
  addStay({ entry: '2024-03-01', exit: '2024-03-30', country: 'IT' });
  addStay({ entry: '2024-05-01', exit: '2024-06-09', country: 'DE' });
  asOfInput.value = '2024-06-19';
  planInput.value = '2024-06-19';
  list.querySelector('[name=entry]').focus();
  schedule();
});

// ---- compute and render ---------------------------------------------------------------------

// Coalesce the events of one interaction into one render (a microtask, so it also runs in
// background tabs, where animation frames are paused).
let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => { pending = false; render(); });
}
form.addEventListener('input', schedule);
form.addEventListener('change', schedule);
form.addEventListener('submit', (e) => { e.preventDefault(); render(); });

let liveTimer = 0;
function announce(text) {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => { live.textContent = text; }, 700);
}

function rowError(li, code) {
  const err = li.querySelector('.err');
  const entry = li.querySelector('[name=entry]');
  const exit = li.querySelector('[name=exit]');
  entry.removeAttribute('aria-invalid');
  exit.removeAttribute('aria-invalid');
  entry.removeAttribute('aria-describedby');
  exit.setAttribute('aria-describedby', `exit-hint-${li.dataset.k}`);
  err.hidden = !code;
  err.textContent = code ? I.errors[code] : '';
  if (!code) return;
  const bad = code.startsWith('entry') ? entry : exit;
  bad.setAttribute('aria-invalid', 'true');
  bad.setAttribute('aria-describedby', `${bad === exit ? `exit-hint-${li.dataset.k} ` : ''}${err.id}`);
}

function block(title, cls = '') {
  const sec = el('section', { class: `card res-block ${cls}`.trim() });
  if (title) sec.append(el('h3', {}, title));
  return sec;
}
const para = (...kids) => el('p', {}, ...kids);

function render() {
  const rows = [...list.children];
  const raw = rows.map((li) => ({
    entry: li.querySelector('[name=entry]').value,
    exit: li.querySelector('[name=exit]').value,
    country: li.querySelector('[name=country]').value,
  }));
  const asOf = S.parseDate(asOfInput.value);
  const { stays, errors } = S.normaliseStays(raw, { asOf });
  rows.forEach((li, i) => rowError(li, errors.find((e) => e.index === i)?.code));

  asOfInput.toggleAttribute('aria-invalid', asOf === null);
  $('#asof-err').hidden = asOf !== null;
  $('#asof-err').textContent = asOf === null ? I.errors.asOf : '';

  let visa = null;
  const visaErr = $('#visa-err');
  if (visaBox.open) {
    const v = S.normaliseVisa({
      validFrom: $('#visa-from').value,
      validUntil: $('#visa-until').value,
      durationDays: $('#visa-duration').value,
      entries: $('#visa-entries').value,
    });
    visa = v.visa || null;
    visaErr.hidden = !v.error;
    visaErr.textContent = v.error ? I.errors[v.error] : '';
  } else {
    visaErr.hidden = true;
  }

  out.replaceChildren();
  if (asOf === null) return;
  if (!stays.length) {
    out.append(el('div', { class: 'card res-block' }, el('p', { class: 'res-empty' }, I.empty)));
    announce(I.empty);
    return;
  }

  const c = S.check(stays, asOf);
  const vc = visa ? S.checkVisa(stays, visa, asOf) : null;

  // Hero: used and left, with status.
  const hero = el('section', { class: 'card res-hero guilloche' });
  const st = c.used > S.MAX_DAYS || vc?.breaches.some((x) => x.to >= c.windowStart) ? status('out', I.statusOver)
    : c.used === S.MAX_DAYS ? status('near', I.statusFull)
    : status('ok', I.statusOk);
  hero.append(st);
  const figs = el('div', { class: 'res-figs' });
  figs.append(
    el('div', { class: 'fig' }, el('p', { class: 'label' }, I.used), el('p', { class: 'value' }, nf.format(c.used)),
      el('p', { class: 'sub' }, fill(I.usedSub, { start: dateNode(c.windowStart), end: dateNode(c.windowEnd) }))),
    el('div', { class: 'fig' }, el('p', { class: 'label' }, I.left), el('p', { class: 'value' }, nf.format(c.remaining)),
      el('p', { class: 'sub' }, I.leftSub)),
  );
  hero.append(figs);
  if (c.lastAuthorisedDay !== null) {
    const p = para(fill(I.stayOn, { date: dateNode(asOf), last: strong(dateText(c.lastAuthorisedDay)) }));
    // A visa that ends earlier sets the real limit (its breaches are listed below).
    if (visa && visa.validUntil < c.lastAuthorisedDay) p.append(' ', fill(I.visaReason.validityEnds, { date: strong(dateText(visa.validUntil)) }));
    hero.append(p);
  }
  if (c.nextDayFreed !== null && c.used > 0) hero.append(el('p', { class: 'small' }, fill(I.nextFreed, { date: dateNode(c.nextDayFreed) })));
  out.append(hero);

  // Planned trip.
  const entry = S.parseDate(planInput.value);
  if (entry !== null) {
    const b = block(I.planTitle);
    const p = S.plan(stays, entry);
    let days = p.maxStayDays;
    if (days > 0) {
      b.append(para(fill(I.planOk, { entry: dateNode(entry), days: strong(daysText(days)), exit: strong(dateText(p.latestExit)) })));
    } else {
      b.append(para(fill(I.planNone, { entry: dateNode(entry) })));
      const first = S.earliestEntry(stays, entry + 1);
      if (first) b.append(para(fill(I.planEarliest, { date: strong(dateText(first.date)), days: daysText(first.maxStayDays) })));
      else b.append(para(I.planNotFound));
    }
    if (days < S.MAX_DAYS) {
      const full = S.earliestEntry(stays, entry + 1, S.MAX_DAYS);
      if (full) b.append(para(fill(I.planFull, { date: strong(dateText(full.date)) })));
    }
    if (visa) {
      const cap = S.visaPlanCap(stays, visa, entry);
      if (cap.reason === 'notValidOnEntry') b.append(el('p', { class: 'err' }, fill(I.visaNotValid, { entry: dateNode(entry) })));
      else if (cap.reason === 'noEntriesLeft') b.append(el('p', { class: 'err' }, I.visaNoEntries));
      else if (days > 0 && cap.maxStayDays < days) {
        days = cap.maxStayDays;
        const why = cap.reason === 'durationLeft'
          ? fill(I.visaReason.durationLeft, { days: daysText(cap.maxStayDays) })
          : fill(I.visaReason.validityEnds, { date: dateNode(visa.validUntil) });
        if (days > 0) b.append(para(fill(I.visaCap, { days: strong(daysText(days)), entry: dateNode(entry), exit: strong(dateText(entry + days - 1)) }), ' ', why));
        else b.append(el('p', { class: 'err' }, why));
      }
    }
    if (p.replacedStays.length) b.append(el('p', { class: 'small' }, fill(I.planReplaced, { entry: dateNode(entry) })));
    out.append(b);
  }

  // Overstays.
  const over = block(I.overTitle, c.overstay ? 'over' : '');
  if (c.overstayRuns.length) {
    over.prepend(status('out', I.statusOver));
    over.append(el('ul', {}, ...c.overstayRuns.map((r) => el('li', {}, fill(I.overRun, { from: dateNode(r.from), to: dateNode(r.to), days: strong(daysText(r.days)) })))));
  } else {
    over.append(para(fill(I.overNone, { date: dateNode(asOf) })));
  }
  if (c.futureOverstayRuns.length) {
    over.append(para(I.overFuture));
    over.append(el('ul', {}, ...c.futureOverstayRuns.map((r) => el('li', {}, fill(I.overRun, { from: dateNode(r.from), to: dateNode(r.to), days: strong(daysText(r.days)) })))));
  }
  out.append(over);

  // Visa limits.
  if (visa) {
    const b = block(I.visaTitle, vc.breaches.length ? 'over' : '');
    b.append(para(visa.durationDays < S.MAX_DAYS
      ? fill(I.visaUsed, { used: strong(daysText(vc.usedUnderVisa)), duration: daysText(visa.durationDays) })
      : I.visaUsed90));
    if (vc.breaches.length) {
      b.append(el('ul', {}, ...vc.breaches.map((x) => el('li', {}, strong(I.breach[x.kind]), ': ', dateNode(x.from), x.days > 1 ? ' \u2013 ' : '', x.days > 1 ? dateNode(x.to) : '', ` (${daysText(x.days)})`))));
    } else {
      b.append(para(status('ok', I.visaOk)));
    }
    out.append(b);
  }

  // Days left out of the count.
  const notes = [];
  if (c.ignoredPreAccessionDays) notes.push(fill(I.warnPreAccession, { days: daysText(c.ignoredPreAccessionDays) }));
  const others = c.ignoredOutsideCodes.filter((x) => x !== 'AD');
  if (others.length) notes.push(fill(I.warnOutside, { places: others.map(place).join(I.listSep) }));
  if (c.warnings.includes('eesAndorraExitMayBeMissing')) notes.push(document.createTextNode(I.warnAndorra));
  if (notes.length) {
    const b = el('section', { class: 'card res-block warn' });
    b.append(...notes.map((n) => para(n)));
    out.append(b);
  }

  // Day by day.
  const det = el('details', { class: 'card res-block' }, el('summary', {}, strong(I.breakdownTitle)));
  det.append(el('ul', { class: 'breakdown' }, ...c.perStay.map((s) => el('li', {}, fill(I.breakdownRow, {
    from: dateNode(s.entry),
    to: s.ongoing ? el('span', {}, dateText(s.exit), ` (${I.ongoing})`) : dateNode(s.exit),
    place: place(s.country),
    days: strong(daysText(s.inWindow)),
  })))));
  out.append(det);

  announce(`${I.used}: ${daysText(c.used)}. ${I.left}: ${daysText(c.remaining)}.${c.overstay ? ` ${I.statusOver}.` : ''}`);
}

// ---- start ----------------------------------------------------------------------------------

function todayLocal() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
if (!asOfInput.value) asOfInput.value = todayLocal();
visaBox.addEventListener('toggle', schedule);
addStay();
$('#calc-app').hidden = false;
$('#calc-nojs')?.remove();
render();
