// services/newsAggregator.js
// FuturesDesk News Aggregator
// Sources: Federal Reserve, NY Fed, CNBC, Finnhub, Polygon, Truth Social (Trump)
//
// Usage:
//   const { fetchNews } = require('./services/newsAggregator');
//   const news = await fetchNews({ sources: 'all' });
//   const news = await fetchNews({ sources: 'fed,trump,cnbc' });

const https = require('https');
const http  = require('http');

// ── CONFIG ─────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = {
  fed:      5 * 60 * 1000,   // Fed moves slow — 5 min
  nyfed:    5 * 60 * 1000,
  cnbc:     90 * 1000,        // CNBC breaks fast — 90 sec
  finnhub:  2 * 60 * 1000,
  polygon:  2 * 60 * 1000,
  trump:    60 * 1000,        // Truth Social — 60 sec
};

const SOURCES = {
  fed:     { label: 'Federal Reserve',    category: 'macro',   color: '#1e3a5f' },
  nyfed:   { label: 'NY Fed',             category: 'macro',   color: '#1e3a5f' },
  cnbc:    { label: 'CNBC Markets',       category: 'market',  color: '#0059b3' },
  finnhub: { label: 'Finnhub',            category: 'market',  color: '#1db954' },
  polygon: { label: 'Polygon.io',         category: 'market',  color: '#7b5ea7' },
  trump:   { label: 'Trump / Truth Social', category: 'political', color: '#b22222' },
};

// ── SIMPLE IN-MEMORY CACHE ─────────────────────────────────────────────────
const _cache = {};

function getCached(key) {
  const entry = _cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > (CACHE_TTL_MS[key] || 3 * 60 * 1000)) {
    delete _cache[key];
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  _cache[key] = { data, ts: Date.now() };
}

// ── HTTP HELPERS ───────────────────────────────────────────────────────────
function fetchURL(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'FuturesDesk/1.0 (trading-dashboard; +https://futuresdesk.app)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchURL(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    req.on('error', reject);
  });
}

function fetchJSON(url, timeoutMs = 8000) {
  return fetchURL(url, timeoutMs).then(body => JSON.parse(body));
}

// ── RSS PARSER (no dependencies — pure stdlib XML parse) ───────────────────
function parseRSS(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];

  for (const block of itemBlocks) {
    const get = (tag) => {
      // Handle CDATA and plain text
      const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`, 'i');
      const m = block.match(re);
      return m ? (m[1] || m[2] || '').trim() : '';
    };
    const title   = get('title');
    const link    = get('link') || get('guid');
    const desc    = get('description');
    const pubDate = get('pubDate') || get('dc:date');
    const guid    = get('guid');

    if (title || desc) {
      items.push({ title, link, description: desc, pubDate, guid });
    }
  }
  return items;
}

// ── NORMALIZER ─────────────────────────────────────────────────────────────
let _idCounter = 0;
function normalize(raw, sourceKey, subCategory) {
  const src = SOURCES[sourceKey] || { label: sourceKey, category: 'general', color: '#888' };
  return {
    id:          raw.id    || raw.guid  || raw.link  || `${sourceKey}-${Date.now()}-${_idCounter++}`,
    source:      sourceKey,
    sourceLabel: src.label,
    sourceColor: src.color,
    category:    subCategory || src.category,
    title:       (raw.title || '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').trim(),
    summary:     (raw.summary || raw.description || raw.contentSnippet || '').replace(/<[^>]+>/g,'').slice(0,400).trim(),
    url:         raw.link  || raw.url   || raw.article_url || '',
    publishedAt: raw.pubDate || raw.published_utc || raw.datetime || new Date().toISOString(),
    tags:        raw.tags || [],
    image:       raw.image || raw.image_url || null,
    publisher:   raw.publisher || null,
  };
}

// ── SOURCE: FEDERAL RESERVE ────────────────────────────────────────────────
async function fetchFed() {
  const cached = getCached('fed');
  if (cached) return cached;

  const feeds = [
    { url: 'https://www.federalreserve.gov/feeds/press_all.xml',  sub: 'fed-press'     },
    { url: 'https://www.federalreserve.gov/feeds/speeches.xml',   sub: 'fed-speeches'  },
    { url: 'https://www.federalreserve.gov/feeds/testimony.xml',  sub: 'fed-testimony' },
  ];

  const results = [];
  for (const { url, sub } of feeds) {
    try {
      const xml   = await fetchURL(url);
      const items = parseRSS(xml).slice(0, 10);
      results.push(...items.map(i => normalize(i, 'fed', sub)));
    } catch (e) {
      console.warn(`[news] Fed RSS error (${sub}):`, e.message);
    }
  }

  setCache('fed', results);
  return results;
}

// ── SOURCE: NY FED ─────────────────────────────────────────────────────────
async function fetchNYFed() {
  const cached = getCached('nyfed');
  if (cached) return cached;

  const feeds = [
    { url: 'https://www.newyorkfed.org/xml/feeds/all.xml',          sub: 'nyfed-general' },
    { url: 'https://www.newyorkfed.org/xml/feeds/markets.xml',      sub: 'nyfed-markets' },
    { url: 'https://www.newyorkfed.org/xml/feeds/repo-operations.xml', sub: 'nyfed-repo' },
  ];

  const results = [];
  for (const { url, sub } of feeds) {
    try {
      const xml   = await fetchURL(url);
      const items = parseRSS(xml).slice(0, 10);
      results.push(...items.map(i => normalize(i, 'nyfed', sub)));
    } catch (e) {
      console.warn(`[news] NY Fed RSS error (${sub}):`, e.message);
    }
  }

  setCache('nyfed', results);
  return results;
}

// ── SOURCE: CNBC ───────────────────────────────────────────────────────────
async function fetchCNBC() {
  const cached = getCached('cnbc');
  if (cached) return cached;

  const feeds = [
    // Markets
    { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839069', sub: 'cnbc-markets'   },
    // Business News
    { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', sub: 'cnbc-business' },
    // Economy
    { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258',  sub: 'cnbc-economy'  },
    // World Markets
    { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664',  sub: 'cnbc-world'    },
  ];

  const results = [];
  for (const { url, sub } of feeds) {
    try {
      const xml   = await fetchURL(url);
      const items = parseRSS(xml).slice(0, 15);
      results.push(...items.map(i => normalize(i, 'cnbc', sub)));
    } catch (e) {
      console.warn(`[news] CNBC RSS error (${sub}):`, e.message);
    }
  }

  setCache('cnbc', results);
  return results;
}

// ── SOURCE: FINNHUB ────────────────────────────────────────────────────────
// Free tier: 60 req/min — covers general market news + symbol-specific queries
async function fetchFinnhub() {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    console.warn('[news] FINNHUB_API_KEY not set — skipping Finnhub');
    return [];
  }
  const cached = getCached('finnhub');
  if (cached) return cached;

  try {
    const data = await fetchJSON(`https://finnhub.io/api/v1/news?category=general&token=${apiKey}`);
    if (!Array.isArray(data)) throw new Error('Unexpected response shape');

    const results = data.slice(0, 40).map(item => normalize({
      id:          String(item.id),
      title:       item.headline,
      description: item.summary,
      link:        item.url,
      pubDate:     new Date(item.datetime * 1000).toISOString(),
      tags:        [item.category, item.source].filter(Boolean),
      image:       item.image,
    }, 'finnhub', 'market-news'));

    setCache('finnhub', results);
    return results;
  } catch (e) {
    console.warn('[news] Finnhub error:', e.message);
    return [];
  }
}

// ── SOURCE: POLYGON.IO ─────────────────────────────────────────────────────
// Plan covers: Stocks Basic, Indices Basic, Currencies Basic, Options Basic
// Tickers mapped to dashboard instruments:
//   ES  → SPY (S&P 500 ETF)
//   NQ  → QQQ (Nasdaq ETF)
//   YM  → DIA (Dow ETF)
//   GC  → GLD (Gold ETF)
//   SI  → SLV (Silver ETF)
//   CL  → USO (Oil ETF)
//   ZN  → TLT (Treasury ETF)
//   DX  → UUP (Dollar Index ETF)
async function fetchPolygon() {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) {
    console.warn('[news] POLYGON_API_KEY not set — skipping Polygon');
    return [];
  }
  const cached = getCached('polygon');
  if (cached) return cached;

  // Instrument proxies — matches your Stocks Basic plan
  const tickers = ['SPY','QQQ','DIA','GLD','SLV','USO','TLT','UUP','IWM'].join(',');
  const url = `https://api.polygon.io/v2/reference/news?ticker=${tickers}&limit=50&order=desc&sort=published_utc&apiKey=${apiKey}`;

  try {
    const data = await fetchJSON(url);
    const items = (data.results || []).map(item => normalize({
      id:          item.id,
      title:       item.title,
      description: item.description,
      link:        item.article_url,
      pubDate:     item.published_utc,
      tags:        item.tickers || [],
      image:       item.image_url,
      publisher:   item.publisher?.name,
    }, 'polygon', 'market-news'));

    setCache('polygon', items);
    return items;
  } catch (e) {
    console.warn('[news] Polygon error:', e.message);
    return [];
  }
}

// ── SOURCE: TRUMP / TRUTH SOCIAL ───────────────────────────────────────────
// Public RSS — no API key needed
async function fetchTrump() {
  const cached = getCached('trump');
  if (cached) return cached;

  try {
    const xml   = await fetchURL('https://truthsocial.com/@realDonaldTrump.rss');
    const items = parseRSS(xml).slice(0, 25);

    const results = items.map(item => normalize({
      ...item,
      title: item.title || item.description?.replace(/<[^>]+>/g,'').slice(0, 120) || 'Truth Social Post',
      description: item.description?.replace(/<[^>]+>/g,'').slice(0, 500) || '',
      tags: ['trump', 'policy', 'tariffs', 'market-sentiment'],
    }, 'trump', 'trump'));

    setCache('trump', results);
    return results;
  } catch (e) {
    console.warn('[news] Trump RSS error:', e.message);
    return [];
  }
}

// ── SOURCE MAP ─────────────────────────────────────────────────────────────
const SOURCE_FETCHERS = {
  fed:     fetchFed,
  nyfed:   fetchNYFed,
  cnbc:    fetchCNBC,
  finnhub: fetchFinnhub,
  polygon: fetchPolygon,
  trump:   fetchTrump,
};
// Re-map to actual functions (names must match keys)
const FETCHERS = {
  fed:     fetchFed,
  nyfed:   fetchNYFed,
  cnbc:    fetchCNBC,
  finnhub: fetchFinnhub,
  polygon: fetchPolygon,
  trump:   fetchTrump,
};

// ── MAIN EXPORT ────────────────────────────────────────────────────────────
/**
 * Fetch aggregated news.
 *
 * @param {object}   opts
 * @param {string}   opts.sources   'all' | comma-separated source IDs e.g. 'fed,trump,cnbc'
 * @param {string}   [opts.category] optional category filter e.g. 'macro' | 'market' | 'political'
 * @param {number}   [opts.limit]   max items to return (default 100)
 *
 * @returns {Promise<Array>} array of normalized news items sorted newest-first
 */
async function fetchNews({ sources = 'all', category, limit = 100 } = {}) {
  const sourceKeys = sources === 'all'
    ? Object.keys(FETCHERS)
    : sources.split(',').map(s => s.trim().toLowerCase()).filter(s => FETCHERS[s]);

  // Fetch all selected sources concurrently — failures don't kill others
  const settled = await Promise.allSettled(sourceKeys.map(k => FETCHERS[k]()));

  let items = settled
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  // De-duplicate by URL
  const seen = new Set();
  items = items.filter(item => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });

  // Optional category filter
  if (category) {
    const cats = category.split(',').map(c => c.trim().toLowerCase());
    items = items.filter(item => cats.some(c => item.category?.includes(c)));
  }

  // Sort newest-first
  items.sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });

  return items.slice(0, limit);
}

/**
 * Returns metadata about all available sources and their current cache status.
 */
function getSourceMeta() {
  return Object.entries(SOURCES).map(([id, meta]) => ({
    id,
    label:         meta.label,
    category:      meta.category,
    color:         meta.color,
    cached:        !!_cache[id],
    cacheAgeMs:    _cache[id] ? Date.now() - _cache[id].ts : null,
    cacheTTLMs:    CACHE_TTL_MS[id],
    requiresKey:   ['finnhub','polygon'].includes(id)
      ? `${id.toUpperCase()}_API_KEY`
      : null,
    keyPresent:    ['finnhub','polygon'].includes(id)
      ? !!process.env[`${id.toUpperCase()}_API_KEY`]
      : true,
  }));
}

module.exports = { fetchNews, getSourceMeta, SOURCES };
