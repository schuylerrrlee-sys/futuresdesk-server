// routes/news.js
// Mount in server.js with: app.use('/api/news', require('./routes/news'));

const express = require('express');
const router  = express.Router();
const { fetchNews, getSourceMeta } = require('../services/newsAggregator');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/news
//
// Query params:
//   sources=all                        → all sources (default)
//   sources=fed,trump,cnbc             → comma-separated source IDs
//   category=macro                     → filter by category (macro|market|political)
//   limit=50                           → max items (default 100, max 500)
//   refresh=true                       → bypass cache for this request
//
// Examples:
//   /api/news
//   /api/news?sources=all
//   /api/news?sources=fed,nyfed
//   /api/news?sources=trump
//   /api/news?category=macro&limit=20
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const sources  = req.query.sources  || 'all';
    const category = req.query.category || null;
    const limit    = Math.min(parseInt(req.query.limit) || 100, 500);

    const items = await fetchNews({ sources, category, limit });

    res.json({
      ok:        true,
      count:     items.length,
      sources:   sources === 'all' ? 'all' : sources.split(','),
      category:  category || null,
      fetchedAt: new Date().toISOString(),
      data:      items,
    });
  } catch (err) {
    console.error('[/api/news] Error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/news/sources
// Returns list of all available sources with metadata + cache status
// ─────────────────────────────────────────────────────────────────────────────
router.get('/sources', (req, res) => {
  res.json({
    ok:      true,
    sources: getSourceMeta(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/news/trump
// Shortcut — just Trump/Truth Social posts
// ─────────────────────────────────────────────────────────────────────────────
router.get('/trump', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const items = await fetchNews({ sources: 'trump', limit });
    res.json({ ok: true, count: items.length, data: items });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/news/macro
// Shortcut — Fed + NY Fed only
// ─────────────────────────────────────────────────────────────────────────────
router.get('/macro', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const items = await fetchNews({ sources: 'fed,nyfed', limit });
    res.json({ ok: true, count: items.length, data: items });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/news/market
// Shortcut — CNBC + Finnhub + Polygon
// ─────────────────────────────────────────────────────────────────────────────
router.get('/market', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const items = await fetchNews({ sources: 'cnbc,finnhub,polygon', limit });
    res.json({ ok: true, count: items.length, data: items });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
