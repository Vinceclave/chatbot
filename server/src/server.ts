import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import axios from "axios";
import fs from "fs";
import path from "path";
import "dotenv/config";

const app = express();
app.use(bodyParser.json());

// ===== CONFIGURATION =====
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "aidvocate_bot_verify_token_2025";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

if (!PAGE_ACCESS_TOKEN) {
  console.error("❌ PAGE_ACCESS_TOKEN environment variable is required!");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "3000", 10);

// ===== CREATE REPORTS FOLDER =====
const reportsDir = path.join(process.cwd(), "reports");
if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir);
  console.log("📁 Created reports folder at:", reportsDir);
}

// ===== USER SESSION MANAGEMENT =====
interface PetReport {
  animalType: string;
  animalName: string;
  lastSeenLocation: string;
  imageUrls: string[];
}

interface UserSession {
  pets: PetReport[];
  currentPet: Partial<PetReport>;
  contactNo?: string;
  contactName?: string;
  facebookAccount?: string;
  currentStep: string;
  createdAt: Date;
  isProcessing: boolean; // Prevent duplicate processing
}

const userSessions = new Map<string, UserSession>();

function initializeUserSession(senderId: string): UserSession {
  const session: UserSession = {
    pets: [],
    currentPet: { imageUrls: [] },
    currentStep: "animal_type",
    createdAt: new Date(),
    isProcessing: false,
  };
  userSessions.set(senderId, session);
  console.log("🆕 New session for:", senderId);
  return session;
}

function updateUserSession(senderId: string, updates: Partial<UserSession>) {
  const session = userSessions.get(senderId) || initializeUserSession(senderId);
  const updated = { ...session, ...updates };
  userSessions.set(senderId, updated);
}

function getCurrentPetSummary(pet: Partial<PetReport>): string {
  return `📋 Current pet details:
• Type: ${pet.animalType || "Not set"}
• Name: ${pet.animalName || "Not set"}
• Location: ${pet.lastSeenLocation || "Not set"}
• Photos: ${pet.imageUrls?.length || 0} image(s)`;
}

// ===== MESSAGES =====
const MESSAGES = {
  WELCOME: {
    text: "🐾 Hi there! I'm HanapKa, your missing animal report assistant.\n\nI'll help you create a detailed report that will be posted on our Facebook page to help find your missing pet.\n\nWould you like to start a report?",
    quick_replies: [
      { content_type: "text", title: "✅ Yes, let's start", payload: "REPORT_YES" },
      { content_type: "text", title: "❌ Not now", payload: "REPORT_NO" },
    ],
  },
  START: { text: "📝 Let's begin!\n\nWhat type of animal is missing?\n(Examples: Dog, Cat, Bird, Rabbit, etc.)" },
  ASK_NAME: { text: "🏷️ What's the animal's name?" },
  ASK_OWNER: { text: "👤 What's your name? (Owner/Reporter's name)" },
  ASK_CONTACT: { text: "📱 Please share your contact number so people can reach you if they find your pet.\n\n(Example: 09123456789)" },
  ASK_FACEBOOK: { text: "💬 Do you want to share your Facebook profile?\n\nType your Facebook name/URL, or type 'skip' if you prefer not to share." },
  ASK_LOCATION: { text: "📍 Where was the animal last seen?\n\n(Be as specific as possible: street name, landmarks, barangay, city)" },
  ASK_IMAGE: { 
    text: "📸 Please send photo(s) of your missing animal.\n\n• You can send multiple photos\n• Send them one by one or all at once\n• Type 'done' when you're finished\n• Type 'skip' if you don't have photos" 
  },
  ASK_MORE_PETS: {
    text: "✅ Pet information saved!\n\nDo you have another missing pet to report?",
    quick_replies: [
      { content_type: "text", title: "➕ Add another pet", payload: "ADD_MORE_YES" },
      { content_type: "text", title: "✅ Submit report", payload: "ADD_MORE_NO" },
    ],
  },
  SUBMIT_DONE: {
    text: "✅ Success! Your missing animal report has been submitted and posted to our Facebook page.\n\n🙏 We'll do everything we can to help bring your pet home safely.\n\nThank you for using Aidvocate! 🐾❤️",
  },
  THANKS: { text: "No problem! If you ever need to report a missing animal, just message me anytime. Stay safe! 🐾" },
  CANCEL: { text: "❌ Report cancelled. Your information has been cleared.\n\nFeel free to start over whenever you're ready!" },
};

// ===== SEND MESSAGE =====
async function callSendAPI(senderId: string, message: any) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: senderId },
        message,
        messaging_type: "RESPONSE",
      }
    );
  } catch (err: any) {
    console.error("❌ Failed to send message:", err.response?.data || err.message);
  }
}

// ===== VALIDATION HELPERS =====
function isValidPhoneNumber(phone: string): boolean {
  // Philippine phone number validation (basic)
  const phoneRegex = /^(09|\+639)\d{9}$/;
  return phoneRegex.test(phone.replace(/[\s-]/g, ''));
}

function validateCurrentPet(pet: Partial<PetReport>): boolean {
  return !!(pet.animalType && pet.animalName && pet.lastSeenLocation);
}

// ===== SAVE AND POST REPORT =====
async function saveReportToFile(senderId: string, data: UserSession) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(reportsDir, `${senderId}-${timestamp}.txt`);
  const reportText = JSON.stringify({ senderId, ...data }, null, 2);

  fs.writeFileSync(filePath, reportText);
  console.log("📄 Report saved:", filePath);

  // ===== AUTO POST TO PAGE FEED - ALL PETS IN ONE POST =====
  let postMessage = `🚨 URGENT: MISSING ${data.pets.length > 1 ? 'PETS' : 'PET'} ALERT 🚨

💔 A family is desperately searching for their beloved ${data.pets.length > 1 ? 'companions' : 'companion'}. Please take a moment to read and share!

`;

  // Add each pet's info
  data.pets.forEach((pet, index) => {
    postMessage += `═══════════════════════════\n\n`;
    if (data.pets.length > 1) {
      postMessage += `🐾 MISSING PET #${index + 1}\n\n`;
    }
    postMessage += `• Animal Type: ${pet.animalType.toUpperCase()}\n`;
    postMessage += `• Name: ${pet.animalName}\n`;
    postMessage += `• Last Seen: ${pet.lastSeenLocation}\n`;
    if (pet.imageUrls && pet.imageUrls.length > 0) {
      postMessage += `• Photos: ${pet.imageUrls.length} image(s) attached\n`;
    }
    postMessage += `\n`;
  });

  postMessage += `═══════════════════════════\n\n`;
  postMessage += `📱 CONTACT INFORMATION\n`;
  postMessage += `Owner: ${data.contactName}\n`;
  postMessage += `Phone: ${data.contactNo}\n`;
  if (data.facebookAccount && data.facebookAccount.toLowerCase() !== 'skip') {
    postMessage += `Facebook: ${data.facebookAccount}\n`;
  }
  postMessage += `\n⚠️ Please call or message if you have any information!\n\n`;

  postMessage += `═══════════════════════════\n\n`;
  postMessage += `🙏 HOW YOU CAN HELP:\n\n`;
  postMessage += `1️⃣ SHARE this post to reach more people\n`;
  postMessage += `2️⃣ CHECK your neighborhood, yard, garage\n`;
  postMessage += `3️⃣ CONTACT US immediately if you spot ${data.pets.length > 1 ? 'any of these pets' : 'this pet'}\n`;
  postMessage += `4️⃣ STAY ALERT during your daily routine\n\n`;

  postMessage += `═══════════════════════════\n\n`;
  postMessage += `Every share counts! Help us bring ${data.pets.length > 1 ? 'them' : data.pets[0].animalName} home. 🏠\n`;
  postMessage += `Thank you for your kindness and compassion. ❤️\n\n`;
  postMessage += `#MissingPet #LostPet #HelpFindThem #PetRescue #PetAlert #LostAndFound #Philippines #PH`;

  // Collect all images from all pets
  const allImages: string[] = [];
  data.pets.forEach(pet => {
    if (pet.imageUrls && pet.imageUrls.length > 0) {
      allImages.push(...pet.imageUrls);
    }
  });

  const postUrl = await postToPageFeed(postMessage, allImages);

  // Send the post link back to the user
  if (postUrl) {
    await callSendAPI(senderId, {
      text: `✅ Your report has been posted to our Facebook page!\n\n🔗 View and share here:\n${postUrl}\n\n📢 Please share this post with your friends and community. The more people who see it, the better the chance of finding ${data.pets.length > 1 ? 'your pets' : 'your pet'}! 🙏`
    });
  }
}

// ===== HANDLE QUICK REPLIES =====
async function handleQuickReply(senderId: string, payload: string) {
  const session = userSessions.get(senderId);

  // Prevent duplicate processing
  if (session?.isProcessing) {
    console.log("⚠️ Already processing for:", senderId);
    return;
  }

  if (payload === "REPORT_YES") {
    initializeUserSession(senderId);
    await callSendAPI(senderId, MESSAGES.START);
  } else if (payload === "REPORT_NO") {
    await callSendAPI(senderId, MESSAGES.THANKS);
    userSessions.delete(senderId);
  } else if (payload === "ADD_MORE_YES") {
    if (session) {
      // Save current pet to array before starting new one
      if (validateCurrentPet(session.currentPet)) {
        session.pets.push(session.currentPet as PetReport);
      }
      
      // Reset for new pet
      updateUserSession(senderId, {
        currentPet: { imageUrls: [] },
        currentStep: "animal_type",
        pets: session.pets,
      });
      await callSendAPI(senderId, { text: `📝 Adding pet #${session.pets.length + 1}...\n\n${MESSAGES.START.text}` });
    }
  } else if (payload === "ADD_MORE_NO") {
    if (session && !session.isProcessing) {
      // Set processing flag
      updateUserSession(senderId, { isProcessing: true });
      
      // Save current pet if valid and not already in array
      if (validateCurrentPet(session.currentPet)) {
        const isDuplicate = session.pets.some(
          p => p.animalName === session.currentPet.animalName && 
               p.animalType === session.currentPet.animalType
        );
        
        if (!isDuplicate) {
          session.pets.push(session.currentPet as PetReport);
        }
      }
      
      // Final validation
      if (session.pets.length === 0) {
        await callSendAPI(senderId, { text: "❌ No valid pet information to submit. Please start over." });
        userSessions.delete(senderId);
        return;
      }
      
      // Save and post
      await saveReportToFile(senderId, session);
      await callSendAPI(senderId, MESSAGES.SUBMIT_DONE);
      
      // Clean up session
      userSessions.delete(senderId);
    }
  }
}

// ===== HANDLE USER INPUT FLOW =====
async function handleUserMessage(senderId: string, text: string) {
  const session = userSessions.get(senderId);
  if (!session) return;

  const normalizedText = text.trim();
  
  // Handle cancel command
  if (normalizedText.toLowerCase() === 'cancel') {
    await callSendAPI(senderId, MESSAGES.CANCEL);
    userSessions.delete(senderId);
    return;
  }

  switch (session.currentStep) {
    case "animal_type":
      if (normalizedText.length < 2) {
        await callSendAPI(senderId, { text: "⚠️ Please enter a valid animal type (e.g., Dog, Cat, Bird)" });
        return;
      }
      session.currentPet.animalType = normalizedText;
      updateUserSession(senderId, { currentStep: "animal_name" });
      await callSendAPI(senderId, MESSAGES.ASK_NAME);
      break;

    case "animal_name":
      if (normalizedText.length < 1) {
        await callSendAPI(senderId, { text: "⚠️ Please enter the animal's name" });
        return;
      }
      session.currentPet.animalName = normalizedText;
      
      // Only ask for owner info if this is the first pet
      if (session.pets.length === 0 && !session.contactName) {
        updateUserSession(senderId, { currentStep: "owner_name" });
        await callSendAPI(senderId, MESSAGES.ASK_OWNER);
      } else {
        // Skip to location for additional pets
        updateUserSession(senderId, { currentStep: "last_seen" });
        await callSendAPI(senderId, MESSAGES.ASK_LOCATION);
      }
      break;

    case "owner_name":
      if (normalizedText.length < 2) {
        await callSendAPI(senderId, { text: "⚠️ Please enter a valid name" });
        return;
      }
      updateUserSession(senderId, { contactName: normalizedText, currentStep: "contact_no" });
      await callSendAPI(senderId, MESSAGES.ASK_CONTACT);
      break;

    case "contact_no":
      const cleanPhone = normalizedText.replace(/[\s-]/g, '');
      if (cleanPhone.length < 10) {
        await callSendAPI(senderId, { text: "⚠️ Please enter a valid phone number (e.g., 09123456789)" });
        return;
      }
      updateUserSession(senderId, { contactNo: normalizedText, currentStep: "facebook_account" });
      await callSendAPI(senderId, MESSAGES.ASK_FACEBOOK);
      break;

    case "facebook_account":
      updateUserSession(senderId, { 
        facebookAccount: normalizedText.toLowerCase() === 'skip' ? undefined : normalizedText, 
        currentStep: "last_seen" 
      });
      await callSendAPI(senderId, MESSAGES.ASK_LOCATION);
      break;

    case "last_seen":
      if (normalizedText.length < 5) {
        await callSendAPI(senderId, { text: "⚠️ Please provide more details about the location (street, landmarks, barangay, city)" });
        return;
      }
      session.currentPet.lastSeenLocation = normalizedText;
      updateUserSession(senderId, { currentStep: "image" });
      await callSendAPI(senderId, MESSAGES.ASK_IMAGE);
      break;

    case "image":
      if (normalizedText.toLowerCase() === "done") {
        // Validate before moving to next step
        if (!validateCurrentPet(session.currentPet)) {
          await callSendAPI(senderId, { 
            text: "❌ Missing required information. Please complete all fields before proceeding." 
          });
          return;
        }
        
        // Show summary and ask if they want to add more pets
        const summary = getCurrentPetSummary(session.currentPet);
        await callSendAPI(senderId, { text: summary });
        
        updateUserSession(senderId, { currentStep: "ask_more" });
        await callSendAPI(senderId, MESSAGES.ASK_MORE_PETS);
        
      } else if (normalizedText.toLowerCase() === "skip") {
        // Allow skipping photos
        if (!validateCurrentPet(session.currentPet)) {
          await callSendAPI(senderId, { 
            text: "❌ Missing required information. Please complete all fields." 
          });
          return;
        }
        
        const summary = getCurrentPetSummary(session.currentPet);
        await callSendAPI(senderId, { text: summary });
        
        updateUserSession(senderId, { currentStep: "ask_more" });
        await callSendAPI(senderId, MESSAGES.ASK_MORE_PETS);
        
      } else {
        // Treat text as image URL (for cases where users paste URLs)
        const urlPattern = /^https?:\/\/.+/i;
        if (urlPattern.test(normalizedText)) {
          if (!session.currentPet.imageUrls) {
            session.currentPet.imageUrls = [];
          }
          session.currentPet.imageUrls.push(normalizedText);
          await callSendAPI(senderId, { 
            text: `✅ Photo link added! (${session.currentPet.imageUrls.length} photo(s) total)\n\nSend more photos or type 'done' to continue.` 
          });
        } else {
          await callSendAPI(senderId, { 
            text: "⚠️ Please send an image file, paste an image URL, or type 'done' to continue." 
          });
        }
      }
      break;

    default:
      await callSendAPI(senderId, { text: "⚠️ Something went wrong. Please type 'cancel' to restart." });
  }
}

// ===== HANDLE ATTACHMENTS (IMAGE) =====
async function handleAttachment(senderId: string, attachments: any[]) {
  const session = userSessions.get(senderId);
  if (!session || session.currentStep !== "image") {
    await callSendAPI(senderId, { text: "⚠️ Please wait for the bot to ask for photos before sending them." });
    return;
  }

  const images = attachments.filter((a) => a.type === "image");
  
  if (images.length > 0) {
    if (!session.currentPet.imageUrls) {
      session.currentPet.imageUrls = [];
    }
    
    images.forEach((img) => {
      if (img.payload?.url) {
        session.currentPet.imageUrls!.push(img.payload.url);
      }
    });
    
    updateUserSession(senderId, session);
    await callSendAPI(senderId, { 
      text: `✅ ${images.length} photo(s) received! (${session.currentPet.imageUrls.length} total)\n\nYou can send more photos or type 'done' to continue.` 
    });
  } else {
    await callSendAPI(senderId, { text: "⚠️ Please send image files only." });
  }
}

// ===== POST TO PAGE FEED =====
async function postToPageFeed(message: string, imageUrls?: string[]): Promise<string | null> {
  try {
    let attached_media = undefined;

    if (imageUrls && imageUrls.length > 0) {
      // Limit to 10 images (Facebook's limit)
      const limitedUrls = imageUrls.slice(0, 10);
      
      // Upload all images
      const uploadPromises = limitedUrls.map(async (url) => {
        try {
          const photoRes = await axios.post(
            `https://graph.facebook.com/v21.0/me/photos`,
            {
              url: url,
              published: false,
              access_token: PAGE_ACCESS_TOKEN,
            }
          );
          return { media_fbid: photoRes.data.id };
        } catch (err) {
          console.error("❌ Failed to upload image:", url);
          return null;
        }
      });

      const results = await Promise.all(uploadPromises);
      attached_media = results.filter(r => r !== null);
    }

    // Create feed post with message + photos
    const postRes = await axios.post(
      `https://graph.facebook.com/v21.0/me/feed`,
      {
        message,
        attached_media: attached_media && attached_media.length > 0 ? attached_media : undefined,
        access_token: PAGE_ACCESS_TOKEN,
      }
    );

    const postId = postRes.data.id;
    console.log("✅ Posted to page feed:", postId);
    
    // Return the Facebook post URL
    return `https://www.facebook.com/${postId}`;
  } catch (err: any) {
    console.error("❌ Failed to post to page feed:", err.response?.data || err.message);
    return null;
  }
}

// ===== WEBHOOK VERIFY =====
app.get("/webhook", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  console.log("❌ Webhook verification failed");
  return res.sendStatus(403);
});

// ===== WEBHOOK RECEIVE =====
app.post("/webhook", async (req: Request, res: Response) => {
  const body = req.body;
  
  if (body.object === "page") {
    // Respond immediately to Facebook
    res.status(200).send("EVENT_RECEIVED");
    
    // Process events asynchronously
    for (const entry of body.entry) {
      for (const event of entry.messaging) {
        const senderId = event.sender?.id;
        if (!senderId) continue;

        // Handle postback (Get Started button)
        if (event.postback?.payload === "GET_STARTED") {
          await callSendAPI(senderId, MESSAGES.WELCOME);
          continue;
        }

        // Handle quick reply
        if (event.message?.quick_reply) {
          await handleQuickReply(senderId, event.message.quick_reply.payload);
          continue;
        }

        // Handle attachments
        if (event.message?.attachments) {
          await handleAttachment(senderId, event.message.attachments);
          continue;
        }

        // Handle text message
        if (event.message?.text) {
          const session = userSessions.get(senderId);
          if (session) {
            await handleUserMessage(senderId, event.message.text);
          } else {
            await callSendAPI(senderId, MESSAGES.WELCOME);
          }
        }
      }
    }
  } else {
    res.sendStatus(404);
  }
});

// ===== SET GET STARTED BUTTON =====
async function setGetStartedButton() {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/me/messenger_profile?access_token=${PAGE_ACCESS_TOKEN}`,
      { 
        get_started: { payload: "GET_STARTED" },
        greeting: [
          {
            locale: "default",
            text: "🐾 Welcome to Aidvocate! I'll help you report missing animals and spread the word to help bring them home safely."
          }
        ]
      }
    );
    console.log("✅ Get Started button and greeting configured");
  } catch (err: any) {
    console.error("❌ Failed to set Get Started button:", err.response?.data || err.message);
  }
}

// ===== HEALTH CHECK =====
app.get("/", (_req, res) => res.json({ 
  status: "ok", 
  service: "Aidvocate - Missing Animal Bot",
  activeUsers: userSessions.size 
}));

// ===== SESSION CLEANUP (every hour) =====
setInterval(() => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  let cleaned = 0;
  
  for (const [senderId, session] of userSessions.entries()) {
    if (session.createdAt < oneHourAgo) {
      userSessions.delete(senderId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} stale session(s)`);
  }
}, 60 * 60 * 1000);

// ===== START SERVER =====
app.listen(PORT, async () => {
  console.log("=".repeat(60));
  console.log(`🚀 Aidvocate Missing Animal Bot v2.0`);
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`🔗 Webhook endpoint: /webhook`);
  console.log(`📁 Reports folder: ${reportsDir}`);
  console.log("=".repeat(60));
  await setGetStartedButton();
});