import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';

const app = express();
app.use(bodyParser.json());

// Configuration - CHANGE THESE!
const VERIFY_TOKEN: string = "my_super_secret_verify_token_12345"; // Choose any random string
const PAGE_ACCESS_TOKEN: string = "YOUR_PAGE_ACCESS_TOKEN_HERE"; // You'll get this from Facebook later
const PORT: number = parseInt(process.env.PORT || "3000");

// Types
interface WebhookQuery {
  'hub.mode'?: string;
  'hub.verify_token'?: string;
  'hub.challenge'?: string;
}

interface Message {
  text?: string;
  attachments?: any[];
}

interface Postback {
  payload: string;
  title?: string;
}

interface MessagingEvent {
  sender: {
    id: string;
  };
  recipient: {
    id: string;
  };
  timestamp: number;
  message?: Message;
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
  attachment?: any;
}

interface SendAPIBody {
  recipient: {
    id: string;
  };
  message: MessageResponse;
  messaging_type?: string;
}

// Root endpoint
app.get('/', (req: Request, res: Response) => {
  res.send('Messenger Bot is running! ✅');
});

// Webhook verification endpoint (GET)
app.get('/webhook', (req: Request<{}, {}, {}, WebhookQuery>, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode && token === VERIFY_TOKEN) {
    console.log('✅ WEBHOOK_VERIFIED');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Verification failed');
    res.sendStatus(403);
  }
});

// Webhook endpoint to receive messages (POST)
app.post('/webhook', (req: Request<{}, {}, WebhookBody>, res: Response) => {
  const body = req.body;
  
  if (body.object === 'page') {
    body.entry.forEach((entry: WebhookEntry) => {
      const webhookEvent = entry.messaging[0];
      console.log('📩 Received webhook event:', webhookEvent);
      
      const senderPsid = webhookEvent.sender.id;
      
      // Handle messages
      if (webhookEvent.message) {
        handleMessage(senderPsid, webhookEvent.message);
      }
      
      // Handle postbacks (button clicks)
      if (webhookEvent.postback) {
        handlePostback(senderPsid, webhookEvent.postback);
      }
    });
    
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// Handle incoming messages
function handleMessage(senderPsid: string, receivedMessage: Message): void {
  let response: MessageResponse;
  
  // Check if message contains text
  if (receivedMessage.text) {
    const userMessage = receivedMessage.text.toLowerCase();
    
    // Simple keyword-based responses
    if (userMessage.includes('hello') || userMessage.includes('hi') || userMessage.includes('hey')) {
      response = {
        text: `Hello! 👋 Welcome to my bot. How can I help you today?`
      };
    } else if (userMessage.includes('help')) {
      response = {
        text: `I'm here to help! 🤖\n\nYou can:\n• Say "hello" to greet me\n• Ask for "menu"\n• Send any message and I'll respond!`
      };
    } else if (userMessage.includes('menu')) {
      response = {
        text: `📋 Here's what I can do:\n\n1️⃣ Answer your questions\n2️⃣ Provide information\n3️⃣ Chat with you!\n\nJust type your message and I'll respond.`
      };
    } else if (userMessage.includes('thanks') || userMessage.includes('thank you')) {
      response = {
        text: `You're welcome! 😊 Is there anything else I can help you with?`
      };
    } else if (userMessage.includes('bye') || userMessage.includes('goodbye')) {
      response = {
        text: `Goodbye! 👋 Feel free to message me anytime!`
      };
    } else {
      response = {
        text: `You said: "${receivedMessage.text}"\n\n🤖 I'm a simple bot, but I'm learning! Try saying "help" to see what I can do.`
      };
    }
  } else if (receivedMessage.attachments) {
    // Handle attachments (images, files, etc.)
    response = {
      text: `Thanks for sending that! 📎 I received your attachment.`
    };
  } else {
    response = {
      text: `I received your message, but I'm not sure how to respond. Try typing "help"!`
    };
  }
  
  // Send the response message
  callSendAPI(senderPsid, response);
}

// Handle postbacks (when user clicks buttons)
function handlePostback(senderPsid: string, receivedPostback: Postback): void {
  let response: MessageResponse;
  const payload = receivedPostback.payload;
  
  if (payload === 'GET_STARTED') {
    response = {
      text: `Welcome! 🎉 Thanks for messaging us. How can I help you today?`
    };
  } else if (payload === 'HELP') {
    response = {
      text: `I'm here to help! What do you need assistance with?`
    };
  } else if (payload === 'MENU') {
    response = {
      text: `Here's the menu:\n\n1. Option 1\n2. Option 2\n3. Option 3\n\nWhat would you like?`
    };
  } else {
    response = {
      text: `You clicked: ${payload}`
    };
  }
  
  callSendAPI(senderPsid, response);
}

// Send message to Facebook Messenger API
async function callSendAPI(senderPsid: string, response: MessageResponse): Promise<void> {
  const requestBody: SendAPIBody = {
    recipient: {
      id: senderPsid
    },
    message: response,
    messaging_type: 'RESPONSE'
  };
  
  try {
    const apiResponse = await fetch(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      }
    );
    
    if (!apiResponse.ok) {
      const error = await apiResponse.json();
      console.error('❌ Error sending message:', error);
    } else {
      console.log('✅ Message sent successfully!');
    }
  } catch (error) {
    console.error('❌ Unable to send message:', error);
  }
}

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`📍 Webhook URL: https://your-app-name.onrender.com/webhook`);
});