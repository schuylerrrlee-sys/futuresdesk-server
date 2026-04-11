// server.js — FuturesDesk Levels Server
// Receives TradingView webhook alerts and serves them to the app
const express = require('express');
const app = express();
app.use(express.json());

// In-memory store — persists while server is running
// For production, swap this for a database
const levelsStore = {};

// ── RECEIVE WEBHOOK FROM TRADINGVIEW ──────────────────────────────────────
// TradingView will POST to: https://YOUR-SERVER.railway.app/webhook
// Set your alert message in TradingView to this JSON format:
/*
{
  "symbol": "ES",
  "trueOpen": {{plot("True Open")}},
  "asiaHigh": {{plot("Asia High")}},
  "asiaLow": {{plot("Asia Low")}},
  "londonHigh": {{plot("London High")}},
  "londonLow": {{plot("London Low")}},
  "nyAMHigh": {{plot("NY AM High")}},
  "nyAMLow": {{plot("NY AM Low")}},
  "nyPMHigh": {{plot("NY PM High")}},
  "nyPMLow": {{plot("NY PM Low")}},
  "trueOpenClaimed": {{plot("True Open Claimed")}},
  "asiaHighClaimed": {{plot("Asia High Claimed")}},
  "asiaLowClaimed": {{plot("Asia Low Claimed")}},
  "londonHighClaimed": {{plot("London High Claimed")}},
  "londonLowClaimed": {{plot("London Low Claimed")}},
  "nyAMHighClaimed": {{plot("NY AM High Claimed")}},
  "nyAMLowClaimed": {{plot("NY AM Low Claimed")}},
  "nyPMHighClaimed": {{plot("NY PM High Claimed")}},
  "nyPMLowClaimed": {{plot("NY PM Low Claimed")}}
}
*/

app.post('/webhook', (req, res) => {
  try {
    const data = req.body;
    const symbol = data.symbol || 'ES';

    levelsStore[symbol] = {
      symbol,
      timestamp: Date.now(),
      levels: {
        trueOpen:     { value: data.trueOpen,     claimed: !!data.trueOpenClaimed },
        asiaHigh:     { value: data.asiaHigh,     claimed: !!data.asiaHighClaimed },
        asiaLow:      { value: data.asiaLow,      claimed: !!data.asiaLowClaimed },
        londonHigh:   { value: data.londonHigh,   claimed: !!data.londonHighClaimed },
        londonLow:    { value: data.londonLow,    claimed: !!data.londonLowClaimed },
        nyAMHigh:     { value: data.nyAMHigh,     claimed: !!data.nyAMHighClaimed },
        nyAMLow:      { value: data.nyAMLow,      claimed: !!data.nyAMLowClaimed },
        nyPMHigh:     { value: data.nyPMHigh,     claimed: !!data.nyPMHighClaimed },
        nyPMLow:      { value: data.nyPMLow,      claimed: !!data.nyPMLowClaimed },
      }
    };

    console.log(`[${new Date().toISOString()}] Received levels for ${symbol}:`, levelsStore[symbol].levels);
    res.json({ success: true, symbol, timestamp: levelsStore[symbol].timestamp });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(400).json({ error: err.message });
  }
});

// ── SERVE LEVELS TO THE APP ───────────────────────────────────────────────
// App fetches: https://YOUR-SERVER.railway.app/levels/ES
app.get('/levels/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const data = levelsStore[symbol];

  if (!data) {
    return res.json({
      symbol,
      timestamp: null,
      levels: null,
      message: 'No data yet — waiting for TradingView alert'
    });
  }

  res.json(data);
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'FuturesDesk Levels Server running',
    symbols: Object.keys(levelsStore),
    uptime: Math.floor(process.uptime()) + 's'
  });
});

// ── ALL LEVELS (for debugging) ────────────────────────────────────────────
app.get('/levels', (req, res) => {
  res.json(levelsStore);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FuturesDesk server running on port ${PORT}`);
});
