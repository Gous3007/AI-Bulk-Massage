const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const P = require('pino');
const path = require('path');

let sock;
let connected = false;

async function initWhatsApp(io) {
    const authFolder = path.join(__dirname, '../auth_info');
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: 'silent' }),
        browser: ['Chrome (Linux)', 'Chrome', '121.0.6167.85']
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
            if (code !== DisconnectReason.loggedOut) {
                console.log('🔁 Reconnecting in 3s...');
                setTimeout(() => initWhatsApp(io), 3000);
            } else {
                console.log('🧹 Session expired, please scan again.');
            }
        }
    });

    // ✅ SOCKET EVENT HANDLERS - यह missing था!
    io.on('connection', (socket) => {
        console.log('👤 Client connected:', socket.id);

        // Send current connection status
        socket.emit(connected ? 'connected' : 'disconnected');

        // ✅ MESSAGE SENDING HANDLER - यह main missing part था!
        socket.on('send-message', async ({ numbers, message }) => {
            console.log(`📤 Sending messages to ${numbers.length} numbers`);

            if (!connected) {
                socket.emit('message-status', '❌ WhatsApp is not connected. Please scan QR code first.');
                return;
            }

            for (const number of numbers) {
                try {
                    // Format number properly (add country code if missing)
                    let formattedNumber = number.replace(/\D/g, '');

                    // Add country code if not present (default: India +91)
                    if (!formattedNumber.startsWith('91') && formattedNumber.length === 10) {
                        formattedNumber = '91' + formattedNumber;
                    }

                    // WhatsApp format: number@s.whatsapp.net
                    const jid = formattedNumber + '@s.whatsapp.net';

                    // Send message
                    await sock.sendMessage(jid, { text: message });

                    // Notify success
                    socket.emit('message-status', `✅ Message sent successfully to ${number}`);
                    console.log(`✅ Sent to ${number}`);

                    // Delay between messages to avoid spam detection (2-5 seconds)
                    await delay(2000 + Math.random() * 3000);

                } catch (error) {
                    console.error(`❌ Error sending to ${number}:`, error.message);
                    socket.emit('message-status', `❌ Failed to send message to ${number}: ${error.message}`);
                }
            }

            socket.emit('message-status', '🎉 All messages processing completed!');
            console.log('✅ Batch sending completed');
        });

        socket.on('disconnect', () => {
            console.log('👤 Client disconnected:', socket.id);
        });
    });
}

// Helper function to check if WhatsApp is connected
function isConnected() {
    return connected;
}

// Helper function to get socket instance
function getSocket() {
    return sock;
}

module.exports = {
    initWhatsApp,
    isConnected,
    getSocket
};