// Загружает карточку товара и печатает компактную сводку ценовых данных.
// Использование: node .claude/skills/extract-price/fetch-price.js <url>
// Выводит JSON с вердиктом (что делать дальше) и кандидатами цены.
// Финальное решение о regular_price/sale_price/has_credit принимает модель.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const LIMIT = 10;
const MAX_REDIRECTS = 12;

// Параметры-трекеры, которые безопасно срезать (см. §1 SKILL.md).
const TRACKING =
  /^(utm_.*|origin_referer|__rr|abt_att|sh|from|_openstat|yclid|gclid|ysclid|fbclid|erid)$/i;

// Маркеры анти-бот заглушки: страница отдаёт 200, но товара в ней нет.
const CHALLENGE = [
  [/get_jhash|__jhash_|__js_p_|__lhash_/, 'js-pow-cookie'],
  [/__qrator|qauth_v/, 'qrator'],
  [/Antibot Challenge|antibot/i, 'antibot'],
  [/__cf_chl|cf-browser-verification|challenge-platform/, 'cloudflare'],
];

const CREDIT_RE =
  /рассрочк\w*|в кредит|кредит\w*|оплат\w* частями|плати\w* частями|частям\w*|долям\w*|сплит|0-0-\d+/gi;

// Контексты, которые выглядят как рассрочка, но ею не являются:
// SEO-описание, пункты меню, ссылки на справку.
const CREDIT_NOISE =
  /<meta|og:description|name="description"|"description"\s*:|href="[^"]*\/(about|credit|help|info|payment)|<title|foText|куп\w+[^<>]{0,60}в кредит или рассрочк|<li|<nav|footer/i;

function uniq(list) {
  return [...new Map(list.map((x) => [JSON.stringify(x), x])).values()];
}

function cleanUrl(raw) {
  const u = new URL(raw);
  [...u.searchParams.keys()]
    .filter((k) => TRACKING.test(k))
    .forEach((k) => u.searchParams.delete(k));
  return u.toString();
}

// --- загрузка: ручные редиректы + cookie-jar -------------------------------
// Без jar сайты с cookie-проверкой (МВидео, Ozon) уводят fetch в бесконечную
// петлю редиректов и падают с "redirect count exceeded".

function storeCookies(jar, res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const raw of list) {
    const pair = raw.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

async function load(url) {
  const jar = new Map();
  const visits = new Map();
  let current = url;
  let redirects = 0;

  for (;;) {
    const headers = {
      'User-Agent': UA,
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.Cookie = cookie;

    const res = await fetch(current, { redirect: 'manual', headers });
    storeCookies(jar, res);

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return { status: res.status, html: '', finalUrl: current, redirects };
      const next = new URL(loc, current).toString();
      const seen = (visits.get(next) || 0) + 1;
      visits.set(next, seen);
      if (++redirects > MAX_REDIRECTS || seen > 3) {
        return { status: res.status, html: '', finalUrl: next, redirects, loop: true };
      }
      current = next;
      continue;
    }

    return {
      status: res.status,
      html: await res.text(),
      finalUrl: current,
      redirects,
    };
  }
}

// --- экстракторы -----------------------------------------------------------

function collectOffers(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((n) => collectOffers(n, out));
    return;
  }
  if (node.price !== undefined || node.lowPrice !== undefined) {
    out.push({
      price: node.price ?? node.lowPrice ?? null,
      currency: node.priceCurrency ?? null,
      availability: node.availability ?? null,
    });
  }
  Object.values(node).forEach((v) => collectOffers(v, out));
}

function jsonLd(html) {
  const out = [];
  const re =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      collectOffers(JSON.parse(m[1].trim()), out);
    } catch {
      /* невалидный блок пропускаем */
    }
  }
  return uniq(out).slice(0, LIMIT);
}

function microdata(html) {
  const out = [];
  const attr =
    /itemprop=["'](price|lowPrice|highPrice)["'][^>]*content=["']([^"']+)["']/gi;
  let m;
  while ((m = attr.exec(html))) out.push({ prop: m[1], value: m[2] });

  // Тот же itemprop, но значение в тексте узла, а не в content=.
  const text =
    /itemprop=["'](price|lowPrice)["'][^>]*>\s*([\d\s  ,.]{3,20})</gi;
  while ((m = text.exec(html))) {
    out.push({ prop: m[1], value: m[2].replace(/[\s ]/g, '') });
  }
  return uniq(out.filter((x) => /\d/.test(x.value))).slice(0, LIMIT);
}

// Ценовые объекты во встроенном состоянии приложения: "price":{...}
function stateBlocks(html) {
  const out = [];
  const re = /"price"\s*:\s*\{/gi;
  let m;
  while ((m = re.exec(html))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < html.length && i - start < 600; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) break;
    }
    try {
      const obj = JSON.parse(html.slice(start, i + 1));
      if (Object.keys(obj).some((k) => /current|old|value|amount|final|base|club/i.test(k))) {
        out.push(obj);
      }
    } catch {
      /* не самостоятельный JSON — пропускаем */
    }
  }
  return uniq(out).slice(0, LIMIT);
}

// Скалярные цены в состоянии: "price":23999 — форма, которую stateBlocks не ловит.
function priceScalars(html) {
  const out = [];
  const re =
    /"(price|oldPrice|priceOld|old_price|salePrice|sale_price|discountPrice|finalPrice|currentPrice|basePrice|priceValue|retailPrice)"\s*:\s*"?(\d{2,9}(?:[.,]\d{1,2})?)"?/gi;
  let m;
  while ((m = re.exec(html))) {
    const value = Number(m[2].replace(',', '.'));
    if (value >= 10 && value <= 100_000_000) out.push({ key: m[1], value });
  }
  return uniq(out).slice(0, LIMIT);
}

function creditSignals(html) {
  // <head> — источник почти всех ложных срабатываний (SEO-описание, title).
  const body = html.replace(/[\s\S]*?<\/head>/i, '');
  const strong = [];
  const weak = [];
  const seen = new Set();
  let m;
  CREDIT_RE.lastIndex = 0;
  while ((m = CREDIT_RE.exec(body)) && strong.length + weak.length < 30) {
    const ctx = body
      .slice(Math.max(0, m.index - 110), m.index + 110)
      .replace(/\s+/g, ' ')
      .trim();
    const key = ctx.replace(/\W/g, '').slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    if (CREDIT_NOISE.test(ctx)) continue;
    // Сильный сигнал: рядом деньги или срок — значит это оффер, а не ссылка.
    // Сильный сигнал: рядом деньги/срок или интерактивный элемент оформления.
    const offer =
      /\d[\d\s ]{2,}\s*(?:₽|руб|мес)|\d+\s*мес|0-0-\d|<button|onclick|role="button"/i.test(ctx);
    (offer ? strong : weak).push(ctx);
  }
  return {
    // offer_found — есть оффер в теле страницы; noise_only — только шаблонные
    // упоминания; none — ни одного. Пусто НЕ означает has_credit:false, см. §6.
    verdict: strong.length ? 'offer_found' : weak.length ? 'noise_only' : 'none',
    strong: strong.slice(0, LIMIT),
    weak: weak.slice(0, 4),
  };
}

// --- вердикт ---------------------------------------------------------------

function classify({ status, html, loop }, found) {
  if (loop) {
    return ['redirect_loop', 'Петля редиректов даже с cookie-jar. Открой URL в браузере.'];
  }
  if ([401, 403, 429, 503].includes(status)) {
    return ['blocked', `Сервер отдал ${status} (анти-бот). Открой URL в браузере, защиту не обходи.`];
  }
  if (status >= 400) {
    return ['http_error', `HTTP ${status}. Проверь URL; цена считается ненайденной.`];
  }
  for (const [re, name] of CHALLENGE) {
    if (re.test(html)) {
      return ['js_challenge', `Анти-бот заглушка (${name}), товара в HTML нет. Открой URL в браузере.`];
    }
  }
  if (found) return ['ok', 'Кандидаты найдены. Сверь их с §3-§6 SKILL.md.'];
  if (html.length < 25_000) {
    return ['js_challenge', 'Ответ подозрительно мал для карточки товара. Открой URL в браузере.'];
  }
  return ['empty', 'Страница отрисована на клиенте (SPA), цены в HTML нет. Открой URL в браузере.'];
}

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.log(JSON.stringify({ verdict: 'no_url', hint: 'Передай один URL карточки товара.' }));
    process.exit(1);
  }

  let url;
  try {
    url = cleanUrl(raw);
  } catch {
    console.log(JSON.stringify({ verdict: 'bad_url', hint: 'Аргумент не является абсолютным URL.' }));
    process.exit(1);
  }

  let page;
  try {
    page = await load(url);
  } catch (e) {
    const cause = e.cause?.code || e.cause?.message || e.message;
    console.log(
      JSON.stringify({
        verdict: 'network_error',
        hint: `Загрузка не удалась (${cause}). Открой URL в браузере.`,
        requestedUrl: url,
      })
    );
    return;
  }

  const data = {
    jsonld: jsonLd(page.html),
    microdata: microdata(page.html),
    stateBlocks: stateBlocks(page.html),
    priceScalars: priceScalars(page.html),
  };
  const found =
    data.jsonld.length + data.microdata.length + data.stateBlocks.length + data.priceScalars.length > 0;
  const [verdict, hint] = classify(page, found);

  console.log(
    JSON.stringify(
      {
        verdict,
        hint,
        http: page.status,
        finalUrl: page.finalUrl,
        redirects: page.redirects,
        bytes: page.html.length,
        ...data,
        credit: creditSignals(page.html),
      },
      null,
      1
    )
  );
}

main().catch((e) => {
  console.log(JSON.stringify({ verdict: 'script_error', hint: String(e) }));
  process.exit(1);
});
