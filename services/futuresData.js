// services/futuresData.js
// Fetches futures OHLCV from Yahoo Finance and calculates pivot levels
// Tickers: ES=F, NQ=F, YM=F, GC=F, SI=F, CL=F
// No API key required — Yahoo Finance unofficial API

const https = require('https');

// ── Futures ticker map ─────────────────────────────────────────────────────
const TICKERS = {
  ES:  'ES=F',   // S&P 500 E-mini
  NQ:  'NQ=F',   // Nasdaq 100 E-mini
  YM:  'YM=F',   // Dow Jones E-mini
  GC:  'GC=F',   // Gold
  SI:  'SI=F',   // Silver
  CL:  'CL=F',   // Crude Oil
};

// ── Cache ──────────────────────────────────────────────────────────────────
const cache = {};
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// ── Fetch Yahoo Finance quote ──────────────────────────────────────────────
function fetchYahooQuote(ticker) {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d&includePrePost=true`;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json?.chart?.result?.[0];
          if (!result) return reject(new Error('No data from Yahoo'));
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// ── Calculate pivot levels from OHLC ──────────────────────────────────────
function calcPivots(high, low, close) {
  const pp  = (high + low + close) / 3;
  return {
    pp:   parseFloat(pp.toFixed(2)),
    r1:   parseFloat((2 * pp - low).toFixed(2)),
    r2:   parseFloat((pp + (high - low)).toFixed(2)),
    r3:   parseFloat((high + 2 * (pp - low)).toFixed(2)),
    s1:   parseFloat((2 * pp - high).toFixed(2)),
    s2:   parseFloat((pp - (high - low)).toFixed(2)),
    s3:   parseFloat((low - 2 * (high - pp)).toFixed(2)),
    // Camarilla
    cr4:  parseFloat((close + (high - low) * 1.1 / 2).toFixed(2)),
    cr3:  parseFloat((close + (high - low) * 1.1 / 4).toFixed(2)),
    cs3:  parseFloat((close - (high - low) * 1.1 / 4).toFixed(2)),
    cs4:  parseFloat((close - (high - low) * 1.1 / 2).toFixed(2)),
  };
}

// ── Main fetch function ────────────────────────────────────────────────────
async function fetchFuturesData(symbol) {
  const ticker = TICKERS[symbol];
  if (!ticker) throw new Error(`Unknown symbol: ${symbol}`);

  // Check cache
  if (cache[symbol] && Date.now() - cache[symbol].fetchedAt < CACHE_TTL) {
    return cache[symbol].data;
  }

  const result = await fetchYahooQuote(ticker);

  const meta       = result.meta;
  const timestamps = result.timestamp || [];
  const quotes     = result.indicators?.quote?.[0] || {};

  const opens   = quotes.open   || [];
  const highs   = quotes.high   || [];
  const lows    = quotes.low    || [];
  const closes  = quotes.close  || [];
  const volumes = quotes.volume || [];

  // Get last 2 complete sessions
  const validDays = timestamps
    .map((ts, i) => ({
      date:   new Date(ts * 1000).toLocaleDateString('en-US', { timeZone: 'America/New_York' }),
      open:   opens[i],
      high:   highs[i],
      low:    lows[i],
      close:  closes[i],
      volume: volumes[i],
    }))
    .filter(d => d.open && d.high && d.low && d.close);

  if (validDays.length < 1) throw new Error('Not enough data from Yahoo');

  const prev = validDays[validDays.length - 2] || validDays[validDays.length - 1];
  const curr = validDays[validDays.length - 1];

  // Current live price
  const livePrice   = meta.regularMarketPrice || curr.close;
  const prevClose   = meta.previousClose      || prev.close;
  const change      = livePrice - prevClose;
  const changePct   = (change / prevClose) * 100;

  // Pivots from previous session
  const pivots = calcPivots(prev.high, prev.low, prev.close);

  // Overnight range (using today's pre/after market vs prev close)
  const dayHigh    = meta.regularMarketDayHigh || curr.high;
  const dayLow     = meta.regularMarketDayLow  || curr.low;
  const fiftyTwoWkHigh = meta.fiftyTwoWeekHigh;
  const fiftyTwoWkLow  = meta.fiftyTwoWeekLow;

  const data = {
    symbol,
    ticker,
    price:          parseFloat(livePrice.toFixed(2)),
    change:         parseFloat(change.toFixed(2)),
    changePct:      parseFloat(changePct.toFixed(2)),
    bull:           change >= 0,
    prevClose:      parseFloat(prevClose.toFixed(2)),
    dayHigh:        parseFloat(dayHigh.toFixed(2)),
    dayLow:         parseFloat(dayLow.toFixed(2)),
    fiftyTwoWkHigh: fiftyTwoWkHigh ? parseFloat(fiftyTwoWkHigh.toFixed(2)) : null,
    fiftyTwoWkLow:  fiftyTwoWkLow  ? parseFloat(fiftyTwoWkLow.toFixed(2))  : null,
    prevSession: {
      date:   prev.date,
      open:   parseFloat(prev.open.toFixed(2)),
      high:   parseFloat(prev.high.toFixed(2)),
      low:    parseFloat(prev.low.toFixed(2)),
      close:  parseFloat(prev.close.toFixed(2)),
      volume: prev.volume,
    },
    pivots,
    gap: {
      points: parseFloat((curr.open - prevClose).toFixed(2)),
      pct:    parseFloat(((curr.open - prevClose) / prevClose * 100).toFixed(2)),
      bull:   curr.open >= prevClose,
    },
    updatedAt: Date.now(),
  };

  cache[symbol] = { data, fetchedAt: Date.now() };
  console.log(`[futures] Fetched ${symbol} (${ticker}): $${data.price} ${data.changePct > 0 ? '+' : ''}${data.changePct}%`);
  return data;
}

// ── Fetch all symbols ──────────────────────────────────────────────────────
async function fetchAllFutures() {
  const results = {};
  await Promise.allSettled(
    Object.keys(TICKERS).map(async sym => {
      try { results[sym] = await fetchFuturesData(sym); }
      catch (e) { console.warn(`[futures] Failed ${sym}:`, e.message); }
    })
  );
  return results;
}


// ── Fetch intraday 5-min bars ──────────────────────────────────────────────
function fetchYahooIntraday(ticker) {
  return new Promise((resolve, reject) => {
    // range=5d gets enough history for prev day + today
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=5m&range=5d&includePrePost=true`;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json?.chart?.result?.[0] || null);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── Session time ranges in minutes from midnight ET ────────────────────────
// Asia:    6:00 PM (prev day) → 2:00 AM  =  1080 → 120
// London:  2:00 AM → 8:00 AM             =  120  → 480
// NY AM:   9:30 AM → 11:30 AM            =  570  → 690
// NY PM:   1:30 PM → 4:00 PM             =  810  → 960
// True Open: 9:30 AM = 570 min

function getEtMinutes(timestamp) {
  const d = new Date(timestamp * 1000);
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: 'numeric', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const hour   = parseInt(et.find(p => p.type === 'hour').value);
  const minute = parseInt(et.find(p => p.type === 'minute').value);
  return hour * 60 + minute;
}

function getEtDate(timestamp) {
  const d = new Date(timestamp * 1000);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function calcSessionLevels(result, currentPrice) {
  if (!result) return null;

  const timestamps = result.timestamp || [];
  const quotes     = result.indicators?.quote?.[0] || {};
  const highs  = quotes.high  || [];
  const lows   = quotes.low   || [];
  const opens  = quotes.open  || [];
  const closes = quotes.close || [];

  const now    = new Date();
  const today  = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

  // Group bars by ET date
  const barsByDate = {};
  timestamps.forEach((ts, i) => {
    if (!highs[i] || !lows[i]) return;
    const date  = getEtDate(ts);
    const mins  = getEtMinutes(ts);
    if (!barsByDate[date]) barsByDate[date] = [];
    barsByDate[date].push({ ts, mins, high: highs[i], low: lows[i], open: opens[i], close: closes[i] });
  });

  const dates     = Object.keys(barsByDate).sort();
  const todayIdx  = dates.indexOf(today);
  const prevDate  = todayIdx > 0 ? dates[todayIdx - 1] : dates[dates.length - 2];
  const todayBars = barsByDate[today]    || [];
  const prevBars  = barsByDate[prevDate] || [];

  function sessionHiLo(bars, startMin, endMin) {
    const session = bars.filter(b => b.mins >= startMin && b.mins < endMin);
    if (!session.length) return { high: null, low: null };
    return {
      high: Math.max(...session.map(b => b.high)),
      low:  Math.min(...session.map(b => b.low)),
    };
  }

  // Previous day session levels
  // Asia spans previous day 18:00 → midnight + today 00:00 → 02:00
  const prevAsiaEve   = sessionHiLo(prevBars, 18*60, 24*60); // prev day 6PM-midnight
  const todayAsiaAM   = sessionHiLo(todayBars, 0, 2*60);     // today midnight-2AM
  const asiaHigh = prevAsiaEve.high && todayAsiaAM.high ? Math.max(prevAsiaEve.high, todayAsiaAM.high) : (prevAsiaEve.high || todayAsiaAM.high);
  const asiaLow  = prevAsiaEve.low  && todayAsiaAM.low  ? Math.min(prevAsiaEve.low,  todayAsiaAM.low)  : (prevAsiaEve.low  || todayAsiaAM.low);

  const london   = sessionHiLo(todayBars, 2*60, 8*60);
  const nyAM     = sessionHiLo(todayBars, 9*60+30, 11*60+30);
  const nyPM     = sessionHiLo(todayBars, 13*60+30, 16*60);

  // True Open — first bar at or after 9:30 AM
  const rthOpen = todayBars.find(b => b.mins >= 9*60+30);
  const trueOpen = rthOpen ? parseFloat(rthOpen.open.toFixed(2)) : null;

  // Previous day equivalents for "unclaimed from yesterday"
  const prevLondon = sessionHiLo(prevBars, 2*60, 8*60);
  const prevNYAM   = sessionHiLo(prevBars, 9*60+30, 11*60+30);
  const prevNYPM   = sessionHiLo(prevBars, 13*60+30, 16*60);
  const prevTrueOpenBar = prevBars.find(b => b.mins >= 9*60+30);
  const prevTrueOpen = prevTrueOpenBar ? parseFloat(prevTrueOpenBar.open.toFixed(2)) : null;

  // Check if a level is claimed — price has wicked into it during today's session
  function isClaimed(level) {
    if (!level || !currentPrice) return false;
    return todayBars.some(b => {
      if (level > currentPrice) return b.high >= level;  // level above price — claimed if any bar wicked up to it
      else return b.low <= level;                         // level below price — claimed if any bar wicked down to it
    });
  }

  const fmt = v => v ? parseFloat(v.toFixed(2)) : null;

  const levels = {
    // Today forming levels
    asiaHigh:   { value: fmt(asiaHigh),        claimed: isClaimed(asiaHigh),        label: 'Asia High',       session: 'asia'   },
    asiaLow:    { value: fmt(asiaLow),          claimed: isClaimed(asiaLow),         label: 'Asia Low',        session: 'asia'   },
    londonHigh: { value: fmt(london.high),      claimed: isClaimed(london.high),     label: 'London High',     session: 'london' },
    londonLow:  { value: fmt(london.low),       claimed: isClaimed(london.low),      label: 'London Low',      session: 'london' },
    nyAMHigh:   { value: fmt(nyAM.high),        claimed: isClaimed(nyAM.high),       label: 'NY AM High',      session: 'ny'     },
    nyAMLow:    { value: fmt(nyAM.low),         claimed: isClaimed(nyAM.low),        label: 'NY AM Low',       session: 'ny'     },
    nyPMHigh:   { value: fmt(nyPM.high),        claimed: isClaimed(nyPM.high),       label: 'NY PM High',      session: 'ny'     },
    nyPMLow:    { value: fmt(nyPM.low),         claimed: isClaimed(nyPM.low),        label: 'NY PM Low',       session: 'ny'     },
    trueOpen:   { value: trueOpen,              claimed: isClaimed(trueOpen),        label: 'True Open',       session: 'ny'     },
    // Previous day levels
    prevLondonHigh: { value: fmt(prevLondon.high), claimed: isClaimed(prevLondon.high), label: 'Prev London High', session: 'london' },
    prevLondonLow:  { value: fmt(prevLondon.low),  claimed: isClaimed(prevLondon.low),  label: 'Prev London Low',  session: 'london' },
    prevNYAMHigh:   { value: fmt(prevNYAM.high),   claimed: isClaimed(prevNYAM.high),   label: 'Prev NY AM High',  session: 'ny'     },
    prevNYAMLow:    { value: fmt(prevNYAM.low),     claimed: isClaimed(prevNYAM.low),    label: 'Prev NY AM Low',   session: 'ny'     },
    prevNYPMHigh:   { value: fmt(prevNYPM.high),   claimed: isClaimed(prevNYPM.high),   label: 'Prev NY PM High',  session: 'ny'     },
    prevNYPMLow:    { value: fmt(prevNYPM.low),     claimed: isClaimed(prevNYPM.low),    label: 'Prev NY PM Low',   session: 'ny'     },
    prevTrueOpen:   { value: prevTrueOpen,           claimed: isClaimed(prevTrueOpen),    label: 'Prev True Open',   session: 'ny'     },
  };

  // Session bias — did London sweep Asia high or low?
  let sessionBias = 'neutral';
  if (london.high && asiaHigh && london.high > asiaHigh) sessionBias = 'london_swept_asia_high';
  else if (london.low && asiaLow && london.low < asiaLow) sessionBias = 'london_swept_asia_low';

  return { levels, sessionBias, today, prevDate };
}

// Intraday cache — 5 min TTL
const intradayCache = {};
const INTRADAY_TTL = 5 * 60 * 1000;

async function fetchSessionLevels(symbol) {
  const ticker = TICKERS[symbol];
  if (!ticker) return null;

  if (intradayCache[symbol] && Date.now() - intradayCache[symbol].fetchedAt < INTRADAY_TTL) {
    return intradayCache[symbol].data;
  }

  try {
    const result = await fetchYahooIntraday(ticker);
    const price  = cache[symbol]?.data?.price || null;
    const levels = calcSessionLevels(result, price);
    intradayCache[symbol] = { data: levels, fetchedAt: Date.now() };
    console.log(`[session-levels] Updated ${symbol} — bias: ${levels?.sessionBias}`);
    return levels;
  } catch (e) {
    console.warn(`[session-levels] Error for ${symbol}:`, e.message);
    return intradayCache[symbol]?.data || null;
  }
}

module.exports = { fetchFuturesData, fetchAllFutures, fetchSessionLevels, TICKERS };
