const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const P = require('pino');
const path = require('path');

let sock;
let connected = false;
let sendingInProgress = false;
const messageQueue = new Map(); // ✅ Track sent messages with 24-hour cooldown

async function initWhatsApp(io) {
    const authFolder = path.join(__dirname, '../auth_info');
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: 'silent' }),
        browser: ['Chrome (Linux)', 'Chrome', '121.0.6167.85'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        getMessage: async () => undefined
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { qr, connection, lastDisconnect } = update;

        if (qr) {
            console.log('🔹 QR Code received, scan it from the scanner page.');
            qrcode.toDataURL(qr, (err, url) => {
                if (err) console.error(err);
                io.emit('qr', url);
            });
        }

        if (connection === 'open') {
            connected = true;
            console.log('✅ WhatsApp connected!');
            io.emit('connected');
        }

        if (connection === 'close') {
            connected = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log('❌ WhatsApp disconnected. Reason:', code);

            const shouldReconnect = code !== DisconnectReason.loggedOut;

            if (shouldReconnect) {
                console.log('🔁 Reconnecting in 5s...');
                await delay(5000);
                initWhatsApp(io);
            } else {
                console.log('🧹 Session logged out, please scan again.');
                io.emit('logged-out');
            }
        }
    });

    setupSocketHandlers(io);
}

function setupSocketHandlers(io) {
    io.on('connection', (socket) => {
        console.log('👤 Client connected:', socket.id);

        socket.emit(connected ? 'connected' : 'disconnected');

        socket.on('send-message', async ({ numbers, message }) => {
            console.log(`📤 Request to send messages to ${numbers.length} numbers`);

            if (sendingInProgress) {
                socket.emit('message-status', '⚠️ Another batch is already being sent. Please wait.');
                return;
            }

            if (!connected) {
                socket.emit('message-status', '❌ WhatsApp is not connected. Please scan QR code first.');
                return;
            }

            sendingInProgress = true;
            const sentNumbers = new Set();
            let messageCounter = 0; // ✅ Track messages for 20-message pause

            try {
                for (let i = 0; i < numbers.length; i++) {
                    const number = numbers[i];

                    // ✅ Skip if already sent in this batch
                    if (sentNumbers.has(number)) {
                        console.log(`⏭️ Skipping duplicate: ${number}`);
                        continue;
                    }

                    try {
                        // Format number properly
                        let formattedNumber = number.replace(/\D/g, '');

                        if (!formattedNumber.startsWith('91') && formattedNumber.length === 10) {
                            formattedNumber = '91' + formattedNumber;
                        }

                        const jid = formattedNumber + '@s.whatsapp.net';

                        // ✅ Check 24-hour cooldown
                        const messageKey = formattedNumber; // Use only number for 24-hour tracking
                        const lastSent = messageQueue.get(messageKey);
                        const now = Date.now();
                        const twentyFourHours = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

                        if (lastSent && (now - lastSent) < twentyFourHours) {
                            const remainingTime = twentyFourHours - (now - lastSent);
                            const hoursLeft = Math.floor(remainingTime / (60 * 60 * 1000));
                            const minutesLeft = Math.floor((remainingTime % (60 * 60 * 1000)) / (60 * 1000));

                            console.log(`⏭️ Message already sent to ${number} within 24 hours`);
                            socket.emit('message-status', `⏭️ Skipped ${number} (Wait ${hoursLeft}h ${minutesLeft}m)`);
                            continue;
                        }

                        // Send message
                        await sock.sendMessage(jid, { text: message });

                        // Mark as sent with current timestamp
                        sentNumbers.add(number);
                        messageQueue.set(messageKey, now);
                        messageCounter++;

                        socket.emit('message-status', `✅ Message sent to ${number} (${i + 1}/${numbers.length})`);
                        console.log(`✅ Sent to ${number}`);

                        // ✅ Smart delay logic
                        if (i < numbers.length - 1) {
                            let delayTime;

                            // After every 20 messages, wait 5 seconds
                            if (messageCounter > 0 && messageCounter % 20 === 0) {
                                delayTime = 5000; // 5 seconds after 20 messages
                                console.log(`⏸️ Taking 5-second break after ${messageCounter} messages...`);
                                socket.emit('message-status', `⏸️ Break: Waiting 5 seconds after 20 messages...`);
                            } else {
                                delayTime = 3000; // 3 seconds regular delay
                                console.log(`⏳ Waiting 3 seconds before next message...`);
                            }

                            // Send countdown updates
                            const seconds = Math.ceil(delayTime / 1000);
                            for (let remaining = seconds; remaining > 0; remaining--) {
                                socket.emit('message-status', `⏳ Next message in ${remaining}s...`);
                                await delay(1000);
                            }
                        }

                    } catch (error) {
                        console.error(`❌ Error sending to ${number}:`, error.message);
                        socket.emit('message-status', `❌ Failed: ${number} - ${error.message}`);
                        await delay(3000);
                    }
                }

                socket.emit('message-status', '🎉 All messages sent successfully!');
                console.log('✅ Batch sending completed');

            } catch (error) {
                console.error('❌ Batch sending error:', error);
                socket.emit('message-status', `❌ Error: ${error.message}`);
            } finally {
                sendingInProgress = false;

                // ✅ Clean old entries from queue (older than 24 hours)
                const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
                for (const [key, timestamp] of messageQueue.entries()) {
                    if (timestamp < twentyFourHoursAgo) {
                        messageQueue.delete(key);
                    }
                }

                console.log(`📊 Queue size: ${messageQueue.size} numbers tracked`);
            }
        });

        socket.on('disconnect', () => {
            console.log('👤 Client disconnected:', socket.id);
        });
    });
}

function isConnected() {
    return connected;
}

function getSocket() {
    return sock;
}

function clearMessageQueue() {
    messageQueue.clear();
    console.log('🧹 Message queue cleared');
}

// ✅ Get remaining time for a number
function getNumberCooldown(number) {
    const formattedNumber = number.replace(/\D/g, '');
    const lastSent = messageQueue.get(formattedNumber);

    if (!lastSent) {
        return { canSend: true, remainingTime: 0 };
    }

    const now = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000;
    const timePassed = now - lastSent;

    if (timePassed >= twentyFourHours) {
        return { canSend: true, remainingTime: 0 };
    }

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
    getNumberCooldown
};