// server.js - Enhanced Telegram Bot with MongoDB
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id)) : [];
const CHANNEL_LINK = process.env.CHANNEL_LINK || 'https://t.me/yourchannel';
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || '@yourchannel';
const GROUP_LINK = process.env.GROUP_LINK || 'https://t.me/yourgroup';
const GROUP_USERNAME = process.env.GROUP_USERNAME || '@yourgroup';
const PORT = process.env.PORT || 3000;

// Initialize bot and express
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();

// MongoDB Connection
mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('✅ Connected to MongoDB');
}).catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
});

// MongoDB Schemas
const userSchema = new mongoose.Schema({
    telegramId: { type: Number, required: true, unique: true },
    username: String,
    nickname: { type: String, required: true },
    gender: { type: String, enum: ['male', 'female'], required: true },
    joinDate: { type: Date, default: Date.now },
    lastActive: { type: Date, default: Date.now },
    safeMode: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    reportCount: { type: Number, default: 0 },
    isPremium: { type: Boolean, default: false },
    premiumExpire: Date,
    premiumHistory: [{
        amount: Number,
        days: Number,
        purchaseDate: Date,
        expiryDate: Date,
        transactionId: String
    }],
    hasJoinedChannel: { type: Boolean, default: false },
    hasJoinedGroup: { type: Boolean, default: false },
    badWordCount: { type: Number, default: 0 },
    linkSpamCount: { type: Number, default: 0 },
    repeatSpamCount: { type: Number, default: 0 },
    floodMessages: { type: Array, default: [] },
    banExpiry: Date,
    banReason: String,
    warnings: { type: Array, default: [] },
    lastMessages: { type: Array, default: [] },
    sensitiveInfo: { type: Array, default: [] },
    totalChatsCompleted: { type: Number, default: 0 }
});

const reportSchema = new mongoose.Schema({
    reportedUserId: { type: Number, required: true },
    reporterUserId: { type: Number, required: true },
    reason: String,
    date: { type: Date, default: Date.now },
    resolved: { type: Boolean, default: false }
});

const chatSessionSchema = new mongoose.Schema({
    user1Id: Number,
    user2Id: Number,
    startTime: { type: Date, default: Date.now },
    endTime: Date,
    messageCount: { type: Number, default: 0 },
    messages: [{
        senderId: Number,
        content: String,
        timestamp: Date,
        type: String
    }]
});

const User = mongoose.model('User', userSchema);
const Report = mongoose.model('Report', reportSchema);
const ChatSession = mongoose.model('ChatSession', chatSessionSchema);

// In-memory storage
const activeChats = new Map();
const waitingQueue = new Map();
const userStates = new Map();
const userChatHistory = new Map();

// Stats tracking
const stats = {
    dailyActiveUsers: new Set()
};

// Bad words filter
const badWords = ['spam', 'scam', 'porn', 'xxx', 'sex', 'nude', 'drugs', 'fuck', 'shit', 'bitch', 'asshole', 'dick', 'pussy', 'nigger', 'faggot'];
const badNicknames = ['admin', 'bot', 'official', 'telegram', 'support', ...badWords];
const linkRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|(@[a-zA-Z0-9_]+)|(t\.me\/[^\s]+)/gi;

// Helper functions
function containsBadWords(text) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    return badWords.some(word => lowerText.includes(word));
}

function containsLinks(text) {
    if (!text) return false;
    return linkRegex.test(text);
}

function isValidNickname(nickname) {
    if (!nickname || nickname.length < 2 || nickname.length > 20) return false;
    const lowerNick = nickname.toLowerCase();
    return !badNicknames.some(bad => lowerNick.includes(bad));
}

function maskBadWords(text) {
    let maskedText = text;
    badWords.forEach(word => {
        const regex = new RegExp(word, 'gi');
        maskedText = maskedText.replace(regex, '*'.repeat(word.length));
    });
    return maskedText;
}

function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

async function getUser(userId, username = null) {
    try {
        let user = await User.findOne({ telegramId: userId });
        if (user) {
            user.lastActive = new Date();
            if (username && user.username !== username) {
                user.username = username;
            }
            await user.save();
            stats.dailyActiveUsers.add(userId);
        }
        return user;
    } catch (error) {
        console.error('Error fetching user:', error);
        return null;
    }
}

async function checkPremiumStatus(user) {
    if (user.isPremium && user.premiumExpire) {
        if (new Date() > user.premiumExpire) {
            user.isPremium = false;
            await user.save();
            return false;
        }
        return true;
    }
    return false;
}

async function checkMembership(userId) {
    try {
        const channelMember = await bot.getChatMember(CHANNEL_USERNAME, userId);
        const isChannelMember = ['member', 'administrator', 'creator'].includes(channelMember.status);

        const groupMember = await bot.getChatMember(GROUP_USERNAME, userId);
        const isGroupMember = ['member', 'administrator', 'creator'].includes(groupMember.status);

        return { channel: isChannelMember, group: isGroupMember };
    } catch (error) {
        console.error('Error checking membership:', error);
        return { channel: false, group: false };
    }
}

async function startRegistration(chatId, userId) {
    const membership = await checkMembership(userId);
    
    if (!membership.channel || !membership.group) {
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '📢 Join Channel', url: CHANNEL_LINK },
                    { text: '💬 Join Group', url: GROUP_LINK }
                ],
                [
                    { text: '✅ I Joined Both', callback_data: 'verify_membership' }
                ]
            ]
        };

        bot.sendMessage(chatId, 
            `👋 Welcome to RandomBuddyBot!\n\n` +
            `⚠️ To use this bot, you must:\n` +
            `1️⃣ Join our Channel\n` +
            `2️⃣ Join our Group\n\n` +
            `After joining both, click "✅ I Joined Both"`,
            { reply_markup: keyboard }
        );
        return false;
    }
    
    return true;
}

async function askGender(chatId, userId) {
    userStates.set(userId, 'awaiting_gender');
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: '👨 Male', callback_data: 'gender_male' },
                { text: '👩 Female', callback_data: 'gender_female' }
            ]
        ]
    };

    await bot.sendMessage(chatId, 
        `🎭 Please select your gender:\n\n` +
        `⚠️ Note: Gender cannot be changed later!`,
        { reply_markup: keyboard }
    );
}

async function askNickname(chatId, userId, gender) {
    userStates.set(userId, `awaiting_nickname:${gender}`);
    
    await bot.sendMessage(chatId, 
        `✏️ Please enter your nickname:\n\n` +
        `Rules:\n` +
        `• 2-20 characters\n` +
        `• No offensive words\n` +
        `• Be respectful\n\n` +
        `Example: Alex, Sarah, Mike`
    );
}

async function completeRegistration(userId, gender, nickname) {
    try {
        const existingUser = await User.findOne({ telegramId: userId });
        if (existingUser) {
            existingUser.nickname = nickname;
            existingUser.gender = gender;
            existingUser.hasJoinedChannel = true;
            existingUser.hasJoinedGroup = true;
            await existingUser.save();
            userStates.delete(userId);
            return true;
        }
        
        const user = new User({
            telegramId: userId,
            nickname: nickname,
            gender: gender,
            hasJoinedChannel: true,
            hasJoinedGroup: true
        });
        
        await user.save();
        userStates.delete(userId);
        return true;
    } catch (error) {
        console.error('Error completing registration:', error);
        return false;
    }
}

async function findPartner(userId, preferredGender = null) {
    waitingQueue.delete(userId);
    
    const user = await getUser(userId);
    if (!user) return null;

    const isPremium = await checkPremiumStatus(user);
    
    if (isPremium && preferredGender) {
        for (const [partnerId] of waitingQueue) {
            if (partnerId !== userId) {
                const partner = await getUser(partnerId);
                if (partner && partner.gender === preferredGender) {
                    waitingQueue.delete(partnerId);
                    return partnerId;
                }
            }
        }
    } else {
        for (const [partnerId] of waitingQueue) {
            if (partnerId !== userId) {
                waitingQueue.delete(partnerId);
                return partnerId;
            }
        }
    }
    
    waitingQueue.set(userId, { 
        gender: preferredGender || 'any', 
        timestamp: Date.now(),
        isPremium: isPremium 
    });
    
    return null;
}

async function startChat(user1Id, user2Id) {
    activeChats.set(user1Id, user2Id);
    activeChats.set(user2Id, user1Id);
    waitingQueue.delete(user1Id);
    waitingQueue.delete(user2Id);

    const session = new ChatSession({
        user1Id: user1Id,
        user2Id: user2Id
    });
    await session.save();

    const user1 = await getUser(user1Id);
    const user2 = await getUser(user2Id);

    const connectMessage = '💬 Connected! You can now chat anonymously.\n\n' +
        '🎁 Send a Telegram Gift to reveal usernames!\n' +
        '🔚 Use /stop to end chat';

    const buttons = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🎁 Send Gift", callback_data: "send_gift" },
                    { text: "🚫 Report", callback_data: "report_partner" }
                ]
            ]
        }
    };

    const user1Badge = user1.isPremium ? ' ⭐' : '';
    const user2Badge = user2.isPremium ? ' ⭐' : '';

    bot.sendMessage(user1Id, `${connectMessage}\n\n👤 Partner: ${user2.nickname}${user2Badge}`, buttons);
    bot.sendMessage(user2Id, `${connectMessage}\n\n👤 Partner: ${user1.nickname}${user1Badge}`, buttons);
}

function endChat(userId) {
    const partnerId = activeChats.get(userId);
    if (partnerId) {
        activeChats.delete(userId);
        activeChats.delete(partnerId);
        return partnerId;
    }
    return null;
}

// ============ BOT COMMANDS (AFTER bot initialization) ============

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username;
    
    if (activeChats.has(userId)) {
        bot.sendMessage(chatId, '❌ You are currently in a chat. Use /stop to end it first.');
        return;
    }
    
    const user = await getUser(userId, username);
    
    if (!user) {
        const currentState = userStates.get(userId);
        if (currentState) {
            bot.sendMessage(chatId, '⏳ Registration in progress. Please complete the current step.');
            return;
        }
        
        const canProceed = await startRegistration(chatId, userId);
        if (canProceed) {
            await askGender(chatId, userId);
        }
        return;
    }
    
    const isPremium = await checkPremiumStatus(user);
    
    let welcomeMessage = `👋 Welcome back, ${user.nickname}!\n\n` +
        `🎭 Stay anonymous, safe & have fun.\n\n` +
        `💬 Tap /chat to find a stranger to talk with!`;

    if (isPremium) {
        const daysLeft = Math.ceil((user.premiumExpire - new Date()) / (1000 * 60 * 60 * 24));
        welcomeMessage += `\n\n⭐ Premium Active (${daysLeft} days left)`;
    }

    bot.sendMessage(chatId, welcomeMessage);
});

bot.onText(/\/chat/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const user = await getUser(userId);
    
    if (!user) {
        bot.sendMessage(chatId, '❌ Please use /start first to register.');
        return;
    }
    
    if (activeChats.has(userId)) {
        bot.sendMessage(chatId, '💬 You are already in a chat! Use /stop to end current chat.');
        return;
    }
    
    if (!user.isActive) {
        bot.sendMessage(chatId, '🚫 You have been banned from using this bot.');
        return;
    }
    
    const isPremium = await checkPremiumStatus(user);
    
    if (isPremium) {
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '👨 Find Male', callback_data: 'find_male' },
                    { text: '👩 Find Female', callback_data: 'find_female' }
                ],
                [
                    { text: '🎲 Find Anyone', callback_data: 'find_random' }
                ]
            ]
        };
        
        bot.sendMessage(chatId, '⭐ Premium: Choose who to chat with:', { reply_markup: keyboard });
    } else {
        const partnerId = await findPartner(userId);
        
        if (partnerId) {
            await startChat(userId, partnerId);
        } else {
            bot.sendMessage(chatId, '🔍 Looking for a partner...\n\n✨ Get Premium to choose gender!');
        }
    }
});

bot.onText(/\/stop/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const partnerId = endChat(userId);
    
    if (partnerId) {
        bot.sendMessage(chatId, '✅ Chat ended. Use /chat to start a new chat');
        bot.sendMessage(partnerId, '👋 Your partner left the chat. Use /chat to find a new partner');
    } else {
        bot.sendMessage(chatId, '❌ You are not in a chat currently. Use /chat to start.');
    }
    
    waitingQueue.delete(userId);
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const isAdminUser = isAdmin(userId);
    
    let helpText = `📖 *Bot Commands*\n\n`;
    
    helpText += `*MAIN COMMANDS*\n`;
    helpText += `/start - Start the bot\n`;
    helpText += `/chat - Find a chat partner\n`;
    helpText += `/stop - End current chat\n`;
    helpText += `/profile - View your profile\n`;
    helpText += `/help - Show this help\n\n`;
    
    helpText += `*SETTINGS*\n`;
    helpText += `/safemode - Toggle safe mode\n`;
    helpText += `/premium - View premium plans\n\n`;
    
    if (isAdminUser) {
        helpText += `\n🛡️ *ADMIN COMMANDS*\n`;
        helpText += `/admin - Admin dashboard\n`;
        helpText += `/stats - Bot statistics\n`;
        helpText += `/ban <id> - Ban user\n`;
        helpText += `/unban <id> - Unban user\n`;
    }
    
    bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
});

bot.onText(/\/profile/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const user = await getUser(userId);
    if (!user) {
        bot.sendMessage(chatId, '❌ Please use /start first.');
        return;
    }

    const isPremium = await checkPremiumStatus(user);
    
    let profile = `👤 Your Profile\n\n` +
        `🏷️ Nickname: ${user.nickname}\n` +
        `🎭 Gender: ${user.gender === 'male' ? '👨 Male' : '👩 Female'}\n` +
        `📅 Joined: ${user.joinDate.toLocaleDateString()}\n`;
    
    if (isPremium) {
        const daysLeft = Math.ceil((user.premiumExpire - new Date()) / (1000 * 60 * 60 * 24));
        profile += `\n⭐ Premium: Active (${daysLeft} days)\n`;
    }

    bot.sendMessage(chatId, profile);
});

// Callback Query Handler
bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    bot.answerCallbackQuery(query.id);

    if (data === 'verify_membership') {
        const membership = await checkMembership(userId);
        
        if (membership.channel && membership.group) {
            try {
                await bot.deleteMessage(chatId, messageId);
            } catch (error) {}
            await askGender(chatId, userId);
        } else {
            let msg = '❌ You must join:\n';
            if (!membership.channel) msg += '• Channel\n';
            if (!membership.group) msg += '• Group\n';
            
            bot.answerCallbackQuery(query.id, { text: msg, show_alert: true });
        }
        return;
    }

    if (data.startsWith('gender_')) {
        const state = userStates.get(userId);
        if (state !== 'awaiting_gender') {
            bot.answerCallbackQuery(query.id, { text: '❌ Please use /start to register.', show_alert: true });
            return;
        }
        
        const gender = data.replace('gender_', '');
        bot.answerCallbackQuery(query.id, { text: `Selected: ${gender === 'male' ? '👨 Male' : '👩 Female'}` });
        
        try {
            await bot.deleteMessage(chatId, messageId);
        } catch (error) {}
        
        await askNickname(chatId, userId, gender);
        return;
    }

    if (data.startsWith('find_')) {
        const user = await getUser(userId);
        if (!user || activeChats.has(userId)) return;

        let preferredGender = null;
        if (data === 'find_male') preferredGender = 'male';
        else if (data === 'find_female') preferredGender = 'female';

        const partnerId = await findPartner(userId, preferredGender);
        
        if (partnerId) {
            await startChat(userId, partnerId);
        } else {
            bot.sendMessage(chatId, `🔍 Looking for partner...`);
        }
        return;
    }
});

// Message Handler
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (msg.text && msg.text.startsWith('/')) return;

    const state = userStates.get(userId);

    if (state && state.startsWith('awaiting_nickname:')) {
        const nickname = msg.text?.trim();
        
        if (!nickname || !isValidNickname(nickname)) {
            bot.sendMessage(chatId, '❌ Invalid nickname! Try again (2-20 characters, no bad words)');
            return;
        }

        const gender = state.split(':')[1];
        const success = await completeRegistration(userId, gender, nickname);
        
        if (success) {
            bot.sendMessage(chatId, 
                `✅ Registration Complete!\n\n` +
                `🏷️ Nickname: ${nickname}\n` +
                `🎭 Gender: ${gender === 'male' ? '👨 Male' : '👩 Female'}\n\n` +
                `💬 Use /chat to start chatting!`
            );
        }
        return;
    }

    const partnerId = activeChats.get(userId);
    if (!partnerId) return;

    const partner = await getUser(partnerId);
    if (!partner) return;

    try {
        if (msg.text) {
            if (containsBadWords(msg.text)) {
                const maskedText = maskBadWords(msg.text);
                await bot.sendMessage(partnerId, maskedText);
                await bot.sendMessage(chatId, '⚠️ Message filtered.');
            } else {
                await bot.sendMessage(partnerId, msg.text);
            }
        } else if (msg.photo) {
            if (partner.safeMode) {
                await bot.sendMessage(partnerId, '📷 [Photo blocked by Safe Mode]');
                await bot.sendMessage(chatId, '📷 Photo blocked by partner\'s Safe Mode.');
            } else {
                await bot.sendPhoto(partnerId, msg.photo[msg.photo.length - 1].file_id);
            }
        }
    } catch (error) {
        console.error('Message relay error:', error);
        endChat(userId);
    }
});

// Express server
app.use(express.json());

app.get('/', async (req, res) => {
    const totalUsers = await User.countDocuments();
    res.json({
        status: 'Bot is running!',
        users: totalUsers,
        activeChats: Math.floor(activeChats.size / 2)
    });
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});

// Error Handling
bot.on('error', (error) => console.error('Bot error:', error));
bot.on('polling_error', (error) => console.error('Polling error:', error));

process.on('SIGINT', async () => {
    await mongoose.connection.close();
    process.exit(0);
});
