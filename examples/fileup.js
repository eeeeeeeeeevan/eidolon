const { Client } = require('../src/eidolon');
const path = require('path');

const token = '';
const client = new Client(token);

client.on('message', async (message) => {
    if (message.content.toLowerCase() === '!upload') {
        const fpath = path.join(__dirname, 'example.txt');
        await message.channel.send('', { files: [fpath] });
    }
});

client.on('ready', () => {
    console.log('bot');
});

client.login();
