// server.js - Enhanced Telegram Bot with MongoDB - FIXED VERSION
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
    // Anti-Abuse System
    badWordCount: { type: Number, default: 0 },
    linkSpamCount: { type: Number, default: 0 },
    repeatSpamCount: { type: Number, default: 0 },
    floodMessages: { type: Array, default: [] },
    banExpiry: Date,
    warnings: { type: Array, default: [] },
    lastMessages: { type: Array, default: [] }
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
    messageCount: { type: Number, default: 0 }
});

const User = mongoose.model('User', userSchema);
const Report = mongoose.model('Report', reportSchema);
const ChatSession = mongoose.model('ChatSession', chatSessionSchema);

// In-memory storage for active chats (session-based)
const activeChats = new Map();
const waitingQueue = new Map();
const userStates = new Map();

// Stats tracking
const stats = {
    dailyActiveUsers: new Set()
};

// Bad words filter
const badWords = ['spam', 'scam', 'porn', 'xxx', 'sex', 'nude', 'drugs', 'fuck', 'shit', 'bitch', 'asshole', 'dick', 'pussy', 'nigger', 'faggot'];
const badNicknames = ['admin', 'bot', 'official', 'telegram', 'support', ...badWords];

// Link detection regex
const linkRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|(@[a-zA-Z0-9_]+)|(t\.me\/[^\s]+)|(telegram\.me\/[^\s]+)|(wa\.me\/[^\s]+)|(instagram\.com\/[^\s]+)|(facebook\.com\/[^\s]+)|(tiktok\.com\/[^\s]+)|(youtube\.com\/[^\s]+)|(youtu\.be\/[^\s]+)/gi;

function containsBadWords(text) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    return badWords.some(word => lowerText.includes(word));
}

function countBadWords(text) {
    if (!text) return 0;
    const lowerText = text.toLowerCase();
    let count = 0;
    badWords.forEach(word => {
        const matches = lowerText.match(new RegExp(word, 'gi'));
        if (matches) count += matches.length;
    });
    return count;
}

function containsLinks(text) {
    if (!text) return false;
    return linkRegex.test(text);
}

function countLinks(text) {
    if (!text) return 0;
    const matches = text.match(linkRegex);
    return matches ? matches.length : 0;
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

// Anti-abuse notification to admins
async function notifyAdminsAboutBan(userId, reason, duration = null) {
    const user = await User.findOne({ telegramId: userId });
    const message = `🚨 Auto-ban triggered:\n\n` +
        `👤 User: ${user?.nickname || 'Unknown'} (${userId})\n` +
        `⚠️ Reason: ${reason}\n` +
        `⏰ Duration: ${duration || 'Permanent'}`;
    
    ADMIN_IDS.forEach(adminId => {
        bot.sendMessage(adminId, message).catch(() => {});
    });
}

// Check and auto-unban if ban expired
async function checkBanExpiry(user) {
    if (!user.isActive && user.banExpiry && new Date() > user.banExpiry) {
        user.isActive = true;
        user.banExpiry = null;
        await user.save();
        
        try {
            bot.sendMessage(user.telegramId, '✅ Your ban has expired. You can use the bot again!');
        } catch (error) {}
        
        return true;
    }
    return false;
}

// Helper Functions
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

function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
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

// 🛡️ IMPROVED AUTO-BAN SYSTEM
async function checkAndAutoBan(user, reason, type) {
    // Skip premium users from auto-ban
    if (user.isPremium) return false;

    let shouldBan = false;
    let banReason = '';

    if (type === 'badwords' && user.badWordCount >= 50) {
        shouldBan = true;
        banReason = `50+ bad words detected`;
    } else if (type === 'links' && user.linkSpamCount >= 20) {
        shouldBan = true;
        banReason = `20+ spam links detected`;
    } else if (type === 'repeat' && user.repeatSpamCount >= 15) {
        shouldBan = true;
        banReason = `15+ identical messages`;
    } else if (type === 'flood') {
        shouldBan = true;
        banReason = `20+ messages in 10 seconds (flooding)`;
    } else if (type === 'reports' && user.reportCount >= 50) {
        shouldBan = true;
        banReason = `50+ reports received`;
    }

    if (shouldBan) {
        user.isActive = false;
        user.banExpiry = null; // Permanent ban
        await user.save();
        
        endChat(user.telegramId);
        
        try {
            bot.sendMessage(user.telegramId, `🚫 You have been permanently banned.\n\nReason: ${banReason}`);
        } catch (error) {}
        
        await notifyAdminsAboutBan(user.telegramId, banReason, 'Permanent');
        return true;
    }

    return false;
}

// Registration Flow
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
    console.log('Asking gender for user:', userId);
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
    console.log('Gender selection message sent, state set to awaiting_gender');
}

async function askNickname(chatId, userId, gender) {
    console.log('Asking nickname for user:', { userId, gender });
    userStates.set(userId, `awaiting_nickname:${gender}`);
    console.log('State set to:', userStates.get(userId));
    
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
        console.log('Registration attempt:', { userId, gender, nickname });
        
        if (!gender || !nickname) {
            console.error('Missing required fields:', { gender, nickname });
            return false;
        }
        
        const existingUser = await User.findOne({ telegramId: userId });
        if (existingUser) {
            console.log('User already exists, updating...');
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
        console.log('User registered successfully:', userId);
        userStates.delete(userId);
        return true;
    } catch (error) {
        console.error('Error completing registration:', error);
        console.error('Registration data was:', { userId, gender, nickname });
        return false;
    }
}

// Chat Management
async function findPartner(userId, preferredGender = null) {
    waitingQueue.delete(userId);
    
    const user = await getUser(userId);
    if (!user) return null;

    const isPremium = await checkPremiumStatus(user);
    
    if (isPremium && preferredGender) {
        // Premium: strict gender matching
        for (const [partnerId, data] of waitingQueue) {
            if (partnerId !== userId) {
                const partner = await getUser(partnerId);
                if (partner && partner.gender === preferredGender && partner.isPremium) {
                    waitingQueue.delete(partnerId);
                    return partnerId;
                }
            }
        }
        
        for (const [partnerId, data] of waitingQueue) {
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
    
    if (isPremium) {
        const queueArray = Array.from(waitingQueue);
        waitingQueue.clear();
        waitingQueue.set(userId, { 
            gender: preferredGender || 'any', 
            timestamp: Date.now(),
            isPremium: true 
        });
        queueArray.forEach(([id, data]) => waitingQueue.set(id, data));
    } else {
        waitingQueue.set(userId, { 
            gender: preferredGender || 'any', 
            timestamp: Date.now(),
            isPremium: false 
        });
    }
    
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
        '🔀 Use /stop to end chat';

    const buttons = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🎁 Send Gift", callback_data: "send_gift" },
                    { text: "🚫 Report", callback_data: "report_partner" }
                ],
                [
                    { text: "🔀 Forward to friends", switch_inline_query: "" }
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

// Bot Commands
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username;
    
    // Prevent group messages from being processed
    if (msg.chat.type !== 'private') return;
    
    console.log('=== /start command received ===', { userId, chatId, username });
    
    if (activeChats.has(userId)) {
        bot.sendMessage(chatId, '❌ You are currently in a chat. Use /stop to end it first.');
        return;
    }
    
    const user = await getUser(userId, username);
    
    if (!user) {
        const currentState = userStates.get(userId);
        if (currentState) {
            console.log('User already in registration:', { userId, currentState });
            bot.sendMessage(chatId, '⏳ Registration in progress. Please complete the current step.');
            return;
        }
        
        console.log('New user registration started:', userId);
        const canProceed = await startRegistration(chatId, userId);
        if (canProceed) {
            console.log('Membership verified, asking gender...');
            await askGender(chatId, userId);
        } else {
            console.log('Waiting for membership verification...');
        }
        return;
    }
    
    console.log('Existing user detected:', { userId, nickname: user.nickname });
    
    const isPremium = await checkPremiumStatus(user);
    
    let welcomeMessage = `👋 Welcome back, ${user.nickname}!\n\n` +
        `🎭 Stay anonymous, safe & have fun.\n\n` +
        `💬 Tap /chat to find a stranger to talk with!`;

    if (isPremium) {
        const daysLeft = Math.ceil((user.premiumExpire - new Date()) / (1000 * 60 * 60 * 24));
        welcomeMessage += `\n\n⭐ Premium Active (${daysLeft} days left)\n` +
            `• Choose gender preference\n` +
            `• Priority matching\n` +
            `• Cannot be reported`;
    } else {
        welcomeMessage += `\n\n✨ Upgrade to Premium with /premium`;
    }

    const options = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📢 Channel', url: CHANNEL_LINK },
                    { text: '💬 Group', url: GROUP_LINK }
                ],
                [
                    { text: '⚙️ Safe Mode', callback_data: 'safe_mode_menu' },
                    { text: '⭐ Premium', callback_data: 'premium_menu' }
                ]
            ]
        }
    };

    bot.sendMessage(chatId, welcomeMessage, options);
});

bot.onText(/\/chat/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Prevent group messages
    if (msg.chat.type !== 'private') return;
    
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
    
    // Prevent group messages
    if (msg.chat.type !== 'private') return;
    
    const partnerId = endChat(userId);
    
    if (partnerId) {
        bot.sendMessage(chatId, '✅ Chat ended. Use /chat to start a new chat');
        bot.sendMessage(partnerId, '👋 Your partner left the chat. Use /chat to find a new partner');
    } else {
        bot.sendMessage(chatId, '❌ You are not in a chat currently. Use /chat to start.');
    }
    
    waitingQueue.delete(userId);
});

bot.onText(/\/premium/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Prevent group messages
    if (msg.chat.type !== 'private') return;
    
    if (activeChats.has(userId)) {
        bot.sendMessage(chatId, '❌ Cannot access premium during chat. Use /stop first.');
        return;
    }
    
    const user = await getUser(userId);
    if (!user) {
        bot.sendMessage(chatId, '❌ Please use /start first.');
        return;
    }

    const isPremium = await checkPremiumStatus(user);
    
    let message = `⭐ Premium Membership\n\n`;
    
    if (isPremium) {
        const daysLeft = Math.ceil((user.premiumExpire - new Date()) / (1000 * 60 * 60 * 24));
        message += `✅ Status: Active\n` +
            `📅 Expires: ${user.premiumExpire.toLocaleDateString()}\n` +
            `⏰ ${daysLeft} days remaining\n\n` +
            `🎯 Your Benefits:\n` +
            `• 👨👩 Choose gender to chat with\n` +
            `• ⚡ Priority matching\n` +
            `• ⭐ Premium badge\n` +
            `• 🛡️ Cannot be reported\n\n` +
            `Renew your membership below!`;
    } else {
        message += `💎 Benefits:\n` +
            `• 👨👩 Choose gender preference\n` +
            `• ⚡ Priority queue\n` +
            `• ⭐ Premium badge\n` +
            `• 🛡️ Cannot be reported\n\n` +
            `Choose your plan:`;
    }

    const keyboard = {
        inline_keyboard: [
            [
                { text: '⭐ 1 Day - 10 Stars', callback_data: 'buy_premium_1' }
            ],
            [
                { text: '⭐⭐ 7 Days - 30 Stars', callback_data: 'buy_premium_7' }
            ],
            [
                { text: '⭐⭐⭐ 30 Days - 50 Stars', callback_data: 'buy_premium_30' }
            ]
        ]
    };

    bot.sendMessage(chatId, message, { 
        reply_markup: keyboard,
        parse_mode: 'Markdown' 
    });
});

bot.onText(/\/profile/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Prevent group messages
    if (msg.chat.type !== 'private') return;
    
    if (activeChats.has(userId)) {
        bot.sendMessage(chatId, '❌ Cannot view profile during chat. Use /stop first.');
        return;
    }
    
    const user = await getUser(userId);
    if (!user) {
        bot.sendMessage(chatId, '❌ Please use /start first.');
        return;
    }

    const isPremium = await checkPremiumStatus(user);
    const totalReports = await Report.countDocuments({ reportedUserId: userId });
    
    let profile = `👤 Your Profile\n\n` +
        `🏷️ Nickname: ${user.nickname}\n` +
        `🎭 Gender: ${user.gender === 'male' ? '👨 Male' : '👩 Female'}\n` +
        `📅 Joined: ${user.joinDate.toLocaleDateString()}\n` +
        `🔒 Safe Mode: ${user.safeMode ? 'ON ✅' : 'OFF ❌'}\n`;
    
    if (isPremium) {
        const daysLeft = Math.ceil((user.premiumExpire - new Date()) / (1000 * 60 * 60 * 24));
        profile += `\n⭐ Premium: Active (${daysLeft} days)\n`;
    } else {
        profile += `\n✨ Premium: Inactive\n`;
    }
    
    profile += `\n⚠️ Reports: ${totalReports}`;
    if (user.warnings && user.warnings.length > 0) {
        profile += `\n⚠️ Warnings: ${user.warnings.length}`;
    }

    bot.sendMessage(chatId, profile);
});

bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    
    // Prevent group messages
    if (msg.chat.type !== 'private') return;
    
    const helpMessage = `📚 *Available Commands*\n\n` +
        `*Chat:*\n` +
        `/start - Start the bot\n` +
        `/chat - Find a stranger to chat\n` +
        `/stop - End current chat\n\n` +
        `*Settings:*\n` +
        `/profile - View your profile\n` +
        `/premium - View premium plans\n\n` +
        `*During Chat:*\n` +
        `🎁 Send Gift - Reveal identities (10 stars)\n` +
        `🚫 Report - Report inappropriate user\n\n` +
        `*Premium Benefits:*\n` +
        `• Choose gender to chat with\n` +
        `• Priority matching\n` +
        `• Premium badge ⭐\n` +
        `• Cannot be reported\n\n` +
        `Need help? Contact support in our group!`;
    
    bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// ⭐ NEW ADMIN COMMANDS

// 1. /givemsg <id> <text> - Send hidden message to user
bot.onText(/\/givemsg (\d+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const targetUserId = parseInt(match[1]);
    const message = match[2];
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only.');
        return;
    }
    
    try {
        await bot.sendMessage(targetUserId, `📩 Message from Admin:\n\n${message}`);
        bot.sendMessage(chatId, `✅ Message sent to ${targetUserId}`);
    } catch (error) {
        bot.sendMessage(chatId, `❌ Failed to send message. User may have blocked the bot.`);
    }
});

// 2. /matchinfo <id> - Show who user is matching with
bot.onText(/\/matchinfo (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const targetUserId = parseInt(match[1]);
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only.');
        return;
    }
    
    const partnerId = activeChats.get(targetUserId);
    
    if (!partnerId) {
        bot.sendMessage(chatId, `ℹ️ User ${targetUserId} is not in an active chat.`);
        return;
    }
    
    const user = await User.findOne({ telegramId: targetUserId });
    const partner = await User.findOne({ telegramId: partnerId });
    
    const info = `💑 Match Info\n\n` +
        `👤 User: ${user?.nickname || 'Unknown'} (${targetUserId})\n` +
        `❤️ Partner: ${partner?.nickname || 'Unknown'} (${partnerId})\n` +
        `⏰ Chat started: Active`;
    
    bot.sendMessage(chatId, info);
});

// 3. /userinfo <id> - Full user profile
bot.onText(/\/userinfo (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const targetUserId = parseInt(match[1]);
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only.');
        return;
    }
    
    const user = await User.findOne({ telegramId: targetUserId });
    
    if (!user) {
        bot.sendMessage(chatId, '❌ User not found.');
        return;
    }
    
    const totalReports = await Report.countDocuments({ reportedUserId: targetUserId });
    const chatSessions = await ChatSession.countDocuments({
        $or: [{ user1Id: targetUserId }, { user2Id: targetUserId }]
    });
    
    let info = `📊 *Full User Profile*\n\n` +
        `👤 *Basic Info:*\n` +
        `ID: \`${targetUserId}\`\n` +
        `Nickname: ${user.nickname}\n` +
        `Username: ${user.username ? '@' + user.username : 'Not set'}\n` +
        `Gender: ${user.gender === 'male' ? '👨 Male' : '👩 Female'}\n` +
        `Joined: ${user.joinDate.toLocaleDateString()}\n` +
        `Last Active: ${user.lastActive.toLocaleDateString()}\n\n` +
        `🛡️ *Status:*\n` +
        `Active: ${user.isActive ? '✅ Yes' : '🚫 Banned'}\n` +
        `Premium: ${user.isPremium ? '⭐ Yes' : '❌ No'}\n` +
        `Safe Mode: ${user.safeMode ? '🔒 ON' : '🔓 OFF'}\n\n` +
        `⚠️ *Moderation:*\n` +
        `Reports: ${totalReports}\n` +
        `Warnings: ${user.warnings.length}\n` +
        `Bad Words: ${user.badWordCount}\n` +
        `Link Spam: ${user.linkSpamCount}\n` +
        `Repeat Spam: ${user.repeatSpamCount}\n\n` +
        `💬 *Activity:*\n` +
        `Total Chats: ${chatSessions}\n` +
        `Currently Chatting: ${activeChats.has(targetUserId) ? 'Yes' : 'No'}`;
    
    if (user.isPremium && user.premiumExpire) {
        const daysLeft = Math.ceil((user.premiumExpire - new Date()) / (1000 * 60 * 60 * 24));
        info += `\n\n⭐ *Premium:*\n` +
            `Expires: ${user.premiumExpire.toLocaleDateString()}\n` +
            `Days Left: ${daysLeft}`;
    }
    
    if (user.banExpiry) {
        info += `\n\n🚫 *Ban Info:*\n` +
            `Ban Expires: ${user.banExpiry.toLocaleDateString()}`;
    }
    
    if (user.warnings.length > 0) {
        info += `\n\n⚠️ *Recent Warnings:*\n`;
        user.warnings.slice(-3).forEach((warning, idx) => {
            info += `${idx + 1}. ${warning.reason} - ${new Date(warning.date).toLocaleDateString()}\n`;
        });
    }
    
    bot.sendMessage(chatId, info, { parse_mode: 'Markdown' });
});

// FIXED ADMIN COMMANDS

// /warn <id> <reason> - Warn user with auto-ban after limit
bot.onText(/\/warn (\d+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const targetUserId = parseInt(match[1]);
    const reason = match[2];
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only.');
        return;
    }
    
    const user = await User.findOne({ telegramId: targetUserId });
    
    if (!user) {
        bot.sendMessage(chatId, '❌ User not found.');
        return;
    }
    
    user.warnings.push({
        reason: reason,
        date: new Date(),
        adminId: userId
    });
    
    // Auto-ban after 3 warnings
    if (user.warnings.length >= 3) {
        user.isActive = false;
        user.banExpiry = null; // Permanent
        await user.save();
        
        endChat(targetUserId);
        
        try {
            bot.sendMessage(targetUserId, `🚫 You have been banned.\n\nReason: 3 warnings received\nLatest: ${reason}`);
        } catch (error) {}
        
        bot.sendMessage(chatId, `✅ User ${user.nickname} (${targetUserId}) warned and BANNED (3+ warnings)`);
        
        await notifyAdminsAboutBan(targetUserId, '3 warnings - Latest: ' + reason, 'Permanent');
    } else {
        await user.save();
        
        try {
            bot.sendMessage(targetUserId, 
                `⚠️ Warning ${user.warnings.length}/3\n\n` +
                `Reason: ${reason}\n\n` +
                `❗ You will be banned at 3 warnings!`
            );
        } catch (error) {}
        
        bot.sendMessage(chatId, `✅ Warning sent to ${user.nickname} (${targetUserId})\nTotal warnings: ${user.warnings.length}/3`);
    }
});

// /resetreports <id> - Reset user report count
bot.onText(/\/resetreports (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const targetUserId = parseInt(match[1]);
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only.');
        return;
    }
    
    const user = await User.findOne({ telegramId: targetUserId });
    
    if (!user) {
        bot.sendMessage(chatId, '❌ User not found.');
        return;
    }
    
    const oldCount = user.reportCount;
    user.reportCount = 0;
    await user.save();
    
    // Also mark all reports as resolved
    await Report.updateMany(
        { reportedUserId: targetUserId, resolved: false },
        { resolved: true }
    );
    
    bot.sendMessage(chatId, `✅ Reports reset for ${user.nickname} (${targetUserId})\nOld count: ${oldCount} → New: 0`);
    
    try {
        bot.sendMessage(targetUserId, '✅ Your reports have been cleared by admin.');
    } catch (error) {}
});

// /resetabuse <id> - Reset abuse counters
bot.onText(/\/resetabuse (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const targetUserId = parseInt(match[1]);
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only.');
        return;
    }
    
    const user = await User.findOne({ telegramId: targetUserId });
    
    if (!user) {
        bot.sendMessage(chatId, '❌ User not found.');
        return;
    }
    
    user.badWordCount = 0;
    user.linkSpamCount = 0;
    user.repeatSpamCount = 0;
    user.floodMessages = [];
    user.lastMessages = [];
    await user.save();
    
    bot.sendMessage(chatId, `✅ Abuse counters reset for ${user.nickname} (${targetUserId})\n` +
        `• Bad words: 0\n` +
        `• Link spam: 0\n` +
        `• Repeat spam: 0\n` +
        `• Flood messages: cleared`
    );
    
    try {
        bot.sendMessage(targetUserId, '✅ Your abuse warnings have been cleared by admin.');
    } catch (error) {}
});

// /endchat <id> - Force end user's active chat
bot.onText(/\/endchat (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const targetUserId = parseInt(match[1]);
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only.');
        return;
    }
    
    const partnerId = endChat(targetUserId);
    
    if (partnerId) {
        const user = await User.findOne({ telegramId: targetUserId });
        const partner = await User.findOne({ telegramId: partnerId });
        
        try {
            bot.sendMessage(targetUserId, '⚠️ Your chat was ended by an admin.');
            bot.sendMessage(partnerId, '⚠️ Your chat was ended by an admin.');
        } catch (error) {}
        
        bot.sendMessage(chatId, 
            `✅ Chat ended\n\n` +
            `User: ${user?.nickname || 'Unknown'} (${targetUserId})\n` +
            `Partner: ${partner?.nickname || 'Unknown'} (${partnerId})`
        );
    } else {
        bot.sendMessage(chatId, `ℹ️ User ${targetUserId} is not in an active chat.`);
    }
});

// /cancelpremium <id> - Remove premium from user
bot.onText(/\/cancelpremium (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const targetUserId = parseInt(match[1]);
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only.');
        return;
    }
    
    const user = await User.findOne({ telegramId: targetUserId });
    
    if (!user) {
        bot.sendMessage(chatId, '❌ User not found.');
        return;
    }
    
    if (!user.isPremium) {
        bot.sendMessage(chatId, `ℹ️ User ${user.nickname} (${targetUserId}) is not premium.`);
        return;
    }
    
    user.isPremium = false;
    user.premiumExpire = null;
    await user.save();
    
    try {
        bot.sendMessage(targetUserId, '⚠️ Your premium membership has been cancelled by admin.');
    } catch (error) {}
    
    bot.sendMessage(chatId, `✅ Premium cancelled for ${user.nickname} (${targetUserId})`);
});

// /banned - Show list of banned users
bot.onText(/\/banned(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only.');
        return;
    }
    
    const page = match[1] ? parseInt(match[1]) : 1;
    const limit = 10;
    const skip = (page - 1) * limit;
    
    const bannedUsers = await User.find({ isActive: false })
        .sort({ lastActive: -1 })
        .skip(skip)
        .limit(limit);
    
    const totalBanned = await User.countDocuments({ isActive: false });
    const totalPages = Math.ceil(totalBanned / limit);
    
    if (bannedUsers.length === 0) {
        bot.sendMessage(chatId, '✅ No banned users.');
        return;
    }
    
    let message = `🚫 *Banned Users* (Page ${page}/${totalPages})\n` +
        `Total: ${totalBanned}\n\n`;
    
    for (const user of bannedUsers) {
        message += `• ${user.nickname} (${user.telegramId})\n`;
        message += `  Gender: ${user.gender === 'male' ? '👨' : '👩'}\n`;
        message += `  Reports: ${user.reportCount}\n`;
        message += `  Warnings: ${user.warnings.length}\n`;
        if (user.banExpiry) {
            message += `  Ban expires: ${user.banExpiry.toLocaleDateString()}\n`;
        } else {
            message += `  Ban: Permanent\n`;
        }
        message += `  /unban ${user.telegramId}\n\n`;
    }
    
    if (totalPages > 1) {
        message += `\nUse /banned ${page + 1} for next page`;
    }
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// /activechats - Show all active matches
bot.onText(/\/activechats/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only.');
        return;
    }
    
    if (activeChats.size === 0) {
        bot.sendMessage(chatId, 'ℹ️ No active chats currently.');
        return;
    }
    
    const processed = new Set();
    let message = `💬 *Active Chats*\n` +
        `Total: ${Math.floor(activeChats.size / 2)}\n\n`;
    
    for (const [user1Id, user2Id] of activeChats) {
        if (processed.has(user1Id) || processed.has(user2Id)) continue;
        
        processed.add(user1Id);
        processed.add(user2Id);
        
        const user1 = await User.findOne({ telegramId: user1Id });
        const user2 = await User.findOne({ telegramId: user2Id });
        
        message += `💑 ${user1?.nickname || 'Unknown'} (${user1Id}) ↔️ ${user2?.nickname || 'Unknown'} (${user2Id})\n`;
        message += `   /endchat ${user1Id}\n\n`;
    }
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// /supporters - List premium users
bot.onText(/\/supporters(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only.');
        return;
    }
    
    const page = match[1] ? parseInt(match[1]) : 1;
    const limit = 10;
    const skip = (page - 1) * limit;
    
    const premiumUsers = await User.find({ isPremium: true })
        .sort({ premiumExpire: -1 })
        .skip(skip)
        .limit(limit);
    
    const totalPremium = await User.countDocuments({ isPremium: true });
    const totalPages = Math.ceil(totalPremium / limit);
    
    if (premiumUsers.length === 0) {
        bot.sendMessage(chatId, 'ℹ️ No premium users currently.');
        return;
    }
    
    let message = `⭐ *Premium Users* (Page ${page}/${totalPages})\n` +
        `Total: ${totalPremium}\n\n`;
    
    for (const user of premiumUsers) {
        const daysLeft = user.premiumExpire ? Math.ceil((user.premiumExpire - new Date()) / (1000 * 60 * 60 * 24)) : 0;
        message += `⭐ ${user.nickname} (${user.telegramId})\n`;
        message += `   Days left: ${daysLeft}\n`;
        message += `   Gender: ${user.gender === 'male' ? '👨 Male' : '👩 Female'}\n`;
        message += `   Expires: ${user.premiumExpire?.toLocaleDateString()}\n`;
        message += `   /cancelpremium ${user.telegramId}\n\n`;
    }
    
    if (totalPages > 1) {
        message += `\nUse /supporters ${page + 1} for next page`;
    }
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// Existing Admin Commands (keeping them)
bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only.');
        return;
    }

    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ isActive: true });
    const bannedUsers = await User.countDocuments({ isActive: false });
    const premiumUsers = await User.countDocuments({ isPremium: true });
    const activeChatsCount = Math.floor(activeChats.size / 2);

    const keyboard = {
        inline_keyboard: [
            [
                { text: `👥 Users: ${totalUsers}`, callback_data: 'admin_users_info' },
                { text: `💬 Chats: ${activeChatsCount}`, callback_data: 'admin_view_chats' }
            ],
            [
                { text: `⭐ Premium: ${premiumUsers}`, callback_data: 'admin_premium_list' },
                { text: `🚫 Banned: ${bannedUsers}`, callback_data: 'admin_banned_list' }
            ],
            [
                { text: '📊 Full Stats', callback_data: 'admin_full_stats' },
                { text: '🚨 Reports', callback_data: 'admin_reports_list' }
            ],
            [
                { text: '📢 Broadcast All', callback_data: 'admin_do_broadcast' },
                { text: '⭐ Broadcast Premium', callback_data: 'admin_do_broadcast_premium' }
            ],
            [
                { text: '📖 Commands Help', callback_data: 'admin_help' }
            ]
        ]
    };

    bot.sendMessage(chatId, `🛡️ *Admin Dashboard*\n\nQuick Overview:`, { 
        reply_markup: keyboard,
        parse_mode: 'Markdown'
    });
});

bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied.');
        return;
    }
    
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ isActive: true });
    const premiumUsers = await User.countDocuments({ isPremium: true });
    const totalReports = await Report.countDocuments();
    const bannedUsers = await User.countDocuments({ isActive: false });
    
    const statsMessage = `📊 Bot Statistics\n\n` +
        `👥 Total Users: ${totalUsers}\n` +
        `✅ Active: ${activeUsers}\n` +
        `🚫 Banned: ${bannedUsers}\n` +
        `⭐ Premium: ${premiumUsers}\n` +
        `💬 Current Chats: ${Math.floor(activeChats.size / 2)}\n` +
        `⏳ Waiting: ${waitingQueue.size}\n` +
        `🚨 Reports: ${totalReports}\n` +
        `📅 Daily Active: ${stats.dailyActiveUsers.size}`;

    bot.sendMessage(chatId, statsMessage);
});

bot.onText(/\/users(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied.');
        return;
    }

    const page = match[1] ? parseInt(match[1]) : 1;
    const limit = 10;
    const skip = (page - 1) * limit;

    const users = await User.find()
        .sort({ joinDate: -1 })
        .skip(skip)
        .limit(limit);

    const totalUsers = await User.countDocuments();
    const totalPages = Math.ceil(totalUsers / limit);

    let usersList = `👥 Users (Page ${page}/${totalPages})\n\n`;
    
    for (const user of users) {
        const status = user.isActive ? '✅' : '🚫';
        const premium = user.isPremium ? '⭐' : '';
        usersList += `${status}${premium} ${user.nickname} (${user.gender})\n`;
        usersList += `   ID: ${user.telegramId}\n`;
        usersList += `   Joined: ${user.joinDate.toLocaleDateString()}\n\n`;
    }

    if (totalPages > 1) {
        usersList += `\nUse /users ${page + 1} for next page`;
    }

    bot.sendMessage(chatId, usersList);
});

bot.onText(/\/reports(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied.');
        return;
    }

    const page = match[1] ? parseInt(match[1]) : 1;
    const limit = 10;
    const skip = (page - 1) * limit;

    const reports = await Report.find({ resolved: false })
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit);

    if (reports.length === 0) {
        bot.sendMessage(chatId, '✅ No pending reports.');
        return;
    }

    let reportsList = `🚨 Reports (Page ${page})\n\n`;
    
    for (const report of reports) {
        const reportedUser = await User.findOne({ telegramId: report.reportedUserId });
        const reporterUser = await User.findOne({ telegramId: report.reporterUserId });
        
        reportsList += `🔍 Report ID: ${report._id}\n`;
        reportsList += `👤 Reported: ${reportedUser?.nickname || 'Unknown'} (${report.reportedUserId})\n`;
        reportsList += `👮 Reporter: ${reporterUser?.nickname || 'Unknown'}\n`;
        reportsList += `📅 Date: ${report.date.toLocaleDateString()}\n`;
        reportsList += `Actions: /resolve ${report._id} | /ban ${report.reportedUserId}\n\n`;
    }

    bot.sendMessage(chatId, reportsList);
});

bot.onText(/\/ban (\d+)(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const targetUserId = parseInt(match[1]);
    const reason = match[2] || 'Banned by admin';
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied.');
        return;
    }
    
    const targetUser = await User.findOne({ telegramId: targetUserId });
    if (!targetUser) {
        bot.sendMessage(chatId, '❌ User not found.');
        return;
    }
    
    if (!targetUser.isActive) {
        bot.sendMessage(chatId, `⚠️ User ${targetUserId} is already banned.`);
        return;
    }
    
    targetUser.isActive = false;
    await targetUser.save();
    
    endChat(targetUserId);
    
    try {
        bot.sendMessage(targetUserId, `🚫 You have been banned.\nReason: ${reason}`);
    } catch (error) {}
    
    bot.sendMessage(chatId, `✅ User ${targetUser.nickname} (${targetUserId}) has been banned.`);
});

bot.onText(/\/unban (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const targetUserId = parseInt(match[1]);
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied.');
        return;
    }
    
    const targetUser = await User.findOne({ telegramId: targetUserId });
    if (!targetUser) {
        bot.sendMessage(chatId, '❌ User not found.');
        return;
    }
    
    if (targetUser.isActive) {
        bot.sendMessage(chatId, `⚠️ User ${targetUserId} is not banned.`);
        return;
    }
    
    targetUser.isActive = true;
    targetUser.reportCount = 0;
    await targetUser.save();
    
    try {
        bot.sendMessage(targetUserId, '✅ You have been unbanned! Use /start to continue.');
    } catch (error) {}
    
    bot.sendMessage(chatId, `✅ User ${targetUser.nickname} (${targetUserId}) has been unbanned.`);
});

bot.onText(/\/resolve (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const reportId = match[1];
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied.');
        return;
    }
    
    const report = await Report.findById(reportId);
    if (!report) {
        bot.sendMessage(chatId, '❌ Report not found.');
        return;
    }
    
    report.resolved = true;
    await report.save();
    
    bot.sendMessage(chatId, '✅ Report marked as resolved.');
});

bot.onText(/\/grantpremium (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const targetUserId = parseInt(match[1]);
    const days = parseInt(match[2]);
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied.');
        return;
    }
    
    const targetUser = await User.findOne({ telegramId: targetUserId });
    if (!targetUser) {
        bot.sendMessage(chatId, '❌ User not found.');
        return;
    }
    
    const expireDate = new Date();
    expireDate.setDate(expireDate.getDate() + days);
    
    targetUser.isPremium = true;
    targetUser.premiumExpire = expireDate;
    targetUser.premiumHistory.push({
        amount: 0,
        days: days,
        purchaseDate: new Date(),
        expiryDate: expireDate,
        transactionId: 'ADMIN_GRANT'
    });
    await targetUser.save();
    
    try {
        bot.sendMessage(targetUserId, `🎉 You've been granted ${days} days of Premium by admin!`);
    } catch (error) {}
    
    bot.sendMessage(chatId, `✅ Granted ${days} days premium to ${targetUser.nickname} (${targetUserId})`);
});

bot.onText(/\/broadcast/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied.');
        return;
    }
    
    userStates.set(userId, 'awaiting_broadcast');
    bot.sendMessage(chatId, 
        '📢 Send the message to broadcast:\n\n' +
        'You can send:\n' +
        '• Text\n' +
        '• Photo (with caption)\n' +
        '• Video (with caption)\n' +
        '• Document\n\n' +
        'Send /cancel to cancel.'
    );
});

bot.onText(/\/broadcastpremium/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied.');
        return;
    }
    
    userStates.set(userId, 'awaiting_premium_broadcast');
    bot.sendMessage(chatId, 
        '⭐ Send message to broadcast to PREMIUM users only:\n\n' +
        'You can send:\n' +
        '• Text\n' +
        '• Photo (with caption)\n' +
        '• Video (with caption)\n' +
        '• Document\n\n' +
        'Send /cancel to cancel.'
    );
});

bot.onText(/\/cancel/, (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    
    if (userStates.has(userId)) {
        userStates.delete(userId);
        bot.sendMessage(chatId, '✅ Operation cancelled.');
    } else {
        bot.sendMessage(chatId, '❌ No active operation to cancel.');
    }
});

// Callback Query Handler
bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    bot.answerCallbackQuery(query.id);

    // Verify Membership
    if (data === 'verify_membership') {
        const membership = await checkMembership(userId);
        
        if (membership.channel && membership.group) {
            console.log('Membership verified for user:', userId);
            try {
                await bot.deleteMessage(chatId, messageId);
            } catch (error) {
                console.log('Could not delete message');
            }
            await askGender(chatId, userId);
        } else {
            let msg = '❌ You must join:\n';
            if (!membership.channel) msg += '• Channel\n';
            if (!membership.group) msg += '• Group\n';
            msg += '\nPlease join and try again.';
            
            bot.answerCallbackQuery(query.id, { text: msg, show_alert: true });
        }
        return;
    }

    // Gender Selection
    if (data.startsWith('gender_')) {
        console.log('Gender button clicked:', { userId, data, currentState: userStates.get(userId) });
        
        const state = userStates.get(userId);
        if (state !== 'awaiting_gender') {
            console.log('Wrong state for gender selection:', state);
            bot.answerCallbackQuery(query.id, { text: '❌ Please use /start to register.', show_alert: true });
            return;
        }
        
        const gender = data.replace('gender_', '');
        console.log('Gender selected:', { userId, gender });
        
        bot.answerCallbackQuery(query.id, { text: `Selected: ${gender === 'male' ? '👨 Male' : '👩 Female'}` });
        
        try {
            await bot.deleteMessage(chatId, messageId);
        } catch (error) {
            console.log('Could not delete gender message:', error.message);
        }
        
        await askNickname(chatId, userId, gender);
        return;
    }

    // Find Partner with Gender Preference
    if (data.startsWith('find_')) {
        const user = await getUser(userId);
        if (!user) {
            bot.sendMessage(chatId, '❌ User not found.');
            return;
        }

        if (activeChats.has(userId)) {
            bot.sendMessage(chatId, '💬 You are already in a chat!');
            return;
        }

        let preferredGender = null;
        if (data === 'find_male') preferredGender = 'male';
        else if (data === 'find_female') preferredGender = 'female';

        const partnerId = await findPartner(userId, preferredGender);
        
        if (partnerId) {
            await startChat(userId, partnerId);
        } else {
            const genderText = preferredGender ? ` ${preferredGender}` : '';
            bot.sendMessage(chatId, `🔍 Looking for${genderText} partner...`);
        }
        return;
    }

    // Send Gift
    if (data === 'send_gift') {
        const partnerId = activeChats.get(userId);
        if (!partnerId) {
            bot.answerCallbackQuery(query.id, { text: '❌ You are not in a chat.', show_alert: true });
            return;
        }

        const prices = [{
            label: 'Reveal Partner Identity',
            amount: 10
        }];

        bot.sendInvoice(
            chatId,
            '🎁 Reveal Partner Identity',
            'Pay 10 stars to reveal your partner\'s Telegram username and ID. Both of you will see each other\'s information.',
            `reveal_identity_${partnerId}`,
            '',
            'XTR',
            prices
        ).catch(error => {
            console.error('Invoice error:', error);
            bot.sendMessage(chatId, '❌ Failed to create payment. Please try again.');
        });
        return;
    }

    // Report Partner
    if (data === 'report_partner') {
        const partnerId = activeChats.get(userId);
        if (!partnerId) {
            bot.sendMessage(chatId, '❌ You are not in a chat.');
            return;
        }

        const keyboard = {
            inline_keyboard: [
                [{ text: 'Spam/Scam', callback_data: `report_spam_${partnerId}` }],
                [{ text: 'Inappropriate Content', callback_data: `report_inappropriate_${partnerId}` }],
                [{ text: 'Harassment', callback_data: `report_harassment_${partnerId}` }],
                [{ text: 'Other', callback_data: `report_other_${partnerId}` }]
            ]
        };

        bot.sendMessage(chatId, '🚨 Why are you reporting this user?', { reply_markup: keyboard });
        return;
    }

    // Handle Report Reasons
    if (data.startsWith('report_')) {
        const parts = data.split('_');
        const reason = parts[1];
        const reportedUserId = parseInt(parts[2]);

        // Premium users cannot be reported
        const reportedUser = await User.findOne({ telegramId: reportedUserId });
        if (reportedUser && reportedUser.isPremium) {
            bot.answerCallbackQuery(query.id, { 
                text: '⭐ Premium users cannot be reported.', 
                show_alert: true 
            });
            return;
        }

        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const existingReport = await Report.findOne({
            reporterUserId: userId,
            reportedUserId: reportedUserId,
            date: { $gte: sevenDaysAgo }
        });

        if (existingReport) {
            bot.answerCallbackQuery(query.id, { 
                text: '⚠️ You already reported this user recently.', 
                show_alert: true 
            });
            return;
        }

        const report = new Report({
            reportedUserId: reportedUserId,
            reporterUserId: userId,
            reason: reason
        });
        await report.save();

        if (reportedUser) {
            const uniqueReports = await Report.distinct('reporterUserId', { 
                reportedUserId: reportedUserId 
            });
            reportedUser.reportCount = uniqueReports.length;
            await reportedUser.save();
            
            // Auto-ban at 50 reports (only non-premium)
            await checkAndAutoBan(reportedUser, reason, 'reports');
        }

        bot.answerCallbackQuery(query.id, { text: '✅ Report submitted' });
        bot.sendMessage(chatId, '✅ Report submitted. Thank you for keeping our community safe!');

        // Notify admins
        ADMIN_IDS.forEach(adminId => {
            bot.sendMessage(adminId, 
                `🚨 New Report\n\n` +
                `Reported: ${reportedUser?.nickname || 'Unknown'} (${reportedUserId})\n` +
                `Reporter: ${userId}\n` +
                `Reason: ${reason}\n` +
                `Total Unique Reports: ${reportedUser?.reportCount || 0}\n` +
                `Time: ${new Date().toLocaleString()}`
            ).catch(() => {});
        });
        return;
    }

    // Safe Mode Toggle
    if (data === 'safe_mode_menu') {
        const user = await getUser(userId);
        const status = user.safeMode ? 'ON' : 'OFF';
        
        const keyboard = {
            inline_keyboard: [
                [{ text: `🔒 Safe Mode: ${status}`, callback_data: 'toggle_safe_mode' }]
            ]
        };

        bot.editMessageText(
            `🔒 Safe Mode Settings\n\n` +
            `Current: ${status}\n\n` +
            `Safe Mode blocks all media from strangers.\n` +
            `• ON = Text only (safest)\n` +
            `• OFF = All media allowed`,
            {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: keyboard
            }
        );
        return;
    }

    if (data === 'toggle_safe_mode') {
        const user = await getUser(userId);
        user.safeMode = !user.safeMode;
        await user.save();

        const status = user.safeMode ? 'ON' : 'OFF';
        
        bot.editMessageText(
            `✅ Safe Mode is now ${status}`,
            {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: `🔒 Safe Mode: ${status}`, callback_data: 'toggle_safe_mode' }]
                    ]
                }
            }
        );
        return;
    }

    // Premium Menu
    if (data === 'premium_menu') {
        const user = await getUser(userId);
        const isPremium = await checkPremiumStatus(user);
        
        let message = `⭐ Premium Membership\n\n`;
        
        if (isPremium) {
            const daysLeft = Math.ceil((user.premiumExpire - new Date()) / (1000 * 60 * 60 * 24));
            message += `✅ Status: Active\n` +
                `📅 ${daysLeft} days remaining\n\n` +
                `🎯 Benefits:\n` +
                `• Choose gender\n` +
                `• Priority matching\n` +
                `• Premium badge\n` +
                `• Cannot be reported`;
        } else {
            message += `💎 Benefits:\n` +
                `• Choose gender preference\n` +
                `• Priority queue\n` +
                `• Premium badge\n` +
                `• Cannot be reported`;
        }

        const keyboard = {
            inline_keyboard: [
                [{ text: '⭐ 1 Day - 10 Stars', callback_data: 'buy_premium_1' }],
                [{ text: '⭐⭐ 7 Days - 30 Stars', callback_data: 'buy_premium_7' }],
                [{ text: '⭐⭐⭐ 30 Days - 50 Stars', callback_data: 'buy_premium_30' }]
            ]
        };

        bot.editMessageText(message, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: keyboard
        });
        return;
    }

    // Premium Purchase
    if (data.startsWith('buy_premium_')) {
        const days = parseInt(data.replace('buy_premium_', ''));
        let price, title;

        if (days === 1) {
            price = 10;
            title = '1 Day Premium';
        } else if (days === 7) {
            price = 30;
            title = '7 Days Premium';
        } else if (days === 30) {
            price = 50;
            title = '30 Days Premium';
        }

        const prices = [{
            label: title,
            amount: price
        }];

        bot.sendInvoice(
            chatId,
            title,
            `Get ${days} days of premium access with gender selection and priority matching!`,
            `premium_${days}_days`,
            '',
            'XTR',
            prices
        ).catch(error => {
            console.error('Invoice error:', error);
            bot.sendMessage(chatId, '❌ Failed to create invoice. Please try again.');
        });
        return;
    }

    // Admin Panel Callbacks
    if (data.startsWith('admin_')) {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Access denied' });
            return;
        }

        if (data === 'admin_full_stats') {
            const totalUsers = await User.countDocuments();
            const activeUsers = await User.countDocuments({ isActive: true });
            const premiumUsers = await User.countDocuments({ isPremium: true });
            const bannedUsers = await User.countDocuments({ isActive: false });
            const totalReports = await Report.countDocuments();
            const unresolvedReports = await Report.countDocuments({ resolved: false });
            
            bot.answerCallbackQuery(query.id);
            bot.sendMessage(chatId,
                `📊 *Detailed Statistics*\n\n` +
                `👥 Total Users: ${totalUsers}\n` +
                `✅ Active: ${activeUsers}\n` +
                `🚫 Banned: ${bannedUsers}\n` +
                `⭐ Premium: ${premiumUsers}\n` +
                `💬 Active Chats: ${Math.floor(activeChats.size / 2)}\n` +
                `⏳ In Queue: ${waitingQueue.size}\n` +
                `🚨 Total Reports: ${totalReports}\n` +
                `⚠️ Unresolved: ${unresolvedReports}\n` +
                `📅 Daily Active: ${stats.dailyActiveUsers.size}`,
                { parse_mode: 'Markdown' }
            );
        } else if (data === 'admin_users_info') {
            bot.answerCallbackQuery(query.id, { text: 'Use /users command for detailed list' });
        } else if (data === 'admin_view_chats') {
            bot.answerCallbackQuery(query.id, { text: 'Use /activechats command' });
        } else if (data === 'admin_reports_list') {
            bot.answerCallbackQuery(query.id, { text: 'Use /reports command' });
        } else if (data === 'admin_banned_list') {
            bot.answerCallbackQuery(query.id, { text: 'Use /banned command' });
        } else if (data === 'admin_premium_list') {
            const premiumUsers = await User.find({ isPremium: true }).limit(10);
            let msg = '⭐ *Top Premium Users:*\n\n';
            
            for (const user of premiumUsers) {
                const daysLeft = user.premiumExpire ? Math.ceil((user.premiumExpire - new Date()) / (1000 * 60 * 60 * 24)) : 0;
                msg += `• ${user.nickname} - ${daysLeft} days left\n`;
            }
            msg += `\nUse /supporters for full list`;
            
            bot.answerCallbackQuery(query.id);
            bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        } else if (data === 'admin_do_broadcast') {
            bot.answerCallbackQuery(query.id, { text: 'Use /broadcast command' });
        } else if (data === 'admin_do_broadcast_premium') {
            bot.answerCallbackQuery(query.id, { text: 'Use /broadcastpremium command' });
        } else if (data === 'admin_help') {
            const helpText = `📖 *Admin Commands*\n\n` +
                `*User Management:*\n` +
                `/ban <id> [reason]\n` +
                `/unban <id>\n` +
                `/warn <id> <reason>\n` +
                `/resetreports <id>\n` +
                `/resetabuse <id>\n\n` +
                `*Premium:*\n` +
                `/grantpremium <id> <days>\n` +
                `/cancelpremium <id>\n\n` +
                `*Monitoring:*\n` +
                `/activechats\n` +
                `/endchat <id>\n` +
                `/banned\n` +
                `/reports\n` +
                `/users\n` +
                `/supporters\n\n` +
                `*New Commands:*\n` +
                `/givemsg <id> <text>\n` +
                `/matchinfo <id>\n` +
                `/userinfo <id>\n\n` +
                `*Broadcast:*\n` +
                `/broadcast\n` +
                `/broadcastpremium`;
            
            bot.answerCallbackQuery(query.id);
            bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
        }
        return;
    }
});

// Pre-checkout query handler
bot.on('pre_checkout_query', (query) => {
    bot.answerPreCheckoutQuery(query.id, true);
});

// Successful payment handler
bot.on('successful_payment', async (msg) => {
    const payment = msg.successful_payment;
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const payload = payment.invoice_payload;
    const amount = payment.total_amount;

    if (payload.startsWith('premium_')) {
        const user = await getUser(userId);
        if (!user) return;

        const days = parseInt(payload.split('_')[1]);
        
        const expireDate = new Date();
        if (user.isPremium && user.premiumExpire > new Date()) {
            expireDate.setTime(user.premiumExpire.getTime());
        }
        expireDate.setDate(expireDate.getDate() + days);

        user.isPremium = true;
        user.premiumExpire = expireDate;
        user.premiumHistory.push({
            amount: amount,
            days: days,
            purchaseDate: new Date(),
            expiryDate: expireDate,
            transactionId: payment.telegram_payment_charge_id
        });
        await user.save();

        bot.sendMessage(chatId,
            `🎉 Premium Activated!\n\n` +
            `⭐ Duration: ${days} days\n` +
            `📅 Expires: ${expireDate.toLocaleDateString()}\n\n` +
            `🎯 You can now:\n` +
            `• 👨👩 Choose gender preference\n` +
            `• ⚡ Get priority matching\n` +
            `• ⭐ Show premium badge\n` +
            `• 🛡️ Cannot be reported\n\n` +
            `Use /chat to start!`
        );

        ADMIN_IDS.forEach(adminId => {
            bot.sendMessage(adminId,
                `💰 Premium Purchase\n\n` +
                `👤 User: ${user.nickname} (${userId})\n` +
                `📦 Plan: ${days} days\n` +
                `💵 Amount: ${amount} Stars\n` +
                `🆔 Transaction: ${payment.telegram_payment_charge_id}`
            ).catch(() => {});
        });
    }
    else if (payload.startsWith('reveal_identity_')) {
        const partnerId = parseInt(payload.replace('reveal_identity_', ''));
        
        if (activeChats.get(userId) !== partnerId) {
            bot.sendMessage(chatId, '❌ Chat session ended. Payment will be refunded.');
            return;
        }

        const user = await getUser(userId, msg.from.username);
        const partner = await getUser(partnerId);

        if (!user || !partner) {
            bot.sendMessage(chatId, '❌ Error retrieving user information.');
            return;
        }

        const userInfo = `👤 *Your Partner's Info:*\n\n` +
            `🏷️ Nickname: ${partner.nickname}\n` +
            `🆔 Telegram ID: \`${partnerId}\`\n` +
            `👤 Username: ${partner.username ? '@' + partner.username : 'Not set'}\n\n` +
            `💬 You can now contact them directly!`;

        const partnerInfo = `🎁 *Partner Revealed Their Identity!*\n\n` +
            `👤 Their Info:\n` +
            `🏷️ Nickname: ${user.nickname}\n` +
            `🆔 Telegram ID: \`${userId}\`\n` +
            `👤 Username: ${user.username ? '@' + user.username : 'Not set'}\n\n` +
            `💬 They paid to reveal identities!`;

        bot.sendMessage(chatId, userInfo, { parse_mode: 'Markdown' });
        bot.sendMessage(partnerId, partnerInfo, { parse_mode: 'Markdown' });

        ADMIN_IDS.forEach(adminId => {
            bot.sendMessage(adminId,
                `🎁 Identity Reveal Purchase\n\n` +
                `👤 Buyer: ${user.nickname} (${userId})\n` +
                `🤝 Partner: ${partner.nickname} (${partnerId})\n` +
                `💵 Amount: 10 Stars\n` +
                `🆔 Transaction: ${payment.telegram_payment_charge_id}`
            ).catch(() => {});
        });
    }
});

// Message Handler with IMPROVED ANTI-ABUSE
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // CRITICAL: Only process private messages
    if (msg.chat.type !== 'private') return;
    
    // Skip commands
    if (msg.text && msg.text.startsWith('/')) return;

    const state = userStates.get(userId);

    // Handle Registration Flow
    if (state && state.includes('awaiting_')) {
        if (state.startsWith('awaiting_nickname:')) {
            const nickname = msg.text?.trim();
            
            console.log('Nickname input received:', { userId, nickname, state });
            
            if (!nickname) {
                bot.sendMessage(chatId, '❌ Please enter a valid nickname.');
                return;
            }

            if (!isValidNickname(nickname)) {
                bot.sendMessage(chatId, 
                    '❌ Invalid nickname!\n\n' +
                    'Please choose:\n' +
                    '• 2-20 characters\n' +
                    '• No offensive words\n' +
                    '• Be respectful'
                );
                return;
            }

            const parts = state.split(':');
            const gender = parts[1];
            
            console.log('Extracted gender:', { gender, fullState: state });

            if (!gender || (gender !== 'male' && gender !== 'female')) {
                console.error('Invalid gender extracted:', gender);
                bot.sendMessage(chatId, '❌ Error with gender selection. Please use /start again.');
                userStates.delete(userId);
                return;
            }

            const success = await completeRegistration(userId, gender, nickname);
            
            if (success) {
                bot.sendMessage(chatId, 
                    `✅ Registration Complete!\n\n` +
                    `🏷️ Nickname: ${nickname}\n` +
                    `🎭 Gender: ${gender === 'male' ? '👨 Male' : '👩 Female'}\n\n` +
                    `💬 Use /chat to start chatting!\n` +
                    `⭐ Use /premium to get gender selection!`
                );
            } else {
                bot.sendMessage(chatId, '❌ Registration failed. Please try /start again.');
            }
            return;
        }

        // Handle Broadcast
        if (state === 'awaiting_broadcast' && isAdmin(userId)) {
            userStates.delete(userId);
            
            const users = await User.find({ isActive: true });
            let successCount = 0;
            let failCount = 0;

            bot.sendMessage(chatId, `📢 Broadcasting to ${users.length} users...`);

            for (const user of users) {
                try {
                    if (msg.text) {
                        await bot.sendMessage(user.telegramId, `📢 Announcement:\n\n${msg.text}`);
                    } else if (msg.photo) {
                        await bot.sendPhoto(user.telegramId, msg.photo[msg.photo.length - 1].file_id, {
                            caption: msg.caption ? `📢 Announcement:\n\n${msg.caption}` : '📢 Announcement'
                        });
                    } else if (msg.video) {
                        await bot.sendVideo(user.telegramId, msg.video.file_id, {
                            caption: msg.caption ? `📢 Announcement:\n\n${msg.caption}` : '📢 Announcement'
                        });
                    } else if (msg.document) {
                        await bot.sendDocument(user.telegramId, msg.document.file_id, {
                            caption: msg.caption ? `📢 Announcement:\n\n${msg.caption}` : '📢 Announcement'
                        });
                    }
                    successCount++;
                    
                    await new Promise(resolve => setTimeout(resolve, 50));
                } catch (error) {
                    failCount++;
                }
            }

            bot.sendMessage(chatId, 
                `✅ Broadcast Complete!\n\n` +
                `✅ Success: ${successCount}\n` +
                `❌ Failed: ${failCount}`
            );
            return;
        }

        // Handle Premium-Only Broadcast
        if (state === 'awaiting_premium_broadcast' && isAdmin(userId)) {
            userStates.delete(userId);
            
            const premiumUsers = await User.find({ isActive: true, isPremium: true });
            let successCount = 0;
            let failCount = 0;

            bot.sendMessage(chatId, `📢 Broadcasting to ${premiumUsers.length} premium users...`);

            for (const user of premiumUsers) {
                try {
                    if (msg.text) {
                        await bot.sendMessage(user.telegramId, `⭐ Premium Announcement:\n\n${msg.text}`);
                    } else if (msg.photo) {
                        await bot.sendPhoto(user.telegramId, msg.photo[msg.photo.length - 1].file_id, {
                            caption: msg.caption ? `⭐ Premium Announcement:\n\n${msg.caption}` : '⭐ Premium Announcement'
                        });
                    } else if (msg.video) {
                        await bot.sendVideo(user.telegramId, msg.video.file_id, {
                            caption: msg.caption ? `⭐ Premium Announcement:\n\n${msg.caption}` : '⭐ Premium Announcement'
                        });
                    } else if (msg.document) {
                        await bot.sendDocument(user.telegramId, msg.document.file_id, {
                            caption: msg.caption ? `⭐ Premium Announcement:\n\n${msg.caption}` : '⭐ Premium Announcement'
                        });
                    }
                    successCount++;
                    
                    await new Promise(resolve => setTimeout(resolve, 50));
                } catch (error) {
                    failCount++;
                }
            }

            bot.sendMessage(chatId, 
                `✅ Premium Broadcast Complete!\n\n` +
                `⭐ Premium Users: ${premiumUsers.length}\n` +
                `✅ Success: ${successCount}\n` +
                `❌ Failed: ${failCount}`
            );
            return;
        }
    }

    // Handle Chat Messages with IMPROVED ANTI-ABUSE
    const partnerId = activeChats.get(userId);
    if (!partnerId) return;

    const user = await getUser(userId);
    const partner = await getUser(partnerId);

    if (!user || !partner) return;

    if (!user.isActive || !partner.isActive) {
        endChat(userId);
        bot.sendMessage(chatId, '❌ Chat ended due to restrictions.');
        if (partner.isActive) {
            bot.sendMessage(partnerId, '❌ Chat ended due to restrictions.');
        }
        return;
    }

    // 🛡️ ANTI-ABUSE CHECKS (Skip for premium users)
    if (!user.isPremium) {
        const now = Date.now();
        
        // 1. Flood detection (20 messages in 10 seconds)
        if (!user.floodMessages) user.floodMessages = [];
        user.floodMessages.push(now);
        user.floodMessages = user.floodMessages.filter(t => now - t < 10000);
        
        if (user.floodMessages.length >= 20) {
            const banned = await checkAndAutoBan(user, 'Flooding: 20+ messages in 10 seconds', 'flood');
            if (banned) return;
        }
        
        // 2. Bad word detection
        if (msg.text && containsBadWords(msg.text)) {
            const badWordCount = countBadWords(msg.text);
            user.badWordCount += badWordCount;
            await user.save();
            
            const banned = await checkAndAutoBan(user, `Bad words detected (${user.badWordCount} total)`, 'badwords');
            if (banned) return;
        }
        
        // 3. Link spam detection
        if (msg.text && containsLinks(msg.text)) {
            const linkCount = countLinks(msg.text);
            user.linkSpamCount += linkCount;
            await user.save();
            
            const banned = await checkAndAutoBan(user, `Link spam detected (${user.linkSpamCount} total)`, 'links');
            if (banned) return;
        }
        
        // 4. Repeat spam detection (15 identical messages)
        if (msg.text) {
            if (!user.lastMessages) user.lastMessages = [];
            user.lastMessages.push(msg.text);
            if (user.lastMessages.length > 20) user.lastMessages.shift();
            
            const messageCount = user.lastMessages.filter(m => m === msg.text).length;
            if (messageCount >= 15) {
                user.repeatSpamCount = messageCount;
                await user.save();
                
                const banned = await checkAndAutoBan(user, `Repeat spam: ${messageCount} identical messages`, 'repeat');
                if (banned) return;
            }
        }
    }

    try {
        // Handle different message types
        if (msg.text) {
            if (containsBadWords(msg.text)) {
                const maskedText = maskBadWords(msg.text);
                await bot.sendMessage(partnerId, maskedText);
                await bot.sendMessage(chatId, '⚠️ Message filtered for inappropriate content.');
            } else {
                await bot.sendMessage(partnerId, msg.text);
            }
        } else if (msg.photo) {
            if (partner.safeMode) {
                await bot.sendMessage(partnerId, '📷 [Photo blocked by Safe Mode]');
                await bot.sendMessage(chatId, '📷 Photo blocked by partner\'s Safe Mode.');
            } else {
                await bot.sendPhoto(partnerId, msg.photo[msg.photo.length - 1].file_id, {
                    caption: msg.caption || ''
                });
            }
        } else if (msg.video) {
            if (partner.safeMode) {
                await bot.sendMessage(partnerId, '🎥 [Video blocked by Safe Mode]');
                await bot.sendMessage(chatId, '🎥 Video blocked by partner\'s Safe Mode.');
            } else {
                await bot.sendVideo(partnerId, msg.video.file_id, {
                    caption: msg.caption || ''
                });
            }
        } else if (msg.document) {
            if (partner.safeMode) {
                await bot.sendMessage(partnerId, '📄 [Document blocked by Safe Mode]');
                await bot.sendMessage(chatId, '📄 Document blocked by partner\'s Safe Mode.');
            } else {
                await bot.sendDocument(partnerId, msg.document.file_id, {
                    caption: msg.caption || ''
                });
            }
        } else if (msg.audio) {
            if (partner.safeMode) {
                await bot.sendMessage(partnerId, '🎵 [Audio blocked by Safe Mode]');
                await bot.sendMessage(chatId, '🎵 Audio blocked by partner\'s Safe Mode.');
            } else {
                await bot.sendAudio(partnerId, msg.audio.file_id);
            }
        } else if (msg.voice) {
            if (partner.safeMode) {
                await bot.sendMessage(partnerId, '🎤 [Voice blocked by Safe Mode]');
                await bot.sendMessage(chatId, '🎤 Voice blocked by partner\'s Safe Mode.');
            } else {
                await bot.sendVoice(partnerId, msg.voice.file_id);
            }
        } else if (msg.sticker) {
            if (partner.safeMode) {
                await bot.sendMessage(partnerId, '😀 [Sticker blocked by Safe Mode]');
                await bot.sendMessage(chatId, '😀 Sticker blocked by partner\'s Safe Mode.');
            } else {
                await bot.sendSticker(partnerId, msg.sticker.file_id);
            }
        }
        
        // Save user state to persist abuse counters
        if (!user.isPremium) {
            await user.save();
        }
    } catch (error) {
        console.error('Message relay error:', error);
        bot.sendMessage(chatId, '❌ Failed to send message.');
        endChat(userId);
    }
});

// Express server
app.use(express.json());
app.use(express.static('public'));

app.get('/', async (req, res) => {
    const totalUsers = await User.countDocuments();
    res.json({
        status: 'Bot is running!',
        users: totalUsers,
        activeChats: Math.floor(activeChats.size / 2),
        uptime: process.uptime()
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`✅ Bot started successfully!`);
});

// Error Handling
bot.on('error', (error) => {
    console.error('Bot error:', error);
});

bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await mongoose.connection.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    await mongoose.connection.close();
    process.exit(0);
});
