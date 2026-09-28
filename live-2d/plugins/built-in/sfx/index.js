const { Plugin } = require('../../../js/core/plugin-base.js');
const { exec } = require('child_process');
const path = require('path');

const SFX_LIBRARY = {
    '01': 'what is going on?', '02': 'a sudden fright', '03': 'a huge explosion',
    '04': 'the noisy clatter of a falling steel pipe', '05': 'an OMG, for disbelief',
    '06': 'a stirring orchestral hit', '07': 'a wow sound effect'
};

class SfxPlugin extends Plugin {

    async onInit() {
        this._sfxDir = path.join(__dirname, 'SFX');
    }

    getTools() {
        return [{
            type: 'function',
            function: {
                name: 'play_sound_effect',
                description: 'Play a sound effect to make the conversation more fun and expressive. 01=what\'s going on, 02=sudden fright, 03=huge explosion, 04=falling steel pipe, 05=OMG (disbelief), 06=orchestral hit, 07=wow sound effect',
                parameters: {
                    type: 'object',
                    properties: {
                        sfx_id: { type: 'string', description: "Sound effect number (01-07), or several separated by commas, for example '01,03'" },
                        repeat: { type: 'integer', description: 'How many times to play it in a row (1-10). Default: 1', minimum: 1, maximum: 10, default: 1 }
                    },
                    required: ['sfx_id']
                }
            }
        }];
    }

    async executeTool(name, params) {
        if (name === 'play_sound_effect') return await this._playSfx(params);
        throw new Error(`[sfx] Unsupported tool: ${name}`);
    }

    async _playSfx({ sfx_id, repeat = 1 }) {
        const sfxIds = sfx_id.split(',').map(id => id.trim());
        for (const id of sfxIds) {
            if (!SFX_LIBRARY[id]) throw new Error(`Invalid sound effect ID: ${id}`);
        }
        const playCount = Math.min(Math.max(repeat || 1, 1), 10);

        return new Promise((resolve, reject) => {
            const playSequence = [];
            for (let i = 0; i < playCount; i++) sfxIds.forEach(id => playSequence.push(id));

            const promises = playSequence.map((id, index) => new Promise((res) => {
                setTimeout(() => {
                    const sfxPath = path.join(this._sfxDir, `${id}.wav`);
                    exec(`powershell -c "(New-Object Media.SoundPlayer '${sfxPath}').PlaySync()"`, { timeout: 10000 }, () => res());
                }, index * 250);
            }));

            Promise.all(promises).then(() => resolve('Played the sound effect')).catch(reject);
        });
    }
}

module.exports = SfxPlugin;
