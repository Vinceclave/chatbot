import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import 'dotenv/config';

const app = express();
app.use(bodyParser.json());

// ===== CONFIGURATION =====
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "aidvocate_bot_verify_token_2025";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

if (!PAGE_ACCESS_TOKEN) {
  console.error("❌ PAGE_ACCESS_TOKEN environment variable is required!");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "3000");

// ===== USER SESSION MANAGEMENT =====
interface UserSession {
  placename?: string;
  contactno?: string;
  needs: string[];
  numberOfPeople?: number;
  urgencyLevel?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  additionalNotes?: string;
  status: "pending" | "in-progress" | "responded";
  createdAt: Date;
  updatedAt: Date;
  isVerified: boolean;
  imageVerification?: string;
  currentStep: string;
}

const userSessions = new Map<string, UserSession>();

function initializeUserSession(senderId: string): UserSession {
  const session: UserSession = {
    needs: [],
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
    isVerified: false,
    currentStep: "location"
  };
  userSessions.set(senderId, session);
  console.log('🆕 New session initialized for:', senderId, session);
  return session;
}

function updateUserSession(senderId: string, updates: Partial<UserSession>) {
  const session = userSessions.get(senderId) || initializeUserSession(senderId);
  const updated = { ...session, ...updates, updatedAt: new Date() };
  userSessions.set(senderId, updated);
  console.log('🔄 Session updated for:', senderId, updated);
}

// ===== HEALTH CHECK =====
app.get('/', (_req, res) => {
  res.json({ status: "ok", service: "Aidvocate Calamity Response Bot" });
});

// ===== WEBHOOK VERIFICATION =====
app.get('/webhook', (req: Request<{}, {}, {}, any>, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===== FACEBOOK MESSAGE TYPES =====
interface FBQuickReply {
  content_type: 'text';
  title: string;
  payload: string;
}

interface FBMessage {
  text: string;
  quick_replies?: readonly FBQuickReply[];
}

// ===== HUMANIZED MESSAGES =====
const MESSAGES = {
  WELCOME: {
    text: "Hi there! I’m Aidvocate, here to help you during emergencies. Are you currently in a situation where you need assistance?",
    quick_replies: [
      { content_type: "text", title: "Yes, I need help", payload: "HELP_YES" } as const,
      { content_type: "text", title: "No, I’m safe", payload: "HELP_NO" } as const
    ] as const
  },
  HELP_YES: {
    text: "Thank you for letting me know. I’m here to assist you step by step. Can we start with your current location or the place you’re at?"
  },
  HELP_NO: {
    text: "I’m glad you’re safe! Remember, I’m always here if you ever need help. Just type 'help' anytime."
  },
  CONTACT_PROMPT: {
    text: "Could you please share a contact number? This will help our team reach you quickly if needed."
  },
  URGENCY_LEVEL: {
    text: "How urgent is your situation? This helps us prioritize assistance for you.",
    quick_replies: [
      { content_type: "text", title: "LOW – Non-urgent help", payload: "URGENCY_LOW" } as const,
      { content_type: "text", title: "MEDIUM – Need help soon", payload: "URGENCY_MEDIUM" } as const,
      { content_type: "text", title: "HIGH – Immediate help needed", payload: "URGENCY_HIGH" } as const,
      { content_type: "text", title: "CRITICAL – Life threatening", payload: "URGENCY_CRITICAL" } as const
    ] as const
  },
  PEOPLE_COUNT: {
    text: "How many people are with you that need assistance? No worries if it’s just you."
  },
  NEEDS_PROMPT: {
    text: "What type of help do you need? You can list as many as necessary. Examples: Food, Water, Medical, Shelter, Rescue, First Aid, Clothing, Other."
  },
  ADDITIONAL_NOTES: {
    text: "Any additional information you’d like to share? It helps us respond more effectively."
  },
  IMAGE_VERIFICATION: {
    text: "If possible, please send a photo of your current situation. This helps us prioritize and respond faster."
  },
  SUBMISSION_COMPLETE: {
    text: "Thank you! Your report has been submitted. Our team will review it and reach out to you soon. Please stay safe!"
  }
} as const;

// ===== SEND MESSAGE =====
async function callSendAPI(senderId: string, message: FBMessage) {
  try {
    console.log('💬 Sending message to', senderId, message);
    await axios.post(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: senderId }, message, messaging_type: "RESPONSE" }
    );
    console.log('✅ Message successfully sent to', senderId);
  } catch (err: any) {
    console.error('❌ Failed to send message:', err.response?.data || err.message);
  }
}

// ===== SEND EMERGENCY PROMPT =====
async function sendEmergencyPrompt(senderId: string) {
  console.log('🚨 Sending emergency prompt to:', senderId);
  await callSendAPI(senderId, MESSAGES.WELCOME);
}

// ===== HANDLE INFORMATION COLLECTION =====
async function handleInformationCollection(senderId: string, text: string) {
  const session = userSessions.get(senderId);
  if (!session) return;

  console.log('✏️ Handling input for step:', session.currentStep, 'Text:', text);

  switch (session.currentStep) {
    case "location":
      updateUserSession(senderId, { placename: text, currentStep: "contact" });
      await callSendAPI(senderId, MESSAGES.CONTACT_PROMPT);
      break;

    case "contact":
      updateUserSession(senderId, { contactno: text, currentStep: "urgency" });
      await callSendAPI(senderId, MESSAGES.URGENCY_LEVEL);
      break;

    case "urgency":
      break;

    case "people":
      const peopleCount = parseInt(text);
      if (!isNaN(peopleCount) && peopleCount > 0) {
        updateUserSession(senderId, { numberOfPeople: peopleCount, currentStep: "needs" });
        await callSendAPI(senderId, MESSAGES.NEEDS_PROMPT);
      } else {
        await callSendAPI(senderId, { text: "Please enter a valid number of people." });
      }
      break;

    case "needs":
      const needs = text.split(',').map(need => need.trim()).filter(need => need.length > 0);
      updateUserSession(senderId, { needs, currentStep: "notes" });
      await callSendAPI(senderId, MESSAGES.ADDITIONAL_NOTES);
      break;

    case "notes":
      updateUserSession(senderId, { additionalNotes: text, currentStep: "image" });
      await callSendAPI(senderId, MESSAGES.IMAGE_VERIFICATION);
      break;

    case "image":
      updateUserSession(senderId, { 
        imageVerification: text, 
        status: "pending",
        isVerified: false,
        currentStep: "complete"
      });
      await callSendAPI(senderId, MESSAGES.SUBMISSION_COMPLETE);

      const finalSession = userSessions.get(senderId);
      console.log('📋 Emergency Report Submitted:', { senderId, ...finalSession });
      break;
  }
}

// ===== HANDLE POSTBACKS =====
async function handlePostback(senderId: string, payload: string) {
  console.log("📩 Postback received:", payload, "from", senderId);
  if (payload === 'GET_STARTED') {
    return sendEmergencyPrompt(senderId);
  }
}

// ===== HANDLE QUICK REPLIES =====
async function handleQuickReply(senderId: string, payload: string) {
  console.log("⚡ Quick reply received:", payload, "from", senderId);

  const session = userSessions.get(senderId);

  if (payload === "HELP_YES") {
    initializeUserSession(senderId);
    await callSendAPI(senderId, MESSAGES.HELP_YES);
  } 
  else if (payload === "HELP_NO") {
    await callSendAPI(senderId, MESSAGES.HELP_NO);
  }
  else if (payload.startsWith("URGENCY_")) {
    const urgencyLevel = payload.replace("URGENCY_", "") as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    updateUserSession(senderId, { urgencyLevel, currentStep: "people" });
    await callSendAPI(senderId, MESSAGES.PEOPLE_COUNT);
  }
}

// ===== WEBHOOK POST (MESSAGES & POSTBACKS) =====
app.post('/webhook', async (req: Request, res: Response) => {
  const body = req.body;
  console.log('📥 Incoming webhook event:', JSON.stringify(body, null, 2));

  if (body.object === 'page') {
    await Promise.all(body.entry.map(async (entry: any) => {
      if (!entry.messaging) return;

      await Promise.all(entry.messaging.map(async (event: any) => {
        const senderId = event.sender?.id;
        if (!senderId) return;

        if (event.postback?.payload) return handlePostback(senderId, event.postback.payload);
        if (event.message?.quick_reply?.payload) return handleQuickReply(senderId, event.message.quick_reply.payload);
        if (event.message?.text && !event.message.quick_reply) {
          const session = userSessions.get(senderId);
          if (session && session.currentStep !== "complete") return handleInformationCollection(senderId, event.message.text);
          return sendEmergencyPrompt(senderId);
        }
        if (event.message?.attachments) {
          const imageAttachment = event.message.attachments.find((att: any) => att.type === 'image');
          const session = userSessions.get(senderId);
          if (imageAttachment && session && session.currentStep === "image") {
            updateUserSession(senderId, { 
              imageVerification: imageAttachment.payload.url,
              currentStep: "complete"
            });
            await callSendAPI(senderId, MESSAGES.SUBMISSION_COMPLETE);
            console.log('📷 Image verification received for:', senderId, imageAttachment.payload.url);
          }
        }
      }));
    }));

    return res.status(200).send("EVENT_RECEIVED");
  }

  return res.sendStatus(404);
});

// ===== SET GET STARTED BUTTON =====
async function setGetStartedButton() {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/me/messenger_profile?access_token=${PAGE_ACCESS_TOKEN}`,
      { get_started: { payload: "GET_STARTED" } }
    );
    console.log("✅ Get Started button configured");
  } catch (err: any) {
    console.error("❌ Failed to set Get Started button:", err.response?.data || err.message);
  }
}

// ===== GET USER SESSIONS ENDPOINT =====
app.get('/sessions', (_req: Request, res: Response) => {
  const sessions = Object.fromEntries(userSessions);
  console.log('📊 Sessions requested:', sessions);
  res.json(sessions);
});

// ===== START SERVER =====
app.listen(PORT, async () => {
  console.log('='.repeat(50));
  console.log(`🚀 Aidvocate Emergency Bot active on port ${PORT}`);
  console.log(`🌐 Webhook endpoint ready at: /webhook`);
  console.log(`🔐 Verify Token: ${VERIFY_TOKEN}`);
  console.log('='.repeat(50));

  await setGetStartedButton();
});
