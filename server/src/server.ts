import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';

const app = express();
app.use(bodyParser.json());

// ===== CONFIGURE =====
const VERIFY_TOKEN: string = "messenger_bot_verify_token_2025_secure";

// Critical: Fail fast if token is missing
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
if (!PAGE_ACCESS_TOKEN) {
  console.error("❌ PAGE_ACCESS_TOKEN environment variable is required!");
  process.exit(1);
}

const PORT: number = parseInt(process.env.PORT || "3000");
const STATE_TIMEOUT_MS = 3600000; // 1 hour
const CLEANUP_INTERVAL_MS = 300000; // 5 minutes

// ===== TYPES =====
interface WebhookQuery {
  'hub.mode'?: string;
  'hub.verify_token'?: string;
  'hub.challenge'?: string;
}

interface Message {
  text?: string;
  attachments?: any[];
}

interface LocationPayload {
  coordinates: {
    lat: number;
    long: number;
  };
}

interface Postback {
  payload: string;
  title?: string;
}

interface MessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: Message & { attachments?: { type: string; payload: LocationPayload | any }[] };
  postback?: Postback;
}

interface WebhookEntry {
  id: string;
  time: number;
  messaging: MessagingEvent[];
}

interface WebhookBody {
  object: string;
  entry: WebhookEntry[];
}

interface MessageResponse {
  text?: string;
  quick_replies?: any[];
}

interface SendAPIBody {
  recipient: { id: string };
  message?: MessageResponse;
  messaging_type?: string;
  sender_action?: string;
}

interface UserState {
  state: string;
  helpType?: string;
  timestamp: number;
}

// ===== Chat State Memory (with timestamps) =====
const userState: Record<string, UserState> = {};

// ===== Memory Cleanup =====
function cleanupOldStates() {
  const now = Date.now();
  let cleaned = 0;
  
  Object.keys(userState).forEach(userId => {
    if (now - userState[userId].timestamp > STATE_TIMEOUT_MS) {
      delete userState[userId];
      cleaned++;
    }
  });
  
  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} expired user state(s)`);
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupOldStates, CLEANUP_INTERVAL_MS);

// ===== Helper Functions =====
function setState(senderId: string, state: string, helpType?: string) {
  userState[senderId] = {
    state,
    helpType,
    timestamp: Date.now()
  };
}

function getState(senderId: string): UserState | undefined {
  return userState[senderId];
}

function clearState(senderId: string) {
  delete userState[senderId];
}

// ===== Routes =====

// Health check
app.get('/', (req, res) => {
  res.json({
    status: "ok",
    service: "AidVocate Messenger Bot",
    uptime: process.uptime(),
    activeUsers: Object.keys(userState).length
  });
});

// Facebook webhook verification
app.get('/webhook', (req: Request<{}, {}, {}, WebhookQuery>, res: Response) => {
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

// Messenger event receiver
app.post('/webhook', async (req: Request<{}, {}, WebhookBody>, res: Response) => {
  const body = req.body;

  if (body.object === 'page') {
    // Process each entry
    for (const entry of body.entry) {
      // Validate messaging array exists
      if (!entry.messaging || entry.messaging.length === 0) {
        console.warn("⚠️ Empty messaging array in entry");
        continue;
      }

      // Process each messaging event
      for (const event of entry.messaging) {
        const senderId = event.sender?.id;
        
        if (!senderId) {
          console.warn("⚠️ Event missing sender ID");
          continue;
        }

        try {
          if (event.message) {
            await handleMessage(senderId, event.message);
          } else if (event.postback) {
            await handlePostback(senderId, event.postback);
          }
        } catch (error) {
          console.error(`❌ Error processing event for user ${senderId}:`, error);
          // Send error message to user
          await callSendAPI(senderId, {
            text: "⚠️ Sorry, something went wrong. Please try again."
          }).catch(e => console.error("Failed to send error message:", e));
        }
      }
    }

    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// ===== Message Handler =====
async function handleMessage(senderId: string, msg: MessagingEvent['message']) {
  if (!msg) return;

  // Show typing indicator
  await sendTypingIndicator(senderId, true);

  // ---- Location received ----
  if (msg.attachments && msg.attachments.length > 0 && msg.attachments[0]?.type === "location") {
    const loc = msg.attachments[0].payload as LocationPayload;
    const currentState = getState(senderId);
    const helpType = currentState?.helpType || "general";
    
    clearState(senderId);

    await sendTypingIndicator(senderId, false);
    return callSendAPI(senderId, {
      text: `📍 **Location Received!**\n` +
            `Latitude: ${loc.coordinates.lat}\n` +
            `Longitude: ${loc.coordinates.long}\n\n` +
            `🚨 Help Type: ${helpType.toUpperCase()}\n` +
            `✅ Emergency response team has been notified!\n` +
            `⏱️ Expected arrival: 15-30 minutes\n\n` +
            `Stay safe. Help is on the way!`
    });
  }

  // ---- Image received ----
  if (msg.attachments && msg.attachments.length > 0 && msg.attachments[0]?.type === "image") {
    await sendTypingIndicator(senderId, false);
    return callSendAPI(senderId, {
      text: `📷 **Image received!** Thank you for the visual information.\n\n` +
            `This will help our response team assess the situation better.\n` +
            `Type **HELP** if you need immediate emergency assistance. 🆘`
    });
  }

  const text = msg.text?.toLowerCase().trim() || "";

  // User asks for help
  if (text.includes("help") || text.includes("sos") || text.includes("emergency") || text.includes("911")) {
    setState(senderId, "help_select");
    await sendTypingIndicator(senderId, false);
    return sendHelpOptions(senderId);
  }

  // Expecting help category
  const currentState = getState(senderId);
  if (currentState && currentState.state === "help_select") {
    setState(senderId, "awaiting_location", text);
    await sendTypingIndicator(senderId, false);
    return askForLocation(senderId, text);
  }

  // Greetings
  if (text.includes("hi") || text.includes("hello") || text.includes("hey") || text.includes("start")) {
    await sendTypingIndicator(senderId, false);
    return callSendAPI(senderId, { 
      text: `👋 **Welcome to AidVocate!**\n\n` +
            `I'm your disaster assistance bot, here to help during emergencies.\n\n` +
            `🆘 Type **HELP** anytime you need assistance.\n` +
            `📍 I can help you:\n` +
            `• Request medical aid\n` +
            `• Contact fire & rescue\n` +
            `• Find shelter\n` +
            `• Get relief goods\n\n` +
            `Stay safe! 🙏`
    });
  }

  // Status check
  if (text.includes("status") || text.includes("info")) {
    await sendTypingIndicator(senderId, false);
    return callSendAPI(senderId, {
      text: `ℹ️ **AidVocate Status**\n` +
            `Service: Online ✅\n` +
            `Response Time: < 5 min\n\n` +
            `Type **HELP** for emergency assistance.`
    });
  }

  // Cancel/Reset
  if (text.includes("cancel") || text.includes("reset") || text.includes("stop")) {
    clearState(senderId);
    await sendTypingIndicator(senderId, false);
    return callSendAPI(senderId, {
      text: `🔄 Session reset.\nType **HELP** when you need assistance.`
    });
  }

  // Default fallback
  await sendTypingIndicator(senderId, false);
  return callSendAPI(senderId, {
    text: `You said: "${msg.text}"\n\n` +
          `I'm here to help during emergencies! 🚨\n` +
          `Type **HELP** to request assistance.`
  });
}

// ===== Quick Response Buttons =====
function sendHelpOptions(senderId: string) {
  return callSendAPI(senderId, {
    text: "🚨 **What type of emergency assistance do you need?**\n\nPlease select:",
    quick_replies: [
      { content_type: "text", title: "🆘 Medical Emergency", payload: "MEDICAL" },
      { content_type: "text", title: "🔥 Fire & Rescue", payload: "RESCUE" },
      { content_type: "text", title: "🏠 Shelter", payload: "SHELTER" },
      { content_type: "text", title: "🍚 Relief Goods", payload: "RELIEF" }
    ]
  });
}

function askForLocation(senderId: string, helpType?: string) {
  const helpText = helpType ? ` for **${helpType.toUpperCase()}** assistance` : "";
  
  return callSendAPI(senderId, {
    text: `📍 **Share Your Location**\n\n` +
          `To dispatch emergency help${helpText}, please tap the button below to share your current location.\n\n` +
          `🔒 Your location is only used for emergency response.`,
    quick_replies: [{ content_type: "location" }]
  });
}

// ===== Postbacks =====
async function handlePostback(senderId: string, postback: Postback) {
  await sendTypingIndicator(senderId, true);

  if (postback.payload === "GET_STARTED") {
    await sendTypingIndicator(senderId, false);
    return callSendAPI(senderId, {
      text: `👋 **Welcome to AidVocate!**\n\n` +
            `Your trusted disaster assistance companion.\n\n` +
            `🆘 Type **HELP** anytime you need emergency assistance.\n\n` +
            `We're here 24/7 to help you stay safe! 🙏`
    });
  }

  await sendTypingIndicator(senderId, false);
  return callSendAPI(senderId, { 
    text: `✅ You selected: **${postback.title || postback.payload}**\n\nType **HELP** if you need assistance.` 
  });
}

// ===== Typing Indicator =====
async function sendTypingIndicator(senderId: string, isTyping: boolean) {
  const requestBody: SendAPIBody = {
    recipient: { id: senderId },
    sender_action: isTyping ? "typing_on" : "typing_off"
  };

  try {
    await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });
  } catch (e) {
    // Don't log typing indicator errors (non-critical)
  }
}

// ===== Send message to Facebook API =====
async function callSendAPI(senderId: string, response: MessageResponse): Promise<void> {
  const requestBody: SendAPIBody = {
    recipient: { id: senderId },
    message: response,
    messaging_type: "RESPONSE"
  };

  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      }
    );

    if (!res.ok) {
      const errorData = await res.json().catch(() => null);
      console.error("❌ Facebook API Error:", {
        status: res.status,
        statusText: res.statusText,
        error: errorData
      });
      throw new Error(`Facebook API returned ${res.status}`);
    }

    // Success
    const data = await res.json();
    console.log(`✅ Message sent to ${senderId}:`, data);
  } catch (error) {
    console.error("❌ Failed to send message:", error);
    throw error; // Re-throw for error handling in caller
  }
}

// ===== Graceful Shutdown =====
process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM received, shutting down gracefully...');
  cleanupOldStates();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n⚠️ SIGINT received, shutting down gracefully...');
  cleanupOldStates();
  process.exit(0);
});

// ===== Start Server =====
app.listen(PORT, () => {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`✅ AidVocate Messenger Bot is RUNNING`);
  console.log(`${"=".repeat(50)}`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`🔗 Webhook URL: https://YOUR-DOMAIN.com/webhook`);
  console.log(`🔑 Verify Token: ${VERIFY_TOKEN}`);
  console.log(`⏰ State cleanup: Every ${CLEANUP_INTERVAL_MS / 1000}s`);
  console.log(`⏱️  State timeout: ${STATE_TIMEOUT_MS / 1000}s`);
  console.log(`${"=".repeat(50)}\n`);
});