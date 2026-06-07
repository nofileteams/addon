class TurboGMBlocks {

    _geminiModel = 'gemini-2.5-flash';
    _customInstructions = '';

    getInfo() {
        return {
            id: 'turbogm',
            name: 'TurboGM',
            color1: '#1A73E8',
            color2: '#0D47A1',
            menuIconURI: 'https://cdn.jsdelivr.net/gh/Alejandrix2456github/TurboGM@main/TurboGM%20Logo2.png',

            blocks: [
                {
                    opcode: 'setGeminiModel',
                    blockType: Scratch.BlockType.COMMAND,
                    text: 'set Gemini Model to [MODEL_NAME]',
                    arguments: {
                        MODEL_NAME: {
                            type: Scratch.ArgumentType.STRING,
                            defaultValue: 'gemini-2.5-flash',
                            menu: 'geminiModels'
                        }
                    }
                },
                {
                    opcode: 'setCustomInstructions',
                    blockType: Scratch.BlockType.COMMAND,
                    text: 'set Custom Instructions to [TEXT]',
                    arguments: {
                        TEXT: {
                            type: Scratch.ArgumentType.STRING,
                            defaultValue: 'You are a helpful assistant.'
                        }
                    }
                },
                '---',
                {
                    opcode: 'getAiAnswer',
                    blockType: Scratch.BlockType.REPORTER,
                    text: 'AI Answer for [QUERY] using API Key [KEY]',
                    arguments: {
                        QUERY: {
                            type: Scratch.ArgumentType.STRING,
                            defaultValue: 'What is your name?'
                        },
                        KEY: {
                            type: Scratch.ArgumentType.STRING,
                            defaultValue: 'YOUR_API_KEY_HERE'
                        }
                    }
                }
            ],

            menus: {
                geminiModels: {
                    acceptsReporters: true,
                    items: ['gemini-2.5-flash', 'gemini-1.5-pro', 'gemini-pro']
                }
            }
        };
    }

    setGeminiModel(args) {
        this._geminiModel = args.MODEL_NAME;
    }

    setCustomInstructions(args) {
        this._customInstructions = args.TEXT;
    }

    async getAiAnswer(args) {
        const userQuery = args.QUERY;
        const apiKey = args.KEY;
        const targetModel = this._geminiModel;

        if (!userQuery || !apiKey) {
            return "Error: Query and API Key are required.";
        }

        const fullPrompt = `${this._customInstructions}\n\n${userQuery}`;
        const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;

        try {
            const requestBody = JSON.stringify({
                contents: [{ role: "user", parts: [{ text: fullPrompt }] }]
            });

            const response = await fetch(GEMINI_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: requestBody
            });

            if (!response.ok) {
                const errorData = await response.json();
                const errorMessage = errorData.error?.message || `Error status: ${response.status}`;
                return `AI API Error: ${errorMessage.substring(0, 150)}...`;
            }

            const data = await response.json();
            const aiAnswer = data.candidates?.[0]?.content?.parts?.[0]?.text;

            return aiAnswer || "Error: Failed to parse AI response.";

        } catch (error) {
            return "Error: Could not connect to the API.";
        }
    }
}

Scratch.extensions.register(new TurboGMBlocks());