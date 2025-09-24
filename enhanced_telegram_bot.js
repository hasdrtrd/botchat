// server.js - Enhanced Telegram Chat Bot
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const path = require('path');

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id)) : [];
const CHANNEL_LINK = process.env.CHANNEL_LINK || 'https://t.me/yourchannel';
const GROUP_LINK = process.env.GROUP_LINK || 'https://t.me/yourgroup';
const BOT_USERNAME = process.env.BOT_USERNAME || 'YourBotUsername'; // Add your bot username
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
    totalReports: 0,
    totalEarnings: 0
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
            reportCount: 0,
            supporter: false,
            supportAmount: 0,
            lastSupport: null,
            totalShares: 0
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
    
    const user = getUser(userId);
    const isSupporter = user.supporter && user.supportAmount > 0;
    
    // Priority matching: supporters get matched with other supporters first
    if (isSupporter) {
        // Find supporter partner first
        for (const partnerId of waitingQueue) {
            if (partnerId !== userId) {
                const partner = getUser(partnerId);
                if (partner.supporter && partner.supportAmount > 0) {
                    waitingQueue.delete(partnerId);
                    return partnerId;
                }
            }
        }
    }
    
    // Find any available partner
    for (const partnerId of waitingQueue) {
        if (partnerId !== userId) {
            waitingQueue.delete(partnerId);
            return partnerId;
        }
    }
    
    // No partner found, add to queue with priority
    if (isSupporter) {
        // Supporters get priority position (added first to be matched first)
        const queueArray = Array.from(waitingQueue);
        waitingQueue.clear();
        waitingQueue.add(userId);
        queueArray.forEach(id => waitingQueue.add(id));
    } else {
        waitingQueue.add(userId);
    }
    
    return null;
}

function startChat(user1Id, user2Id) {
    activeChats.set(user1Id, user2Id);
    activeChats.set(user2Id, user1Id);
    waitingQueue.delete(user1Id);
    waitingQueue.delete(user2Id);
    
    // Check if both are supporters for special message
    const user1 = getUser(user1Id);
    const user2 = getUser(user2Id);
    const bothSupporters = user1.supporter && user2.supporter;
    
    let connectMessage = '💬 Connected! You can now chat anonymously. Use /stop to end chat.';
    
    if (bothSupporters) {
        connectMessage = '💬✨ Connected with fellow supporter! You can now chat anonymously. Use /stop to end chat.\n\n🌟 Thank you both for supporting our bot!';
    } else if (user1.supporter) {
        bot.sendMessage(user1Id, '💬⭐ Connected! As a supporter, you get priority matching. Chat away!');
        bot.sendMessage(user2Id, connectMessage);
        return;
    } else if (user2.supporter) {
        bot.sendMessage(user2Id, '💬⭐ Connected! As a supporter, you get priority matching. Chat away!');
        bot.sendMessage(user1Id, connectMessage);
        return;
    }
    
    // Send same message to both if both supporters or both regular users
    bot.sendMessage(user1Id, connectMessage);
    bot.sendMessage(user2Id, connectMessage);
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

// Generate random support tip
function getRandomSupportTip() {
    const tips = [
        "💡 Tip: Support us with /support to get priority matching!",
        "🌟 Love our bot? Consider supporting us with Telegram Stars!",
        "⚡ Supporters get faster matching and special features!",
        "💖 Help us grow by using /support - every Star counts!",
        "🚀 Want premium features? Check out /support!",
        "⭐ Share the love! Use /share to tell friends about us!"
    ];
    return tips[Math.floor(Math.random() * tips.length)];
}

// Bot commands
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const user = getUser(userId); // Initialize user
    
    let welcomeMessage = `🎉 Welcome to StrangerTalk Bot!
Stay anonymous, safe & have fun chatting with strangers worldwide.

💬 Tap /chat to find someone to talk with!
🔒 Use /safemode to control media filtering
📊 Check /premium for exclusive features

${getRandomSupportTip()}`;

    // Add supporter welcome message
    if (user.supporter && user.supportAmount > 0) {
        welcomeMessage = `🎉 Welcome back, Premium User!

⭐ Thank you for your ${user.supportAmount} Stars support!
🚀 You have priority matching and exclusive features!

💬 Ready to chat? Use /chat to get matched faster!`;
    }

    const options = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '💬 Start Chatting', callback_data: 'start_chat' },
                    { text: '⭐ Support Us', callback_data: 'show_support' }
                ],
                [
                    { text: '📢 Channel', url: CHANNEL_LINK },
                    { text: '👥 Group', url: GROUP_LINK }
                ],
                [
                    { text: '📤 Share Bot', callback_data: 'share_bot' }
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
    } else {
        // Different waiting messages for supporters vs regular users
        if (user.supporter && user.supportAmount > 0) {
            bot.sendMessage(chatId, '🔍⭐ Looking for a partner... Supporters get priority matching!\n\n✨ Thank you for your support!');
        } else {
            const tipMessage = getRandomSupportTip();
            bot.sendMessage(chatId, `🔍 Looking for a partner... Please wait!\n\n${tipMessage}`);
        }
    }
});

bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const partnerId = endChat(userId);
    
    if (partnerId) {
        const tipMessage = getRandomSupportTip();
        bot.sendMessage(chatId, `⏹ Chat ended. Use /chat to start a new conversation!\n\n${tipMessage}`);
        bot.sendMessage(partnerId, '⏹ Your partner left the chat. Use /chat to find a new partner!');
    } else {
        bot.sendMessage(chatId, '⏹ You are not in a chat currently.');
    }
    
    // Remove from waiting queue if present
    waitingQueue.delete(userId);
});

bot.onText(/\/share/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const user = getUser(userId);
    user.totalShares++;
    
    const shareText = `🤖 Join me on StrangerTalk Bot!

Chat anonymously with people from around the world 🌍

✨ Features:
• Anonymous chatting
• Safe mode protection
• Premium features available
• 24/7 active community

Start chatting now! 👇`;

    const shareUrl = `https://t.me/${BOT_USERNAME}?start=shared_by_${userId}`;
    
    const options = {
        reply_markup: {
            inline_keyboard: [
                [
                    { 
                        text: '📤 Share Bot', 
                        switch_inline_query: shareText + `\n\n${shareUrl}`
                    }
                ],
                [
                    { 
                        text: '📋 Copy Link', 
                        callback_data: `copy_link_${shareUrl}`
                    },
                    { 
                        text: '📨 Forward Bot', 
                        callback_data: 'forward_bot'
                    }
                ]
            ]
        }
    };

    const responseMessage = `📤 Share StrangerTalk Bot!

Help us grow our community! Share the bot with your friends and family.

🎁 The more users join, the faster matching becomes for everyone!

${getRandomSupportTip()}`;

    bot.sendMessage(chatId, responseMessage, options);
});

bot.onText(/\/premium/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const user = getUser(userId);
    
    if (!user.supporter || user.supportAmount === 0) {
        const premiumInfo = `🌟 Premium Features

Support our bot with Telegram Stars and unlock amazing benefits:

⚡ **Priority Matching**
• Get matched 3x faster than regular users
• Skip to front of waiting queue

👑 **Supporter Badge**  
• Special recognition in chats
• Exclusive supporter-only messages

🤝 **Supporter-to-Supporter Matching**
• Higher chance to chat with other supporters
• Premium community experience

🎨 **Exclusive Features**
• Custom welcome messages
• Priority customer support
• Early access to new features

💫 **Coming Soon**
• Custom themes and colors
• Extended chat history
• Special emojis and stickers
• Private supporter group access

Ready to upgrade? Use /support to donate with Telegram Stars!

${getRandomSupportTip()}`;

        const options = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⭐ Support Now', callback_data: 'show_support' }],
                    [{ text: '📤 Share Bot', callback_data: 'share_bot' }]
                ]
            }
        };

        bot.sendMessage(chatId, premiumInfo, options);
        return;
    }
    
    // Show supporter status
    const supportDate = new Date(user.lastSupport).toLocaleDateString();
    const statusMessage = `👑 Your Premium Status

✅ **Active Supporter**
⭐ Total Support: ${user.supportAmount} Stars
📅 Last Support: ${supportDate}
📤 Total Shares: ${user.totalShares}

🎯 **Your Benefits:**
• ⚡ Priority matching (active)
• 👑 Supporter badge (active)  
• 🤝 Supporter-to-supporter matching (active)
• 🎨 Exclusive features (active)

Thank you for supporting StrangerTalk Bot! 💖

Want to support more? Use /support`;

    const options = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '⭐ Support More', callback_data: 'show_support' }],
                [{ text: '📤 Share Bot', callback_data: 'share_bot' }]
            ]
        }
    };

    bot.sendMessage(chatId, statusMessage, options);
});

bot.onText(/\/support/, (msg) => {
    const chatId = msg.chat.id;
    
    const supportMessage = `⭐ Support Our Bot!

Your donations with Telegram Stars help us:
• Keep the service free for everyone
• Add new features and improvements
• Maintain fast, reliable servers
• Create a safe community

Choose your support level:

💡 All supporters get premium features instantly!`;

    const options = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '⭐ 5 Stars - Starter', callback_data: 'buy_stars_5' },
                    { text: '⭐⭐ 25 Stars - Supporter', callback_data: 'buy_stars_25' }
                ],
                [
                    { text: '⭐⭐⭐ 50 Stars - Premium', callback_data: 'buy_stars_50' },
                    { text: '⭐⭐⭐⭐ 100 Stars - VIP', callback_data: 'buy_stars_100' }
                ],
                [
                    { text: '⭐⭐⭐⭐⭐ 500 Stars - Champion', callback_data: 'buy_stars_500' }
                ],
                [
                    { text: '📤 Share Bot Instead', callback_data: 'share_bot' }
                ]
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

Toggle using the button below:

${getRandomSupportTip()}`;

    const options = {
        reply_markup: {
            inline_keyboard: [
                [{ 
                    text: `🔒 Safe Mode: ${status}`, 
                    callback_data: 'toggle_safe_mode' 
                }],
                [{ text: '📤 Share Bot', callback_data: 'share_bot' }]
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
        bot.sendMessage(chatId, '⏹ You are not in a chat currently.');
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
    
    const thankYouMessage = `✅ User reported successfully. Thank you for keeping our community safe!

${getRandomSupportTip()}`;
    
    bot.sendMessage(chatId, thankYouMessage);
    
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
        bot.sendMessage(chatId, '⏹ Access denied. Admin only command.');
        return;
    }
    
    const supporters = Array.from(users.values()).filter(u => u.supporter).length;
    const totalDonations = Array.from(users.values()).reduce((sum, u) => sum + (u.supportAmount || 0), 0);
    const totalShares = Array.from(users.values()).reduce((sum, u) => sum + (u.totalShares || 0), 0);
    
    const statsMessage = `📊 Bot Statistics:

👥 **Users:**
• Total Users: ${stats.totalUsers}
• Active Today: ${stats.dailyActiveUsers.size}
• Supporters: ${supporters}

💬 **Activity:**
• Current Chats: ${Math.floor(activeChats.size / 2)}
• Waiting Queue: ${waitingQueue.size}
• Total Reports: ${stats.totalReports}

💰 **Revenue:**
• Total Donations: ${totalDonations} Stars ⭐
• Total Earnings: $${(totalDonations * 0.013).toFixed(2)} USD

📤 **Growth:**
• Total Shares: ${totalShares}
• Avg. Shares/User: ${(totalShares / stats.totalUsers).toFixed(1)}`;

    bot.sendMessage(chatId, statsMessage);
});

bot.onText(/\/users/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '⏹ Access denied. Admin only command.');
        return;
    }
    
    const recentUsers = Array.from(users.values())
        .sort((a, b) => new Date(b.joinDate) - new Date(a.joinDate))
        .slice(0, 10);
    
    let usersList = '👥 Recent Users (Last 10):\n\n';
    recentUsers.forEach((user, index) => {
        const status = user.isActive ? '✅' : '🚫';
        const supporter = user.supporter ? '⭐' : '';
        const date = new Date(user.joinDate).toLocaleDateString();
        usersList += `${index + 1}. ${status}${supporter} ID: ${user.id} (${date})\n`;
    });
    
    bot.sendMessage(chatId, usersList);
});

bot.onText(/\/reports/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '⏹ Access denied. Admin only command.');
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
        bot.sendMessage(chatId, '⏹ Access denied. Admin only command.');
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
        bot.sendMessage(chatId, '⏹ Access denied. Admin only command.');
        return;
    }
    
    const targetUser = users.get(targetUserId);
    if (!targetUser) {
        bot.sendMessage(chatId, '⏹ User not found.');
        return;
    }
    
    if (!targetUser.isActive) {
        bot.sendMessage(chatId, `⚠️ User ${targetUserId} is already banned.`);
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

bot.onText(/\/unban (\d+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const targetUserId = parseInt(match[1]);
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '⏹ Access denied. Admin only command.');
        return;
    }
    
    const targetUser = users.get(targetUserId);
    if (!targetUser) {
        bot.sendMessage(chatId, '⏹ User not found.');
        return;
    }
    
    if (targetUser.isActive) {
        bot.sendMessage(chatId, `⚠️ User ${targetUserId} is not banned.`);
        return;
    }
    
    targetUser.isActive = true;
    targetUser.reportCount = 0; // Reset report count on unban
    
    try {
        bot.sendMessage(targetUserId, '✅ You have been unbanned! You can now use the bot again. Use /chat to start chatting.');
    } catch (error) {
        // User might have blocked the bot
    }
    
    bot.sendMessage(chatId, `✅ User ${targetUserId} has been unbanned.`);
});

bot.onText(/\/supporters/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '⏹ Access denied. Admin only command.');
        return;
    }
    
    const supporters = Array.from(users.values())
        .filter(user => user.supporter && user.supportAmount > 0)
        .sort((a, b) => b.supportAmount - a.supportAmount);
    
    if (supporters.length === 0) {
        bot.sendMessage(chatId, '💫 No supporters yet. Share the /support command to get donations!');
        return;
    }
    
    let supportersList = `💖 Bot Supporters (${supporters.length}):\n\n`;
    let totalSupport = 0;
    
    supporters.slice(0, 10).forEach((user, index) => {
        const supportDate = new Date(user.lastSupport).toLocaleDateString();
        supportersList += `${index + 1}. ID: ${user.id}\n`;
        supportersList += `   ⭐ ${user.supportAmount} Stars\n`;
        supportersList += `   📅 ${supportDate}\n`;
        supportersList += `   📤 Shares: ${user.totalShares || 0}\n\n`;
        totalSupport += user.supportAmount;
    });
    
    if (supporters.length > 10) {
        supportersList += `... and ${supporters.length - 10} more supporters\n\n`;
        // Calculate total from all supporters
        totalSupport = supporters.reduce((sum, user) => sum + user.supportAmount, 0);
    }
    
    supportersList += `💰 Total Support: ${totalSupport} Stars ⭐\n`;
    supportersList += `💵 Estimated Revenue: $${(totalSupport * 0.013).toFixed(2)} USD`;
    
    bot.sendMessage(chatId, supportersList);
});

bot.onText(/\/banned/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '⏹ Access denied. Admin only command.');
        return;
    }
    
    const bannedUsers = Array.from(users.values()).filter(user => !user.isActive);
    
    if (bannedUsers.length === 0) {
        bot.sendMessage(chatId, '✅ No banned users found.');
        return;
    }
    
    let bannedList = '🚫 Banned Users:\n\n';
    bannedUsers.slice(0, 15).forEach((user, index) => { // Show max 15
        const joinDate = new Date(user.joinDate).toLocaleDateString();
        bannedList += `${index + 1}. ID: ${user.id}\n`;
        bannedList += `   Reports: ${user.reportCount}\n`;
        bannedList += `   Joined: ${joinDate}\n`;
        bannedList += `   Unban: /unban ${user.id}\n\n`;
    });
    
    if (bannedUsers.length > 15) {
        bannedList += `... and ${bannedUsers.length - 15} more banned users`;
    }
    
    bot.sendMessage(chatId, bannedList);
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
        bot.sendMessage(chatId, '⏹ Chat ended due to user restrictions.');
        if (partner.isActive) {
            bot.sendMessage(partnerId, '⏹ Chat ended due to user restrictions.');
        }
        return;
    }
    
    try {
        // Handle different message types
        if (msg.text) {
            // Text message
            if (containsBadWords(msg.text)) {
                const maskedText = maskBadWords(msg.text);
                
                // Add supporter badge to messages from high-tier supporters
                let finalMessage = maskedText;
                if (user.supporter && user.supportAmount >= 50) {
                    finalMessage = `${maskedText}\n\n⭐ _From Premium Supporter_`;
                }
                
                bot.sendMessage(partnerId, finalMessage, { parse_mode: 'Markdown' });
                bot.sendMessage(chatId, '⚠️ Your message contained inappropriate content and was filtered.');
            } else {
                // Add supporter badge to clean messages from high-tier supporters
                let finalMessage = msg.text;
                if (user.supporter && user.supportAmount >= 50) {
                    finalMessage = `${msg.text}\n\n⭐ _From Premium Supporter_`;
                }
                
                bot.sendMessage(partnerId, finalMessage, { parse_mode: 'Markdown' });
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
                // Add supporter badge to sticker messages  
                let caption = '';
                if (user.supporter && user.supportAmount >= 50) {
                    caption = '⭐ From Premium Supporter';
                }
                
                if (caption) {
                    bot.sendSticker(partnerId, msg.sticker.file_id);
                    bot.sendMessage(partnerId, caption);
                } else {
                    bot.sendSticker(partnerId, msg.sticker.file_id);
                }
            }
        }
    } catch (error) {
        console.error('Error relaying message:', error);
        bot.sendMessage(chatId, '⏹ Failed to send message. Your partner might have left.');
        endChat(userId);
    }
});

// Handle callback queries (inline button clicks)
bot.on('callback_query', (query) => {
    const userId = query.from.id;
    const data = query.data;
    const chatId = query.message.chat.id;
    
    if (data === 'toggle_safe_mode') {
        const user = getUser(userId);
        user.safeMode = !user.safeMode;
        
        const status = user.safeMode ? 'ON' : 'OFF';
        bot.answerCallbackQuery(query.id, `Safe Mode: ${status}`);
        
        const options = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: `🔒 Safe Mode: ${status}`, callback_data: 'toggle_safe_mode' }],
                    [{ text: '📤 Share Bot', callback_data: 'share_bot' }]
                ]
            }
        };
        
        bot.editMessageText(`🔒 Safe Mode is now ${status}\n\n${getRandomSupportTip()}`, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            reply_markup: options.reply_markup
        });
    }
    
    // Handle start chat button
    if (data === 'start_chat') {
        bot.answerCallbackQuery(query.id, '🔍 Looking for a partner...');
        // Simulate /chat command
        bot.emit('message', {
            chat: { id: chatId },
            from: { id: userId },
            text: '/chat'
        });
    }
    
    // Handle support button
    if (data === 'show_support') {
        bot.answerCallbackQuery(query.id, '⭐ Support options');
        // Simulate /support command
        bot.emit('message', {
            chat: { id: chatId },
            from: { id: userId },
            text: '/support'
        });
    }
    
    // Handle share bot button
    if (data === 'share_bot') {
        bot.answerCallbackQuery(query.id, '📤 Share with friends!');
        // Simulate /share command
        bot.emit('message', {
            chat: { id: chatId },
            from: { id: userId },
            text: '/share'
        });
    }
    
    // Handle forward bot button
    if (data === 'forward_bot') {
        bot.answerCallbackQuery(query.id, '📨 Bot info sent!');
        const forwardMessage = `🤖 StrangerTalk Bot

Anonymous chat with people worldwide!

✨ Features:
• Safe anonymous chatting
• Media filtering with Safe Mode
• Premium features for supporters
• 24/7 active community

Start here: @${BOT_USERNAME}`;

        bot.sendMessage(chatId, forwardMessage);
    }
    
    // Handle copy link callback
    if (data.startsWith('copy_link_')) {
        const link = data.replace('copy_link_', '');
        bot.answerCallbackQuery(query.id, '📋 Link ready to copy!');
        bot.sendMessage(chatId, `📋 Copy this link to share:\n\n\`${link}\``, { parse_mode: 'Markdown' });
    }
    
    // Handle Stars payment buttons
    if (data.startsWith('buy_stars_')) {
        const amount = data.split('_')[2]; // Extract amount (5, 25, 50, 100, 500)
        const starsAmount = parseInt(amount);
        
        let title, description, benefits;
        
        switch(starsAmount) {
            case 5:
                title = "Starter Support ⭐";
                description = "Thank you for supporting our bot with 5 Stars!";
                benefits = "• Basic supporter badge\n• Priority queue";
                break;
            case 25:
                title = "Supporter Package ⭐⭐";
                description = "Amazing! 25 Stars helps us keep growing!";
                benefits = "• Supporter badge in chats\n• Priority matching\n• Supporter-to-supporter matching";
                break;
            case 50:
                title = "Premium Support ⭐⭐⭐";
                description = "Fantastic! 50 Stars unlocks premium features!";
                benefits = "• Premium supporter badge\n• Priority matching\n• Special welcome messages\n• Early feature access";
                break;
            case 100:
                title = "VIP Support ⭐⭐⭐⭐";
                description = "Incredible! 100 Stars - you're a VIP supporter!";
                benefits = "• VIP supporter status\n• All premium features\n• Priority customer support\n• Exclusive supporter group access";
                break;
            case 500:
                title = "Champion Support ⭐⭐⭐⭐⭐";
                description = "WOW! 500 Stars - you're our champion supporter!";
                benefits = "• Champion supporter status\n• All premium features\n• Direct line to developers\n• Feature request priority\n• Lifetime supporter status";
                break;
        }
        
        try {
            // Create invoice with proper payload structure
            const payload = JSON.stringify({
                type: 'stars_donation',
                amount: starsAmount,
                userId: userId,
                timestamp: Date.now()
            });
            
            bot.sendInvoice(chatId, {
                title: title,
                description: `${description}\n\nWhat you get:\n${benefits}`,
                payload: payload,
                provider_token: "", // Empty for Telegram Stars
                currency: "XTR", // Telegram Stars currency
                prices: [{ 
                    label: `${starsAmount} Telegram Stars`, 
                    amount: starsAmount 
                }],
                // Optional: Add photo
                photo_url: "https://img.icons8.com/fluency/96/star.png",
                photo_width: 96,
                photo_height: 96,
                // Need payment flag
                need_name: false,
                need_phone_number: false,
                need_email: false,
                need_shipping_address: false,
                send_phone_number_to_provider: false,
                send_email_to_provider: false,
                is_flexible: false
            });
            
            bot.answerCallbackQuery(query.id, `💫 Invoice sent for ${starsAmount} Stars!`);
            
            // Send additional info about Telegram Stars
            bot.sendMessage(chatId, `ℹ️ About Telegram Stars:

⭐ Telegram Stars are Telegram's official virtual currency
💳 You can buy Stars in any Telegram app
🔒 Payments are processed securely by Telegram
💰 Stars go directly to our bot owner account

Your support helps us keep this service free for everyone! 💖`);
            
        } catch (error) {
            console.error('Error sending invoice:', error);
            bot.answerCallbackQuery(query.id, "❌ Payment temporarily unavailable");
            bot.sendMessage(chatId, "❌ Sorry, Telegram Stars payments are temporarily unavailable. Please try again later.\n\nMake sure you have:\n• Updated Telegram app\n• Sufficient Stars balance\n• Payment method configured");
        }
    }
});

// Handle pre-checkout query (payment validation)
bot.on('pre_checkout_query', (query) => {
    const preCheckoutQuery = query.preCheckoutQuery;
    const userId = preCheckoutQuery.from.id;
    const totalAmount = preCheckoutQuery.total_amount;
    
    try {
        // Parse payload to verify it's our payment
        const payload = JSON.parse(preCheckoutQuery.invoice_payload);
        
        if (payload.type === 'stars_donation' && payload.userId === userId) {
            // Approve the payment
            bot.answerPreCheckoutQuery(preCheckoutQuery.id, true);
            
            console.log(`Pre-checkout approved: User ${userId} - ${totalAmount} Stars`);
        } else {
            // Reject invalid payments
            bot.answerPreCheckoutQuery(preCheckoutQuery.id, false, "Invalid payment data");
            console.log(`Pre-checkout rejected: Invalid payload for user ${userId}`);
        }
    } catch (error) {
        console.error('Pre-checkout error:', error);
        bot.answerPreCheckoutQuery(preCheckoutQuery.id, false, "Payment processing error");
    }
});

// Handle successful payment
bot.on('successful_payment', (msg) => {
    const payment = msg.successful_payment;
    const userId = msg.from.id;
    const username = msg.from.username || 'Unknown';
    const firstName = msg.from.first_name || 'User';
    const amount = payment.total_amount;
    const currency = payment.currency;
    
    try {
        const payload = JSON.parse(payment.invoice_payload);
        
        // Update user data
        const user = getUser(userId);
        const oldAmount = user.supportAmount || 0;
        user.supporter = true;
        user.supportAmount = oldAmount + amount;
        user.lastSupport = new Date();
        
        // Update stats
        stats.totalEarnings += amount;
        
        // Determine support tier
        let tier = 'Supporter';
        let tierEmoji = '⭐';
        if (user.supportAmount >= 500) {
            tier = 'Champion';
            tierEmoji = '⭐⭐⭐⭐⭐';
        } else if (user.supportAmount >= 100) {
            tier = 'VIP';
            tierEmoji = '⭐⭐⭐⭐';
        } else if (user.supportAmount >= 50) {
            tier = 'Premium';
            tierEmoji = '⭐⭐⭐';
        } else if (user.supportAmount >= 25) {
            tier = 'Supporter';
            tierEmoji = '⭐⭐';
        }
        
        console.log(`Payment successful: ${username} (${userId}) paid ${amount} Stars - Total: ${user.supportAmount}`);
        
        // Thank the user with personalized message
        const thankYouMessage = `🎉 Payment Successful!

Thank you ${firstName} for your generous ${amount} Stars donation! ${tierEmoji}

🏆 **Your Status:** ${tier}
💎 **Total Support:** ${user.supportAmount} Stars
⚡ **Benefits Unlocked:**
${user.supportAmount >= 5 ? '• ✅ Priority matching' : ''}
${user.supportAmount >= 25 ? '\n• ✅ Supporter badge in chats' : ''}
${user.supportAmount >= 50 ? '\n• ✅ Premium supporter features' : ''}
${user.supportAmount >= 100 ? '\n• ✅ VIP status and priority support' : ''}
${user.supportAmount >= 500 ? '\n• ✅ Champion status and direct developer access' : ''}

Your contribution helps us:
💻 Keep the bot running 24/7
🚀 Add new features and improvements
🛡️ Maintain a safe community
🌟 Provide free service to everyone

You're amazing! 💖

Ready to chat with priority matching? Use /chat`;

        const options = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '💬 Start Chatting', callback_data: 'start_chat' },
                        { text: '📤 Share Bot', callback_data: 'share_bot' }
                    ],
                    [
                        { text: '👑 View Premium Status', callback_data: 'show_premium' }
                    ]
                ]
            }
        };

        bot.sendMessage(userId, thankYouMessage, options);
        
        // Notify admins about the payment
        ADMIN_IDS.forEach(adminId => {
            try {
                const adminMessage = `💰 Payment Received!

👤 **User:** @${username} (${firstName})
🆔 **ID:** ${userId}
💳 **Amount:** ${amount} Stars ⭐
💎 **Total Support:** ${user.supportAmount} Stars
🏆 **Tier:** ${tier} ${tierEmoji}
⏰ **Time:** ${new Date().toLocaleString()}

📊 **Bot Stats:**
• Total Earnings: ${stats.totalEarnings} Stars
• Total Users: ${stats.totalUsers}
• Current Supporters: ${Array.from(users.values()).filter(u => u.supporter).length}

Keep growing! 🚀`;
                
                bot.sendMessage(adminId, adminMessage);
            } catch (error) {
                console.error('Error notifying admin:', error);
            }
        });
        
        // Send special welcome message to other supporters about new supporter
        const supporters = Array.from(users.values()).filter(u => u.supporter && u.id !== userId);
        if (supporters.length > 0 && user.supportAmount >= 50) {
            const welcomeMessage = `🎉 New ${tier} Supporter!

Welcome to our premium community! Another amazing supporter just joined us.

Current premium community: ${supporters.length + 1} supporters strong! 💪

Thank you all for making this bot better! ✨`;
            
            // Send to random 3 supporters to avoid spam
            const randomSupporters = supporters.sort(() => 0.5 - Math.random()).slice(0, 3);
            randomSupporters.forEach(supporter => {
                try {
                    bot.sendMessage(supporter.id, welcomeMessage);
                } catch (error) {
                    // Supporter might have blocked the bot
                }
            });
        }
        
    } catch (error) {
        console.error('Error processing successful payment:', error);
        bot.sendMessage(userId, 'Payment received but there was an error processing your supporter status. Please contact an admin.');
    }
});

// Handle payment errors
bot.on('shipping_query', (query) => {
    // We don't use shipping, but handle it to avoid errors
    bot.answerShippingQuery(query.id, false, "We don't ship physical items");
});

// Express server for health checks (required for hosting)
app.use(express.static('public'));
app.use(express.json());

app.get('/', (req, res) => {
    const totalSupporters = Array.from(users.values()).filter(u => u.supporter).length;
    const totalEarnings = Array.from(users.values()).reduce((sum, u) => sum + (u.supportAmount || 0), 0);
    
    res.json({
        status: '🤖 StrangerTalk Bot is running!',
        users: stats.totalUsers,
        supporters: totalSupporters,
        activeChats: Math.floor(activeChats.size / 2),
        earnings: `${totalEarnings} Stars`,
        uptime: Math.floor(process.uptime() / 3600) + ' hours'
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        version: '2.0.0'
    });
});

app.get('/stats', (req, res) => {
    const supporters = Array.from(users.values()).filter(u => u.supporter);
    const totalEarnings = supporters.reduce((sum, u) => sum + (u.supportAmount || 0), 0);
    
    res.json({
        totalUsers: stats.totalUsers,
        dailyActive: stats.dailyActiveUsers.size,
        currentChats: Math.floor(activeChats.size / 2),
        waitingQueue: waitingQueue.size,
        supporters: supporters.length,
        totalEarnings: totalEarnings,
        totalReports: stats.totalReports,
        uptime: process.uptime()
    });
});

// Webhook endpoint for Telegram (optional, for production deployment)
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
    console.log(`🤖 StrangerTalk Bot started successfully!`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`👑 Admins configured: ${ADMIN_IDS.length}`);
});

// Error handling
bot.on('error', (error) => {
    console.error('❌ Bot error:', error);
});

bot.on('polling_error', (error) => {
    console.error('❌ Polling error:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    // Don't exit immediately in production
    if (process.env.NODE_ENV === 'production') {
        console.log('🔄 Attempting to recover...');
        setTimeout(() => process.exit(1), 5000);
    } else {
        process.exit(1);
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('📴 SIGTERM received, shutting down gracefully...');
    bot.stopPolling();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('📴 SIGINT received, shutting down gracefully...');
    bot.stopPolling();
    process.exit(0);
});