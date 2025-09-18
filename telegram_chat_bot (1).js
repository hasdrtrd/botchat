// server.js - Main application file
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const path = require('path');

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id)) : [];
const CHANNEL_LINK = process.env.CHANNEL_LINK || 'https://t.me/yourchannel';
const GROUP_LINK = process.env.GROUP_LINK || 'https://t.me/yourgroup';
const PORT = process.env.PORT || 3000;

// Initialize bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();

// In-memory storage (for MVP - replace with database in production)
const users = new Map(); // userId -> user data
const activeChats = new Map(); // userId -> partnerId
const waitingQueue = new Set(); // users waiting for chat
const reports = new Map(); // userId -> reports array
const stats = {
    totalUsers: 0,
    dailyActiveUsers: new Set(),
    totalReports: 0
};

// Bad words filter (basic implementation)
const badWords = ['spam', 'scam', 'porn', 'xxx', 'sex', 'nude', 'drugs'];

function containsBadWords(text) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    return badWords.some(word => lowerText.includes(word));
}

function maskBadWords(text) {
    let maskedText = text;
    badWords.forEach(word => {
        const regex = new RegExp(word, 'gi');
        maskedText = maskedText.replace(regex, '*'.repeat(word.length));
    });
    return maskedText;
}

// User management
function getUser(userId) {
    if (!users.has(userId)) {
        users.set(userId, {
            id: userId,
            joinDate: new Date(),
            safeMode: true,
            isActive: true,
            reportCount: 0
        });
        stats.totalUsers++;
    }
    stats.dailyActiveUsers.add(userId);
    return users.get(userId);
}

function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

// Chat management
function findPartner(userId) {
    // Remove user from queue if already there
    waitingQueue.delete(userId);
    
    // Find available partner
    for (const partnerId of waitingQueue) {
        if (partnerId !== userId) {
            waitingQueue.delete(partnerId);
            return partnerId;
        }
    }
    
    // No partner found, add to queue
    waitingQueue.add(userId);
    return null;
}

function startChat(user1Id, user2Id) {
    activeChats.set(user1Id, user2Id);
    activeChats.set(user2Id, user1Id);
    waitingQueue.delete(user1Id);
    waitingQueue.delete(user2Id);
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

// Bot commands
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    getUser(userId); // Initialize user
    
    const welcomeMessage = `👋 Welcome to StrangerTalk Bot!
Stay anonymous, safe & have fun.

👉 Tap /chat to find a stranger to talk with!`;

    const options = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📢 Channel', url: CHANNEL_LINK },
                    { text: '💬 Group', url: GROUP_LINK }
                ]
            ]
        }
    };

    bot.sendMessage(chatId, welcomeMessage, options);
});

bot.onText(/\/chat/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const user = getUser(userId);
    
    // Check if user is already in a chat
    if (activeChats.has(userId)) {
        bot.sendMessage(chatId, '💬 You are already in a chat! Use /stop to end current chat first.');
        return;
    }
    
    // Check if user is banned
    if (!user.isActive) {
        bot.sendMessage(chatId, '🚫 You have been banned from using this bot.');
        return;
    }
    
    // Find partner
    const partnerId = findPartner(userId);
    
    if (partnerId) {
        // Start chat with found partner
        startChat(userId, partnerId);
        
        bot.sendMessage(chatId, '💬 Connected! You can now chat anonymously. Use /stop to end chat.');
        bot.sendMessage(partnerId, '💬 Connected! You can now chat anonymously. Use /stop to end chat.');
    } else {
        bot.sendMessage(chatId, '🔍 Looking for a partner... Please wait!');
    }
});

bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const partnerId = endChat(userId);
    
    if (partnerId) {
        bot.sendMessage(chatId, '❌ Chat ended. Use /chat to start a new conversation!');
        bot.sendMessage(partnerId, '❌ Your partner left the chat. Use /chat to find a new partner!');
    } else {
        bot.sendMessage(chatId, '❌ You are not in a chat currently.');
    }
    
    // Remove from waiting queue if present
    waitingQueue.delete(userId);
});

bot.onText(/\/support/, (msg) => {
    const chatId = msg.chat.id;
    
    const supportMessage = `💝 Support Our Bot!

Your donations help us keep this service free and improve features!

⭐ Thank you for your support!`;

    const options = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '⭐ Donate', url: 'https://t.me/donate' }]
            ]
        }
    };

    bot.sendMessage(chatId, supportMessage, options);
});

bot.onText(/\/safemode/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const user = getUser(userId);
    const status = user.safeMode ? 'ON' : 'OFF';
    
    const safeModeMessage = `🔒 Safe Mode Settings

Current Status: **${status}**

Safe Mode blocks ALL media from strangers (photos, videos, documents, audio, voice messages, stickers).

• ON = Only text messages allowed (safest)
• OFF = All media types allowed

Toggle using the button below:`;

    const options = {
        reply_markup: {
            inline_keyboard: [
                [{ 
                    text: `🔒 Safe Mode: ${status}`, 
                    callback_data: 'toggle_safe_mode' 
                }]
            ]
        },
        parse_mode: 'Markdown'
    };

    bot.sendMessage(chatId, safeModeMessage, options);
});

bot.onText(/\/report/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const partnerId = activeChats.get(userId);
    
    if (!partnerId) {
        bot.sendMessage(chatId, '❌ You are not in a chat currently.');
        return;
    }
    
    // Add report
    if (!reports.has(partnerId)) {
        reports.set(partnerId, []);
    }
    reports.get(partnerId).push({
        reporterId: userId,
        date: new Date(),
        reason: 'User reported'
    });
    
    stats.totalReports++;
    
    // Increase report count for reported user
    const reportedUser = getUser(partnerId);
    reportedUser.reportCount++;
    
    bot.sendMessage(chatId, '✅ User reported successfully. Thank you for keeping our community safe!');
    
    // Auto-ban if too many reports
    if (reportedUser.reportCount >= 3) {
        reportedUser.isActive = false;
        bot.sendMessage(partnerId, '🚫 You have been banned due to multiple reports.');
        endChat(partnerId);
    }
});

// Admin commands
bot.onText(/\/stats/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only command.');
        return;
    }
    
    const statsMessage = `📊 Bot Stats:
- Total Users: ${stats.totalUsers}
- Active Users Today: ${stats.dailyActiveUsers.size}
- Current Chats: ${Math.floor(activeChats.size / 2)}
- Reports: ${stats.totalReports}
- Waiting Queue: ${waitingQueue.size}`;

    bot.sendMessage(chatId, statsMessage);
});

bot.onText(/\/users/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only command.');
        return;
    }
    
    const recentUsers = Array.from(users.values())
        .sort((a, b) => new Date(b.joinDate) - new Date(a.joinDate))
        .slice(0, 10);
    
    let usersList = '👥 Recent Users (Last 10):\n\n';
    recentUsers.forEach((user, index) => {
        const status = user.isActive ? '✅' : '🚫';
        const date = new Date(user.joinDate).toLocaleDateString();
        usersList += `${index + 1}. ${status} ID: ${user.id} (${date})\n`;
    });
    
    bot.sendMessage(chatId, usersList);
});

bot.onText(/\/reports/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only command.');
        return;
    }
    
    if (reports.size === 0) {
        bot.sendMessage(chatId, '📋 No reports found.');
        return;
    }
    
    let reportsList = '🚨 Flagged Users:\n\n';
    let count = 0;
    
    for (const [reportedUserId, userReports] of reports) {
        if (count >= 10) break; // Limit to 10 reports
        
        const user = users.get(reportedUserId);
        const status = user?.isActive ? '✅' : '🚫';
        reportsList += `${status} User ID: ${reportedUserId}\n`;
        reportsList += `Reports: ${userReports.length}\n`;
        reportsList += `Latest: ${new Date(userReports[userReports.length - 1].date).toLocaleDateString()}\n\n`;
        count++;
    }
    
    bot.sendMessage(chatId, reportsList);
});

bot.onText(/\/broadcast (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const message = match[1];
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only command.');
        return;
    }
    
    let successCount = 0;
    let failCount = 0;
    
    bot.sendMessage(chatId, `📢 Broadcasting to ${users.size} users...`);
    
    for (const user of users.keys()) {
        try {
            bot.sendMessage(user, `📢 Announcement:\n\n${message}`);
            successCount++;
        } catch (error) {
            failCount++;
        }
    }
    
    bot.sendMessage(chatId, `✅ Broadcast completed!\nSuccess: ${successCount}\nFailed: ${failCount}`);
});

bot.onText(/\/ban (\d+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const targetUserId = parseInt(match[1]);
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only command.');
        return;
    }
    
    const targetUser = users.get(targetUserId);
    if (!targetUser) {
        bot.sendMessage(chatId, '❌ User not found.');
        return;
    }
    
    targetUser.isActive = false;
    endChat(targetUserId); // End any active chat
    
    try {
        bot.sendMessage(targetUserId, '🚫 You have been banned by an administrator.');
    } catch (error) {
        // User might have blocked the bot
    }
    
    bot.sendMessage(chatId, `✅ User ${targetUserId} has been banned.`);
});

// Handle all messages (message relay)
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Skip if it's a command
    if (msg.text && msg.text.startsWith('/')) {
        return;
    }
    
    // Check if user is in a chat
    const partnerId = activeChats.get(userId);
    if (!partnerId) {
        return;
    }
    
    const user = getUser(userId);
    const partner = getUser(partnerId);
    
    // Check if either user is banned
    if (!user.isActive || !partner.isActive) {
        endChat(userId);
        bot.sendMessage(chatId, '❌ Chat ended due to user restrictions.');
        if (partner.isActive) {
            bot.sendMessage(partnerId, '❌ Chat ended due to user restrictions.');
        }
        return;
    }
    
    try {
        // Handle different message types
        if (msg.text) {
            // Text message
            if (containsBadWords(msg.text)) {
                const maskedText = maskBadWords(msg.text);
                bot.sendMessage(partnerId, maskedText);
                bot.sendMessage(chatId, '⚠️ Your message contained inappropriate content and was filtered.');
            } else {
                bot.sendMessage(partnerId, msg.text);
            }
        } else if (msg.photo) {
            // Photo
            if (partner.safeMode) {
                bot.sendMessage(partnerId, '📷 [Photo blocked by Safe Mode]');
                bot.sendMessage(chatId, '📷 Your photo was blocked by your partner\'s Safe Mode.');
            } else {
                bot.sendPhoto(partnerId, msg.photo[msg.photo.length - 1].file_id, {
                    caption: msg.caption || ''
                });
            }
        } else if (msg.video) {
            // Video
            if (partner.safeMode) {
                bot.sendMessage(partnerId, '🎥 [Video blocked by Safe Mode]');
                bot.sendMessage(chatId, '🎥 Your video was blocked by your partner\'s Safe Mode.');
            } else {
                bot.sendVideo(partnerId, msg.video.file_id, {
                    caption: msg.caption || ''
                });
            }
        } else if (msg.document) {
            // Document
            if (partner.safeMode) {
                bot.sendMessage(partnerId, '📄 [Document blocked by Safe Mode]');
                bot.sendMessage(chatId, '📄 Your document was blocked by your partner\'s Safe Mode.');
            } else {
                bot.sendDocument(partnerId, msg.document.file_id, {
                    caption: msg.caption || ''
                });
            }
        } else if (msg.audio) {
            // Audio
            if (partner.safeMode) {
                bot.sendMessage(partnerId, '🎵 [Audio blocked by Safe Mode]');
                bot.sendMessage(chatId, '🎵 Your audio was blocked by your partner\'s Safe Mode.');
            } else {
                bot.sendAudio(partnerId, msg.audio.file_id);
            }
        } else if (msg.voice) {
            // Voice message
            if (partner.safeMode) {
                bot.sendMessage(partnerId, '🎤 [Voice message blocked by Safe Mode]');
                bot.sendMessage(chatId, '🎤 Your voice message was blocked by your partner\'s Safe Mode.');
            } else {
                bot.sendVoice(partnerId, msg.voice.file_id);
            }
        } else if (msg.sticker) {
            // Sticker
            if (partner.safeMode) {
                bot.sendMessage(partnerId, '😀 [Sticker blocked by Safe Mode]');
                bot.sendMessage(chatId, '😀 Your sticker was blocked by your partner\'s Safe Mode.');
            } else {
                bot.sendSticker(partnerId, msg.sticker.file_id);
            }
        }
    } catch (error) {
        console.error('Error relaying message:', error);
        bot.sendMessage(chatId, '❌ Failed to send message. Your partner might have left.');
        endChat(userId);
    }
});

// Handle callback queries (inline button clicks)
bot.on('callback_query', (query) => {
    const userId = query.from.id;
    const data = query.data;
    
    if (data === 'toggle_safe_mode') {
        const user = getUser(userId);
        user.safeMode = !user.safeMode;
        
        const status = user.safeMode ? 'ON' : 'OFF';
        bot.answerCallbackQuery(query.id, `Safe Mode: ${status}`);
        
        const options = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Safe Mode: ${status}`, callback_data: 'toggle_safe_mode' }]
                ]
            }
        };
        
        bot.editMessageText(`🔒 Safe Mode is now ${status}`, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            reply_markup: options.reply_markup
        });
    }
});

// Express server for health checks (required for Render)
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.json({
        status: 'Bot is running!',
        users: stats.totalUsers,
        activeChats: Math.floor(activeChats.size / 2),
        uptime: process.uptime()
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Bot started successfully!`);
});

// Error handling
bot.on('error', (error) => {
    console.error('Bot error:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});