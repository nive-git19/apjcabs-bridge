const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app = express();
app.use(cors());

// ─── FRESHCHAT RSA PUBLIC KEY ─────────────────────────────
// Used to verify webhook signatures from Freshchat
const FRESHCHAT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArHZszshUHWqi13n1K5p
57GGCbp9alQUen+Cp+1OztrhTqeaUxC/LifqQnlOJf1/qXvA9AnGFzNm2wXjgI
pN1WfmvY6j2/p5pCp2bROHxKliZrBmcaPNaXxleewYW+0d2d+dP0gmzyUDox30
XQUZPhtWaYFyTAtFNQ+q1Y/jAhJslgVv879AXgBk3YFMjxPk+enRajCtroiU0G
EL+k1SdzCIhY8Ju/XqBuQq2/kObikloN87ilUt03Ue/tT2/Ehh3ctjqoUhRuP3
e1EPg8qQlS1fQa8IKbGC34s9oMfKdRyhk9Ab8nv7m0tZycViZmzAcnQr6l8y6U
+7kJEQ7g4trIwIDAQAB
-----END PUBLIC KEY-----`;

// ─── CONFIG ───────────────────────────────────────────────
const FRESHCHAT_TOKEN  = process.env.FRESHCHAT_TOKEN;
const FRESHCHAT_DOMAIN = 'https://cabs-952462514711362027-d37d39c8fb1f00417734408.freshchat.com/v2';

// ─── PERSISTENT FILE STORE ───────────────────────────────
// /tmp persists across requests on Render free tier
const STORE_FILE = path.join('/tmp', 'apj_conv_store.json');

function readStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    }
  } catch(e) { console.error('Read store error:', e.message); }
  return { latestConvId: null, convMap: {} };
}

function writeStore(data) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(data), 'utf8');
  } catch(e) { console.error('Write store error:', e.message); }
}

let store = readStore();
console.log('Loaded store on startup:', store.latestConvId || 'empty');

// ─── SIGNATURE VERIFICATION ───────────────────────────────
function verifySignature(rawBody, signature) {
  try {
    const verify = crypto.createVerify('SHA256');
    verify.update(rawBody);
    const isValid = verify.verify(FRESHCHAT_PUBLIC_KEY, signature, 'base64');
    return isValid;
  } catch(e) {
    console.error('Signature verify error:', e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────
// GET / — health check
// ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  store = readStore();
  res.json({
    status      : 'APJ Cabs Bridge Running ✅',
    latestConvId: store.latestConvId || 'none',
    token_set   : !!FRESHCHAT_TOKEN
  });
});

// ─────────────────────────────────────────────────────────
// POST /webhook — Freshchat fires this on events
// Uses raw body parser to verify RSA signature
// ─────────────────────────────────────────────────────────
app.post('/webhook',
  express.raw({ type: '*/*' }),
  async (req, res) => {
    try {
      const rawBody  = req.body.toString('utf8');
      const signature = req.headers['x-freshchat-signature'];

      console.log('=== WEBHOOK HIT ===');
      console.log('Signature header:', signature ? 'present' : 'missing');

      // Verify signature if present
      if (signature) {
        const isValid = verifySignature(rawBody, signature);
        console.log('Signature valid:', isValid);
        if (!isValid) {
          console.log('❌ Invalid signature');
          return res.sendStatus(401);
        }
      }

      const body   = JSON.parse(rawBody);
      const action = body?.action;
      console.log('Action:', action);

      let convId = null;
      let userId = null;

      if (action === 'message_create') {
        convId = body?.data?.message?.conversation_id;
        userId = body?.data?.message?.user_id ||
                 body?.actor?.actor_id;
      } else if (action === 'conversation_assignment') {
        convId = body?.data?.assignment?.conversation?.conversation_id;
        userId = body?.actor?.actor_id;
      } else if (action === 'conversation_resolution') {
        convId = body?.data?.resolve?.conversation?.conversation_id;
        userId = body?.actor?.actor_id;
      } else if (action === 'conversation_reopen') {
        convId = body?.data?.reopen?.conversation?.conversation_id;
        userId = body?.actor?.actor_id;
      }

      console.log('convId:', convId);
      console.log('userId:', userId);

      if (convId) {
        store = readStore();
        store.latestConvId = convId;
        if (userId) store.convMap[userId] = convId;
        writeStore(store);
        console.log('✅ Stored conv_id:', convId);
      } else {
        console.log('⚠️ No conv_id found — action:', action);
        console.log('Full body:', rawBody);
      }

      res.sendStatus(200);
    } catch(e) {
      console.error('Webhook error:', e.message);
      res.sendStatus(200); // always 200 to Freshchat
    }
  }
);

// ─────────────────────────────────────────────────────────
// GET /get-conv-id — HTML page calls this on load
// Returns stored conv_id from webhook
// ─────────────────────────────────────────────────────────
app.use(express.json());

app.get('/get-conv-id', (req, res) => {
  store = readStore();
  const convId = store.latestConvId;
  console.log('GET /get-conv-id →', convId || 'null');
  res.json({
    conversation_id : convId,
    found           : !!convId
  });
});

// ─────────────────────────────────────────────────────────
// GET /get-latest-conv — fallback: fetch from Freshchat API
// Called if webhook hasn't fired yet
// ─────────────────────────────────────────────────────────
app.get('/get-latest-conv', async (req, res) => {
  try {
    if (!FRESHCHAT_TOKEN) {
      return res.status(500).json({ error: 'FRESHCHAT_TOKEN not set' });
    }

    const response = await fetch(
      `${FRESHCHAT_DOMAIN}/conversations?sort_by=last_activity&sort_order=desc&items_per_page=1`,
      {
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_TOKEN}`,
          'Content-Type' : 'application/json'
        }
      }
    );

    const data = await response.json();
    console.log('Freshchat conversations API:', response.status);

    const conv = data?.conversations?.[0];

    if (conv) {
      // Store it for future use
      store = readStore();
      store.latestConvId = conv.id;
      writeStore(store);
      console.log('✅ Got conv from API:', conv.id);
      res.json({ conversation_id: conv.id, found: true });
    } else {
      console.log('No open conversations found');
      res.json({ conversation_id: null, found: false });
    }
  } catch(e) {
    console.error('Get latest conv error:', e.message);
    res.status(500).json({ error: e.message });
  }
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

    const fcUrl = `${FRESHCHAT_DOMAIN}/conversations/${conversation_id}/messages`;

    console.log('Calling Freshchat API:', fcUrl);

    const response = await fetch(fcUrl, {
      method  : 'POST',
      headers : {
        'Authorization': `Bearer ${FRESHCHAT_TOKEN}`,
        'Content-Type' : 'application/json'
      },
      body: JSON.stringify({
        message_parts: [{ text: { content: summary } }],
        message_type : 'normal',
        actor_type   : 'agent',
        actor_id     : 'aae28b3c-7e8e-4d8e-839e-e3954fcb30e3'
      })
    });

    const result = await response.json();
    console.log('Freshchat response:', response.status, JSON.stringify(result));

    if (response.ok) {
      res.json({ success: true });
    } else {
      res.status(response.status).json({ error: result });
    }
  } catch(e) {
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
