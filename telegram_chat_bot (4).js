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
            reportCount: 0,
            supporter: false,
            supportAmount: 0,
            lastSupport: null
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

// Bot commands
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const user = getUser(userId); // Initialize user
    
    let welcomeMessage = `👋 Welcome to StrangerTalk Bot!
Stay anonymous, safe & have fun.

👉 Tap /chat to find a stranger to talk with!`;

    // Add supporter welcome message
    if (user.supporter && user.supportAmount > 0) {
        welcomeMessage += `\n\n⭐ Welcome back, supporter! Thanks for your ${user.supportAmount} Stars donation. You get priority matching!`;
    } else {
        welcomeMessage += `\n\n💝 Like our bot? Support us with /support and get premium features!`;
    }

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
    } else {
        // Different waiting messages for supporters vs regular users
        if (user.supporter && user.supportAmount > 0) {
            bot.sendMessage(chatId, '🔍⭐ Looking for a partner... Supporters get priority matching!');
        } else {
            bot.sendMessage(chatId, '🔍 Looking for a partner... Please wait!\n\n💡 Tip: Supporters get faster matching with /support');
        }
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

bot.onText(/\/premium/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const user = getUser(userId);
    
    if (!user.supporter || user.supportAmount === 0) {
        const premiumInfo = `🌟 Premium Features

Support our bot and unlock premium benefits:

⚡ **Priority Matching**
• Get matched faster than regular users
• Skip to front of waiting queue

👑 **Supporter Badge**  
• Special welcome messages
• Recognition in chats

🤝 **Supporter-to-Supporter**
• Higher chance to chat with other supporters
• Premium community experience

💫 **Future Features**
• Custom themes (coming soon)
• Extended chat history (coming soon)  
• Special emojis (coming soon)

Ready to upgrade? Use /support to donate with Telegram Stars!`;

        bot.sendMessage(chatId, premiumInfo);
        return;
    }
    
    // Show supporter status
    const supportDate = new Date(user.lastSupport).toLocaleDateString();
    const statusMessage = `👑 Your Premium Status

✅ **Active Supporter**
⭐ Total Support: ${user.supportAmount} Stars
📅 Last Support: ${supportDate}

🎯 **Your Benefits:**
• ⚡ Priority matching (active)
• 👑 Supporter badge (active)  
• 🤝 Supporter-to-supporter matching (active)

Thank you for supporting StrangerTalk Bot! 💖

Want to support more? Use /support`;

    bot.sendMessage(chatId, statusMessage);
});
    const chatId = msg.chat.id;
    
    const supportMessage = `💝 Support Our Bot!

Your donations help us keep this service free and improve features!

Choose your support level:`;

    const options = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '⭐ 10 Stars', callback_data: 'buy_stars_10' },
                    { text: '⭐⭐ 50 Stars', callback_data: 'buy_stars_50' }
                ],
                [
                    { text: '⭐⭐⭐ 100 Stars', callback_data: 'buy_stars_100' },
                    { text: '⭐⭐⭐⭐ 500 Stars', callback_data: 'buy_stars_500' }
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
- Waiting Queue: ${waitingQueue.size}
- Supporters: ${Array.from(users.values()).filter(u => u.supporter).length}
- Total Donations: ${Array.from(users.values()).reduce((sum, u) => sum + (u.supportAmount || 0), 0)} Stars ⭐`;

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
        bot.sendMessage(chatId, '❌ Access denied. Admin only command.');
        return;
    }
    
    const targetUser = users.get(targetUserId);
    if (!targetUser) {
        bot.sendMessage(chatId, '❌ User not found.');
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
        bot.sendMessage(chatId, '❌ Access denied. Admin only command.');
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
        supportersList += `   📅 ${supportDate}\n\n`;
        totalSupport += user.supportAmount;
    });
    
    if (supporters.length > 10) {
        supportersList += `... and ${supporters.length - 10} more supporters\n\n`;
        // Calculate total from all supporters
        totalSupport = supporters.reduce((sum, user) => sum + user.supportAmount, 0);
    }
    
    supportersList += `💰 Total Support: ${totalSupport} Stars ⭐`;
    
    bot.sendMessage(chatId, supportersList);
});
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Access denied. Admin only command.');
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
                
                // Add supporter badge to messages from high-tier supporters
                let finalMessage = maskedText;
                if (user.supporter && user.supportAmount >= 100) {
                    finalMessage = `${maskedText}\n\n⭐ _From Supporter_`;
                }
                
                bot.sendMessage(partnerId, finalMessage, { parse_mode: 'Markdown' });
                bot.sendMessage(chatId, '⚠️ Your message contained inappropriate content and was filtered.');
            } else {
                // Add supporter badge to clean messages from high-tier supporters
                let finalMessage = msg.text;
                if (user.supporter && user.supportAmount >= 100) {
                    finalMessage = `${msg.text}\n\n⭐ _From Supporter_`;
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
                if (user.supporter && user.supportAmount >= 100) {
                    caption = '⭐ From Supporter';
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
        bot.sendMessage(chatId, '❌ Failed to send message. Your partner might have left.');
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
    
    // Handle Stars payment buttons
    if (data.startsWith('buy_stars_')) {
        const amount = data.split('_')[2]; // Extract amount (10, 50, 100, 500)
        const starsAmount = parseInt(amount);
        
        let title, description;
        
        switch(starsAmount) {
            case 10:
                title = "Small Support ⭐";
                description = "Thank you for supporting our bot with 10 Stars!";
                break;
            case 50:
                title = "Medium Support ⭐⭐";
                description = "Amazing support! 50 Stars helps us grow!";
                break;
            case 100:
                title = "Big Support ⭐⭐⭐";
                description = "Wow! 100 Stars makes a huge difference!";
                break;
            case 500:
                title = "Premium Support ⭐⭐⭐⭐";
                description = "Incredible! 500 Stars - you're a true supporter!";
                break;
        }
        
        try {
            bot.sendInvoice(chatId, {
                title: title,
                description: description,
                payload: `stars_donation_${starsAmount}_${userId}`,
                provider_token: "", // Empty for Telegram Stars
                currency: "XTR", // Telegram Stars currency
                prices: [{ 
                    label: `${starsAmount} Stars`, 
                    amount: starsAmount 
                }]
            });
            
            bot.answerCallbackQuery(query.id, `💫 Invoice sent for ${starsAmount} Stars!`);
        } catch (error) {
            console.error('Error sending invoice:', error);
            bot.answerCallbackQuery(query.id, "❌ Payment temporarily unavailable");
            bot.sendMessage(chatId, "❌ Sorry, Telegram Stars payments are temporarily unavailable. Please try again later.");
        }
    }
});

// Handle pre-checkout query (payment validation)
bot.on('pre_checkout_query', (ctx) => {
    try {
        // Always approve the payment
        ctx.answerPreCheckoutQuery(true);
        
        // Log payment attempt
        console.log(`Pre-checkout: ${ctx.preCheckoutQuery.from.username} - ${ctx.preCheckoutQuery.total_amount} Stars`);
    } catch (error) {
        console.error('Pre-checkout error:', error);
        ctx.answerPreCheckoutQuery(false, "Payment processing error");
    }
});

// Handle successful payment
bot.on('successful_payment', (ctx) => {
    const payment = ctx.message.successful_payment;
    const userId = ctx.from.id;
    const username = ctx.from.username || 'Unknown';
    const amount = payment.total_amount;
    const payload = payment.invoice_payload;
    
    // Log successful payment
    console.log(`Payment received: ${username} (${userId}) paid ${amount} Stars`);
    
    // Thank the user
    const thankYouMessage = `🎉 Payment Successful!

Thank you for your generous support of ${amount} Stars! ⭐

Your contribution helps us:
• Keep the bot running 24/7
• Add new features
• Maintain a safe community
• Provide free service to everyone

You're amazing! 💖`;

    ctx.reply(thankYouMessage);
    
    // Notify admins about the payment
    ADMIN_IDS.forEach(adminId => {
        try {
            bot.sendMessage(adminId, `💰 Payment Received!
            
User: @${username} (ID: ${userId})
Amount: ${amount} Stars ⭐
Time: ${new Date().toLocaleString()}

Total supporters growing! 🚀`);
        } catch (error) {
            console.error('Error notifying admin:', error);
        }
    });
    
    // Optional: Grant premium features or special status
    const user = getUser(userId);
    user.supporter = true;
    user.supportAmount = (user.supportAmount || 0) + amount;
    user.lastSupport = new Date();
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