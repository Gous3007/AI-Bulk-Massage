const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');

class WhatsAppModel {
    constructor() {
        this.sock = null;
        this.qr = null;
        this.isConnected = false;
    }

    async initializeConnection() {
        try {
            const { state, saveCreds } = await useMultiFileAuthState('./sessions');
            const { version, isLatest } = await fetchLatestBaileysVersion();

            console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

            this.sock = makeWASocket({
                version,
                logger: pino({ level: 'silent' }),
                printQRInTerminal: false,
                auth: state,
                generateHighQualityLinkPreview: true,
            });

            this.sock.ev.on('connection.update', (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    this.qr = qr;
                }

                if (connection === 'close') {
                    const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                    console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);

                    if (shouldReconnect) {
                        this.initializeConnection();
                    }
                    this.isConnected = false;
                } else if (connection === 'open') {
                    console.log('WhatsApp connection opened');
                    this.isConnected = true;
                    this.qr = null;
                }
            });

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('messages.upsert', (m) => {
                console.log('New message:', JSON.stringify(m, undefined, 2));
                if (global.updateMessageCount) {
                    global.updateMessageCount();
                }
            });

        } catch (error) {
            console.error('Error initializing WhatsApp connection:', error);
            throw error;
        }
    }

    async sendMessage(phoneNumber, message) {
        if (!this.isConnected) {
            throw new Error('WhatsApp not connected');
        }

        try {
            const formattedNumber = phoneNumber.includes('@s.whatsapp.net')
                ? phoneNumber
                : `${phoneNumber}@s.whatsapp.net`;

            await this.sock.sendMessage(formattedNumber, { text: message });

            if (global.updateMessageCount) {
                global.updateMessageCount();
            }

            return { success: true, message: 'Message sent successfully' };
        } catch (error) {
            console.error('Error sending message:', error);
            throw error;
        }
    }

    getQR() {
        return this.qr;
    }

    getConnectionStatus() {
        return this.isConnected;
    }
}

module.exports = new WhatsAppModel();