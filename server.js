const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const FRESHCHAT_TOKEN  = process.env.FRESHCHAT_TOKEN;
const ACCOUNT_ID       = '1108501973785697';
const FRESHCHAT_DOMAIN = 'https://apjcabs.myfreshworks.com';

// ─── PERSISTENT STORAGE ──────────────────────────────────
// Render free tier spins down and loses memory
// We write conv_id to a file so it survives restarts
const STORE_FILE = path.join('/tmp', 'apj_conv_store.json');

function readStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    }
  } catch(e) {}
  return { latestConvId: null, convMap: {} };
}

function writeStore(data) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(data), 'utf8');
  } catch(e) {
    console.error('Write store error:', e.message);
  }
}

// Load on startup
let store = readStore();
console.log('Loaded store on startup:', store.latestConvId || 'empty');

// ─────────────────────────────────────────────────────────
// GET / — health check
// ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  store = readStore();
  res.json({
    status      : 'APJ Cabs Bridge Running ✅',
    latestConvId: store.latestConvId || 'none',
    stored      : Object.keys(store.convMap || {}).length
  });
});

// ─────────────────────────────────────────────────────────
// POST /webhook — Freshchat fires this on events
// Payload docs: data.message.conversation_id (message_create)
// ─────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    const body   = req.body;
    const action = body?.action;

    console.log('Webhook received — action:', action);

    let convId = null;
    let userId = null;

    if (action === 'message_create') {
      // Per Freshchat docs: data.message.conversation_id
      convId = body?.data?.message?.conversation_id;
      userId = body?.data?.message?.user_id ||
               body?.actor?.actor_id;
    }
    else if (action === 'conversation_assignment') {
      convId = body?.data?.assignment?.conversation?.conversation_id;
      userId = body?.data?.assignment?.to_agent_id ||
               body?.actor?.actor_id;
    }
    else if (action === 'conversation_resolution') {
      convId = body?.data?.resolve?.conversation?.conversation_id;
      userId = body?.actor?.actor_id;
    }
    else if (action === 'conversation_reopen') {
      convId = body?.data?.reopen?.conversation?.conversation_id;
      userId = body?.actor?.actor_id;
    }

    console.log('Extracted convId:', convId);
    console.log('Extracted userId:', userId);

    if (convId) {
      store = readStore();
      store.latestConvId = convId;
      if (userId) store.convMap[userId] = convId;
      writeStore(store);
      console.log(`✅ Stored conv_id: ${convId}`);
    } else {
      console.log('⚠️ No conv_id in this payload — action:', action);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e.message);
    res.sendStatus(200);
  }
});

// ─────────────────────────────────────────────────────────
// GET /get-conv-id — HTML quote page calls this on load
// ─────────────────────────────────────────────────────────
app.get('/get-conv-id', (req, res) => {
  store = readStore();

  const userId = req.query.user_id;
  let convId   = null;

  if (userId && store.convMap?.[userId]) {
    convId = store.convMap[userId];
  } else {
    convId = store.latestConvId;
  }

  console.log('GET /get-conv-id →', convId || 'null');

  res.json({
    conversation_id : convId,
    found           : !!convId
  });
});

// ─────────────────────────────────────────────────────────
// POST /send-summary — posts summary into Freshchat thread
// ─────────────────────────────────────────────────────────
app.post('/send-summary', async (req, res) => {
  try {
    const { conversation_id, summary } = req.body;

    console.log('POST /send-summary — conv_id:', conversation_id);

    if (!conversation_id) {
      return res.status(400).json({ error: 'conversation_id required' });
    }
    if (!summary) {
      return res.status(400).json({ error: 'summary required' });
    }
    if (!FRESHCHAT_TOKEN) {
      return res.status(500).json({ error: 'FRESHCHAT_TOKEN not set' });
    }

    const fcUrl = `${FRESHCHAT_DOMAIN}/crm/messaging/a/${ACCOUNT_ID}/api/v2/conversations/${conversation_id}/messages`;

    console.log('Calling Freshchat:', fcUrl);

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
    console.log('Freshchat response:', response.status, JSON.stringify(result));

    if (response.ok) {
      res.json({ success: true });
    } else {
      res.status(response.status).json({ error: result });
    }

  } catch (e) {
    console.error('Send summary error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// GET /debug — check stored values
// ─────────────────────────────────────────────────────────
app.get('/debug', (req, res) => {
  store = readStore();
  res.json({
    latestConvId : store.latestConvId,
    convMap      : store.convMap,
    token_set    : !!FRESHCHAT_TOKEN
  });
});

// ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`APJ Cabs Bridge running on port ${PORT}`));
