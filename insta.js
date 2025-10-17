const { Telegraf, Markup } = require('telegraf');
const { igdl } = require("ruhend-scraper");
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const CONFIG = {
    BOT_TOKEN: '7620991709:AAH2qNNm4UVOTxQvheJNiHMNV7KN1f4L0Lo',
    ADMIN_ID: 5518489725,
    ADMIN_CHANNEL: -1002423451263,
    DB_FILE: path.join(__dirname, 'database.json')
};

const bot = new Telegraf(CONFIG.BOT_TOKEN);

// Database structure
let database = {
    users: new Set(),
    downloads: [],
    stats: {
        totalUsers: 0,
        totalDownloads: 0,
        lastUpdate: Date.now()
    }
};

// Load database
async function loadDatabase() {
    try {
        const data = await fs.readFile(CONFIG.DB_FILE, 'utf8');
        const parsed = JSON.parse(data);
        database.users = new Set(parsed.users || []);
        database.downloads = parsed.downloads || [];
        database.stats = parsed.stats || database.stats;
    } catch (error) {
        console.log('No existing database found, creating new one...');
    }
}

// Save database
async function saveDatabase() {
    try {
        const data = {
            users: Array.from(database.users),
            downloads: database.downloads.slice(-1000),
            stats: database.stats
        };
        await fs.writeFile(CONFIG.DB_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error saving database:', error);
    }
}

// Add user to database
async function addUser(userId, username) {
    if (!database.users.has(userId)) {
        database.users.add(userId);
        database.stats.totalUsers = database.users.size;
        await saveDatabase();
        
        try {
            await bot.telegram.sendMessage(
                CONFIG.ADMIN_CHANNEL,
                `🆕 *New User Registration*\n\n` +
                `👤 User ID: \`${userId}\`\n` +
                `📝 Username: ${username ? '@' + username : 'N/A'}\n` +
                `📅 Date: ${new Date().toLocaleString()}\n` +
                `📊 Total Users: ${database.stats.totalUsers}`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('Error notifying admin:', error);
        }
    }
}

// Log download
async function logDownload(userId, username, url, caption) {
    const log = {
        userId,
        username,
        url,
        caption: caption || 'N/A',
        timestamp: Date.now(),
        date: new Date().toLocaleString()
    };
    
    database.downloads.push(log);
    database.stats.totalDownloads++;
    await saveDatabase();
    
    try {
        await bot.telegram.sendMessage(
            CONFIG.ADMIN_CHANNEL,
            `📥 *New Download*\n\n` +
            `👤 User: ${username ? '@' + username : 'ID: ' + userId}\n` +
            `🔗 Link: ${url}\n` +
            `📝 Caption: ${caption ? caption.substring(0, 100) + '...' : 'None'}\n` +
            `📅 Time: ${log.date}\n` +
            `📊 Total Downloads: ${database.stats.totalDownloads}`,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        console.error('Error logging to admin channel:', error);
    }
}

// Store processed messages
const processedMessages = new Set();

// Session storage for navigation
const userSessions = new Map();

// Extract unique media
function extractUniqueMedia(mediaData) {
    const uniqueMedia = [];
    const seenUrls = new Set();
    
    for (const media of mediaData) {
        if (!media?.url) continue;
        
        const cleanUrl = media.url.split('?')[0].split('#')[0];
        
        if (!seenUrls.has(cleanUrl)) {
            seenUrls.add(cleanUrl);
            uniqueMedia.push({
                url: media.url,
                thumbnail: media.thumbnail || null,
                cleanUrl: cleanUrl
            });
        }
    }
    
    return uniqueMedia;
}

// Validate Instagram URL
function isValidInstagramUrl(url) {
    if (!url || typeof url !== 'string') return false;
    
    const patterns = [
        /https?:\/\/(www\.)?instagram\.com\/(p|reel|tv|stories)\/[A-Za-z0-9_-]+\/?/i,
        /https?:\/\/(www\.)?instagr\.am\/(p|reel|tv)\/[A-Za-z0-9_-]+\/?/i
    ];
    
    return patterns.some(pattern => pattern.test(url.trim()));
}

// Extract clean Instagram URL
function extractCleanInstagramUrl(inputText) {
    const urlMatch = inputText.match(/(https?:\/\/[^\s]+)/);
    if (!urlMatch) return null;
    
    let url = urlMatch[0];
    const cleanMatch = url.match(/(https?:\/\/(www\.)?instagram\.com\/(p|reel|tv|stories)\/[A-Za-z0-9_-]+)/i);
    
    if (cleanMatch) return cleanMatch[0];
    
    url = url.split('?')[0].split('&')[0];
    return isValidInstagramUrl(url) ? url : null;
}

// Determine media type
function getMediaType(mediaUrl, originalUrl) {
    if (!mediaUrl) return 'image';
    
    const url = mediaUrl.toLowerCase();
    
    if (/\.(mp4|mov|avi|mkv|webm|3gp)$/i.test(url) || 
        url.includes('/video/') || 
        url.includes('_video_') || 
        url.includes('.mp4')) {
        return 'video';
    }
    
    if (originalUrl.includes('/reel/') || originalUrl.includes('/tv/')) {
        return 'video';
    }
    
    return 'image';
}

// Download file with retry
async function downloadFile(url, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios({
                method: 'GET',
                url: url,
                responseType: 'arraybuffer',
                timeout: 30000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            return Buffer.from(response.data);
        } catch (error) {
            if (attempt === retries) {
                throw new Error('Failed to download media file');
            }
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
    }
}

// Check URL accessibility
async function isUrlAccessible(url) {
    try {
        const response = await axios.head(url, { 
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        return response.status === 200;
    } catch (error) {
        return false;
    }
}

// Beautify caption
function beautifyCaption(rawCaption, url) {
    if (!rawCaption) return null;
    
    let caption = rawCaption.trim();
    
    caption = caption.replace(/\n{3,}/g, '\n\n');
    
    if (caption.length > 800) {
        caption = caption.substring(0, 800) + '...';
    }
    
    return caption;
}

// Create inline keyboard
function createMediaKeyboard(url, currentIndex, totalMedia, sessionId) {
    const buttons = [
        [
            Markup.button.url('🔗 Open on Instagram', url),
            Markup.button.callback('📥 Download All', `download_all_${sessionId}`)
        ]
    ];
    
    if (totalMedia > 1) {
        const navButtons = [];
        if (currentIndex > 0) {
            navButtons.push(Markup.button.callback('⏮️ Previous', `prev_${sessionId}_${currentIndex}`));
        }
        navButtons.push(Markup.button.callback(`${currentIndex + 1}/${totalMedia}`, 'noop'));
        if (currentIndex < totalMedia - 1) {
            navButtons.push(Markup.button.callback('⏭️ Next', `next_${sessionId}_${currentIndex}`));
        }
        buttons.push(navButtons);
    }
    
    return Markup.inlineKeyboard(buttons);
}

// Send media group
async function sendMediaGroup(ctx, mediaItems, caption, type = 'photo') {
    try {
        const mediaGroup = mediaItems.map((item, index) => ({
            type: type,
            media: { source: item },
            caption: index === 0 ? caption : undefined,
            parse_mode: index === 0 ? 'Markdown' : undefined
        }));

        await ctx.replyWithMediaGroup(mediaGroup);
        return true;
    } catch (error) {
        console.error('Error sending media group:', error.message);
        return false;
    }
}

// Main Instagram handler
async function handleInstagramCommand(ctx) {
    try {
        const message = ctx.message;
        const userId = ctx.from.id;
        const username = ctx.from.username;
        
        await addUser(userId, username);
        
        if (processedMessages.has(message.message_id)) {
            return;
        }
        
        processedMessages.add(message.message_id);
        setTimeout(() => processedMessages.delete(message.message_id), 5 * 60 * 1000);

        const text = message.text || message.caption || '';

        if (!text) {
            return await ctx.reply(
                "🕷️ *SPIDEY OFFICIAL - Instagram Downloader PRO v3.0*\n\n" +
                "Send me an Instagram link to download!\n\n" +
                "✨ *Features:*\n" +
                "• 📸 Photos & Carousels\n" +
                "• 🎥 Videos & Reels\n" +
                "• 💎 HD Quality\n" +
                "• 🧩 Interactive Buttons\n" +
                "• 📝 Smart Captions", 
                { parse_mode: 'Markdown' }
            );
        }

        const instagramUrl = extractCleanInstagramUrl(text);
        
        if (!instagramUrl || !isValidInstagramUrl(instagramUrl)) {
            return await ctx.reply(
                "❌ *Invalid Instagram Link*\n\n" +
                "Please provide a valid Instagram URL.\n\n" +
                "*Examples:*\n" +
                "• https://instagram.com/reel/ABC123\n" +
                "• https://instagram.com/p/XYZ789", 
                { parse_mode: 'Markdown' }
            );
        }

        const processingMsg = await ctx.reply(
            "⏳ *SPIDEY OFFICIAL is working...*\n\n" +
            "🕷️ Fetching your media in HD\n" +
            "⚡ Please wait..."
        );

        try {
            const downloadData = await igdl(instagramUrl);
            
            if (!downloadData?.data || downloadData.data.length === 0) {
                await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
                return await ctx.reply(
                    "❌ *No Media Found*\n\n" +
                    "The post might be private, deleted, or unavailable.", 
                    { parse_mode: 'Markdown' }
                );
            }

            await logDownload(userId, username, instagramUrl, downloadData.caption || null);

            const uniqueMedia = extractUniqueMedia(downloadData.data);
            const mediaToDownload = uniqueMedia.slice(0, 10);
            
            if (mediaToDownload.length === 0) {
                await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
                return await ctx.reply(
                    "❌ *No Downloadable Media*\n\n" +
                    "Could not find valid media in this post.", 
                    { parse_mode: 'Markdown' }
                );
            }

            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);

            const sessionId = `${userId}_${Date.now()}`;
            userSessions.set(sessionId, {
                media: mediaToDownload,
                url: instagramUrl,
                caption: downloadData.caption || null,
                userId: userId
            });

            setTimeout(() => userSessions.delete(sessionId), 30 * 60 * 1000);

            if (mediaToDownload.length > 1) {
                await ctx.reply(
                    `🕷️ *SPIDEY OFFICIAL*\n\n` +
                    `📦 Found *${mediaToDownload.length}* media items\n` +
                    `⚡ Processing in HD quality...`,
                    { parse_mode: 'Markdown' }
                );
            }

            const images = [];
            const videos = [];

            for (const media of mediaToDownload) {
                const mediaType = getMediaType(media.url, instagramUrl);
                if (mediaType === 'video') {
                    videos.push(media);
                } else {
                    images.push(media);
                }
            }

            let successCount = 0;

            if (images.length > 0) {
                const imageBuffers = [];
                
                for (let i = 0; i < images.length; i++) {
                    try {
                        const isAccessible = await isUrlAccessible(images[i].url);
                        if (!isAccessible) continue;

                        const buffer = await downloadFile(images[i].url);
                        imageBuffers.push(buffer);
                    } catch (error) {
                        console.error(`Error downloading image ${i + 1}:`, error.message);
                    }
                }

                if (imageBuffers.length > 0) {
                    const beautifiedCaption = beautifyCaption(downloadData.caption, instagramUrl);
                    const caption = 
                        `🕷️ *SPIDEY OFFICIAL - PRO v3.0*\n\n` +
                        `📸 ${imageBuffers.length} HD Image${imageBuffers.length > 1 ? 's' : ''}\n` +
                        (beautifiedCaption ? `\n📝 *Caption:*\n${beautifiedCaption}\n` : '') +
                        `\n✨ Downloaded in high quality\n` +
                        `💎 SPIDEY OFFICIAL - Fast. Secure. Stylish.`;

                    if (imageBuffers.length > 1 && imageBuffers.length <= 10) {
                        const sent = await sendMediaGroup(ctx, imageBuffers, caption, 'photo');
                        if (sent) {
                            successCount += imageBuffers.length;
                            await ctx.reply(
                                '🧩 *Interactive Controls:*',
                                {
                                    parse_mode: 'Markdown',
                                    ...createMediaKeyboard(instagramUrl, 0, imageBuffers.length, sessionId)
                                }
                            );
                        }
                    } else {
                        await ctx.replyWithPhoto(
                            { source: imageBuffers[0] },
                            { 
                                caption: caption, 
                                parse_mode: 'Markdown',
                                ...createMediaKeyboard(instagramUrl, 0, 1, sessionId)
                            }
                        );
                        successCount++;
                    }
                }
            }

            for (let i = 0; i < videos.length; i++) {
                try {
                    const isAccessible = await isUrlAccessible(videos[i].url);
                    if (!isAccessible) continue;

                    const buffer = await downloadFile(videos[i].url);
                    const beautifiedCaption = beautifyCaption(downloadData.caption, instagramUrl);
                    const caption = 
                        `🕷️ *SPIDEY OFFICIAL - PRO v3.0*\n\n` +
                        `🎥 HD Video ${i + 1}/${videos.length}\n` +
                        (beautifiedCaption ? `\n📝 *Caption:*\n${beautifiedCaption}\n` : '') +
                        `\n✨ Downloaded in high quality\n` +
                        `💎 SPIDEY OFFICIAL - Fast. Secure. Stylish.`;

                    await ctx.replyWithVideo(
                        { source: buffer },
                        { 
                            caption: caption, 
                            parse_mode: 'Markdown',
                            ...createMediaKeyboard(instagramUrl, i, videos.length, sessionId)
                        }
                    );
                    
                    successCount++;
                    
                    if (i < videos.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 1500));
                    }
                } catch (error) {
                    console.error(`Error downloading video ${i + 1}:`, error.message);
                }
            }

            if (successCount === 0) {
                await ctx.reply(
                    "❌ *Download Failed*\n\n" +
                    "Could not download media. Please try again later.", 
                    { parse_mode: 'Markdown' }
                );
            }

        } catch (scraperError) {
            console.error('Scraper error:', scraperError);
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
            await ctx.reply(
                "❌ *Download Error*\n\n" +
                "Failed to fetch media. Please try again in a few minutes.", 
                { parse_mode: 'Markdown' }
            );
        }

    } catch (error) {
        console.error('Error in Instagram handler:', error);
        await ctx.reply(
            "❌ *Unexpected Error*\n\n" +
            "Something went wrong. Please try again.\n\n" +
            "🕷️ SPIDEY OFFICIAL", 
            { parse_mode: 'Markdown' }
        );
    }
}

// Admin commands
bot.command('stats', async (ctx) => {
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    
    await ctx.reply(
        `📊 *SPIDEY OFFICIAL - Statistics*\n\n` +
        `👥 Total Users: ${database.stats.totalUsers}\n` +
        `📥 Total Downloads: ${database.stats.totalDownloads}\n` +
        `🔄 Active Sessions: ${userSessions.size}\n` +
        `📅 Last Update: ${new Date(database.stats.lastUpdate).toLocaleString()}\n\n` +
        `🕷️ SPIDEY OFFICIAL - Admin Panel`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('broadcast', async (ctx) => {
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    
    const message = ctx.message.text.replace('/broadcast', '').trim();
    if (!message) {
        return await ctx.reply('Usage: /broadcast <message>');
    }
    
    let sent = 0;
    let failed = 0;
    
    for (const userId of database.users) {
        try {
            await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
            sent++;
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
            failed++;
        }
    }
    
    await ctx.reply(
        `📢 *Broadcast Complete*\n\n` +
        `✅ Sent: ${sent}\n` +
        `❌ Failed: ${failed}`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('dm', async (ctx) => {
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    
    const args = ctx.message.text.split(' ');
    if (args.length < 3) {
        return await ctx.reply('Usage: /dm <user_id> <message>');
    }
    
    const targetUserId = parseInt(args[1]);
    const message = args.slice(2).join(' ');
    
    try {
        await bot.telegram.sendMessage(targetUserId, message, { parse_mode: 'Markdown' });
        await ctx.reply('✅ Message sent successfully!');
    } catch (error) {
        await ctx.reply(`❌ Failed to send message: ${error.message}`);
    }
});

bot.command('users', async (ctx) => {
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    
    const userList = Array.from(database.users).join('\n');
    await ctx.reply(
        `👥 *Total Users: ${database.users.size}*\n\n` +
        `User IDs:\n${userList}`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('update', async (ctx) => {
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    
    database.stats.lastUpdate = Date.now();
    await saveDatabase();
    
    await ctx.reply(
        `✅ *Update Complete*\n\n` +
        `📅 Updated: ${new Date().toLocaleString()}\n` +
        `🕷️ SPIDEY OFFICIAL v3.0`,
        { parse_mode: 'Markdown' }
    );
});

// Bot commands
bot.start(async (ctx) => {
    await addUser(ctx.from.id, ctx.from.username);
    
    ctx.reply(
        "🕷️ *SPIDEY OFFICIAL*\n" +
        "━━━━━━━━━━━━━━━━━━━━\n\n" +
        "🎯 *Instagram Downloader PRO v3.0*\n\n" +
        "Send me any Instagram link!\n\n" +
        "✨ *Features:*\n" +
        "• 📸 Photos & Carousels\n" +
        "• 🎥 Videos & Reels\n" +
        "• 💎 HD Quality\n" +
        "• 🧩 Interactive Buttons\n" +
        "• 📝 Smart Captions\n" +
        "• ⚡ Lightning Fast\n\n" +
        "━━━━━━━━━━━━━━━━━━━━\n" +
        "💥 *Smarter • Faster • More Powerful*",
        { parse_mode: 'Markdown' }
    );
});

bot.help((ctx) => {
    ctx.reply(
        "📖 *SPIDEY OFFICIAL - Help Guide*\n" +
        "━━━━━━━━━━━━━━━━━━━━\n\n" +
        "🎯 *How to use:*\n" +
        "1. Send any Instagram link\n" +
        "2. Wait for processing\n" +
        "3. Get HD media with buttons!\n\n" +
        "🧩 *Interactive Features:*\n" +
        "• 🔗 Open on Instagram\n" +
        "• 📥 Download All\n" +
        "• ⏮️⏭️ Navigate media\n\n" +
        "✨ *Supported:*\n" +
        "• Posts, Reels, Videos\n" +
        "• Multi-image carousels\n" +
        "• HD quality downloads\n" +
        "• Original captions\n\n" +
        "━━━━━━━━━━━━━━━━━━━━\n" +
        "🕷️ *Fast • Secure • Stylish • Unstoppable*",
        { parse_mode: 'Markdown' }
    );
});

// Handle text with Instagram links
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    if (text && (text.includes('instagram.com') || text.includes('instagr.am'))) {
        await handleInstagramCommand(ctx);
    }
});

// Handle captions with Instagram links
bot.on('message', async (ctx) => {
    const caption = ctx.message?.caption;
    if (caption && (caption.includes('instagram.com') || caption.includes('instagr.am'))) {
        await handleInstagramCommand(ctx);
    }
});

// Handle callback queries (button clicks)
bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data;
    
    if (data === 'noop') {
        return await ctx.answerCbQuery();
    }
    
    await ctx.answerCbQuery('🕷️ SPIDEY OFFICIAL is processing...');
});

// Error handler
bot.catch((err, ctx) => {
    console.error(`Error for ${ctx.updateType}:`, err);
    ctx.reply(
        "❌ An error occurred.\n\n" +
        "🕷️ SPIDEY OFFICIAL - Please try again."
    );
});

// Initialize and launch
(async () => {
    await loadDatabase();
    
    console.log('🕷️ SPIDEY OFFICIAL PRO v3.0 is starting...');
    bot.launch().then(() => {
        console.log('✅ SPIDEY OFFICIAL is now running!');
        console.log('💎 Smarter • Faster • More Powerful');
        console.log(`📊 Loaded ${database.stats.totalUsers} users, ${database.stats.totalDownloads} downloads`);
    });
})();

// Graceful shutdown
process.once('SIGINT', async () => {
    await saveDatabase();
    bot.stop('SIGINT');
});
process.once('SIGTERM', async () => {
    await saveDatabase();
    bot.stop('SIGTERM');
});

module.exports = bot;
