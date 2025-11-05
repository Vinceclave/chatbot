import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import 'dotenv/config';

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

if (!PAGE_ACCESS_TOKEN || !VERIFY_TOKEN) {
  console.error("❌ PAGE_ACCESS_TOKEN and VERIFY_TOKEN are required!");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "3000");

// ===== HEALTH CHECK =====
app.get('/', (_req, res) => {
  res.send("Minimal Test Bot is running ✅");
});

// ===== WEBHOOK VERIFICATION =====
app.get('/webhook', (req: Request<{}, {}, {}, any>, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

// ===== SEND MESSAGE =====
async function sendMessage(senderId: string, text: string) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: senderId },
        message: { text },
        messaging_type: "RESPONSE"
      }
    );
    console.log(`💬 Replied to ${senderId}`);
  } catch (err: any) {
    console.error("❌ Failed to send message:", err.response?.data || err.message);
  }
}

// ===== WEBHOOK POST =====
app.post('/webhook', async (req: Request, res: Response) => {
  const body = req.body;
  console.log('📥 Incoming webhook event:', JSON.stringify(body, null, 2));

  if (body.object === 'page') {
    body.entry.forEach((entry: any) => {
      entry.messaging.forEach((event: any) => {
        const senderId = event.sender?.id;
        if (!senderId) return;

        // Always reply with a fixed message
        sendMessage(senderId, "Hello! Your message was received.");
      });
    });

    return res.status(200).send("EVENT_RECEIVED");
  }

  res.sendStatus(404);
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`🚀 Minimal test bot running on port ${PORT}`);
});
