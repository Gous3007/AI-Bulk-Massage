const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, delay, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const P = require('pino');
const path = require('path');
const fs = require('fs');

let sock = null;
let connected = false;
let sendingInProgress = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
const messageQueue = new Map();

// ============= SAFETY CONFIGURATIONS =============
const SAFETY_CONFIG = {
    // Minimum delay between messages (random range for human-like behavior)
    MIN_DELAY: 8000,  // 8 seconds
    MAX_DELAY: 15000, // 15 seconds

    // Maximum messages per session before long break
    MAX_MESSAGES_PER_SESSION: 15,
    LONG_BREAK_DURATION: 300000, // 5 minutes break after every 15 messages

    // Cooldown between same number
    MESSAGE_COOLDOWN: 48 * 60 * 60 * 1000, // 48 hours (increased from 24)

    // Daily limits
    MAX_MESSAGES_PER_DAY: 100, // Maximum 50 messages per day

    // Random variation in message timing (to appear human-like)
    RANDOM_EXTRA_DELAY: true,

    // Simulate typing (adds natural delay)
    SIMULATE_TYPING: true,
    TYPING_DELAY: 3000, // 3 seconds typing simulation
};

// Track daily message count
let dailyMessageCount = 0;
let lastResetDate = new Date().toDateString();

function resetDailyCountIfNeeded() {
    const today = new Date().toDateString();
    if (today !== lastResetDate) {
        dailyMessageCount = 0;
        lastResetDate = today;
        console.log('📅 Daily message count reset');
    }
}

function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function cleanup() {
    if (sock) {
        try {
            sock.ws.close();
            sock.end();
            sock = null;
        } catch (err) {
            // Ignore cleanup errors
        }
    }
    connected = false;
}

async function initWhatsApp(io) {
    cleanup();
    reconnectAttempts++;

    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        console.log('❌ Max reconnection attempts reached. Please refresh the page.');
        io.emit('max-reconnects');
        return;
    }

    const authFolder = path.join(__dirname, '../auth_info');

    if (!fs.existsSync(authFolder)) {
        fs.mkdirSync(authFolder, { recursive: true });
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        const { version, isLatest } = await fetchLatestBaileysVersion();

        console.log(`🔗 Using WA v${version.join('.')}, isLatest: ${isLatest}`);

        sock = makeWASocket({
            auth: state,
            logger: P({ level: 'silent' }),
            version,
            browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            getMessage: async () => undefined,
            retryRequestDelayMs: 2000,
            fireInitQueries: false,
            generateHighQualityLinkPreview: false,
            linkPreviewImageThumbnailWidth: 192,
            // Additional safety options
            emitOwnEvents: false,
            shouldIgnoreJid: jid => jid === 'status@broadcast',
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr, isNewLogin } = update;

            console.log('🔗 Connection update:', connection, qr ? 'QR Received' : '', isNewLogin ? 'New Login' : '');

            if (qr) {
                reconnectAttempts = 0;
                try {
                    console.log('📱 Generating QR code...');
                    const qrDataUrl = await qrcode.toDataURL(qr);
                    io.emit('qr', qrDataUrl);
                    io.emit('status', 'Scan the QR code with WhatsApp');
                    console.log('✅ QR code emitted to frontend');
                } catch (err) {
                    console.error('❌ QR generation failed:', err);
                    io.emit('status', 'QR generation failed');
                }
            }

            if (connection === 'close') {
                connected = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                const reason = lastDisconnect?.error?.output?.payload?.reason || code;

                console.log('❌ WhatsApp disconnected. Reason:', reason);

                if (code === DisconnectReason.loggedOut || code === 405) {
                    console.log('🧹 Session invalid/expired, clearing auth data...');
                    cleanup();

                    try {
                        if (fs.existsSync(authFolder)) {
                            fs.rmSync(authFolder, { recursive: true, force: true });
                            console.log('✅ Auth files deleted successfully');
                        }
                    } catch (cleanupErr) {
                        console.error('❌ Failed to delete auth files:', cleanupErr);
                    }

                    io.emit('logged-out');
                    io.emit('status', 'Session expired. Please refresh the page and scan QR again.');
                    return;
                }

                if (code === DisconnectReason.connectionLost || code === DisconnectReason.timedOut) {
                    const delayTime = Math.min(1000 * Math.pow(2, reconnectAttempts), 10000);
                    console.log(`🔁 Reconnecting in ${delayTime / 1000}s... (Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
                    setTimeout(() => initWhatsApp(io), delayTime);
                    return;
                }

                const delayTime = 5000;
                console.log(`🔁 Reconnecting in ${delayTime / 1000}s...`);
                setTimeout(() => initWhatsApp(io), delayTime);
            }

            if (connection === 'open') {
                connected = true;
                reconnectAttempts = 0;
                console.log('✅ WhatsApp connected successfully');
                io.emit('connected');
                io.emit('status', 'WhatsApp connected successfully! ⚠️ Safe mode enabled');
            }

            if (connection === 'connecting') {
                io.emit('status', 'Connecting to WhatsApp...');
            }
        });

        setupSocketHandlers(io);

    } catch (error) {
        console.error('❌ Initialization error:', error);
        io.emit('status', `Initialization failed: ${error.message}`);
        setTimeout(() => initWhatsApp(io), 5000);
    }
}

function setupSocketHandlers(io) {
    io.removeAllListeners('connection');

    io.on('connection', (socket) => {
        console.log('👤 Client connected:', socket.id);
        socket.setMaxListeners(15);

        if (connected) {
            socket.emit('connected');
            socket.emit('status', 'WhatsApp connected successfully! Safe mode active 🛡️');
        } else {
            socket.emit('disconnected');
            socket.emit('status', 'Please scan QR code to connect WhatsApp');
        }

        socket.on('restart-connection', () => {
            console.log('🔄 Manual restart requested by client');
            reconnectAttempts = 0;
            initWhatsApp(io);
        });

        socket.on('force-refresh', () => {
            console.log('🔄 Force refresh requested');
            const authFolder = path.join(__dirname, '../auth_info');
            try {
                if (fs.existsSync(authFolder)) {
                    fs.rmSync(authFolder, { recursive: true, force: true });
                    console.log('✅ Auth files deleted');
                }
            } catch (err) {
                console.error('❌ Failed to delete auth files:', err);
            }
            reconnectAttempts = 0;
            setTimeout(() => initWhatsApp(io), 1000);
        });

        socket.on('send-message', async ({ numbers, message }) => {
            if (!sock || !connected) {
                socket.emit('message-status', '❌ WhatsApp is not connected. Please scan QR code first.');
                return;
            }

            if (sendingInProgress) {
                socket.emit('message-status', '⚠️ Another batch is already being sent. Please wait.');
                return;
            }

            // Reset daily count if needed
            resetDailyCountIfNeeded();

            // Check daily limit
            if (dailyMessageCount >= SAFETY_CONFIG.MAX_MESSAGES_PER_DAY) {
                socket.emit('message-status', `⛔ Daily limit reached (${SAFETY_CONFIG.MAX_MESSAGES_PER_DAY} messages). Please try tomorrow.`);
                return;
            }

            // Calculate how many messages can be sent today
            const remainingToday = SAFETY_CONFIG.MAX_MESSAGES_PER_DAY - dailyMessageCount;
            const numbersToSend = Math.min(numbers.length, remainingToday);

            if (numbersToSend < numbers.length) {
                socket.emit('message-status', `⚠️ Only ${numbersToSend} messages will be sent today (daily limit: ${SAFETY_CONFIG.MAX_MESSAGES_PER_DAY})`);
            }

            sendingInProgress = true;
            console.log(`📤 Sending messages to ${numbersToSend} numbers (Safe Mode)`);

            try {
                let successCount = 0;
                let failCount = 0;
                let sessionMessageCount = 0;

                for (let i = 0; i < numbersToSend; i++) {
                    const number = numbers[i];

                    try {
                        let formattedNumber = number.replace(/\D/g, '');
                        if (!formattedNumber.startsWith('91') && formattedNumber.length === 10) {
                            formattedNumber = '91' + formattedNumber;
                        }
                        const jid = formattedNumber + '@s.whatsapp.net';

                        // Cooldown check (48 hours)
                        const messageKey = formattedNumber;
                        const lastSent = messageQueue.get(messageKey);
                        const now = Date.now();

                        if (lastSent && (now - lastSent) < SAFETY_CONFIG.MESSAGE_COOLDOWN) {
                            const remainingTime = SAFETY_CONFIG.MESSAGE_COOLDOWN - (now - lastSent);
                            const hoursLeft = Math.floor(remainingTime / (60 * 60 * 1000));
                            socket.emit('message-status', `⏭️ Skipped ${number} (Wait ${hoursLeft}h)`);
                            failCount++;
                            continue;
                        }

                        // Simulate typing (natural behavior)
                        if (SAFETY_CONFIG.SIMULATE_TYPING) {
                            await sock.presenceSubscribe(jid);
                            await sock.sendPresenceUpdate('composing', jid);
                            await delay(SAFETY_CONFIG.TYPING_DELAY);
                            await sock.sendPresenceUpdate('paused', jid);
                        }

                        // Send message
                        await sock.sendMessage(jid, { text: message });
                        messageQueue.set(messageKey, now);
                        successCount++;
                        dailyMessageCount++;
                        sessionMessageCount++;

                        socket.emit('message-status', `✅ Sent to ${number} (${i + 1}/${numbersToSend}) | Daily: ${dailyMessageCount}/${SAFETY_CONFIG.MAX_MESSAGES_PER_DAY}`);

                        // Long break after every 15 messages
                        if (sessionMessageCount >= SAFETY_CONFIG.MAX_MESSAGES_PER_SESSION && i < numbersToSend - 1) {
                            const breakMinutes = SAFETY_CONFIG.LONG_BREAK_DURATION / 60000;
                            socket.emit('message-status', `⏸️ Taking ${breakMinutes} minute break for safety...`);
                            await delay(SAFETY_CONFIG.LONG_BREAK_DURATION);
                            sessionMessageCount = 0;
                            socket.emit('message-status', `▶️ Resuming...`);
                        } else if (i < numbersToSend - 1) {
                            // Random delay between messages (8-15 seconds)
                            const randomDelay = getRandomDelay(
                                SAFETY_CONFIG.MIN_DELAY,
                                SAFETY_CONFIG.MAX_DELAY
                            );
                            socket.emit('message-status', `⏳ Waiting ${(randomDelay / 1000).toFixed(1)}s... (Human-like delay)`);
                            await delay(randomDelay);
                        }

                    } catch (err) {
                        console.error(`❌ Error sending to ${number}:`, err.message);
                        socket.emit('message-status', `❌ Failed: ${number} - ${err.message}`);
                        failCount++;
                        await delay(5000); // Wait longer on error
                    }
                }

                socket.emit('message-status',
                    `🎉 Batch completed! ✅ ${successCount} sent, ❌ ${failCount} failed | Daily total: ${dailyMessageCount}/${SAFETY_CONFIG.MAX_MESSAGES_PER_DAY}`);

            } catch (err) {
                console.error('❌ Batch sending error:', err);
                socket.emit('message-status', `❌ Error: ${err.message}`);
            } finally {
                sendingInProgress = false;
                // Clean up old queue entries
                const cooldownAgo = Date.now() - SAFETY_CONFIG.MESSAGE_COOLDOWN;
                for (const [key, timestamp] of messageQueue.entries()) {
                    if (timestamp < cooldownAgo) messageQueue.delete(key);
                }
            }
        });

        socket.on('get-safety-info', () => {
            resetDailyCountIfNeeded();
            socket.emit('safety-info', {
                dailyLimit: SAFETY_CONFIG.MAX_MESSAGES_PER_DAY,
                dailyUsed: dailyMessageCount,
                dailyRemaining: SAFETY_CONFIG.MAX_MESSAGES_PER_DAY - dailyMessageCount,
                minDelay: SAFETY_CONFIG.MIN_DELAY / 1000,
                maxDelay: SAFETY_CONFIG.MAX_DELAY / 1000,
                cooldownHours: SAFETY_CONFIG.MESSAGE_COOLDOWN / (60 * 60 * 1000),
                sessionLimit: SAFETY_CONFIG.MAX_MESSAGES_PER_SESSION,
                longBreakMinutes: SAFETY_CONFIG.LONG_BREAK_DURATION / 60000
            });
        });

        socket.on('disconnect', () => {
            console.log('👤 Client disconnected:', socket.id);
        });
    });
}

function isConnected() {
    return connected && sock !== null;
}

function getSocket() {
    return sock;
}

function clearMessageQueue() {
    messageQueue.clear();
    dailyMessageCount = 0;
    console.log('🧹 Message queue and daily count cleared');
}

function getNumberCooldown(number) {
    const formattedNumber = number.replace(/\D/g, '');
    const lastSent = messageQueue.get(formattedNumber);
    if (!lastSent) return { canSend: true, remainingTime: 0 };

    const now = Date.now();
    const timePassed = now - lastSent;

    if (timePassed >= SAFETY_CONFIG.MESSAGE_COOLDOWN) return { canSend: true, remainingTime: 0 };

    return {
        canSend: false,
        remainingTime: SAFETY_CONFIG.MESSAGE_COOLDOWN - timePassed,
        hoursLeft: Math.floor((SAFETY_CONFIG.MESSAGE_COOLDOWN - timePassed) / (60 * 60 * 1000)),
        minutesLeft: Math.floor(((SAFETY_CONFIG.MESSAGE_COOLDOWN - timePassed) % (60 * 60 * 1000)) / (60 * 1000))
    };
}

module.exports = {
    initWhatsApp,
    isConnected,
    getSocket,
    clearMessageQueue,
    getNumberCooldown,
    cleanup
};