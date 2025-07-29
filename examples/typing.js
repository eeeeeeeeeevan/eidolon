const { Client } = require('../src/eidolon');

const token = '';
const client = new Client(token);

client.on('message', async (message) => {
    if (message.content.toLowerCase() === '!type') {
        await message.channel.type(message.channel.id);
    }
});

client.on('ready', () => {
    console.log('wow');
});

client.login();
