const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const FRESHCHAT_TOKEN  = process.env.FRESHCHAT_TOKEN;
const ACCOUNT_ID       = '1108501973785697';
const FRESHCHAT_DOMAIN = 'https://apjcabs.myfreshworks.com';

// ─── CONVERSATION STORE ──────────────────────────────────
// Stores the latest conversation_id captured from webhook
// Also keeps a map of userId → convId for multi-user support
let latestConvId = null;
const convStore  = {};  // { userId: convId }
const convTimes  = {};  // { convId: timestamp } for cleanup

// ─────────────────────────────────────────────────────────
// GET / — health check
// ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status      : 'APJ Cabs Bridge Running ✅',
    latestConvId: latestConvId || 'none',
    storedConvs : Object.keys(convStore).length
  });
});

// ─────────────────────────────────────────────────────────
// POST /webhook — Freshchat fires this on events
// Configure in Freshchat: Settings → Webhooks
// Events to subscribe: message_create
// ─────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Webhook received:', JSON.stringify(body, null, 2));

    // Freshchat webhook payload varies by event
    // Try all known paths for conversation_id
    const convId =
      body?.data?.message?.conversation_id ||
      body?.data?.conversation?.id         ||
      body?.conversation_id                ||
      body?.data?.id;

    // Try all known paths for actor/user id
    const userId =
      body?.data?.message?.actor_id        ||
      body?.data?.message?.user_id         ||
      body?.actor?.id                      ||
      body?.data?.actor_id                 ||
      'unknown';

    if (convId) {
      latestConvId       = convId;
      convStore[userId]  = convId;
      convTimes[convId]  = Date.now();
      console.log(`✅ Stored conv_id: ${convId} (user: ${userId})`);
    } else {
      console.log('⚠️  No conv_id found in webhook payload');
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e.message);
    res.sendStatus(200); // always 200 to Freshchat
  }
});

// ─────────────────────────────────────────────────────────
// GET /get-conv-id — HTML quote page calls this on load
// Returns the latest captured conversation_id
// ─────────────────────────────────────────────────────────
app.get('/get-conv-id', (req, res) => {
  // Optional: filter by userId if passed as query param
  const userId = req.query.user_id;

  let convId = null;

  if (userId && convStore[userId]) {
    convId = convStore[userId];
    console.log(`Returning conv_id for user ${userId}: ${convId}`);
  } else if (latestConvId) {
    convId = latestConvId;
    console.log(`Returning latest conv_id: ${convId}`);
  }

  res.json({
    conversation_id : convId,
    found           : !!convId,
    timestamp       : convId ? convTimes[convId] : null
  });
});

// ─────────────────────────────────────────────────────────
// POST /send-summary — posts booking summary into chat
// Called by HTML page when customer clicks Talk to Agent
// ─────────────────────────────────────────────────────────
app.post('/send-summary', async (req, res) => {
  try {
    const { conversation_id, summary } = req.body;

    console.log('Send summary request:', {
      conversation_id,
      summary_length: summary?.length
    });

    if (!conversation_id) {
      return res.status(400).json({ error: 'conversation_id required' });
    }

    if (!summary) {
      return res.status(400).json({ error: 'summary required' });
    }

    if (!FRESHCHAT_TOKEN) {
      return res.status(500).json({ error: 'FRESHCHAT_TOKEN not configured' });
    }

    // Post message to Freshchat conversation
    const fcUrl = `${FRESHCHAT_DOMAIN}/crm/messaging/a/${ACCOUNT_ID}/api/v2/conversations/${conversation_id}/messages`;

    console.log('Calling Freshchat API:', fcUrl);

    const response = await fetch(fcUrl, {
      method  : 'POST',
      headers : {
        'Authorization': `Bearer ${FRESHCHAT_TOKEN}`,
        'Content-Type' : 'application/json'
      },
      body: JSON.stringify({
        message_parts: [{ text: { content: summary } }],
        actor_type   : 'agent',
        message_type : 'normal'
      })
    });

    const result = await response.json();
    console.log('Freshchat API response:', response.status, JSON.stringify(result));

    if (response.ok) {
      res.json({ success: true, message_id: result.id || null });
    } else {
      res.status(response.status).json({
        error  : 'Freshchat API error',
        details: result
      });
    }

  } catch (e) {
    console.error('Send summary error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// POST /assign-agent — assigns conversation to agent group
// Optional: call this after /send-summary
// ─────────────────────────────────────────────────────────
app.post('/assign-agent', async (req, res) => {
  try {
    const { conversation_id, group_id } = req.body;

    if (!conversation_id) {
      return res.status(400).json({ error: 'conversation_id required' });
    }

    const fcUrl = `${FRESHCHAT_DOMAIN}/crm/messaging/a/${ACCOUNT_ID}/api/v2/conversations/${conversation_id}/assignments`;

    const response = await fetch(fcUrl, {
      method  : 'PUT',
      headers : {
        'Authorization': `Bearer ${FRESHCHAT_TOKEN}`,
        'Content-Type' : 'application/json'
      },
      body: JSON.stringify({
        assigned_group_id: group_id || null
      })
    });

    const result = await response.json();
    response.ok
      ? res.json({ success: true })
      : res.status(response.status).json({ error: result });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// GET /debug — see what's stored (remove before production)
// ─────────────────────────────────────────────────────────
app.get('/debug', (req, res) => {
  res.json({
    latestConvId,
    convStore,
    convTimes,
    token_set: !!FRESHCHAT_TOKEN
  });
});

// ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`APJ Cabs Bridge running on port ${PORT}`));
