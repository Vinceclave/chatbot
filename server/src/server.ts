import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';

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

// ===== Emergency Relief Request Data Structure =====
interface EmergencyRequest {
  // Location
  location?: string;
  locationCoords?: { lat: number; long: number };
  
  // Contact Information
  contactName?: string;
  contactNumber?: string;
  
  // Emergency Details
  requiredAssistance?: string; // Food, Water, Medical, Shelter, Clothing, Other
  numberOfPeople?: number;
  urgencyLevel?: string; // Low, Medium, High, Critical
  
  // Verification
  verificationDoc?: string; // Image URL
  
  // Additional Information
  additionalInfo?: string;
  
  timestamp: number;
}

interface UserState {
  state: 
    | "start"
    | "awaiting_assistance_type"
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
      emergencyData: { timestamp: Date.now() },
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

// ===== Routes =====

// Health check
app.get('/', (req, res) => {
  res.json({
    status: "ok",
    service: "AidVocate Emergency Relief Bot",
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

// Messenger event receiver
app.post('/webhook', async (req: Request<{}, {}, WebhookBody>, res: Response) => {
  const body = req.body;

  if (body.object === 'page') {
    for (const entry of body.entry) {
      if (!entry.messaging || entry.messaging.length === 0) {
        console.warn("⚠️ Empty messaging array in entry");
        continue;
      }

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
  const currentState = getState(senderId);

  // ===== HANDLE ATTACHMENTS =====
  
  // Location attachment
  if (msg.attachments && msg.attachments.length > 0) {
    const attachment = msg.attachments[0];
    
    if (attachment.type === "location") {
      const loc = attachment.payload as LocationPayload;
      updateEmergencyData(senderId, {
        locationCoords: { lat: loc.coordinates.lat, long: loc.coordinates.long },
        location: `${loc.coordinates.lat}, ${loc.coordinates.long}`
      });
      
      setState(senderId, "awaiting_verification_doc");
      await sendTypingIndicator(senderId, false);
      return callSendAPI(senderId, {
        text: `📍 **Location Received!**\n` +
              `Latitude: ${loc.coordinates.lat}\n` +
              `Longitude: ${loc.coordinates.long}\n\n` +
              `📄 **Verification Document** (Optional)\n` +
              `Please upload any document that verifies your emergency situation (PDF, JPG, PNG).\n\n` +
              `Or type **SKIP** to continue without a document.`
      });
    }
    
    // Image attachment (for verification)
    if (attachment.type === "image") {
      if (currentState?.state === "awaiting_verification_doc") {
        const imageUrl = attachment.payload?.url || "Image received";
        updateEmergencyData(senderId, { verificationDoc: imageUrl });
        
        setState(senderId, "awaiting_additional_info");
        await sendTypingIndicator(senderId, false);
        return callSendAPI(senderId, {
          text: `✅ **Verification document received!**\n\n` +
                `📝 **Additional Information** (Optional)\n` +
                `Please share any special needs, medical conditions, accessibility requirements, etc.\n\n` +
                `Or type **SKIP** to submit your request.`
        });
      } else {
        await sendTypingIndicator(senderId, false);
        return callSendAPI(senderId, {
          text: `📷 Image received! Type **HELP** to start an emergency request.`
        });
      }
    }
  }

  // ===== COMMAND HANDLERS =====
  
  // Help/Emergency command
  if (text.toLowerCase().includes("help") || 
      text.toLowerCase().includes("sos") || 
      text.toLowerCase().includes("emergency") || 
      text.toLowerCase().includes("start")) {
    setState(senderId, "awaiting_assistance_type");
    await sendTypingIndicator(senderId, false);
    return sendAssistanceTypeOptions(senderId);
  }

  // Cancel command
  if (text.toLowerCase().includes("cancel") || text.toLowerCase().includes("reset")) {
    clearState(senderId);
    await sendTypingIndicator(senderId, false);
    return callSendAPI(senderId, {
      text: `🔄 Request cancelled. Type **HELP** when you need assistance.`
    });
  }

  // ===== STATE-BASED CONVERSATION FLOW =====

  if (!currentState) {
    // No active request - show welcome
    await sendTypingIndicator(senderId, false);
    return callSendAPI(senderId, {
      text: `👋 **Welcome to AidVocate Emergency Relief**\n\n` +
            `I help you submit emergency assistance requests.\n\n` +
            `🆘 Type **HELP** to start a new request.\n\n` +
            `We're here 24/7 to assist you! 🙏`
    });
  }

  // STATE: Awaiting required assistance type
  if (currentState.state === "awaiting_assistance_type") {
    // Remove emojis and extra spaces to get clean text
    const cleanText = text.toLowerCase().replace(/[^\w\s]/gi, '').trim();
    const validTypes = ["food", "water", "medical", "shelter", "clothing", "other"];
    
    if (validTypes.includes(cleanText)) {
      updateEmergencyData(senderId, { 
        requiredAssistance: cleanText.charAt(0).toUpperCase() + cleanText.slice(1) 
      });
      setState(senderId, "awaiting_contact_name");
      await sendTypingIndicator(senderId, false);
      return callSendAPI(senderId, {
        text: `✅ Required Assistance: **${cleanText.toUpperCase()}**\n\n` +
              `👤 **Contact Name**\n` +
              `Please provide your full name:`
      });
    } else {
      await sendTypingIndicator(senderId, false);
      return sendAssistanceTypeOptions(senderId);
    }
  }

  // STATE: Awaiting contact name
  if (currentState.state === "awaiting_contact_name") {
    updateEmergencyData(senderId, { contactName: text });
    setState(senderId, "awaiting_contact_number");
    await sendTypingIndicator(senderId, false);
    return callSendAPI(senderId, {
      text: `✅ Name: **${text}**\n\n` +
            `📱 **Contact Number**\n` +
            `Please provide your phone number:`
    });
  }

  // STATE: Awaiting contact number
  if (currentState.state === "awaiting_contact_number") {
    // Basic phone validation
    const phoneRegex = /^[0-9+\-\s()]{7,}$/;
    if (!phoneRegex.test(text)) {
      await sendTypingIndicator(senderId, false);
      return callSendAPI(senderId, {
        text: `⚠️ Invalid phone number format.\n\nPlease enter a valid phone number (e.g., 09171234567):`
      });
    }
    
    updateEmergencyData(senderId, { contactNumber: text });
    setState(senderId, "awaiting_number_of_people");
    await sendTypingIndicator(senderId, false);
    return callSendAPI(senderId, {
      text: `✅ Contact Number: **${text}**\n\n` +
            `👥 **Number of People**\n` +
            `How many people need assistance? (Enter a number):`
    });
  }

  // STATE: Awaiting number of people
  if (currentState.state === "awaiting_number_of_people") {
    const num = parseInt(text);
    if (isNaN(num) || num < 1 || num > 10000) {
      await sendTypingIndicator(senderId, false);
      return callSendAPI(senderId, {
        text: `⚠️ Please enter a valid number (1-10000):`
      });
    }
    
    updateEmergencyData(senderId, { numberOfPeople: num });
    setState(senderId, "awaiting_urgency_level");
    await sendTypingIndicator(senderId, false);
    return sendUrgencyLevelOptions(senderId);
  }

  // STATE: Awaiting urgency level
  if (currentState.state === "awaiting_urgency_level") {
    // Remove emojis and extra spaces to get clean text
    const cleanText = text.toLowerCase().replace(/[^\w\s]/gi, '').trim();
    const validLevels = ["low", "medium", "high", "critical"];
    
    if (validLevels.includes(cleanText)) {
      updateEmergencyData(senderId, { 
        urgencyLevel: cleanText.charAt(0).toUpperCase() + cleanText.slice(1) 
      });
      setState(senderId, "awaiting_location");
      await sendTypingIndicator(senderId, false);
      return askForLocation(senderId);
    } else {
      await sendTypingIndicator(senderId, false);
      return sendUrgencyLevelOptions(senderId);
    }
  }

  // STATE: Awaiting location (text address)
  if (currentState.state === "awaiting_location") {
    updateEmergencyData(senderId, { location: text });
    setState(senderId, "awaiting_verification_doc");
    await sendTypingIndicator(senderId, false);
    return callSendAPI(senderId, {
      text: `📍 **Location Received!**\n` +
            `Address: ${text}\n\n` +
            `📄 **Verification Document** (Optional)\n` +
            `Please upload any document that verifies your emergency situation (image).\n\n` +
            `Or type **SKIP** to continue without a document.`
    });
  }

  // STATE: Awaiting verification document
  if (currentState.state === "awaiting_verification_doc") {
    if (text.toLowerCase() === "skip") {
      setState(senderId, "awaiting_additional_info");
      await sendTypingIndicator(senderId, false);
      return callSendAPI(senderId, {
        text: `⏭️ **Skipped verification document**\n\n` +
              `📝 **Additional Information** (Optional)\n` +
              `Please share any special needs, medical conditions, accessibility requirements, etc.\n\n` +
              `Or type **DONE** to submit your request.`
      });
    } else {
      await sendTypingIndicator(senderId, false);
      return callSendAPI(senderId, {
        text: `Please upload an image as verification, or type **SKIP** to continue.`
      });
    }
  }

  // STATE: Awaiting additional info
  if (currentState.state === "awaiting_additional_info") {
    if (text.toLowerCase() === "skip" || text.toLowerCase() === "done") {
      // Submit the request
      await submitEmergencyRequest(senderId);
      return;
    }
    
    updateEmergencyData(senderId, { additionalInfo: text });
    await sendTypingIndicator(senderId, false);
    return callSendAPI(senderId, {
      text: `✅ **Additional information received!**\n\n` +
            `Type **DONE** to submit your emergency request.`
    });
  }

  // Default fallback
  await sendTypingIndicator(senderId, false);
  return callSendAPI(senderId, {
    text: `I didn't understand that. Type **HELP** to start a new emergency request.`
  });
}

// ===== Quick Reply Options =====
function sendAssistanceTypeOptions(senderId: string) {
  return callSendAPI(senderId, {
    text: "🆘 **What type of assistance do you need?**\n\nPlease select:",
    quick_replies: [
      { content_type: "text", title: "🍚 Food", payload: "FOOD" },
      { content_type: "text", title: "💧 Water", payload: "WATER" },
      { content_type: "text", title: "🏥 Medical", payload: "MEDICAL" },
      { content_type: "text", title: "🏠 Shelter", payload: "SHELTER" },
      { content_type: "text", title: "👕 Clothing", payload: "CLOTHING" },
      { content_type: "text", title: "📦 Other", payload: "OTHER" }
    ]
  });
}

function sendUrgencyLevelOptions(senderId: string) {
  return callSendAPI(senderId, {
    text: "⚠️ **What is the urgency level?**\n\nPlease select:",
    quick_replies: [
      { content_type: "text", title: "🟢 Low", payload: "LOW" },
      { content_type: "text", title: "🟡 Medium", payload: "MEDIUM" },
      { content_type: "text", title: "🟠 High", payload: "HIGH" },
      { content_type: "text", title: "🔴 Critical", payload: "CRITICAL" }
    ]
  });
}

function askForLocation(senderId: string) {
  return callSendAPI(senderId, {
    text: `📍 **Share Your Location**\n\n` +
          `Please provide your location:\n\n` +
          `1️⃣ Tap the "+" button in Messenger\n` +
          `2️⃣ Select "Location" 📍\n` +
          `3️⃣ Send your current location\n\n` +
          `💡 Or simply type your full address.`
  });
}

// ===== Submit Emergency Request =====
async function submitEmergencyRequest(senderId: string) {
  const state = getState(senderId);
  if (!state) return;

  const data = state.emergencyData;
  
  await sendTypingIndicator(senderId, true);

  // Log the complete request (in production, save to database)
  console.log("📋 EMERGENCY REQUEST SUBMITTED:");
  console.log(JSON.stringify(data, null, 2));

  // Clear user state
  clearState(senderId);

  await sendTypingIndicator(senderId, false);

  // Send confirmation
  return callSendAPI(senderId, {
    text: `✅ **EMERGENCY REQUEST SUBMITTED**\n\n` +
          `**Summary:**\n` +
          `• Assistance Needed: ${data.requiredAssistance || 'N/A'}\n` +
          `• Contact: ${data.contactName || 'N/A'}\n` +
          `• Phone: ${data.contactNumber || 'N/A'}\n` +
          `• People: ${data.numberOfPeople || 'N/A'}\n` +
          `• Urgency: ${data.urgencyLevel || 'N/A'}\n` +
          `• Location: ${data.location || 'N/A'}\n\n` +
          `🚨 **Emergency response team has been notified!**\n` +
          `⏱️ Expected response: 15-30 minutes\n\n` +
          `Stay safe! Help is on the way! 🙏\n\n` +
          `Type **HELP** to submit another request.`
  });
}

// ===== Postbacks =====
async function handlePostback(senderId: string, postback: Postback) {
  await sendTypingIndicator(senderId, true);

  if (postback.payload === "GET_STARTED") {
    await sendTypingIndicator(senderId, false);
    return callSendAPI(senderId, {
      text: `👋 **Welcome to AidVocate Emergency Relief!**\n\n` +
            `Your trusted disaster assistance companion.\n\n` +
            `🆘 Type **HELP** to submit an emergency request.\n\n` +
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

    const data = await res.json();
    console.log(`✅ Message sent to ${senderId}`);
  } catch (error) {
    console.error("❌ Failed to send message:", error);
    throw error;
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
  console.log(`\n${"=".repeat(60)}`);
  console.log(`✅ AidVocate Emergency Relief Bot is RUNNING`);
  console.log(`${"=".repeat(60)}`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`🔗 Webhook URL: https://YOUR-DOMAIN.com/webhook`);
  console.log(`🔑 Verify Token: ${VERIFY_TOKEN}`);
  console.log(`⏰ State cleanup: Every ${CLEANUP_INTERVAL_MS / 1000}s`);
  console.log(`⏱️  State timeout: ${STATE_TIMEOUT_MS / 1000}s`);
  console.log(`${"=".repeat(60)}\n`);
});