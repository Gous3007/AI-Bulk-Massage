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
    // Cleanup previous connection
    cleanup();
    reconnectAttempts++;

    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        console.log('❌ Max reconnection attempts reached. Please refresh the page.');
        io.emit('max-reconnects');
        return;
    }

    const authFolder = path.join(__dirname, '../auth_info');

    // Ensure auth directory exists
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
            fireInitQueries: false, // Disable initial queries to reduce load
            generateHighQualityLinkPreview: false,
            linkPreviewImageThumbnailWidth: 192,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr, isNewLogin } = update;

            console.log('🔗 Connection update:', connection, qr ? 'QR Received' : '', isNewLogin ? 'New Login' : '');

            if (qr) {
                reconnectAttempts = 0; // Reset on new QR
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

                // Handle specific disconnect reasons
                if (code === DisconnectReason.loggedOut || code === 405) {
                    console.log('🧹 Session invalid/expired, clearing auth data...');
                    cleanup();

                    // Delete auth files
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

                    // Don't auto-reconnect for these errors
                    return;
                }

                if (code === DisconnectReason.connectionLost || code === DisconnectReason.timedOut) {
                    // Reconnect for temporary issues
                    const delayTime = Math.min(1000 * Math.pow(2, reconnectAttempts), 10000);
                    console.log(`🔁 Reconnecting in ${delayTime / 1000}s... (Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
                    setTimeout(() => initWhatsApp(io), delayTime);
                    return;
                }

                // For other errors, wait longer before retry
                const delayTime = 5000;
                console.log(`🔁 Reconnecting in ${delayTime / 1000}s...`);
                setTimeout(() => initWhatsApp(io), delayTime);
            }

            if (connection === 'open') {
                connected = true;
                reconnectAttempts = 0;
                console.log('✅ WhatsApp connected successfully');
                io.emit('connected');
                io.emit('status', 'WhatsApp connected successfully!');
            }

            if (connection === 'connecting') {
                io.emit('status', 'Connecting to WhatsApp...');
            }
        });

        setupSocketHandlers(io);

    } catch (error) {
        console.error('❌ Initialization error:', error);
        io.emit('status', `Initialization failed: ${error.message}`);

        // Retry after delay
        setTimeout(() => initWhatsApp(io), 5000);
    }
}

function setupSocketHandlers(io) {
    // Remove existing connection listeners to prevent duplicates
    io.removeAllListeners('connection');

    io.on('connection', (socket) => {
        console.log('👤 Client connected:', socket.id);

        // Set max listeners
        socket.setMaxListeners(15);

        // Emit current connection status
        if (connected) {
            socket.emit('connected');
            socket.emit('status', 'WhatsApp connected successfully!');
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
            // Delete auth folder and restart
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

            sendingInProgress = true;
            console.log(`📤 Sending messages to ${numbers.length} numbers`);

            try {
                let successCount = 0;
                let failCount = 0;

                for (let i = 0; i < numbers.length; i++) {
                    const number = numbers[i];

                    try {
                        let formattedNumber = number.replace(/\D/g, '');
                        if (!formattedNumber.startsWith('91') && formattedNumber.length === 10) {
                            formattedNumber = '91' + formattedNumber;
                        }
                        const jid = formattedNumber + '@s.whatsapp.net';

                        // Cooldown check
                        const messageKey = formattedNumber;
                        const lastSent = messageQueue.get(messageKey);
                        const now = Date.now();
                        const twentyFourHours = 24 * 60 * 60 * 1000;

                        if (lastSent && (now - lastSent) < twentyFourHours) {
                            const remainingTime = twentyFourHours - (now - lastSent);
                            const hoursLeft = Math.floor(remainingTime / (60 * 60 * 1000));
                            const minutesLeft = Math.floor((remainingTime % (60 * 60 * 1000)) / (60 * 1000));
                            socket.emit('message-status', `⏭️ Skipped ${number} (Wait ${hoursLeft}h ${minutesLeft}m)`);
                            failCount++;
                            continue;
                        }

                        // Send message
                        await sock.sendMessage(jid, { text: message });
                        messageQueue.set(messageKey, now);
                        successCount++;

                        socket.emit('message-status', `✅ Sent to ${number} (${i + 1}/${numbers.length})`);

                        // Delay between messages
                        if (i < numbers.length - 1) {
                            const delayTime = (successCount % 20 === 0) ? 5000 : 2000;
                            socket.emit('message-status', `⏳ Waiting ${delayTime / 1000}s...`);
                            await delay(delayTime);
                        }

                    } catch (err) {
                        console.error(`❌ Error sending to ${number}:`, err.message);
                        socket.emit('message-status', `❌ Failed: ${number} - ${err.message}`);
                        failCount++;
                        await delay(2000);
                    }
                }

                socket.emit('message-status',
                    `🎉 Batch completed! ✅ ${successCount} successful, ❌ ${failCount} failed`);

            } catch (err) {
                console.error('❌ Batch sending error:', err);
                socket.emit('message-status', `❌ Error: ${err.message}`);
            } finally {
                sendingInProgress = false;
                // Clean up old queue entries
                const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
                for (const [key, timestamp] of messageQueue.entries()) {
                    if (timestamp < twentyFourHoursAgo) messageQueue.delete(key);
                }
            }
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
    console.log('🧹 Message queue cleared');
}

function getNumberCooldown(number) {
    const formattedNumber = number.replace(/\D/g, '');
    const lastSent = messageQueue.get(formattedNumber);
    if (!lastSent) return { canSend: true, remainingTime: 0 };

    const now = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000;
    const timePassed = now - lastSent;

    if (timePassed >= twentyFourHours) return { canSend: true, remainingTime: 0 };

    return {
        canSend: false,
        remainingTime: twentyFourHours - timePassed,
        hoursLeft: Math.floor((twentyFourHours - timePassed) / (60 * 60 * 1000)),
        minutesLeft: Math.floor(((twentyFourHours - timePassed) % (60 * 60 * 1000)) / (60 * 1000))
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