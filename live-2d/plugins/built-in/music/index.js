const { Plugin } = require('../../../js/core/plugin-base.js');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SUPPORTED_FORMATS = ['.mp3', '.wav', '.m4a', '.ogg'];

class MusicPlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();
        this._port = cfg.port?.value ?? cfg.port ?? 3001;
        this._musicFolder = path.join(__dirname, '../../../song-library/output');
    }

    getTools() {
        return [
            { type: 'function', function: { name: 'play_random_music', description: 'Sing a random song in your real voice', parameters: { type: 'object', properties: {}, required: [] } } },
            { type: 'function', function: { name: 'stop_music', description: 'Stop the song you are singing', parameters: { type: 'object', properties: {}, required: [] } } },
            { type: 'function', function: { name: 'list_music_files', description: 'See which songs in your library you can sing', parameters: { type: 'object', properties: {}, required: [] } } },
            { type: 'function', function: { name: 'play_specific_music', description: 'Sing a specific song in your real voice', parameters: { type: 'object', properties: { filename: { type: 'string', description: 'File name of the song to sing (no path or file extension needed)' } }, required: ['filename'] } } }
        ];
    }

    async executeTool(name, params) {
        switch (name) {
            case 'play_random_music':   return await this._playRandom();
            case 'stop_music':          return await this._stop();
            case 'list_music_files':    return this._list();
            case 'play_specific_music': return await this._playSpecific(params.filename);
            default: throw new Error(`[music] Unsupported tool: ${name}`);
        }
    }

    _getMusicFiles() {
        try {
            if (!fs.existsSync(this._musicFolder)) return [];
            return fs.readdirSync(this._musicFolder).filter(f => SUPPORTED_FORMATS.includes(path.extname(f).toLowerCase()));
        } catch { return []; }
    }

    async _request(action, filename = null) {
        return new Promise((resolve) => {
            const postData = JSON.stringify({ action, filename });
            const req = http.request({ hostname: 'localhost', port: this._port, path: '/control-music', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        resolve(result.success ? result.message : `Action failed: ${result.message}`);
                    } catch { resolve('Done'); }
                });
            });
            req.on('error', () => resolve('Could not connect to the music control service. Make sure the app is running'));
            req.write(postData);
            req.end();
        });
    }

    _formatResponse(result) {
        if (typeof result === 'string') return result;
        const { message, metadata } = result;
        if (!metadata) return message;
        let response = `Now singing: ${metadata.title} - ${metadata.artist}.\n`;
        if (metadata.lyrics && metadata.lyrics !== '暂无歌词') {
            response += `Lyrics:\n${metadata.lyrics.split('\n').slice(0, 200).join('\n')}\n`;
        }
        return response;
    }

    async _playRandom() {
        if (this._getMusicFiles().length === 0) return 'No songs found in my song library';
        return this._formatResponse(await this._request('play_random'));
    }

    async _stop() {
        const result = await this._request('stop');
        return result.replace(/Music stopped|音乐已停止/, 'OK, I stopped singing');
    }

    _list() {
        const files = this._getMusicFiles();
        if (files.length === 0) return 'No songs found in my song library';
        const names = new Set(files.map(f => f.replace(/\.(mp3|wav|m4a|ogg)$/i, '').replace(/-(Acc|Vocal)$/i, '')));
        const sorted = Array.from(names).sort();
        return `I can sing ${sorted.length} songs:\n${sorted.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
    }

    async _playSpecific(filename) {
        const files = this._getMusicFiles();
        if (files.length === 0) return 'No songs found in my song library';
        const matched = files.find(f => f.toLowerCase().includes(filename.toLowerCase()) || filename.toLowerCase().includes(f.toLowerCase().replace(/\.[^/.]+$/, '')));
        if (!matched) return `I can't sing this song: ${filename}`;
        return this._formatResponse(await this._request('play_specific', matched));
    }
}

module.exports = MusicPlugin;
