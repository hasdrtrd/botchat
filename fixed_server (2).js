// server.js - Main application file
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const path = require('path');

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME; // Add your bot username (without @)
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
const referrals = new Map(); // userId -> referral data
const stats = {
    totalUsers: 0,
    dailyActiveUsers: new Set(),
    totalReports: 0,
    totalReferrals: 0,
    totalStarsEarned: 0
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
            referredBy: null,
            referralCode: generateReferralCode(userId),
            referralCount: 0,
            referralEarnings: 0
        });
        stats.totalUsers++;
    }
    stats.dailyActiveUsers.add(userId);
    return users.get(userId);
}

// Generate unique referral code
function generateReferralCode(userId) {
    return `ST${userId.toString().slice(-4)}${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
}

// Process referral
function processReferral(newUserId, referralCode) {
    // Find referrer by referral code
    let referrerId = null;
    for (const [userId, userData] of users.entries()) {
        if (userData.referralCode === referralCode) {
            referrerId = userId;
            break;
        }
    }
    
    if (!referrerId || referrerId === newUserId) {
        return false; // Invalid referral or self-referral
    }
    
    const newUser = getUser(newUserId);
    const referrer = getUser(referrerId);
    
    // Set referral relationship
    newUser.referredBy = referrerId;
    referrer.referralCount++;
    stats.totalReferrals++;
    
    // Notify referrer
    try {
        bot.sendMessage(referrerId, `🎉 Great news! Someone joined using your referral link!\n\n👥 Total referrals: ${referrer.referralCount}\n💰 Referral earnings: ${referrer.referralEarnings} Stars ⭐\n\n💡 Keep sharing to earn more rewards!`);
    } catch (error) {
        console.error('Error notifying referrer:', error);
    }
    
    return true;
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
bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const referralCode = match && match[1] ? match[1].trim() : null;
    
    const user = getUser(userId); // Initialize user
    
    // Process referral if code provided and user is new
    if (referralCode && !user.referredBy && users.size === 1) {
        processReferral(userId, referralCode);
    }
    
    let welcomeMessage = `👋 Welcome to StrangerTalk Bot!
Stay anonymous, safe & have fun.

👉 Tap /chat to find a stranger to talk with!`;

    // Add supporter welcome message
    if (user.supporter && user.supportAmount > 0) {
        welcomeMessage += `\n\n⭐ Welcome back, supporter! Thanks for your ${user.supportAmount} Stars donation. You get priority matching!`;
    } else {
        welcomeMessage += `\n\n💝 Like our bot? Support us with /support and get premium features!`;
    }
    
    // Add referral info for new users
    if (user.referredBy) {
        welcomeMessage += `\n\n🎉 Thanks for joining through a friend's referral!`;
    }

    const options = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '💬 Start Chat', callback_data: 'start_chat' },
                    { text: '🌟 Premium', callback_data: 'show_premium' }
                ],
                [
                    { text: '👥 Invite Friends', callback_data: 'show_referral' },
                    { text: '⚙️ Settings', callback_data: 'show_settings' }
                ],
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

bot.onText(/\/refer/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const user = getUser(userId);
    
    const botUsername = process.env.BOT_USERNAME || 'StrangerTalkBot'; // Add your bot username to env
    const referralLink = `https://t.me/${botUsername}?start=${user.referralCode}`;
    
    const referralMessage = `👥 **Invite Friends & Earn Rewards!**

🎁 **Your Benefits:**
• Get 10% of your friends' donations as bonus Stars ⭐
• Help grow our community
• Unlock special features faster

📊 **Your Referral Stats:**
• Referral Code: \`${user.referralCode}\`
• Friends Invited: ${user.referralCount}
• Stars Earned: ${user.referralEarnings} ⭐

🔗 **Your Referral Link:**
${referralLink}

💬 **Share Message:**
"Join me on StrangerTalk - anonymous chat with strangers! 🗣️✨ ${referralLink}"

Tap the button below to share easily!`;

    const options = {
        reply_markup: {
            inline_keyboard: [
                [
                    { 
                        text: '📤 Share Referral Link', 
                        url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent('Join me on StrangerTalk - anonymous chat with strangers! 🗣️✨')}`
                    }
                ],
                [
                    { text: '📋 Copy Link', callback_data: `copy_referral_${user.referralCode}` }
                ],
                [
                    { text: '🏆 Top Referrers', callback_data: 'top_referrers' }
                ]
            ]
        },
        parse_mode: 'Markdown'
    };

    bot.sendMessage(chatId, referralMessage, options);
});

bot.onText(/\/rewards/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const user = getUser(userId);
    
    let rewardsMessage = `🏆 **Your Rewards Dashboard**

👥 **Referral Program:**
• Friends Invited: ${user.referralCount}
• Referral Earnings: ${user.referralEarnings} Stars ⭐
• Referral Rate: 10% of friend donations

💎 **Supporter Status:**`;
    
    if (user.supporter && user.supportAmount > 0) {
        const supportDate = user.lastSupport ? new Date(user.lastSupport).toLocaleDateString() : 'Never';
        rewardsMessage += `
• Status: ✅ Active Supporter
• Total Support: ${user.supportAmount} Stars ⭐
• Last Support: ${supportDate}
• Benefits: Priority matching, Supporter badge`;
    } else {
        rewardsMessage += `
• Status: Regular User
• Upgrade with /support for premium features!`;
    }
    
    rewardsMessage += `

🎯 **How to Earn More:**
• Invite friends with /refer (get 10% of their donations)
• Support the bot with /support (unlock premium features)
• Stay active and help build our community!

💰 **Total Platform Stats:**
• Total Stars Earned by Users: ${stats.totalStarsEarned} ⭐
• Total Referrals: ${stats.totalReferrals}`;

    const options = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '👥 Invite Friends', callback_data: 'show_referral' },
                    { text: '💎 Get Premium', callback_data: 'show_premium' }
                ]
            ]
        },
        parse_mode: 'Markdown'
    };

    bot.sendMessage(chatId, rewardsMessage, options);
});
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

bot.onText(/\/support/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const user = getUser(userId);
    
    let supportMessage = `💝 **Support StrangerTalk Bot**

Your support keeps us running and helps us add amazing features!

🌟 **Premium Benefits:**
• ⚡ Priority matching (skip the queue!)
• 👑 Supporter badge in chats
• 🤝 Match with other supporters
• 💬 Special welcome messages
• 🚀 Early access to new features

Choose your support level:`;

    if (user.supporter && user.supportAmount > 0) {
        supportMessage += `\n\n✨ **Current Status:** Premium Supporter (${user.supportAmount} Stars ⭐)
Thank you for your support! ❤️`;
    }

    const options = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '⭐ 5 Stars - Supporter', callback_data: 'buy_stars_5' },
                    { text: '⭐⭐ 25 Stars - Fan', callback_data: 'buy_stars_25' }
                ],
                [
                    { text: '⭐⭐⭐ 50 Stars - VIP', callback_data: 'buy_stars_50' },
                    { text: '🌟 100 Stars - Champion', callback_data: 'buy_stars_100' }
                ],
                [
                    { text: '💎 250 Stars - Legend', callback_data: 'buy_stars_250' },
                    { text: '👑 500 Stars - Ultimate', callback_data: 'buy_stars_500' }
                ],
                [
                    { text: '💰 Custom Amount', callback_data: 'custom_stars' }
                ]
            ]
        },
        parse_mode: 'Markdown'
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
    
    const supporters = Array.from(users.values()).filter(u => u.supporter);
    const totalDonations = Array.from(users.values()).reduce((sum, u) => sum + (u.supportAmount || 0), 0);
    const totalReferralEarnings = Array.from(users.values()).reduce((sum, u) => sum + (u.referralEarnings || 0), 0);
    
    const statsMessage = `📊 **Bot Statistics**

👥 **Users:**
• Total Users: ${stats.totalUsers}
• Active Today: ${stats.dailyActiveUsers.size}
• Currently Chatting: ${Math.floor(activeChats.size / 2)} pairs
• In Queue: ${waitingQueue.size}

💰 **Financials:**
• Total Stars Earned: ${stats.totalStarsEarned} ⭐
• Active Supporters: ${supporters.length}
• Total Donations: ${totalDonations} Stars ⭐
• Referral Bonuses Paid: ${totalReferralEarnings} Stars ⭐

👥 **Referrals:**
• Total Referrals: ${stats.totalReferrals}
• Active Referrers: ${Array.from(users.values()).filter(u => u.referralCount > 0).length}

🚨 **Moderation:**
• Total Reports: ${stats.totalReports}
• Banned Users: ${Array.from(users.values()).filter(u => !u.isActive).length}

📈 **Engagement:**
• Avg. Support per User: ${supporters.length > 0 ? Math.round(totalDonations / supporters.length) : 0} Stars
• Top Supporter: ${supporters.length > 0 ? Math.max(...supporters.map(u => u.supportAmount)) : 0} Stars`;

    bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });
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

bot.onText(/\/banned/, (msg) => {
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

// Handle all messages (message relay and custom amount processing)
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Handle custom Stars amount input
    const user = getUser(userId);
    if (user.awaitingCustomAmount && msg.text && !msg.text.startsWith('/')) {
        const customAmount = parseInt(msg.text);
        
        if (isNaN(customAmount) || customAmount < 5 || customAmount > 1000) {
            bot.sendMessage(chatId, "❌ Please send a valid number between 5 and 1000.\n\nExample: `50` for 50 Stars ⭐", { parse_mode: 'Markdown' });
            return;
        }
        
        user.awaitingCustomAmount = false;
        
        try {
            // Create custom invoice
            bot.sendInvoice(chatId, {
                title: `Custom Support 💫`,
                description: `Thank you for your custom ${customAmount} Stars support!`,
                payload: JSON.stringify({
                    type: 'stars_donation',
                    amount: customAmount,
                    userId: userId,
                    timestamp: Date.now()
                }),
                provider_token: '',
                currency: 'XTR',
                prices: [{
                    label: `${customAmount} Stars 💫`,
                    amount: customAmount
                }],
                max_tip_amount: Math.floor(customAmount * 0.5),
                suggested_tip_amounts: [
                    Math.floor(customAmount * 0.1),
                    Math.floor(customAmount * 0.2),
                    Math.floor(customAmount * 0.3)
                ]
            });
            
            bot.sendMessage(chatId, `✅ Custom invoice created for ${customAmount} Stars! ⭐`);
            
        } catch (error) {
            console.error('Error creating custom invoice:', error);
            bot.sendMessage(chatId, "❌ Error creating invoice. Please try again later.");
        }
        
        return;
    }
    
    // Skip if it's a command or payment message
    if ((msg.text && msg.text.startsWith('/')) || msg.successful_payment) {
        return;
    }
    
    // Check if user is in a chat
    const partnerId = activeChats.get(userId);
    if (!partnerId) {
        return;
    }
    
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
                    finalMessage = `${maskedText}\n\n⭐ _From Champion Supporter_`;
                } else if (user.supporter && user.supportAmount >= 50) {
                    finalMessage = `${maskedText}\n\n⭐ _From VIP Supporter_`;
                } else if (user.supporter && user.supportAmount >= 25) {
                    finalMessage = `${maskedText}\n\n⭐ _From Fan_`;
                } else if (user.supporter) {
                    finalMessage = `${maskedText}\n\n⭐ _From Supporter_`;
                }
                
                bot.sendMessage(partnerId, finalMessage, { parse_mode: 'Markdown' });
                bot.sendMessage(chatId, '⚠️ Your message contained inappropriate content and was filtered.');
            } else {
                // Add supporter badge to clean messages from supporters
                let finalMessage = msg.text;
                if (user.supporter && user.supportAmount >= 250) {
                    finalMessage = `${msg.text}\n\n👑 _Legend Supporter_`;
                } else if (user.supporter && user.supportAmount >= 100) {
                    finalMessage = `${msg.text}\n\n🌟 _Champion Supporter_`;
                } else if (user.supporter && user.supportAmount >= 50) {
                    finalMessage = `${msg.text}\n\n💎 _VIP Supporter_`;
                } else if (user.supporter && user.supportAmount >= 25) {
                    finalMessage = `${msg.text}\n\n⭐⭐ _Fan_`;
                } else if (user.supporter) {
                    finalMessage = `${msg.text}\n\n⭐ _Supporter_`;
                }
                
                bot.sendMessage(partnerId, finalMessage, { parse_mode: 'Markdown' });
            }
        } else if (msg.photo) {
            // Photo
            if (partner.safeMode) {
                bot.sendMessage(partnerId, '📷 [Photo blocked by Safe Mode]');
                bot.sendMessage(chatId, '📷 Your photo was blocked by your partner\'s Safe Mode.');
            } else {
                let caption = msg.caption || '';
                if (user.supporter && user.supportAmount >= 50) {
                    caption += caption ? '\n\n⭐ From Supporter' : '⭐ From Supporter';
                }
                bot.sendPhoto(partnerId, msg.photo[msg.photo.length - 1].file_id, {
                    caption: caption
                });
            }
        } else if (msg.video) {
            // Video
            if (partner.safeMode) {
                bot.sendMessage(partnerId, '🎥 [Video blocked by Safe Mode]');
                bot.sendMessage(chatId, '🎥 Your video was blocked by your partner\'s Safe Mode.');
            } else {
                let caption = msg.caption || '';
                if (user.supporter && user.supportAmount >= 50) {
                    caption += caption ? '\n\n⭐ From Supporter' : '⭐ From Supporter';
                }
                bot.sendVideo(partnerId, msg.video.file_id, {
                    caption: caption
                });
            }
        } else if (msg.document) {
            // Document
            if (partner.safeMode) {
                bot.sendMessage(partnerId, '📄 [Document blocked by Safe Mode]');
                bot.sendMessage(chatId, '📄 Your document was blocked by your partner\'s Safe Mode.');
            } else {
                let caption = msg.caption || '';
                if (user.supporter && user.supportAmount >= 50) {
                    caption += caption ? '\n\n⭐ From Supporter' : '⭐ From Supporter';
                }
                bot.sendDocument(partnerId, msg.document.file_id, {
                    caption: caption
                });
            }
        } else if (msg.audio) {
            // Audio
            if (partner.safeMode) {
                bot.sendMessage(partnerId, '🎵 [Audio blocked by Safe Mode]');
                bot.sendMessage(chatId, '🎵 Your audio was blocked by your partner\'s Safe Mode.');
            } else {
                bot.sendAudio(partnerId, msg.audio.file_id);
                if (user.supporter && user.supportAmount >= 50) {
                    bot.sendMessage(partnerId, '⭐ _From Supporter_', { parse_mode: 'Markdown' });
                }
            }
        } else if (msg.voice) {
            // Voice message
            if (partner.safeMode) {
                bot.sendMessage(partnerId, '🎤 [Voice message blocked by Safe Mode]');
                bot.sendMessage(chatId, '🎤 Your voice message was blocked by your partner\'s Safe Mode.');
            } else {
                bot.sendVoice(partnerId, msg.voice.file_id);
                if (user.supporter && user.supportAmount >= 50) {
                    bot.sendMessage(partnerId, '⭐ _From Supporter_', { parse_mode: 'Markdown' });
                }
            }
        } else if (msg.sticker) {
            // Sticker
            if (partner.safeMode) {
                bot.sendMessage(partnerId, '😀 [Sticker blocked by Safe Mode]');
                bot.sendMessage(chatId, '😀 Your sticker was blocked by your partner\'s Safe Mode.');
            } else {
                bot.sendSticker(partnerId, msg.sticker.file_id);
                
                // Add supporter badge for stickers
                if (user.supporter && user.supportAmount >= 100) {
                    bot.sendMessage(partnerId, '🌟 _From Champion Supporter_', { parse_mode: 'Markdown' });
                } else if (user.supporter && user.supportAmount >= 50) {
                    bot.sendMessage(partnerId, '💎 _From VIP Supporter_', { parse_mode: 'Markdown' });
                } else if (user.supporter) {
                    bot.sendMessage(partnerId, '⭐ _From Supporter_', { parse_mode: 'Markdown' });
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
    
    if (data === 'start_chat') {
        // Simulate /chat command
        const user = getUser(userId);
        
        if (activeChats.has(userId)) {
            bot.answerCallbackQuery(query.id, '💬 You are already in a chat!');
            return;
        }
        
        if (!user.isActive) {
            bot.answerCallbackQuery(query.id, '🚫 You are banned');
            return;
        }
        
        const partnerId = findPartner(userId);
        
        if (partnerId) {
            startChat(userId, partnerId);
            bot.answerCallbackQuery(query.id, '✅ Connected!');
        } else {
            if (user.supporter && user.supportAmount > 0) {
                bot.answerCallbackQuery(query.id, '🔍⭐ Looking for partner...');
            } else {
                bot.answerCallbackQuery(query.id, '🔍 Looking for partner...');
            }
        }
    }
    
    if (data === 'show_premium') {
        const user = getUser(userId);
        
        if (!user.supporter || user.supportAmount === 0) {
            const premiumInfo = `🌟 **Premium Features**

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

            bot.editMessageText(premiumInfo, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💎 Get Premium', callback_data: 'show_support' }],
                        [{ text: '← Back', callback_data: 'back_to_main' }]
                    ]
                }
            });
        } else {
            // Show supporter status
            const supportDate = new Date(user.lastSupport).toLocaleDateString();
            const statusMessage = `👑 **Your Premium Status**

✅ **Active Supporter**
⭐ Total Support: ${user.supportAmount} Stars
📅 Last Support: ${supportDate}

🎯 **Your Benefits:**
• ⚡ Priority matching (active)
• 👑 Supporter badge (active)  
• 🤝 Supporter-to-supporter matching (active)

Thank you for supporting StrangerTalk Bot! 💖

Want to support more? Use /support`;

            bot.editMessageText(statusMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💎 Support More', callback_data: 'show_support' }],
                        [{ text: '← Back', callback_data: 'back_to_main' }]
                    ]
                }
            });
        }
        
        bot.answerCallbackQuery(query.id);
    }
    
    if (data === 'show_referral') {
        const user = getUser(userId);
        const botUsername = process.env.BOT_USERNAME || 'StrangerTalkBot';
        const referralLink = `https://t.me/${botUsername}?start=${user.referralCode}`;
        
        const referralMessage = `👥 **Invite Friends & Earn!**

🎁 **Earn 10% of friends' donations!**

📊 **Your Stats:**
• Code: \`${user.referralCode}\`
• Invited: ${user.referralCount} friends
• Earned: ${user.referralEarnings} Stars ⭐

🔗 **Your Link:**
${referralLink}`;

        bot.editMessageText(referralMessage, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📤 Share Link', url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent('Join me on StrangerTalk! 🗣️✨')}` }],
                    [{ text: '🏆 Leaderboard', callback_data: 'top_referrers' }],
                    [{ text: '← Back', callback_data: 'back_to_main' }]
                ]
            }
        });
        
        bot.answerCallbackQuery(query.id);
    }
    
    if (data === 'show_settings') {
        const user = getUser(userId);
        const status = user.safeMode ? 'ON' : 'OFF';
        
        const settingsMessage = `⚙️ **Bot Settings**

🔒 **Safe Mode:** ${status}
Safe Mode blocks ALL media from strangers (photos, videos, documents, audio, voice messages, stickers).

• ON = Only text messages (safest)
• OFF = All media types allowed`;

        bot.editMessageText(settingsMessage, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: `🔒 Safe Mode: ${status}`, callback_data: 'toggle_safe_mode' }],
                    [{ text: '📊 My Stats', callback_data: 'my_stats' }],
                    [{ text: '← Back', callback_data: 'back_to_main' }]
                ]
            }
        });
        
        bot.answerCallbackQuery(query.id);
    }
    
    if (data === 'back_to_main') {
        const user = getUser(userId);
        
        let welcomeMessage = `👋 **StrangerTalk Bot**
Stay anonymous, safe & have fun.

Ready to chat with strangers?`;

        if (user.supporter && user.supportAmount > 0) {
            welcomeMessage += `\n\n⭐ Premium User - Priority Matching Active!`;
        }

        bot.editMessageText(welcomeMessage, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '💬 Start Chat', callback_data: 'start_chat' },
                        { text: '🌟 Premium', callback_data: 'show_premium' }
                    ],
                    [
                        { text: '👥 Invite Friends', callback_data: 'show_referral' },
                        { text: '⚙️ Settings', callback_data: 'show_settings' }
                    ],
                    [
                        { text: '📢 Channel', url: CHANNEL_LINK },
                        { text: '💬 Group', url: GROUP_LINK }
                    ]
                ]
            }
        });
        
        bot.answerCallbackQuery(query.id);
    }
    
    if (data === 'top_referrers') {
        const topReferrers = Array.from(users.values())
            .filter(user => user.referralCount > 0)
            .sort((a, b) => b.referralCount - a.referralCount)
            .slice(0, 10);
        
        let leaderboard = `🏆 **Top Referrers**\n\n`;
        
        if (topReferrers.length === 0) {
            leaderboard += `No referrers yet. Be the first! 🚀`;
        } else {
            topReferrers.forEach((user, index) => {
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
                leaderboard += `${medal} **${user.referralCount}** referrals - ${user.referralEarnings} Stars ⭐\n`;
            });
        }
        
        bot.editMessageText(leaderboard, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '👥 My Referrals', callback_data: 'show_referral' }],
                    [{ text: '← Back', callback_data: 'back_to_main' }]
                ]
            }
        });
        
        bot.answerCallbackQuery(query.id);
    }
    
    if (data.startsWith('copy_referral_')) {
        const referralCode = data.split('_')[2];
        const botUsername = process.env.BOT_USERNAME || 'StrangerTalkBot';
        const referralLink = `https://t.me/${botUsername}?start=${referralCode}`;
        
        bot.answerCallbackQuery(query.id, `📋 Link copied! Share: ${referralLink}`, true);
    }
    
    if (data === 'toggle_safe_mode') {
        const user = getUser(userId);
        user.safeMode = !user.safeMode;
        
        const status = user.safeMode ? 'ON' : 'OFF';
        bot.answerCallbackQuery(query.id, `Safe Mode: ${status}`);
        
        // Update the settings message
        const settingsMessage = `⚙️ **Bot Settings**

🔒 **Safe Mode:** ${status}
Safe Mode blocks ALL media from strangers (photos, videos, documents, audio, voice messages, stickers).

• ON = Only text messages (safest)
• OFF = All media types allowed`;

        bot.editMessageText(settingsMessage, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: `🔒 Safe Mode: ${status}`, callback_data: 'toggle_safe_mode' }],
                    [{ text: '📊 My Stats', callback_data: 'my_stats' }],
                    [{ text: '← Back', callback_data: 'back_to_main' }]
                ]
            }
        });
    }
    
    // Handle Stars payment buttons
    if (data.startsWith('buy_stars_')) {
        const amount = data.split('_')[2];
        const starsAmount = parseInt(amount);
        
        let title, description, emoji;
        
        switch(starsAmount) {
            case 5:
                title = "Supporter ⭐";
                description = "Thank you for supporting our bot!";
                emoji = "⭐";
                break;
            case 25:
                title = "Fan ⭐⭐";
                description = "Amazing support! You're a true fan!";
                emoji = "⭐⭐";
                break;
            case 50:
                title = "VIP ⭐⭐⭐";
                description = "VIP supporter! Thank you so much!";
                emoji = "⭐⭐⭐";
                break;
            case 100:
                title = "Champion 🌟";
                description = "Champion supporter! You're incredible!";
                emoji = "🌟";
                break;
            case 250:
                title = "Legend 💎";
                description = "Legendary support! You're amazing!";
                emoji = "💎";
                break;
            case 500:
                title = "Ultimate 👑";
                description = "Ultimate supporter! You're the best!";
                emoji = "👑";
                break;
            default:
                title = "Custom Support 💫";
                description = "Thank you for your custom support!";
                emoji = "💫";
        }
        
        try {
            // Create invoice for Telegram Stars
            const invoice = await bot.sendInvoice(chatId, {
                title: title,
                description: description,
                payload: JSON.stringify({
                    type: 'stars_donation',
                    amount: starsAmount,
                    userId: userId,
                    timestamp: Date.now()
                }),
                provider_token: '', // Empty for Telegram Stars
                currency: 'XTR', // Telegram Stars currency code
                prices: [{
                    label: `${starsAmount} Stars ${emoji}`,
                    amount: starsAmount
                }],
                max_tip_amount: Math.floor(starsAmount * 0.5), // Allow up to 50% tip
                suggested_tip_amounts: [
                    Math.floor(starsAmount * 0.1),
                    Math.floor(starsAmount * 0.2),
                    Math.floor(starsAmount * 0.3)
                ]
            });
            
            bot.answerCallbackQuery(query.id, `💫 Payment invoice sent!`);
            
        } catch (error) {
            console.error('Error sending invoice:', error);
            bot.answerCallbackQuery(query.id, "❌ Payment temporarily unavailable");
            bot.sendMessage(chatId, "❌ Sorry, payment is temporarily unavailable. Please try again later or contact support.");
        }
    }
    
    if (data === 'custom_stars') {
        bot.answerCallbackQuery(query.id, "💡 Send a number for custom Stars amount (5-1000)");
        bot.sendMessage(chatId, "💰 **Custom Stars Amount**\n\nSend me a number between 5 and 1000 for your custom donation amount.\n\nExample: Send `50` to donate 50 Stars ⭐");
        
        // Set user state for custom amount (you might want to implement a proper state system)
        const user = getUser(userId);
        user.awaitingCustomAmount = true;
    }
}); (10, 50, 100, 500)
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
bot.on('pre_checkout_query', (query) => {
    try {
        const payload = JSON.parse(query.invoice_payload);
        
        // Validate payment
        if (payload.type === 'stars_donation' && payload.amount > 0 && payload.amount <= 1000) {
            query.answerPreCheckoutQuery(true);
            console.log(`Pre-checkout approved: User ${payload.userId} - ${payload.amount} Stars`);
        } else {
            query.answerPreCheckoutQuery(false, "Invalid payment amount");
        }
    } catch (error) {
        console.error('Pre-checkout error:', error);
        query.answerPreCheckoutQuery(false, "Payment processing error");
    }
});

// Handle successful payment
bot.on('successful_payment', (msg) => {
    const payment = msg.successful_payment;
    const userId = msg.from.id;
    const username = msg.from.username || 'Unknown';
    const firstName = msg.from.first_name || 'User';
    const totalAmount = payment.total_amount; // Total including tip
    const invoiceAmount = payment.invoice_payload ? JSON.parse(payment.invoice_payload).amount : totalAmount;
    const tipAmount = totalAmount - invoiceAmount;
    
    try {
        const payload = JSON.parse(payment.invoice_payload);
        
        // Log successful payment
        console.log(`💰 Payment received: ${username} (${userId}) paid ${totalAmount} Stars (${invoiceAmount} + ${tipAmount} tip)`);
        
        // Update user data
        const user = getUser(userId);
        const previousAmount = user.supportAmount || 0;
        user.supporter = true;
        user.supportAmount = (user.supportAmount || 0) + totalAmount;
        user.lastSupport = new Date();
        
        // Update global stats
        stats.totalStarsEarned += totalAmount;
        
        // Process referral bonus (10% of payment to referrer)
        if (user.referredBy && totalAmount >= 5) {
            const referrerId = user.referredBy;
            const referrer = getUser(referrerId);
            const bonusAmount = Math.floor(totalAmount * 0.1); // 10% bonus
            
            referrer.referralEarnings = (referrer.referralEarnings || 0) + bonusAmount;
            
            // Notify referrer about bonus
            try {
                bot.sendMessage(referrerId, `🎉 **Referral Bonus Earned!**

Your friend just supported the bot with ${totalAmount} Stars! ⭐

💰 **Your bonus:** ${bonusAmount} Stars
📊 **Total earned:** ${referrer.referralEarnings} Stars
👥 **Total referrals:** ${referrer.referralCount}

Keep inviting friends to earn more! /refer`);
            } catch (error) {
                console.error('Error notifying referrer:', error);
            }
        }
        
        // Thank the user with personalized message
        let thankYouMessage = `🎉 **Payment Successful!**

Thank you ${firstName} for your generous support of ${totalAmount} Stars! ⭐`;
        
        if (tipAmount > 0) {
            thankYouMessage += `\n💝 Including ${tipAmount} Stars tip - you're amazing!`;
        }
        
        thankYouMessage += `

🌟 **Premium Features Unlocked:**
• ⚡ Priority matching (active now!)
• 👑 Supporter badge in chats
• 🤝 Match with other supporters
• 💬 Special welcome messages

Your contribution helps us:
• Keep the bot running 24/7 🔄
• Add new features 🚀
• Maintain a safe community 🛡️
• Provide free service to everyone 🌍

You're incredible! Thank you! ❤️`;

        // Add milestone message for large donations
        if (totalAmount >= 100) {
            thankYouMessage += `\n\n🏆 **CHAMPION SUPPORTER!**\nYou're now a Champion supporter with exclusive recognition!`;
        } else if (totalAmount >= 50) {
            thankYouMessage += `\n\n💎 **VIP SUPPORTER!**\nYou're now a VIP supporter with special status!`;
        }

        const options = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '💬 Start Chatting', callback_data: 'start_chat' },
                        { text: '👥 Invite Friends', callback_data: 'show_referral' }
                    ],
                    [
                        { text: '🏆 Leaderboard', callback_data: 'top_supporters' }
                    ]
                ]
            },
            parse_mode: 'Markdown'
        };
        
        bot.sendMessage(userId, thankYouMessage, options);
        
        // Notify admins about the payment
        const adminMessage = `💰 **New Payment Received!**

👤 **User:** @${username} (${firstName})
🆔 **ID:** ${userId}
💎 **Amount:** ${totalAmount} Stars ⭐`;

        if (tipAmount > 0) {
            adminMessage += `\n🎁 **Tip:** ${tipAmount} Stars`;
        }

        adminMessage += `\n⏰ **Time:** ${new Date().toLocaleString()}
🏆 **User Total:** ${user.supportAmount} Stars
📊 **Platform Total:** ${stats.totalStarsEarned} Stars

🚀 Community is growing!`;

        ADMIN_IDS.forEach(adminId => {
            try {
                bot.sendMessage(adminId, adminMessage);
            } catch (error) {
                console.error('Error notifying admin:', error);
            }
        });
        
        // Send achievement notification for milestones
        if (user.supportAmount >= 500 && previousAmount < 500) {
            // Ultimate supporter milestone
            bot.sendMessage(userId, `🏆👑 **ULTIMATE SUPPORTER ACHIEVED!**\n\nYou've reached 500+ Stars total support!\nYou're now an Ultimate Supporter with maximum recognition! 🎉`);
        } else if (user.supportAmount >= 250 && previousAmount < 250) {
            // Legend supporter milestone  
            bot.sendMessage(userId, `🏆💎 **LEGEND SUPPORTER ACHIEVED!**\n\nYou've reached 250+ Stars total support!\nYou're now a Legend Supporter! 🎉`);
        } else if (user.supportAmount >= 100 && previousAmount < 100) {
            // Champion supporter milestone
            bot.sendMessage(userId, `🏆🌟 **CHAMPION SUPPORTER ACHIEVED!**\n\nYou've reached 100+ Stars total support!\nYou're now a Champion Supporter! 🎉`);
        }
        
    } catch (error) {
        console.error('Error processing successful payment:', error);
        // Still thank the user even if there's an error
        bot.sendMessage(userId, `🎉 Payment received! Thank you for your support! ⭐\n\nIf you experience any issues, please contact our admins.`);
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