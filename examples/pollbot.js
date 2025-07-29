const { Client } = require('../src/eidolon');

const token = process.env.DT;
const client = new Client(token);

client.on('message', async (message) => {
    if (message.content.toLowerCase() === '!poll') {
        await message.channel.send('', {
            poll: {
                question: 'hi',
                answers: ['yay', 'nah', 'wow', 'UD'],
                allowMultiselect: false,
                duration: 60
            }
        });
    }
});

client.on('ready', () => {
    console.log('ok');
});

client.login();
