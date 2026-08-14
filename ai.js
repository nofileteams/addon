(function (Scratch) {
  "use strict";

  if (!Scratch.extensions.unsandboxed) {
    throw new Error("この拡張機能はサンドボックス化されていない状態(unsandboxed)で実行する必要があります");
  }

  const DEFAULT_MODEL = "llama-3.3-70b-versatile";
  const DEFAULT_MAX_HISTORY = 20;

  // 選択メニューに出すおすすめモデル一覧(必要に応じて増減してOK)
  const MODEL_LIST = [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "llama3-70b-8192",
    "llama3-8b-8192",
    "mixtral-8x7b-32768",
    "gemma2-9b-it",
  ];

  class GroqAIExtension {
    constructor() {
      this.apiKey = "";
      this.customInstructions = "あなたは親切なアシスタントです。";
      this.history = []; // [{role: "user" | "assistant", content: "..."}]
      this.autoClear = true;
      this.maxHistory = DEFAULT_MAX_HISTORY;
      this.model = DEFAULT_MODEL;
    }

    getInfo() {
      return {
        id: "groqAiExtension",
        name: "Groq AI",
        color1: "#F55036",
        color2: "#D8402A",
        blocks: [
          {
            opcode: "setApiKey",
            blockType: Scratch.BlockType.COMMAND,
            text: "set api-key [KEY]",
            arguments: {
              KEY: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "gsk_xxxxxxxxxxxxxxxx",
              },
            },
          },
          {
            opcode: "setCustomInstructions",
            blockType: Scratch.BlockType.COMMAND,
            text: "カスタム指示を [TEXT] に設定する",
            arguments: {
              TEXT: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "あなたは親切なアシスタントです。",
              },
            },
          },
          {
            opcode: "setModel",
            blockType: Scratch.BlockType.COMMAND,
            text: "使用するモデルを [MODEL] にする",
            arguments: {
              MODEL: {
                type: Scratch.ArgumentType.STRING,
                menu: "modelMenu",
                defaultValue: DEFAULT_MODEL,
              },
            },
          },
          {
            opcode: "setCustomModel",
            blockType: Scratch.BlockType.COMMAND,
            text: "使用するモデルを自由入力で [MODEL] にする",
            arguments: {
              MODEL: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: DEFAULT_MODEL,
              },
            },
          },
          {
            opcode: "getModel",
            blockType: Scratch.BlockType.REPORTER,
            text: "現在のモデル",
          },
          "---",
          {
            opcode: "askQuestion",
            blockType: Scratch.BlockType.REPORTER,
            text: "[QUESTION] を質問する(履歴を使う)",
            arguments: {
              QUESTION: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "TurboWarpとは何ですか?",
              },
            },
          },
          {
            opcode: "askQuestionNoHistory",
            blockType: Scratch.BlockType.REPORTER,
            text: "[QUESTION] を質問する(履歴を使わない)",
            arguments: {
              QUESTION: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "TurboWarpとは何ですか?",
              },
            },
          },
          "---",
          {
            opcode: "clearHistory",
            blockType: Scratch.BlockType.COMMAND,
            text: "履歴をクリアする",
          },
          {
            opcode: "setAutoClear",
            blockType: Scratch.BlockType.COMMAND,
            text: "履歴の自動クリアを [STATE] にする",
            arguments: {
              STATE: {
                type: Scratch.ArgumentType.STRING,
                menu: "onOffMenu",
                defaultValue: "on",
              },
            },
          },
          {
            opcode: "setMaxHistory",
            blockType: Scratch.BlockType.COMMAND,
            text: "履歴の最大メッセージ数を [NUM] に設定する",
            arguments: {
              NUM: {
                type: Scratch.ArgumentType.NUMBER,
                defaultValue: DEFAULT_MAX_HISTORY,
              },
            },
          },
          {
            opcode: "showHistory",
            blockType: Scratch.BlockType.REPORTER,
            text: "現在の履歴を表示する",
          },
          {
            opcode: "historyLength",
            blockType: Scratch.BlockType.REPORTER,
            text: "履歴のメッセージ数",
          },
        ],
        menus: {
          onOffMenu: {
            acceptReporters: true,
            items: ["on", "off"],
          },
          modelMenu: {
            acceptReporters: true,
            items: MODEL_LIST,
          },
        },
      };
    }

    // ---- 設定系ブロック ----

    setApiKey(args) {
      this.apiKey = String(args.KEY).trim();
    }

    setCustomInstructions(args) {
      this.customInstructions = String(args.TEXT);
    }

    setModel(args) {
      const m = String(args.MODEL).trim();
      this.model = m || DEFAULT_MODEL;
    }

    setCustomModel(args) {
      const m = String(args.MODEL).trim();
      this.model = m || DEFAULT_MODEL;
    }

    getModel() {
      return this.model;
    }

    // ---- 履歴管理ブロック ----

    clearHistory() {
      this.history = [];
    }

    setAutoClear(args) {
      this.autoClear = String(args.STATE) === "on";
    }

    setMaxHistory(args) {
      const n = Math.floor(Number(args.NUM));
      this.maxHistory = n > 0 ? n : DEFAULT_MAX_HISTORY;
    }

    showHistory() {
      if (this.history.length === 0) return "(履歴はありません)";
      return this.history
        .map((m) => `${m.role === "user" ? "自分" : "AI"}: ${m.content}`)
        .join("\n");
    }

    historyLength() {
      return this.history.length;
    }

    _maybeAutoClear() {
      // メッセージ数がしきい値を超えたら履歴を丸ごとクリアする(古い分だけ残したい場合はここをtrim処理に変更可)
      if (this.autoClear && this.history.length > this.maxHistory) {
        this.history = [];
      }
    }

    // ---- Groq API呼び出し共通処理 ----

    async _callGroq(messages) {
      if (!this.apiKey) {
        return {
          error:
            "APIキーが設定されていません。「set api-key」ブロックを先に使ってください。",
        };
      }
      try {
        const response = await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
              model: this.model,
              messages,
            }),
          }
        );

        const data = await response.json();

        if (!response.ok) {
          const message =
            (data && data.error && data.error.message) ||
            `HTTPエラー ${response.status}`;
          return { error: message };
        }

        const content =
          data &&
          data.choices &&
          data.choices[0] &&
          data.choices[0].message &&
          data.choices[0].message.content;

        return content ? { content } : { error: "応答を取得できませんでした。" };
      } catch (err) {
        return { error: err.message };
      }
    }

    // ---- 質問ブロック ----

    async askQuestion(args) {
      const question = String(args.QUESTION);

      // system + 過去の履歴 + 今回の質問、をまとめて送信する
      const messages = [
        { role: "system", content: this.customInstructions },
        ...this.history,
        { role: "user", content: question },
      ];

      const result = await this._callGroq(messages);
      if (result.error) return `エラー: ${result.error}`;

      // 成功したら履歴に今回のやり取りを追加
      this.history.push({ role: "user", content: question });
      this.history.push({ role: "assistant", content: result.content });
      this._maybeAutoClear();

      return result.content;
    }

    async askQuestionNoHistory(args) {
      const question = String(args.QUESTION);
      const messages = [
        { role: "system", content: this.customInstructions },
        { role: "user", content: question },
      ];
      const result = await this._callGroq(messages);
      return result.error ? `エラー: ${result.error}` : result.content;
    }
  }

  Scratch.extensions.register(new GroqAIExtension());
})(Scratch);
