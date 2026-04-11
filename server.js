// server.js — FuturesDesk Server
// - TradingView webhook receiver (ICT levels)
// - Real-time RSS news aggregator: Bloomberg, Reuters, Fed, Benzinga, MarketWatch, ForexLive
// Deploy on Railway — PORT set automatically via process.env.PORT

const express = require('express');
const https = require('https');
const http = require('http');
const app = express();
app.use(express.json());

// ── IN-MEMORY STORES ───────────────────────────────────────────────────────
const levelsStore = {};
let newsCache = [];
let newsCacheTime = 0;
const NEWS_TTL = 60 * 1000; // 60 second cache

// ── RSS SOURCES ────────────────────────────────────────────────────────────
const RSS_SOURCES = [
  // Bloomberg — core macro
  { name: 'Bloomberg Economy',     url: 'https://feeds.bloomberg.com/economics/news.rss',              tag: 'BLOOMBERG', color: '#E24B4A' },
  { name: 'Bloomberg Commodities', url: 'https://feeds.bloomberg.com/markets/commodities/news.rss',    tag: 'BLOOMBERG', color: '#E24B4A' },
  { name: 'Bloomberg Energy',      url: 'https://feeds.bloomberg.com/energy/news.rss',                 tag: 'BLOOMBERG', color: '#E24B4A' },

  // Reuters
  { name: 'Reuters Economy',       url: 'https://feeds.reuters.com/reuters/businessNews',               tag: 'REUTERS',   color: '#FF6600' },

  // Federal Reserve
  { name: 'Fed Press Releases',    url: 'https://www.federalreserve.gov/feeds/press_all.xml',          tag: 'FED',       color: '#7F77DD' },
  { name: 'Fed Speeches',          url: 'https://www.federalreserve.gov/feeds/speeches.xml',           tag: 'FED',       color: '#7F77DD' },
  { name: 'NY Fed',                url: 'https://www.newyorkfed.org/xml/feeds/research.xml',           tag: 'NY FED',    color: '#7F77DD' },

  // ForexLive — fastest real-time macro commentary
  { name: 'ForexLive',             url: 'https://www.forexlive.com/feed/news',                         tag: 'FOREXLIVE', color: '#1D9E75' },

  // WSJ
  { name: 'WSJ Markets',           url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',               tag: 'WSJ',       color: '#004B87' },

  // CNBC
  { name: 'CNBC Economy',          url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html',        tag: 'CNBC',      color: '#005594' },

  // White House — official Trump statements, EOs, press briefings
  { name: 'White House',           url: 'https://www.whitehouse.gov/feed/',                            tag: 'WHITE HSE', color: '#B22222' },

  // C-SPAN — Trump speeches, congressional hearings
  { name: 'C-SPAN',                url: 'https://www.c-span.org/assets/rss/podcast.xml',               tag: 'C-SPAN',    color: '#1A1A5E' },
];

// Futures-relevant keywords
const KEYWORDS = [
  'fed','federal reserve','fomc','powell','inflation','cpi','pce','gdp',
  'jobs','employment','payroll','unemployment','interest rate','rate cut','rate hike',
  'oil','crude','opec','energy','gold','silver','commodity','commodities',
  's&p','nasdaq','dow','futures','market','stocks','equities',
  'trump','tariff','trade','china','dollar','treasury','yield',
  'recession','manufacturing','pmi','retail sales','eia','inventory',
  'jackson hole','beige book','jobless claims','nonfarm','non-farm','trump','white house','executive order','ceasefire','iran','china','trade war','sanction','strategic reserve','opec+','debt ceiling',
  'debt ceiling','deficit','stimulus','quantitative','taper','hawkish','dovish',
];

function isRelevant(text) {
  const t = text.toLowerCase();
  return KEYWORDS.some(kw => t.includes(kw));
}

function getInstruments(text) {
  const t = text.toLowerCase();
  const insts = new Set();

  if (t.match(/s&p|nasdaq|dow|stock|equit|fed|fomc|powell|inflation|cpi|gdp|jobs|payroll|rate|tariff|trade|treasury|yield|recession|stimulus/)) {
    insts.add('ES');
    insts.add('NQ');
  }
  if (t.match(/gold|silver|precious|safe.?haven|dollar weakness|inflation|fed|rate cut/)) {
    insts.add('GC');
    if (t.includes('silver')) insts.add('SI');
  }
  if (t.match(/oil|crude|opec|energy|petroleum|eia|barrel|natural gas/)) {
    insts.add('CL');
  }

  return insts.size > 0 ? [...insts] : ['ES', 'NQ'];
}

// ── HTTP FETCHER ───────────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 FuturesDesk/1.0',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      }
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── RSS PARSER ─────────────────────────────────────────────────────────────
function parseRSS(xml, source) {
  const items = [];
  const itemMatches = xml.match(/<item[\s\S]*?<\/item>/gi) || [];

  for (const itemXml of itemMatches) {
    try {
      const getField = (tags) => {
        for (const tag of tags) {
          const m = itemXml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
          if (m) return (m[1] || m[2] || '').replace(/<[^>]+>/g, '').trim();
        }
        return '';
      };

      const title = getField(['title']);
      const desc = getField(['description', 'summary', 'content']);
      const pubDate = getField(['pubDate', 'published', 'dc:date', 'updated']);
      const link = getField(['link', 'guid']);

      if (!title || title.length < 10) continue;
      if (!isRelevant(title + ' ' + desc)) continue;

      const parsedDate = pubDate ? new Date(pubDate) : new Date();
      const ageMs = Date.now() - parsedDate.getTime();
      if (ageMs > 24 * 60 * 60 * 1000) continue; // Skip items older than 24h

      items.push({
        id: Buffer.from(source.tag + title).toString('base64').slice(0, 24),
        headline: title,
        description: desc.slice(0, 250),
        tag: source.tag,
        tagColor: source.color,
        time: parsedDate.toISOString(),
        timeLabel: formatTimeAgo(parsedDate),
        instruments: getInstruments(title + ' ' + desc),
        source: source.name,
        link: link || '',
      });
    } catch (e) {
      // Skip malformed items
    }
  }

  return items;
}

function formatTimeAgo(date) {
  const diff = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diff < 1) return 'Just now';
  if (diff < 60) return `${diff}m ago`;
  const h = Math.floor(diff / 60);
  if (h < 24) return `${h}h ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── NEWS AGGREGATOR ────────────────────────────────────────────────────────
async function aggregateNews() {
  const allItems = [];
  const results = await Promise.allSettled(
    RSS_SOURCES.map(async (source) => {
      try {
        const xml = await fetchUrl(source.url);
        const items = parseRSS(xml, source);
        allItems.push(...items);
        return { source: source.name, count: items.length };
      } catch (e) {
        return { source: source.name, error: e.message };
      }
    })
  );

  const log = results.map(r => r.value || r.reason);
  console.log(`[${new Date().toISOString()}] News aggregation:`, JSON.stringify(log));

  // Sort by newest first
  allItems.sort((a, b) => new Date(b.time) - new Date(a.time));

  // Deduplicate by headline similarity
  const seen = new Set();
  const deduped = allItems.filter(item => {
    const key = item.headline.toLowerCase().slice(0, 60).replace(/\s+/g, ' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.slice(0, 60);
}

// ── NEWS ENDPOINTS ─────────────────────────────────────────────────────────
app.get('/news', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const now = Date.now();
  const symbol = req.query.symbol?.toUpperCase();

  if (newsCache.length > 0 && now - newsCacheTime < NEWS_TTL) {
    let items = newsCache;
    if (symbol) items = items.filter(i => i.instruments.includes(symbol));
    return res.json({ items, cached: true, total: newsCache.length });
  }

  try {
    newsCache = await aggregateNews();
    newsCacheTime = now;
    let items = newsCache;
    if (symbol) items = items.filter(i => i.instruments.includes(symbol));
    res.json({ items, cached: false, total: newsCache.length });
  } catch (e) {
    res.json({ items: newsCache, cached: true, error: e.message });
  }
});

app.get('/news/refresh', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  newsCacheTime = 0;
  newsCache = await aggregateNews();
  newsCacheTime = Date.now();
  res.json({ success: true, count: newsCache.length });
});

// ── TRADINGVIEW WEBHOOK ────────────────────────────────────────────────────
app.post('/webhook', (req, res) => {
  try {
    const data = req.body;
    const symbol = data.symbol || 'ES';
    levelsStore[symbol] = {
      symbol, timestamp: Date.now(),
      levels: {
        trueOpen:   { value: data.trueOpen,   claimed: !!data.trueOpenClaimed },
        asiaHigh:   { value: data.asiaHigh,   claimed: !!data.asiaHighClaimed },
        asiaLow:    { value: data.asiaLow,    claimed: !!data.asiaLowClaimed },
        londonHigh: { value: data.londonHigh, claimed: !!data.londonHighClaimed },
        londonLow:  { value: data.londonLow,  claimed: !!data.londonLowClaimed },
        nyAMHigh:   { value: data.nyAMHigh,   claimed: !!data.nyAMHighClaimed },
        nyAMLow:    { value: data.nyAMLow,    claimed: !!data.nyAMLowClaimed },
        nyPMHigh:   { value: data.nyPMHigh,   claimed: !!data.nyPMHighClaimed },
        nyPMLow:    { value: data.nyPMLow,    claimed: !!data.nyPMLowClaimed },
      }
    };
    console.log(`[${new Date().toISOString()}] Levels for ${symbol}`);
    res.json({ success: true, symbol });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/levels/:symbol', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const symbol = req.params.symbol.toUpperCase();
  const data = levelsStore[symbol];
  if (!data) return res.json({ symbol, timestamp: null, levels: null, message: 'No data yet — waiting for TradingView alert' });
  res.json(data);
});

app.get('/levels', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json(levelsStore);
});

app.get('/', (req, res) => {
  res.json({
    status: 'FuturesDesk Server ✓',
    endpoints: { news: '/news', newsFiltered: '/news?symbol=ES', newsRefresh: '/news/refresh', levels: '/levels/ES', webhook: 'POST /webhook' },
    newsItems: newsCache.length,
    cacheAge: newsCache.length ? Math.floor((Date.now() - newsCacheTime) / 1000) + 's' : 'empty',
    levelSymbols: Object.keys(levelsStore),
    uptime: Math.floor(process.uptime()) + 's',
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`FuturesDesk server on port ${PORT}`);
  // Pre-warm news cache
  aggregateNews().then(items => {
    newsCache = items;
    newsCacheTime = Date.now();
    console.log(`News cache: ${items.length} items ready`);
  }).catch(e => console.log('Cache warm error:', e.message));
});