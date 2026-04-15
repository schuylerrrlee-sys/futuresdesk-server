// services/routes/push.js
// Mount in server.js with: app.use('/api/push', require('./services/routes/push'));
//
// Endpoints:
//   POST /api/push/register          → register device token + settings
//   POST /api/push/settings          → update notification settings
//   POST /api/push/test              → send a test notification
//   GET  /api/push/tokens            → list registered tokens (debug)

const express = require('express');
const router  = express.Router();
const push    = require('../pushNotifications');

// POST /api/push/register
router.post('/register', (req, res) => {
  const { token, settings } = req.body;
  if (!token) return res.status(400).json({ ok: false, error: 'token required' });

  try {
    push.registerToken(token, settings || {});
    res.json({ ok: true, message: 'Token registered', token: token.slice(0, 30) + '...' });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// POST /api/push/settings  { token, settings: { briefingEnabled, briefingHour, briefingMinute, highImpactAlerts } }
router.post('/settings', (req, res) => {
  const { token, settings } = req.body;
  if (!token || !settings) return res.status(400).json({ ok: false, error: 'token and settings required' });

  try {
    push.updateSettings(token, settings);
    res.json({ ok: true, message: 'Settings updated' });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// POST /api/push/test  { token }
router.post('/test', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ ok: false, error: 'token required' });

  try {
    await push.sendPush(
      token,
      '✅ FuturesDesk Notifications Active',
      'Your alerts are set up and working. Good trading!',
      { type: 'test' }
    );
    res.json({ ok: true, message: 'Test notification sent' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/push/tokens (debug — remove in production if needed)
router.get('/tokens', (req, res) => {
  const tokens = push.getAllTokens().map(t => ({
    token:         t.token.slice(0, 25) + '...',
    registeredAt:  new Date(t.registeredAt).toISOString(),
    settings:      t.settings,
  }));
  res.json({ ok: true, count: tokens.length, tokens });
});

module.exports = router;
