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

module.exports = { fetchFuturesData, fetchAllFutures, TICKERS };
