const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const P = require('pino');
const path = require('path');

// Keep all your imports and setup same as before
let sock;
let connected = false;

async function initWhatsApp(io) {
    const authFolder = path.join(__dirname, '../auth_info');
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { qr, connection, lastDisconnect } = update;

        if (qr) {
            console.log('🔹 QR Code received, scan it from the scanner page.');
            qrcode.toString(qr, { type: 'terminal' }, (err, url) => {
                if (err) console.error(err);
                console.log(url);
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
            console.log('❌ WhatsApp disconnected.');
            if (lastDisconnect) {
                console.log('Last disconnect reason:', lastDisconnect.error?.output?.statusCode);
            }
        }
    });

    // Bulk send function with delay
    async function sendBulkMessages(numbers, message) {
        for (let i = 0; i < numbers.length; i++) {
            const number = numbers[i];
            try {
                await sock.sendMessage(`${number}@s.whatsapp.net`, { text: message });
                io.emit('message-status', `✅ Message sent to ${number} (${i + 1}/${numbers.length})`);
                console.log(`✅ Message sent to ${number} (${i + 1}/${numbers.length})`);
                await new Promise(resolve => setTimeout(resolve, 3000)); // 3 seconds delay
            } catch (err) {
                io.emit('message-status', `❌ Failed to send to ${number}`);
                console.error(`❌ Failed to send to ${number}`, err);
            }
        }
    }

    // Handle frontend
    io.on('connection', (socket) => {
        socket.on('send-message', async ({ numbers, message }) => {
            if (!connected) return socket.emit('message-status', 'WhatsApp not connected!');

            // Expect numbers as array of strings
            if (!Array.isArray(numbers)) {
                numbers = numbers.split(',').map(n => n.trim()); // if user sends comma separated
            }

            sendBulkMessages(numbers, message);
        });
    });
}

module.exports = { initWhatsApp };
