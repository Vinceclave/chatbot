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
  res.json({ status: "ok", service: "Location Lite + Map Bot" });
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
            console.log(`User ${senderId} location:`, loc);
            await sendLocationConfirmation(senderId, loc.lat, loc.long);
            continue;
          }
        }

        // Handle text input for location (Messenger Lite / fallback)
        if (event.message?.text) {
          const text = event.message.text.trim();
          // Basic coordinate detection: "lat, long"
          const match = text.match(/(-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?)/);
          if (match) {
            const lat = parseFloat(match[1]);
            const long = parseFloat(match[3]);
            console.log(`User ${senderId} text location:`, { lat, long });
            await sendLocationConfirmation(senderId, lat, long);
          } else {
            // Ask user to input coordinates
            await callSendAPI(senderId, {
              text: "📍 Please send your location as text in this format:\n`latitude, longitude`\n\nExample: `14.5995, 120.9842`"
            });
          }
          continue;
        }

        // If user sends anything else (no attachment, no text)
        await callSendAPI(senderId, {
          text: "📍 Please share your location by sending coordinates (e.g., `14.5995, 120.9842`) or using Messenger location."
        });
      }
    }
    res.status(200).send("EVENT_RECEIVED");
  } else {
    res.sendStatus(404);
  }
});

// ===== SEND CONFIRMATION & MAP BUTTON =====
async function sendLocationConfirmation(senderId: string, lat: number, long: number) {
  await callSendAPI(senderId, {
    text: `📍 Location received!\nLatitude: ${lat}\nLongitude: ${long}`
  });

  await callSendAPI(senderId, {
    attachment: {
      type: "template",
      payload: {
        template_type: "generic",
        elements: [
          {
            title: "View Location on Map",
            subtitle: "Tap to open in Google Maps",
            buttons: [
              {
                type: "web_url",
                url: `https://www.google.com/maps?q=${lat},${long}`,
                title: "📍 View +"
              }
            ]
          }
        ]
      }
    }
  });
}

// ===== SEND TO FACEBOOK =====
async function callSendAPI(senderId: string, message: { text?: string; attachment?: any }) {
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
  console.log(`✅ Location Lite + Map Bot running on port ${PORT}`);
  console.log(`🔗 Webhook URL: https://YOUR-DOMAIN.com/webhook`);
  console.log(`🔑 Verify Token: ${VERIFY_TOKEN}`);
});
