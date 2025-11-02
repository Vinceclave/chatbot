import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch'; // Make sure node-fetch is installed

const app = express();
app.use(bodyParser.json());

// ===== CONFIGURE =====
const VERIFY_TOKEN: string = "messenger_bot_verify_token_2025_secure";

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
  quick_reply?: {
    payload: string;
  };
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
  attachment?: any;
}

interface SendAPIBody {
  recipient: { id: string };
  message?: MessageResponse;
  messaging_type?: string;
  sender_action?: string;
}

// ===== Emergency Request Data Structure =====
interface EmergencyRequest {
  location?: string;
  locationCoords?: { lat: number; long: number };
  contactName?: string;
  contactNumber?: string;
  requiredAssistance?: string[];
  numberOfPeople?: number;
  urgencyLevel?: string;
  verificationDoc?: string;
  additionalInfo?: string;
  timestamp: number;
  submittedAt?: number;
}

interface UserState {
  state:
    | "start"
    | "awaiting_assistance_type"
    | "awaiting_more_assistance"
    | "awaiting_contact_name"
    | "awaiting_contact_number"
    | "awaiting_number_of_people"
    | "awaiting_urgency_level"
    | "awaiting_location"
    | "awaiting_verification_doc"
    | "awaiting_additional_info";
  emergencyData: EmergencyRequest;
  timestamp: number;
}

// ===== State Memory =====
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
setInterval(cleanupOldStates, CLEANUP_INTERVAL_MS);

// ===== Helper Functions =====
function setState(senderId: string, state: UserState['state']) {
  if (!userState[senderId]) {
    userState[senderId] = {
      state,
      emergencyData: { timestamp: Date.now(), requiredAssistance: [] },
      timestamp: Date.now()
    };
  } else {
    userState[senderId].state = state;
    userState[senderId].timestamp = Date.now();
  }
}

function getState(senderId: string): UserState | undefined {
  return userState[senderId];
}

function clearState(senderId: string) {
  delete userState[senderId];
}

function updateEmergencyData(senderId: string, data: Partial<EmergencyRequest>) {
  if (userState[senderId]) {
    userState[senderId].emergencyData = {
      ...userState[senderId].emergencyData,
      ...data
    };
  }
}

function addAssistanceType(senderId: string, type: string) {
  if (userState[senderId]) {
    const current = userState[senderId].emergencyData.requiredAssistance || [];
    if (!current.includes(type)) {
      current.push(type);
      userState[senderId].emergencyData.requiredAssistance = current;
    }
  }
}

// ===== Routes =====
app.get('/', (req, res) => {
  res.json({
    status: "ok",
    service: "AidVocate Emergency Bot",
    uptime: process.uptime(),
    activeRequests: Object.keys(userState).length
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

// Messenger webhook receiver
app.post('/webhook', async (req: Request<{}, {}, WebhookBody>, res: Response) => {
  const body = req.body;

  if (body.object === 'page') {
    for (const entry of body.entry) {
      if (!entry.messaging || entry.messaging.length === 0) continue;
      for (const event of entry.messaging) {
        const senderId = event.sender?.id;
        if (!senderId) continue;

        try {
          if (event.message) await handleMessage(senderId, event.message);
          else if (event.postback) await handlePostback(senderId, event.postback);
        } catch (error) {
          console.error(`❌ Error processing event for user ${senderId}:`, error);
          await callSendAPI(senderId, {
            text: "⚠️ Sorry, something went wrong. Please type HELP to restart."
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

  await sendTypingIndicator(senderId, true);

  const text = msg.text?.trim() || "";
  const quickReplyPayload = msg.quick_reply?.payload;
  const currentState = getState(senderId);

  console.log(`📨 Message from ${senderId}: text="${text}", payload="${quickReplyPayload}", state="${currentState?.state}"`);

  // ===== Handle Attachments =====
  if (msg.attachments && msg.attachments.length > 0) {
    const attachment = msg.attachments[0];

    // Location
    if (attachment.type === "location") {
      const loc = attachment.payload as LocationPayload;
      updateEmergencyData(senderId, {
        locationCoords: { lat: loc.coordinates.lat, long: loc.coordinates.long },
        location: `${loc.coordinates.lat}, ${loc.coordinates.long}`
      });
      setState(senderId, "awaiting_verification_doc");
      await sendTypingIndicator(senderId, false);
      return callSendAPI(senderId, {
        text: `📍 Location Received!\nLatitude: ${loc.coordinates.lat}\nLongitude: ${loc.coordinates.long}\n\n📄 Verification Document (Optional)\nPlease upload any document verifying your emergency (image) or type SKIP to continue.`
      });
    }

    // Image (Verification Document)
    if (attachment.type === "image") {
      if (currentState?.state === "awaiting_verification_doc") {
        const imageUrl = attachment.payload?.url || "Image received";
        updateEmergencyData(senderId, { verificationDoc: imageUrl });
        setState(senderId, "awaiting_additional_info");
        await sendTypingIndicator(senderId, false);
        return callSendAPI(senderId, {
          text: `✅ Verification document received!\n\n📝 Additional Information (Optional)\nPlease share special needs, medical conditions, etc., or type SKIP to submit.`
        });
      } else {
        await sendTypingIndicator(senderId, false);
        return callSendAPI(senderId, { text: `📷 Image received! Type HELP to start a new emergency request.` });
      }
    }
  }

  // ===== Command Handlers =====
  if (text.toLowerCase().includes("help") || text.toLowerCase().includes("sos") || text.toLowerCase().includes("emergency") || text.toLowerCase().includes("start")) {
    setState(senderId, "awaiting_assistance_type");
    await sendTypingIndicator(senderId, false);
    return sendAssistanceTypeOptions(senderId);
  }

  if (text.toLowerCase().includes("cancel") || text.toLowerCase().includes("reset")) {
    clearState(senderId);
    await sendTypingIndicator(senderId, false);
    return callSendAPI(senderId, { text: `🔄 Request cancelled. Type HELP when you need assistance.` });
  }

  // ===== State-based Conversation Flow =====
  if (!currentState) {
    await sendTypingIndicator(senderId, false);
    return callSendAPI(senderId, {
      text: `👋 Welcome to AidVocate Emergency Bot\n\nType HELP to start a new emergency request. We're here 24/7! 🙏`
    });
  }

  // STATE: Awaiting Assistance Type
  if (currentState.state === "awaiting_assistance_type") {
    const cleanText = text.toUpperCase();
    const payload = quickReplyPayload?.toUpperCase();
    const validTypes = ["FOOD", "WATER", "MEDICAL", "SHELTER", "CLOTHING", "OTHER"];
    let selectedType = validTypes.includes(payload || "") ? payload : validTypes.includes(cleanText) ? cleanText : null;

    if (selectedType) {
      const capitalizedType = selectedType.charAt(0) + selectedType.slice(1).toLowerCase();
      addAssistanceType(senderId, capitalizedType);
      setState(senderId, "awaiting_more_assistance");
      await sendTypingIndicator(senderId, false);
      return askForMoreAssistance(senderId);
    } else {
      await sendTypingIndicator(senderId, false);
      return sendAssistanceTypeOptions(senderId);
    }
  }

  // STATE: Awaiting More Assistance (YES/NO)
  if (currentState.state === "awaiting_more_assistance") {
    if (text.toLowerCase() === "yes") {
      setState(senderId, "awaiting_assistance_type");
      await sendTypingIndicator(senderId, false);
      return sendAssistanceTypeOptions(senderId);
    } else {
      setState(senderId, "awaiting_contact_name");
      await sendTypingIndicator(senderId, false);
      return callSendAPI(senderId, { text: "👤 Please provide a contact name for this request:" });
    }
  }

  // STATE: Awaiting Contact Name
  if (currentState.state === "awaiting_contact_name") {
    if (text.length >= 2) {
      updateEmergencyData(senderId, { contactName: text });
      setState(senderId, "awaiting_contact_number");
      await sendTypingIndicator(senderId, false);
      return callSendAPI(senderId, { text: "📞 Now, please provide the contact number:" });
    } else {
      await sendTypingIndicator(senderId, false);
      return callSendAPI(senderId, { text: "⚠️ Please provide a valid name." });
    }
  }

  // STATE: Awaiting Contact Number
  if (currentState.state === "awaiting_contact_number") {
    if (/^\+?\d{7,15}$/.test(text.replace(/ /g, ""))) {
      updateEmergencyData(senderId, { contactNumber: text });
      setState(senderId, "awaiting_number_of_people");
      await sendTypingIndicator(senderId, false);
      return callSendAPI(senderId, { text: "👥 How many people need assistance?" });
    } else {
      await sendTypingIndicator(senderId, false);
      return callSendAPI(senderId, { text: "⚠️ Please provide a valid phone number (digits only, may include +)." });
    }
  }

  // STATE: Awaiting Number of People
  if (currentState.state === "awaiting_number_of_people") {
    const num = parseInt(text);
    if (!isNaN(num) && num > 0) {
      updateEmergencyData(senderId, { numberOfPeople: num });
      setState(senderId, "awaiting_urgency_level");
      await sendTypingIndicator(senderId, false);
      return askForUrgencyLevel(senderId);
    } else {
      await sendTypingIndicator(senderId, false);
      return callSendAPI(senderId, { text: "⚠️ Please enter a valid number of people." });
    }
  }

  // STATE: Awaiting Urgency Level
  if (currentState.state === "awaiting_urgency_level") {
    const levels = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
    if (levels.includes(text.toUpperCase())) {
      updateEmergencyData(senderId, { urgencyLevel: text.toUpperCase() });
      setState(senderId, "awaiting_location");
      await sendTypingIndicator(senderId, false);
      return askForLocation(senderId);
    } else {
      await sendTypingIndicator(senderId, false);
      return askForUrgencyLevel(senderId);
    }
  }

  // STATE: Awaiting Additional Info
  if (currentState.state === "awaiting_additional_info") {
    if (text.toLowerCase() !== "skip") {
      updateEmergencyData(senderId, { additionalInfo: text });
    }
    await finalizeEmergencyRequest(senderId);
    clearState(senderId);
    await sendTypingIndicator(senderId, false);
    return callSendAPI(senderId, { text: "✅ Your emergency request has been submitted! Help is on the way." });
  }

  // Fallback
  await sendTypingIndicator(senderId, false);
  return callSendAPI(senderId, { text: `⚠️ I didn't understand that. Type HELP to start a new emergency request.` });
}

// ===== Postback Handler =====
async function handlePostback(senderId: string, postback: Postback) {
  if (postback.payload === "GET_STARTED") {
    setState(senderId, "start");
    return callSendAPI(senderId, { text: `👋 Welcome to AidVocate Emergency Bot!\n\nType HELP to start a new emergency request.` });
  }
}

// ===== UI / Messages =====
function sendAssistanceTypeOptions(senderId: string) {
  const quickReplies = [
    { content_type: "text", title: "Food", payload: "FOOD" },
    { content_type: "text", title: "Water", payload: "WATER" },
    { content_type: "text", title: "Medical", payload: "MEDICAL" },
    { content_type: "text", title: "Shelter", payload: "SHELTER" },
    { content_type: "text", title: "Clothing", payload: "CLOTHING" },
    { content_type: "text", title: "Other", payload: "OTHER" }
  ];

  return callSendAPI(senderId, {
    text: "🆘 What type of assistance do you need?",
    quick_replies: quickReplies
  });
}

function askForMoreAssistance(senderId: string) {
  return callSendAPI(senderId, {
    text: "Do you need to request another type of assistance? (Yes/No)"
  });
}

function askForUrgencyLevel(senderId: string) {
  const quickReplies = [
    { content_type: "text", title: "Low", payload: "LOW" },
    { content_type: "text", title: "Medium", payload: "MEDIUM" },
    { content_type: "text", title: "High", payload: "HIGH" },
    { content_type: "text", title: "Critical", payload: "CRITICAL" }
  ];
  return callSendAPI(senderId, {
    text: "⚡ Please select the urgency level:",
    quick_replies: quickReplies
  });
}

function askForLocation(senderId: string) {
  return callSendAPI(senderId, {
    text: "📍 Please share your location or type your address:",
    quick_replies: [{ content_type: "location" }]
  });
}

async function finalizeEmergencyRequest(senderId: string) {
  const data = getState(senderId)?.emergencyData;
  if (!data) return;

  console.log("📝 Emergency Request Submitted:", JSON.stringify(data, null, 2));
  // TODO: Save to database or notify responders
}

// ===== Messenger API =====
async function callSendAPI(senderId: string, message: MessageResponse) {
  const body: SendAPIBody = {
    recipient: { id: senderId },
    message,
    messaging_type: "RESPONSE"
  };

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" }
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("❌ Messenger API Error:", text);
    }
  } catch (error) {
    console.error("❌ callSendAPI error:", error);
  }
}

// Typing indicator
async function sendTypingIndicator(senderId: string, typing: boolean) {
  const body: SendAPIBody = {
    recipient: { id: senderId },
    sender_action: typing ? "typing_on" : "typing_off"
  };
  await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" }
  }).catch(e => console.error("Typing indicator error:", e));
}

// ===== Server Start =====
app.listen(PORT, () => {
  console.log(`🚀 AidVocate Bot running on port ${PORT}`);
});
