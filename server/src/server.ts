import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';

const app = express();
app.use(bodyParser.json());

// ===== CONFIGURATION =====
const VERIFY_TOKEN: string = "messenger_bot_verify_token_2025_secure";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
if (!PAGE_ACCESS_TOKEN) {
  console.error("❌ PAGE_ACCESS_TOKEN environment variable is required!");
  process.exit(1);
}

const PORT: number = parseInt(process.env.PORT || "3000");

// ===== ROUTES =====
app.get('/', (req, res) => {
  res.json({ status: "ok", service: "Location Only Bot" });
});

app.get('/webhook', (req: Request<{}, {}, {}, any>, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    res.status(200).send(challenge);
  } else {
    console.log("❌ Webhook verification failed");
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req: Request<{}, {}, any>, res: Response) => {
  const body = req.body;

  if (body.object === 'page') {
    for (const entry of body.entry) {
      for (const event of entry.messaging) {
        const senderId = event.sender?.id;
        if (!senderId) continue;

        // Handle location attachment
        if (event.message?.attachments?.length) {
          const attachment = event.message.attachments[0];
          if (attachment.type === "location") {
            const loc = attachment.payload.coordinates;
            await callSendAPI(senderId, {
              text: `📍 Location received!\nLatitude: ${loc.lat}\nLongitude: ${loc.long}`
            });
            console.log(`User ${senderId} location:`, loc);
            continue;
          }
        }

        // Ask user to share location if they send any other message
        await askForLocation(senderId);
      }
    }
    res.status(200).send("EVENT_RECEIVED");
  } else {
    res.sendStatus(404);
  }
});

// ===== ASK FOR LOCATION =====
async function askForLocation(senderId: string) {
  await callSendAPI(senderId, {
    text: "📍 Please share your location:",
    quick_replies: [
      { content_type: "location" }, // Messenger opens location picker
      { content_type: "text", title: "Cancel", payload: "CANCEL" }
    ]
  });
}

// ===== SEND TO FACEBOOK =====
async function callSendAPI(senderId: string, message: { text: string; quick_replies?: any[] }) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: senderId }, message, messaging_type: "RESPONSE" }
    );
  } catch (error: any) {
    console.error("❌ Failed to send:", error.response?.data || error.message);
  }
}

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`✅ Location Only Bot running on port ${PORT}`);
  console.log(`🔗 Webhook URL: https://YOUR-DOMAIN.com/webhook`);
  console.log(`🔑 Verify Token: ${VERIFY_TOKEN}`);
});
