const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const FRESHCHAT_TOKEN = process.env.FRESHCHAT_TOKEN;
const FRESHCHAT_DOMAIN = 'https://apjcabs.myfreshworks.com';
const conversationStore = {};

// Webhook: captures conversation_id
app.post('/webhook', async (req, res) => {
  try {
    const { action, data } = req.body;
    if (action === 'message_create' && data?.message?.conversation_id) {
      const convId = data.message.conversation_id;
      const userId = data.message.actor_id || 'unknown';
      conversationStore[userId] = convId;
      console.log(`Stored: ${userId} → ${convId}`);
    }
    res.sendStatus(200);
  } catch (e) {
    res.sendStatus(500);
  }
});

// Quote summary → posts into Freshchat conversation
app.post('/send-summary', async (req, res) => {
  try {
    const { conversation_id, summary } = req.body;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id required' });

    const response = await fetch(
      `${FRESHCHAT_DOMAIN}/crm/messaging/a/1108501973785697/api/v2/conversations/${conversation_id}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message_parts: [{ text: { content: summary } }],
          actor_type: 'agent',
          message_type: 'normal'
        })
      }
    );
    const result = await response.json();
    response.ok ? res.json({ success: true }) : res.status(response.status).json({ error: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('APJ Cabs Bridge Server Running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
