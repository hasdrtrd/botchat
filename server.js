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
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || '@yourchannel'; // e.g., @yourchannel
const GROUP_LINK = process.env.GROUP_LINK || 'https://t.me/yourgroup';
const GROUP_USERNAME = process.env.GROUP_USERNAME || '@yourgroup'; // e.g., @yourgroup
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
    hasJoinedGroup: { type: Boolean, default: false }
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
const activeChats = new Map(); // userId -> partnerId
const waitingQueue = new Map(); // userId -> { gender: 'male'/'female', timestamp }
const userStates = new Map(); // userId -> current state for registration flow
const pendingGifts = new Map(); // userId -> gift data

// Stats tracking
const stats = {
    dailyActiveUsers: new Set()
};

// Bad words filter
const badWords = ['spam', 'scam', 'porn', 'xxx', 'sex', 'nude', 'drugs', 'fuck', 'shit', 'bitch', 'asshole', 'dick', 'pussy', 'nigger', 'faggot'];
const badNicknames = ['admin', 'bot', 'official', 'telegram', 'support', ...badWords];

function containsBadWords(text) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    return badWords.some(word => lowerText.includes(word));
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

// Helper Functions
async function getUser(userId) {
    try {
        let user = await User.findOne({ telegramId: userId });
        if (user) {
            user.lastActive = new Date();
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
        // Check channel membership
        const channelMember = await bot.getChatMember(CHANNEL_USERNAME, userId);
        const isChannelMember = ['member', 'administrator', 'creator'].includes(channelMember.status);

        // Check group membership
        const groupMember = await bot.getChatMember(GROUP_USERNAME, userId);
        const isGroupMember = ['member', 'administrator', 'creator'].includes(groupMember.status);

        return { channel: isChannelMember, group: isGroupMember };
    } catch (error) {
        console.error('Error checking membership:', error);
        return { channel: false, group: false };
    }
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
    userStates.set(userId, 'awaiting_gender');
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: '👨 Male', callback_data: 'gender_male' },
                { text: '👩 Female', callback_data: 'gender_female' }
            ]
        ]
    };

    bot.sendMessage(chatId, 
        `🎭 Please select your gender:\n\n` +
        `⚠️ Note: Gender cannot be changed later!`,
        { reply_markup: keyboard }
    );
}

async function askNickname(chatId, userId) {
    userStates.set(userId, 'awaiting_nickname');
    bot.sendMessage(chatId, 
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

// Chat Management
async function findPartner(userId, preferredGender = null) {
    waitingQueue.delete(userId);
    
    const user = await getUser(userId);
    if (!user) return null;

    const isPremium = await checkPremiumStatus(user);
    
    // If premium and gender preference specified, find matching gender
    if (isPremium && preferredGender) {
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
        // Random matching for non-premium users
        for (const [partnerId] of waitingQueue) {
            if (partnerId !== userId) {
                waitingQueue.delete(partnerId);
                return partnerId;
            }
        }
    }
    
    // Add to queue
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

    // Create chat session record
    const session = new ChatSession({
        user1Id: user1Id,
        user2Id: user2Id
    });
    await session.save();

    const user1 = await getUser(user1Id);
    const user2 = await getUser(user2Id);

    const connectMessage = '💬 Connected! You can now chat anonymously.\n\n' +
        '🎁 Send a Telegram Gift to reveal usernames!\n' +
        '📤 Use /stop to end chat';

    const buttons = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🎁 Send Gift", callback_data: "send_gift" },
                    { text: "🚫 Report", callback_data: "report_partner" }
                ],
                [
                    { text: "📤 Forward to friends", switch_inline_query: "" }
                ]
            ]
        }
    };

    bot.sendMessage(user1Id, `${connectMessage}\n\n👤 Partner: ${user2.nickname}`, buttons);
    bot.sendMessage(user2Id, `${connectMessage}\n\n👤 Partner: ${user1.nickname}`, buttons);
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
    
    const user = await getUser(userId);
    
    if (!user) {
        // New user - start registration
        const canProceed = await startRegistration(chatId, userId);
        if (canProceed) {
            await askGender(chatId, userId);
        }
        return;
    }
    
    // Existing user
    const isPremium = await checkPremiumStatus(user);
    
    let welcomeMessage = `👋 Welcome back, ${user.nickname}!\n\n` +
        `🎭 Stay anonymous, safe & have fun.\n\n` +
        `💬 Tap /chat to find a stranger to talk with!`;

    if (isPremium) {
        const daysLeft = Math.ceil((user.premiumExpire - new Date()) / (1000 * 60 * 60 * 24));
        welcomeMessage += `\n\n⭐ Premium Active (${daysLeft} days left)\n` +
            `• Choose gender preference\n` +
            `• Priority matching`;
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
        // Show gender preference for premium users
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
        // Random matching for non-premium
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

bot.onText(/\/premium/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
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
            `• ⭐ Premium badge\n\n` +
            `Renew your membership below!`;
    } else {
        message += `💎 Benefits:\n` +
            `• 👨👩 Choose gender preference\n` +
            `• ⚡ Priority queue\n` +
            `• ⭐ Premium badge\n\n` +
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
        `🔒 Safe Mode: ${user.safeMode ? 'ON' : 'OFF'}\n`;
    
    if (isPremium) {
        const daysLeft = Math.ceil((user.premiumExpire - new Date()) / (1000 * 60 * 60 * 24));
        profile += `\n⭐ Premium: Active (${daysLeft} days)\n`;
    } else {
        profile += `\n✨ Premium: Inactive\n`;
    }
    
    profile += `\n⚠️ Reports: ${totalReports}`;

    bot.sendMessage(chatId, profile);
});

// Admin Commands
bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only.');
        return;
    }

    const keyboard = {
        inline_keyboard: [
            [
                { text: '📊 Stats', callback_data: 'admin_stats' },
                { text: '👥 Users', callback_data: 'admin_users' }
            ],
            [
                { text: '🚨 Reports', callback_data: 'admin_reports' },
                { text: '🚫 Bans', callback_data: 'admin_bans' }
            ],
            [
                { text: '⭐ Premium', callback_data: 'admin_premium' },
                { text: '📢 Broadcast', callback_data: 'admin_broadcast' }
            ]
        ]
    };

    bot.sendMessage(chatId, '🛡️ Admin Panel', { reply_markup: keyboard });
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
        
        reportsList += `📝 Report ID: ${report._id}\n`;
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
    } catch (error) {
        // User might have blocked bot
    }
    
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
    } catch (error) {
        // User might have blocked bot
    }
    
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
    } catch (error) {
        // User might have blocked bot
    }
    
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
            await askGender(chatId, userId);
        } else {
            let msg = '❌ You must join:\n';
            if (!membership.channel) msg += '• Channel\n';
            if (!membership.group) msg += '• Group\n';
            msg += '\nPlease join and try again.';
            
            bot.sendMessage(chatId, msg);
        }
        return;
    }

    // Gender Selection
    if (data.startsWith('gender_')) {
        const state = userStates.get(userId);
        if (state !== 'awaiting_gender') return;
        
        const gender = data.replace('gender_', '');
        userStates.set(userId, `awaiting_nickname:${gender}`);
        
        await askNickname(chatId, userId);
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
            bot.sendMessage(chatId, '❌ You are not in a chat.');
            return;
        }

        pendingGifts.set(userId, partnerId);
        
        bot.sendMessage(chatId, 
            '🎁 Send a Telegram Gift!\n\n' +
            'Forward any gift to this chat, and your partner will receive it along with your username!\n\n' +
            '⚠️ Once you send a gift, your username will be revealed to your partner.'
        );
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

        const report = new Report({
            reportedUserId: reportedUserId,
            reporterUserId: userId,
            reason: reason
        });
        await report.save();

        const reportedUser = await User.findOne({ telegramId: reportedUserId });
        if (reportedUser) {
            reportedUser.reportCount++;
            
            // Auto-ban after 3 reports
            if (reportedUser.reportCount >= 3) {
                reportedUser.isActive = false;
                await reportedUser.save();
                
                endChat(reportedUserId);
                
                try {
                    bot.sendMessage(reportedUserId, '🚫 You have been banned due to multiple reports.');
                } catch (error) {
                    // User might have blocked bot
                }
            } else {
                await reportedUser.save();
            }
        }

        bot.sendMessage(chatId, '✅ Report submitted. Thank you for keeping our community safe!');

        // Notify admins
        ADMIN_IDS.forEach(adminId => {
            bot.sendMessage(adminId, 
                `🚨 New Report\n\n` +
                `Reported: ${reportedUserId}\n` +
                `Reporter: ${userId}\n` +
                `Reason: ${reason}\n` +
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
                `• Premium badge`;
        } else {
            message += `💎 Benefits:\n` +
                `• Choose gender preference\n` +
                `• Priority queue\n` +
                `• Premium badge`;
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

        if (data === 'admin_stats') {
            const totalUsers = await User.countDocuments();
            const activeUsers = await User.countDocuments({ isActive: true });
            const premiumUsers = await User.countDocuments({ isPremium: true });
            const totalReports = await Report.countDocuments();
            
            bot.editMessageText(
                `📊 Bot Statistics\n\n` +
                `👥 Total: ${totalUsers}\n` +
                `✅ Active: ${activeUsers}\n` +
                `⭐ Premium: ${premiumUsers}\n` +
                `💬 Chatting: ${Math.floor(activeChats.size / 2)}\n` +
                `🚨 Reports: ${totalReports}`,
                { chat_id: chatId, message_id: messageId }
            );
        } else if (data === 'admin_users') {
            bot.sendMessage(chatId, 'Use /users to see user list');
        } else if (data === 'admin_reports') {
            bot.sendMessage(chatId, 'Use /reports to see reports');
        } else if (data === 'admin_bans') {
            const bannedUsers = await User.countDocuments({ isActive: false });
            bot.sendMessage(chatId, `🚫 Banned Users: ${bannedUsers}\n\nUse /banned for list`);
        } else if (data === 'admin_premium') {
            const premiumUsers = await User.find({ isPremium: true }).limit(10);
            let msg = '⭐ Premium Users:\n\n';
            
            for (const user of premiumUsers) {
                const daysLeft = Math.ceil((user.premiumExpire - new Date()) / (1000 * 60 * 60 * 24));
                msg += `${user.nickname} - ${daysLeft} days\n`;
            }
            
            bot.sendMessage(chatId, msg);
        } else if (data === 'admin_broadcast') {
            bot.sendMessage(chatId, 'Use /broadcast to send a message to all users');
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

    const user = await getUser(userId);
    if (!user) return;

    // Extract days from payload
    const days = parseInt(payload.split('_')[1]);
    
    const expireDate = new Date();
    if (user.isPremium && user.premiumExpire > new Date()) {
        // Extend existing premium
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
        `• Choose gender preference\n` +
        `• Get priority matching\n` +
        `• Show premium badge\n\n` +
        `Use /chat to start!`
    );

    // Notify admins
    ADMIN_IDS.forEach(adminId => {
        bot.sendMessage(adminId,
            `💰 Premium Purchase\n\n` +
            `👤 User: ${user.nickname} (${userId})\n` +
            `📦 Plan: ${days} days\n` +
            `💵 Amount: ${amount} Stars\n` +
            `🆔 Transaction: ${payment.telegram_payment_charge_id}`
        ).catch(() => {});
    });
});

// Message Handler
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Skip commands
    if (msg.text && msg.text.startsWith('/')) return;

    const state = userStates.get(userId);

    // Handle Registration Flow
    if (state && state.startsWith('awaiting_')) {
        if (state === 'awaiting_nickname') {
            const nickname = msg.text?.trim();
            
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

            const genderState = userStates.get(userId);
            const gender = genderState.split(':')[1];

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
                    
                    // Small delay to avoid rate limits
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
    }

    // Handle Chat Messages
    const partnerId = activeChats.get(userId);
    if (!partnerId) return;

    const user = await getUser(userId);
    const partner = await getUser(partnerId);

    if (!user || !partner) return;

    // Check if either user is banned
    if (!user.isActive || !partner.isActive) {
        endChat(userId);
        bot.sendMessage(chatId, '❌ Chat ended due to restrictions.');
        if (partner.isActive) {
            bot.sendMessage(partnerId, '❌ Chat ended due to restrictions.');
        }
        return;
    }

    // Handle gift messages
    if (msg.gift && pendingGifts.has(userId)) {
        const expectedPartnerId = pendingGifts.get(userId);
        
        if (expectedPartnerId === partnerId) {
            pendingGifts.delete(userId);
            
            try {
                // Forward gift
                await bot.forwardMessage(partnerId, chatId, msg.message_id);
                
                // Reveal username
                const senderUsername = msg.from.username ? `@${msg.from.username}` : user.nickname;
                await bot.sendMessage(partnerId, 
                    `🎁 Gift received from: ${senderUsername}\n\n` +
                    `You can now contact them directly!`
                );
                
                await bot.sendMessage(chatId, '✅ Gift sent! Your username has been revealed.');
            } catch (error) {
                bot.sendMessage(chatId, '❌ Failed to send gift.');
            }
            return;
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
