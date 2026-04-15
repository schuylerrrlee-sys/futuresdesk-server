// routes/markets.js
// Mount in server.js with: app.use('/api/markets', require('./routes/markets'));
//
// Endpoints:
//   GET /api/markets          → all symbols
//   GET /api/markets/:symbol  → single symbol (ES, NQ, YM, GC, SI, CL)

const express = require('express');
const router  = express.Router();
const { fetchFuturesData, fetchAllFutures } = require('../futuresData');

// GET /api/markets
router.get('/', async (req, res) => {
  try {
    const data = await fetchAllFutures();
    res.json({ ok: true, data, updatedAt: Date.now() });
  } catch (e) {
    console.error('[markets] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/markets/:symbol
router.get('/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const data = await fetchFuturesData(symbol);
    res.json({ ok: true, data });
  } catch (e) {
    console.error(`[markets] Error for ${symbol}:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
