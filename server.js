// server.js — EdgeDesk Server
const express = require('express');
const newsRouter = require('./services/routes/news');
const pushRouter = require('./services/routes/push');
const https = require('https');
const http = require('http');
const push = require('./services/pushNotifications');

const app = express();

// ── CORS — allow everything (web app + iPhone app) ─────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use('/api/news', newsRouter);
app.use('/api/markets', require('./services/routes/markets'));
app.use('/api/push', pushRouter);

// ── Claude API proxy (web app can't call Anthropic directly) ───────────────
app.post('/api/claude', async (req, res) => {
  const { prompt, system } = req.body;
  if (!prompt) return res.status(400).json({ error: 'No prompt' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  try {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: system || 'You are EdgeDesk AI — an institutional futures analyst. Always respond in exact JSON format.',
      messages: [{ role: 'user', content: prompt }],
    });

    const text = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req2 = https.request(options, (res2) => {
        let data = '';
        res2.on('data', chunk => { data += chunk; });
        res2.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const txt = parsed.content?.map(b => b.text || '').join('') || '';
            resolve(txt);
          } catch(e) { reject(e); }
        });
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── IN-MEMORY STORES ───────────────────────────────────────────────────────
const levelsStore = {};
let newsCache = [];
let newsCacheTime = 0;
const NEWS_TTL = 30 * 1000;

// ── RSS SOURCES ────────────────────────────────────────────────────────────
const RSS_SOURCES = [
  { name: 'Bloomberg Economy',     url: 'https://feeds.bloomberg.com/economics/news.rss',              tag: 'BLOOMBERG', color: '#E24B4A' },
  { name: 'Bloomberg Commodities', url: 'https://feeds.bloomberg.com/markets/commodities/news.rss',    tag: 'BLOOMBERG', color: '#E24B4A' },
  { name: 'Bloomberg Energy',      url: 'https://feeds.bloomberg.com/energy/news.rss',                 tag: 'BLOOMBERG', color: '#E24B4A' },
  { name: 'AP Business',           url: 'https://feeds.apnews.com/rss/business',                       tag: 'AP NEWS',   color: '#FF6600' },
  { name: 'AP Economy',            url: 'https://feeds.apnews.com/rss/economy',                        tag: 'AP NEWS',   color: '#FF6600' },
  { name: 'Investing.com',         url: 'https://www.investing.com/rss/news.rss',                      tag: 'INVESTING', color: '#FF8C00' },
  { name: 'Fed Press Releases',    url: 'https://www.federalreserve.gov/feeds/press_all.xml',          tag: 'FED',       color: '#7F77DD' },
  { name: 'Fed Speeches',          url: 'https://www.federalreserve.gov/feeds/speeches.xml',           tag: 'FED',       color: '#7F77DD' },
  { name: 'NY Fed',                url: 'https://www.newyorkfed.org/xml/feeds/research.xml',           tag: 'NY FED',    color: '#7F77DD' },
  { name: 'ForexLive',             url: 'https://www.forexlive.com/feed/news',                         tag: 'FOREXLIVE', color: '#1D9E75' },
  { name: 'WSJ Markets',           url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',               tag: 'WSJ',       color: '#004B87' },
  { name: 'WSJ Economy',           url: 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml',             tag: 'WSJ',       color: '#004B87' },
  { name: 'CNBC Economy',          url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html',        tag: 'CNBC',      color: '#005594' },
  { name: 'White House',           url: 'https://www.whitehouse.gov/feed/',                            tag: 'WHITE HSE', color: '#B22222' },
  { name: 'C-SPAN',                url: 'https://www.c-span.org/assets/rss/podcast.xml',               tag: 'C-SPAN',    color: '#1A1A5E' },
];

const KEYWORDS = [
  'fed','federal reserve','fomc','powell','inflation','cpi','pce','gdp',
  'jobs','employment','payroll','unemployment','interest rate','rate cut','rate hike',
  'oil','crude','opec','energy','gold','silver','commodity','commodities',
  's&p','nasdaq','dow','futures','market','stocks','equities',
  'trump','tariff','trade','china','dollar','treasury','yield',
  'recession','manufacturing','pmi','retail sales','eia','inventory',
  'jackson hole','beige book','jobless claims','nonfarm','non-farm',
  'white house','executive order','ceasefire','iran','trade war',
  'sanction','strategic reserve','debt ceiling','deficit','stimulus',
  'quantitative','taper','hawkish','dovish',
];

function isRelevant(text) {
  const t = text.toLowerCase();
  return KEYWORDS.some(kw => t.includes(kw));
}

function getInstruments(text) {
  const t = text.toLowerCase();
  const insts = new Set();
  if (t.match(/s&p|nasdaq|dow|stock|equit|fed|fomc|powell|inflation|cpi|gdp|jobs|payroll|rate|tariff|trade|treasury|yield|recession|stimulus/)) {
    insts.add('ES'); insts.add('NQ');
  }
  if (t.match(/gold|precious|safe.?haven|dollar weakness/)) insts.add('GC');
  if (t.includes('silver')) insts.add('SI');
  if (t.match(/oil|crude|opec|energy|petroleum|eia|barrel/)) insts.add('CL');
  if (t.match(/gold|silver|inflation|fed|rate cut/)) insts.add('GC');
  return insts.size > 0 ? [...insts] : ['ES', 'NQ'];
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 EdgeDesk/1.0',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      }
    }, (res) => {
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
      const title   = getField(['title']);
      const desc    = getField(['description', 'summary', 'content']);
      const pubDate = getField(['pubDate', 'published', 'dc:date', 'updated']);
      const link    = getField(['link', 'guid']);
      if (!title || title.length < 10) continue;
      if (!isRelevant(title + ' ' + desc)) continue;
      const parsedDate = pubDate ? new Date(pubDate) : new Date();
      const ageMs = Date.now() - parsedDate.getTime();
      if (ageMs > 24 * 60 * 60 * 1000) continue;
      items.push({
        id:          Buffer.from(source.tag + title).toString('base64').slice(0, 24),
        headline:    title,
        description: desc.slice(0, 250),
        summary:     desc.slice(0, 250),
        tag:         source.tag,
        tagColor:    source.color,
        time:        parsedDate.toISOString(),
        timeLabel:   formatTimeAgo(parsedDate),
        instruments: getInstruments(title + ' ' + desc),
        source:      source.name,
        sourceKey:   source.tag.toLowerCase().replace(/\s/g,''),
        url:         link || '',
        link:        link || '',
      });
    } catch(e) {}
  }
  return items;
}

function formatTimeAgo(date) {
  const diff = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (diff < 1)  return 'Just now';
  if (diff < 60) return `${diff}m ago`;
  const h = Math.floor(diff / 60);
  if (h < 24)   return `${h}h ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function aggregateNews() {
  const allItems = [];
  await Promise.allSettled(
    RSS_SOURCES.map(async (source) => {
      try {
        const xml   = await fetchUrl(source.url);
        const items = parseRSS(xml, source);
        allItems.push(...items);
      } catch(e) {
        console.warn(`[news] ${source.name} error:`, e.message);
      }
    })
  );
  allItems.sort((a, b) => new Date(b.time) - new Date(a.time));
  const seen = new Set();
  const deduped = allItems.filter(item => {
    const key = item.headline.toLowerCase().slice(0, 60).replace(/\s+/g, ' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  deduped.filter(item => {
    const age  = Date.now() - new Date(item.time).getTime();
    const text = (item.headline + ' ' + item.description).toLowerCase();
    return age < fiveMinAgo && ['fomc','federal reserve','powell','rate decision','cpi','nonfarm payroll','nfp','jobs report','opec','tariff'].some(k => text.includes(k));
  }).forEach(item => push.sendHighImpactAlert(item).catch(() => {}));
  return deduped.slice(0, 60);
}

// ── NEWS ENDPOINTS ─────────────────────────────────────────────────────────
app.get('/news', async (req, res) => {
  const now    = Date.now();
  const symbol = req.query.symbol?.toUpperCase();
  if (newsCache.length > 0 && now - newsCacheTime < NEWS_TTL) {
    let items = newsCache;
    if (symbol) items = items.filter(i => i.instruments.includes(symbol));
    return res.json({ items, cached: true, total: newsCache.length });
  }
  try {
    newsCache    = await aggregateNews();
    newsCacheTime = now;
    let items    = newsCache;
    if (symbol) items = items.filter(i => i.instruments.includes(symbol));
    res.json({ items, cached: false, total: newsCache.length });
  } catch(e) {
    res.json({ items: newsCache, cached: true, error: e.message });
  }
});

app.get('/news/refresh', async (req, res) => {
  newsCacheTime = 0;
  newsCache     = await aggregateNews();
  newsCacheTime = Date.now();
  res.json({ success: true, count: newsCache.length });
});

// ── TRADINGVIEW WEBHOOK ────────────────────────────────────────────────────
app.post('/webhook', (req, res) => {
  try {
    const data   = req.body;
    const symbol = data.symbol || 'ES';
    levelsStore[symbol] = {
      symbol, timestamp: Date.now(),
      levels: {
        trueOpen:   { value: data.trueOpen,   claimed: !!data.trueOpenClaimed   },
        asiaHigh:   { value: data.asiaHigh,   claimed: !!data.asiaHighClaimed   },
        asiaLow:    { value: data.asiaLow,    claimed: !!data.asiaLowClaimed    },
        londonHigh: { value: data.londonHigh, claimed: !!data.londonHighClaimed  },
        londonLow:  { value: data.londonLow,  claimed: !!data.londonLowClaimed  },
        nyAMHigh:   { value: data.nyAMHigh,   claimed: !!data.nyAMHighClaimed   },
        nyAMLow:    { value: data.nyAMLow,    claimed: !!data.nyAMLowClaimed    },
        nyPMHigh:   { value: data.nyPMHigh,   claimed: !!data.nyPMHighClaimed   },
        nyPMLow:    { value: data.nyPMLow,    claimed: !!data.nyPMLowClaimed    },
      }
    };
    res.json({ success: true, symbol });
  } catch(err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/levels/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const data   = levelsStore[symbol];
  if (!data) return res.json({ symbol, timestamp: null, levels: null, message: 'No data yet' });
  res.json(data);
});

app.get('/levels', (req, res) => res.json(levelsStore));

app.get('/', (req, res) => {
  res.json({
    status:       'EdgeDesk Server ✓',
    newsItems:    newsCache.length,
    cacheAge:     newsCache.length ? Math.floor((Date.now() - newsCacheTime) / 1000) + 's' : 'empty',
    levelSymbols: Object.keys(levelsStore),
    uptime:       Math.floor(process.uptime()) + 's',
  });
});

// ── START ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`EdgeDesk server on port ${PORT}`);
  aggregateNews().then(items => {
    newsCache     = items;
    newsCacheTime = Date.now();
    console.log(`News cache: ${items.length} items ready`);
    push.startBriefingScheduler(() => Promise.resolve(newsCache));
  }).catch(e => console.log('Cache warm error:', e.message));

  setInterval(async () => {
    try {
      newsCache     = await aggregateNews();
      newsCacheTime = Date.now();
      console.log(`[auto-refresh] ${newsCache.length} items`);
    } catch(e) {
      console.log('[auto-refresh] Error:', e.message);
    }
  }, 2 * 60 * 1000);
});
