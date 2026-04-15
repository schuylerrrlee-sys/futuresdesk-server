// services/pushNotifications.js
// Sends push notifications via Expo Push API
// No SDK needed — just HTTP POST to Expo's endpoint

const https = require('https');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// ── In-memory token store (survives restarts if you add persistence later) ──
const tokenStore = new Map(); // token → { token, registeredAt, settings }

// ── Register / update a token ───────────────────────────────────────────────
function registerToken(token, settings = {}) {
  if (!token || !token.startsWith('ExponentPushToken')) {
    throw new Error('Invalid Expo push token');
  }
  tokenStore.set(token, {
    token,
    registeredAt: Date.now(),
    settings: {
      briefingEnabled: settings.briefingEnabled ?? true,
      briefingHour:    settings.briefingHour    ?? 8,   // 0-23 ET
      briefingMinute:  settings.briefingMinute   ?? 0,
      highImpactAlerts: settings.highImpactAlerts ?? true,
      ...settings,
    },
  });
  console.log(`[push] Registered token: ${token.slice(0, 30)}...`);
}

// ── Update settings for a token ─────────────────────────────────────────────
function updateSettings(token, settings) {
  const existing = tokenStore.get(token);
  if (!existing) throw new Error('Token not found');
  tokenStore.set(token, {
    ...existing,
    settings: { ...existing.settings, ...settings },
  });
}

// ── Get all tokens ───────────────────────────────────────────────────────────
function getAllTokens() {
  return [...tokenStore.values()];
}

// ── Send a single push notification ─────────────────────────────────────────
function sendPush(token, title, body, data = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      to:    token,
      title,
      body,
      data,
      sound: 'default',
      priority: 'high',
    });

    const options = {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(EXPO_PUSH_URL, options, (res) => {
      let responseData = '';
      res.on('data', chunk => { responseData += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(responseData);
          if (json.data?.status === 'error') {
            console.warn(`[push] Error for ${token.slice(0,20)}:`, json.data.message);
          }
          resolve(json);
        } catch (e) {
          resolve({ raw: responseData });
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Send to all tokens that match a filter ───────────────────────────────────
async function broadcast(title, body, data = {}, filter = () => true) {
  const tokens = getAllTokens().filter(t => filter(t));
  if (tokens.length === 0) {
    console.log('[push] No tokens to broadcast to');
    return;
  }

  console.log(`[push] Broadcasting to ${tokens.length} device(s): ${title}`);
  const results = await Promise.allSettled(
    tokens.map(t => sendPush(t.token, title, body, data))
  );
  return results;
}

// ── Morning briefing scheduler ───────────────────────────────────────────────
// Checks every minute if any token is due for a briefing
let briefingInterval = null;
const sentToday = new Set(); // token+date → prevent double-sending

function startBriefingScheduler(getNewsCallback) {
  if (briefingInterval) clearInterval(briefingInterval);

  briefingInterval = setInterval(async () => {
    try {
      // Get current ET time
      const now = new Date();
      const etFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric', minute: 'numeric', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
      });
      const parts = etFormatter.formatToParts(now);
      const etHour   = parseInt(parts.find(p => p.type === 'hour').value);
      const etMinute = parseInt(parts.find(p => p.type === 'minute').value);
      const etDate   = `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;

      const tokens = getAllTokens().filter(t => t.settings.briefingEnabled);

      for (const t of tokens) {
        const dueHour   = t.settings.briefingHour;
        const dueMinute = t.settings.briefingMinute;
        const sentKey   = `${t.token}-${etDate}`;

        if (etHour === dueHour && etMinute === dueMinute && !sentToday.has(sentKey)) {
          sentToday.add(sentKey);

          // Clean up old sent keys (keep last 100)
          if (sentToday.size > 100) {
            const first = sentToday.values().next().value;
            sentToday.delete(first);
          }

          // Get top news for briefing
          let newsSnippet = 'Markets are open. Check FuturesDesk for the latest.';
          try {
            const news = await getNewsCallback();
            const top = news.slice(0, 3).map(n => n.headline).join(' · ');
            if (top) newsSnippet = top;
          } catch (e) {
            console.warn('[push] Could not fetch news for briefing:', e.message);
          }

          const timeLabel = `${dueHour % 12 || 12}:${String(dueMinute).padStart(2, '0')} ${dueHour >= 12 ? 'PM' : 'AM'} ET`;
          await sendPush(
            t.token,
            `🌅 FuturesDesk Morning Briefing · ${timeLabel}`,
            newsSnippet,
            { type: 'morning_briefing' }
          );
          console.log(`[push] Morning briefing sent to ${t.token.slice(0, 20)}...`);
        }
      }
    } catch (e) {
      console.error('[push] Briefing scheduler error:', e.message);
    }
  }, 60 * 1000); // Check every minute

  console.log('[push] Briefing scheduler started');
}

// ── High-impact news alert ───────────────────────────────────────────────────
async function sendHighImpactAlert(newsItem) {
  const tokens = getAllTokens().filter(t => t.settings.highImpactAlerts);
  if (tokens.length === 0) return;

  const title = `⚡ High Impact: ${newsItem.tag || 'Market Alert'}`;
  const body  = newsItem.headline.slice(0, 120);

  console.log(`[push] High impact alert: ${body.slice(0, 50)}...`);
  await Promise.allSettled(
    tokens.map(t => sendPush(t.token, title, body, { type: 'high_impact', newsId: newsItem.id }))
  );
}

module.exports = {
  registerToken,
  updateSettings,
  getAllTokens,
  sendPush,
  broadcast,
  startBriefingScheduler,
  sendHighImpactAlert,
};
