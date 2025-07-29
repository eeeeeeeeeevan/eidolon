const { Client } = require('../src/eidolon');

const token = process.env.DT;
const client = new Client(token);

client.on('friendRequest', async (user) => {
    console.log(`received friend request from ${user.username}`);
    if (user.username === 'johnpork') {
        await client.users.acceptFriendRequest(user.id);
        console.log(`accepted friend request from ${user.username}`);
    } else {
        await client.users.declineFriendRequest(user.id);
        console.log(`declined friend request from ${user.username}`);
    }
});

client.on('ready', () => {
    console.log('bot');
});

client.login();
