const { Client } = require('../src/eidolon');

const token = process.env.DT;
const client = new Client(token);

client.on('message', (message) => {
    if (message.content.toLowerCase() === 'ping') {
        message.reply('Pong!');
    }
});

client.on('ready', () => {
    console.log('bot');
});

client.login();
