const WebSocket = require('ws');
const zlib = require('zlib');
const EventEmitter = require('events');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');



class RESTManager {
    constructor(client) {
        this.client = client;
        this.baseURL = 'https://discord.com/api/v9';
        this.superProperties = Buffer.from(JSON.stringify(client._superProperties)).toString('base64');
        this.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    }

    getHeaders(channelId) {
        const referer = channelId !== undefined
            ? `https://discord.com/channels/@me/${channelId}`
            : 'https://discord.com/channels/@me';
        return {
            'Authorization': this.client.token,
            'Content-Type': 'application/json',
            'X-Super-Properties': this.superProperties,
            'X-Debug-Options': 'bugReporterEnabled',
            'X-Discord-Locale': 'en-US',
            'X-Discord-Timezone': this.timezone,
            'Referer': referer,
            'User-Agent': this.client._superProperties.browser_user_agent,
            'Origin': 'https://discord.com',
            'Accept-Encoding': 'gzip, deflate, br, zstd'
        };
    }

    async request(method, path, data, channelId) {
        try {
            const response = await axios({
                method,
                url: `${this.baseURL}${path}`,
                data,
                headers: this.getHeaders(channelId)
            });
            return response.data ? this.client._enhanceMessage(response.data) : null;
        } catch (error) {
            if (error.response) throw this.client._convertKeys(error.response.data);
            throw error;
        }
    }

    async postTyping(channelId) {
        return this.request('POST', `/channels/${channelId}/typing`, null, channelId);
    }

    async postRing(channelId) {
        return this.request('POST', `/channels/${channelId}/call/ring`, null, channelId);
    }
}

class Client extends EventEmitter {
    constructor(token, mobile) {
        super();
        if (!token) throw new Error('No token provided');
        this.token = token;
        this._buffer = '';
        this._inflate = zlib.createInflate();
        this._ws = null;
        this._seq = null;
        this._heartbeatInterval = null;
        this._messageCache = new Map();
        this._reconnectAttempts = 0;
        this._reconnectTimeout = null;
        this._superProperties = {
            os: "Windows",
            browser: mobile != true && 'Chrome' || 'Discord iOS',
            device: "",
            system_locale: "en-US",
            has_client_mods: false,
            browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
            browser_version: "132.0.0.0",
            os_version: "10",
            referrer: "",
            referring_domain: "",
            referrer_current: "",
            referring_domain_current: "",
            release_channel: "stable",
            client_build_number: 362568,
            client_event_source: null
        };
        this.rest = new RESTManager(this);
        this._disconnectCodes = [1000, 1001, 1006, 4000, 4001, 4002, 4003, 4005, 4007, 4008, 4009];
        this._lastHeartbeatAck = null;
        this._heartbeatTimeout = null;

        this._inflate = zlib.createInflate();
        this._setupInflateErrorHandling();

        this.channels = {
            send: (channelId, content, options) => this.sendMessage(channelId, content, options),
            type: (channelId) => this.triggerTyping(channelId),
        };

        this.users = {
            acceptFriendRequest: (userId) => this.acceptFriendRequest(userId),
            declineFriendRequest: (userId) => this.declineFriendRequest(userId),
        };
    }

    _setupInflateErrorHandling() {
        this._inflate.on('error', (err) => {
            if (err.code === 'Z_BUF_ERROR') {
                return;
            }
            this.emit('error', err);
        });
    }

    async triggerTyping(channelId) {
        return this.rest.postTyping(channelId);
    }

    _enhanceMessage(message) {
        const converted = this._convertKeys(message);
        if (!converted) return converted;

        const enhanced = {
            ...converted,
            delete: () => this.rest.request(
                'DELETE',
                `/channels/${converted.channelId}/messages/${converted.id}`,
                null,
                converted.channelId
            ).catch(console.error),
            edit: (newContent) => this.rest.request(
                'PATCH',
                `/channels/${converted.channelId}/messages/${converted.id}`,
                { content: newContent },
                converted.channelId
            ).catch(console.error),
            reply: (content, options) => this.sendMessage(
                converted.channelId,
                content,
                {
                    ...options,
                    messageReference: {
                        channelId: converted.channelId,
                        messageId: converted.id
                    }
                }
            ).catch(console.error),
            channel: {
                send: (content, options) => this.sendMessage(converted.channelId, content, options)
                    .catch(console.error),
                type: () => this.triggerTyping(converted.channelId).catch(console.error),
                leaveGroupChat: (silent) => this.leaveGroupChat(converted.channelId, silent),
                delete: (messageId) => this.rest.request(
                    'DELETE',
                    `/channels/${converted.channelId}/messages/${messageId}`,
                    null,
                    converted.channelId
                ).catch(console.error),
            }
        };

        return enhanced;
    }

        async sendMessage(channelId, content, rawOptions = {}) {
        let options = rawOptions;
        const delay = ms => new Promise(res => setTimeout(res, ms));

        if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
            options = { ...rawOptions, ...content };
            content = options.content || "";
        }

        const { tts = false, messageReference, poll, files } = options;

        if (!channelId) throw new Error('No channel ID provided');
        if (!content && !poll && (!files || files.length === 0)) {
            throw new Error('sendMessage requires content, a poll, or files to be provided.');
        }

        let preparedAttachments = [];

        if (files && files.length > 0) {
            await delay(Math.random() * 400 + 200);

            const fileDetails = await Promise.all(
                files.map(async (filePath, index) => {
                    const stats = await fs.stat(filePath);
                    if (!stats.isFile()) throw new Error(`Path is not a file: ${filePath}`);
                    return {
                        id: index.toString(),
                        filename: path.basename(filePath),
                        file_size: stats.size,
                        path: filePath,
                    };
                })
            );

            const attachmentsPayload = {
                files: fileDetails.map(({ id, filename, file_size }) => ({
                    id,
                    filename,
                    file_size,
                    is_clip: false
                }))
            };

            const uploadUrlResponse = await axios({
                method: 'POST',
                url: `${this.rest.baseURL}/channels/${channelId}/attachments`,
                data: attachmentsPayload,
                headers: this.rest.getHeaders(channelId)
            }).catch(error => {
                if (error.response) throw this._convertKeys(error.response.data);
                throw error;
            });

            const uploadTargets = this._convertKeys(uploadUrlResponse.data).attachments;
            for (const target of uploadTargets) {
                 const fileToUpload = fileDetails.find(f => f.id === target.id.toString());
                 if (!fileToUpload) continue;

                 const fileBuffer = await fs.readFile(fileToUpload.path);
                 
                 await axios.put(target.uploadUrl, fileBuffer, {
                     headers: { 'Content-Type': 'application/octet-stream' },
                 });
                 
                await delay(Math.random() * 800 + 500);
            }


            preparedAttachments = fileDetails.map((originalFile, index) => {
                const target = uploadTargets.find(t => t.id.toString() === originalFile.id);

                if (!target) {
                    throw new Error(`Consistency error: Could not find upload target for file: ${originalFile.filename}`);
                }

                return {
                    id: index.toString(),
                    filename: originalFile.filename,
                    uploaded_filename: target.uploadFilename,
                };
            });
        }

        let payload = {
            mobile_network_type: "unknown",
            content: content || "",
            nonce: Math.floor(Math.random() * 1000000000000000000).toString(),
            tts,
            flags: 0,
            attachments: preparedAttachments
        };

        if (messageReference) {
            payload.message_reference = {
                channel_id: messageReference.channelId,
                message_id: messageReference.messageId,
                fail_if_not_exists: false
            };
            payload.flags |= 1;
        }

        if (poll) {
            payload.content = '';
            payload.poll = {
                question: { text: poll.question },
                answers: poll.answers.map(ans => ({ poll_media: { text: ans } })),
                allow_multiselect: poll.allowMultiselect || false,
                duration: poll.duration,
                layout_type: 1
            };
        }
        
        await delay(Math.random() * 300 + 100);

        return this.rest.request(
            'POST',
            `/channels/${channelId}/messages`,
            payload,
            channelId
        );
    }

    async getMessages(channelId, { limit = 100, before, after, around } = {}) {
        if (!channelId) throw new Error('No channel ID provided');

        const params = { limit };
        if (before) params.before = before;
        if (after) params.after = after;
        if (around) params.around = around;

        try {
            const response = await axios({
                method: 'GET',
                url: `${this.rest.baseURL}/channels/${channelId}/messages`,
                params,
                headers: this.rest.getHeaders(channelId)
            });
            return response.data.map(msg => this._enhanceMessage(msg));
        } catch (error) {
            if (error.response) throw this._convertKeys(error.response.data);
            throw error;
        }
    }

    async leaveGroupChat(channelId, silent) {
        silent = (silent && true) || !silent && false;
        this.rest.request(
            'DELETE',
            `/channels/${channelId}?silent=${silent}`,
            null,
            channelId
        );
    }

    async acceptFriendRequest(userId) {
        return this.rest.request(
            'PUT',
            `/users/@me/relationships/${userId}`,
            { type: 1 },
            undefined
        );
    }

    async declineFriendRequest(userId) {
        return this.rest.request(
            'DELETE',
            `/users/@me/relationships/${userId}`,
            { type: 1 },
            undefined
        );
    }

    login() {
        this._setupWebSocket();
        return this;
    }

    _setupWebSocket(isReconnect) {
        if (this._ws) {
            this._ws.removeAllListeners();
            this._ws.close();
            this._ws = null;
        }
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
            this._heartbeatInterval = null;
        }
        if (this._heartbeatTimeout) {
            clearTimeout(this._heartbeatTimeout);
            this._heartbeatTimeout = null;
        }
        this._lastHeartbeatAck = null;

        if (this._inflate) {
            this._inflate.removeAllListeners();
            this._inflate.reset();
        } else {
            this._inflate = zlib.createInflate();
            this._inflate.on('error', err => this.emit('error', err));
        }
        this._setupInflateErrorHandling();

        this._ws = new WebSocket('wss://gateway.discord.gg/?encoding=json&v=9&compress=zlib-stream');
        this._ws.binaryType = 'nodebuffer';

        this._buffer = '';

        this._inflate.on('data', chunk => this._handleDecompressedData(chunk, isReconnect));

        this._ws.on('open', () => {
            setTimeout(() => {
                this._sendIdentify();
                if (isReconnect) {
                    this.emit('reconnected');
                }
            }, 1000)
        });
        this._ws.on('message', data => this._handleMessage(data));
        this._ws.on('close', (code, reason) => this._handleClose(code, reason));
        this._ws.on('error', err => this.emit('error', err));
    }

    _scheduleReconnect() {
        clearTimeout(this._reconnectTimeout);
        const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);

        this.emit('reconnecting', delay);
        this._reconnectTimeout = setTimeout(() => {
            this._reconnectAttempts++;
            this._setupWebSocket(true);
        }, delay);
    }

    _handleDecompressedData(chunk, isReconnect) {
        this._buffer += chunk.toString();

        if (this._buffer.endsWith('}')) {
            try {
                const json = JSON.parse(this._buffer);
                this._buffer = '';

                if (json.s) this._seq = json.s;
                this.emit('raw', json);

                switch (json.op) {
                    case 10:
                        this.emit('debug', 'Start heartbeat', json.d.heartbeat_interval);
                        this._startHeartbeat(json.d.heartbeat_interval);
                        break;
                    case 11:
                        this._handleHeartbeatAck();
                        this.emit('debug', 'Heartbeat acknowledged');
                        break;
                    case 0:
                        if (json.t === 'READY_SUPPLEMENTAL') {
                            if (!isReconnect) this.emit('ready', this._convertKeys(json.d));
                            this._reconnectAttempts = 0;
                        } else if (json.t) {
                            this._handleEvent(json.t, json.d);
                        }
                        break;
                    case 7:
                    case 9:
                        this._handleReconnectOpcodes(json.op);
                        break;
                }

            } catch (error) {
                this._buffer = '';
            }
        }
    }

    _handleReconnectOpcodes(opCode) {
        if (opCode === 7 || opCode === 9) {
            this.emit('debug', `Discord requested reconnect (Opcode ${opCode}).`);
            this._setupWebSocket(true);
        }
    }

    _handleEvent(type, data) {
        switch (type) {
            case 'MESSAGE_CREATE':
                this._handleMessageCreate(data);
                break;
            case 'MESSAGE_DELETE':
                this._handleMessageDelete(data);
                break;
            case 'MESSAGE_UPDATE':
                this._handleMessageUpdate(data);
                break;
            case 'MESSAGE_REACTION_ADD':
                this._handleReactionAdd(data);
                break;
            case 'MESSAGE_REACTION_REMOVE':
                this._handleReactionRemove(data);
                break;
            case 'RELATIONSHIP_ADD':
                this._handleRelationshipAdd(data);
                break;
            case 'CALL_UPDATE':
                this._handleCallUpdate(data);
                break;
        }
    }

    _handleRelationshipAdd(data) {
        const converted = this._convertKeys(data);
        if (converted.type === 3) {
            this.emit('friendRequest', converted.user);
        }
    }

    _handleMessageCreate(data) {
        const message = this._enhanceMessage(this._convertKeys(data));
        this.emit('message', message);
    }

    _handleCallUpdate(data) {
        const converted = this._convertKeys(data);
        this.emit('callUpdate', converted);
    }

    _handleMessageDelete(data) {
        const formattedData = this._convertKeys(data);
        this.emit('messageDeleted', formattedData.d);
    }

    _handleMessageUpdate(data) {
        const formattedData = this._convertKeys(data);
        this.emit('messageUpdated', formattedData);
    }

    _handleReactionAdd(data) {
        this.emit('reactionAdd', this._enhanceMessage(this._convertKeys(data)));
    }

    _handleReactionRemove(data) {
        this.emit('reactionRemove', this._enhanceMessage(this._convertKeys(data)));
    }

    _convertKeys(obj) {
        if (!obj || typeof obj !== 'object') return obj;

        if (Array.isArray(obj)) {
            return obj.map(item => this._convertKeys(item));
        }

        return Object.entries(obj).reduce((acc, [key, value]) => {
            const newKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
            let newValue = value;

            if (Array.isArray(value)) {
                newValue = value.map(item => this._convertKeys(item));
            } else if (value !== null && typeof value === 'object') {
                newValue = this._convertKeys(value);
            }

            if (newKey.endsWith('Timestamp') && typeof newValue === 'string') {
                newValue = new Date(newValue);
            }

            acc[newKey] = newValue;
            return acc;
        }, {});
    }

    _getMessageChanges(original, updated) {
        if (!original) return null;
        return {
            content: original.content !== updated.content ? {
                from: original.content,
                to: updated.content
            } : null,
            editedTimestamp: original.editedTimestamp !== updated.editedTimestamp,
            attachments: original.attachments.length !== updated.attachments.length
        };
    }

    _startHeartbeat(interval) {
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
        }
        if (this._heartbeatTimeout) {
            clearTimeout(this._heartbeatTimeout);
        }

        this._lastHeartbeatAck = Date.now();
        this._sendHeartbeat();
        this._heartbeatInterval = setInterval(() => {
            this._sendHeartbeat();
        }, interval);
        this._startHeartbeatTimeoutCheck();
    }

    _startHeartbeatTimeoutCheck() {
        this._heartbeatTimeout = setTimeout(() => {
            if (this._lastHeartbeatAck && (Date.now() - this._lastHeartbeatAck) > 60000) {
                this.emit('debug', 'Heartbeat timeout, reconnecting...');
                this._setupWebSocket(true);
            } else {
                this._startHeartbeatTimeoutCheck();
            }
        }, 30000);
    }

    _handleHeartbeatAck() {
        this._lastHeartbeatAck = Date.now();
    }

    _sendHeartbeat() {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify({
                op: 1,
                d: this._seq
            }));
        }
    }

    _sendIdentify() {
        const payload = {
            op: 2,
            d: {
                token: this.token,
                capabilities: 30717,
                properties: this._superProperties,
                presence: {
                    status: "unknown",
                    since: 0,
                    activities: [],
                    afk: false
                },
                compress: false,
                client_state: {
                    guild_versions: {}
                }
            }
        };

        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(payload));
        }
    }

    _handleMessage(data) {
        if (this._inflate) {
            this._inflate.write(data);
        } else {
            console.error("Inflate stream is missing, cannot decompress data!");
        }
    }

    _handleClose(code, reason) {
        const reasonString = reason ? reason.toString() : 'No reason provided';
        const error = new Error(`Connection closed: ${code} - ${reasonString}`);
        if (code === 4004) error.message = 'Authentication failed';

        clearInterval(this._heartbeatInterval);
        this._heartbeatInterval = null;
        clearTimeout(this._heartbeatTimeout);
        this._heartbeatTimeout = null;
        this._lastHeartbeatAck = null;


        if (this._inflate) {
            this._inflate.removeAllListeners();
            this._inflate.end();
            this._inflate = null;
        }

        if (!this._disconnectCodes.includes(code)) {
            this.emit('debug', `Attempting to reconnect after non-standard close code: ${code}`);
        }
        
        this._scheduleReconnect();
    }
}

module.exports = { Client };
