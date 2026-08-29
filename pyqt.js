// Name: PyQt5 Message
// ID: pyqt5message
// Description: PyQt5の親ウィンドウ(QWebChannel)とメッセージをやり取りするブロック
// By: unknown
// License: MIT

(function (Scratch) {
  "use strict";

  if (!Scratch.extensions.unsandboxed) {
    throw new Error("PyQt5 Message extension must run unsandboxed");
  }

  class PyQt5MessageExtension {
    constructor() {
      // QWebChannelで公開されているオブジェクトの名前（デフォルト: "bridge"）
      this.objectName = "bridge";

      // QWebChannel本体と、接続できたPython側オブジェクトの参照
      this.channel = null;
      this.bridgeObject = null;

      // Pythonから receiveMessage シグナルで送られてきた最後のメッセージ
      this.lastMessage = "";

      this._ensureQWebChannelLoaded();
    }

    // qwebchannel.js を読み込む（PyQt5/PySide側が自動で用意してくれるURL）
    _ensureQWebChannelLoaded() {
      if (typeof QWebChannel !== "undefined") {
        this._tryInitChannel();
        return;
      }

      const script = document.createElement("script");
      script.src = "qrc:///qtwebchannel/qwebchannel.js";
      script.onload = () => this._tryInitChannel();
      script.onerror = () => {
        console.warn(
          "[PyQt5 Message] qwebchannel.js の読み込みに失敗しました。" +
            "PyQt5/QWebEngineView上で実行しているか確認してください。"
        );
      };
      document.head.appendChild(script);
    }

    // qt.webChannelTransport が用意され次第 QWebChannel を初期化する
    _tryInitChannel() {
      if (this.channel) return; // 既に初期化済み

      if (typeof qt === "undefined" || !qt.webChannelTransport) {
        // まだ用意できていない場合は少し待って再試行
        setTimeout(() => this._tryInitChannel(), 200);
        return;
      }

      this.channel = new QWebChannel(qt.webChannelTransport, (channel) => {
        this._connectObject(channel);
      });
    }

    // channel.objects の中から指定した名前のオブジェクトを探して接続する
    _connectObject(channel) {
      const obj = channel.objects[this.objectName];
      if (!obj) {
        console.warn(
          `[PyQt5 Message] "${this.objectName}" という公開オブジェクトが見つかりません。` +
            "Python側の channel.registerObject(name, obj) の name と一致しているか確認してください。"
        );
        return;
      }

      this.bridgeObject = obj;

      // Python側で定義された receiveMessage シグナルを購読する
      if (obj.receiveMessage && typeof obj.receiveMessage.connect === "function") {
        obj.receiveMessage.connect((msg) => {
          this.lastMessage = msg;
        });
      } else {
        console.warn(
          `[PyQt5 Message] "${this.objectName}" に receiveMessage シグナルが見つかりません。`
        );
      }
    }

    getInfo() {
      return {
        id: "pyqt5message",
        name: "PyQt5 Message",
        color1: "#4C97FF",
        blocks: [
          {
            opcode: "setObjectName",
            blockType: Scratch.BlockType.COMMAND,
            text: "親ウィンドウの公開オブジェクトを [NAME] に設定",
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: "bridge" },
            },
          },
          "---",
          {
            opcode: "sendMessage",
            blockType: Scratch.BlockType.COMMAND,
            text: "親ウィンドウにメッセージ [MESSAGE] を送る",
            arguments: {
              MESSAGE: { type: Scratch.ArgumentType.STRING, defaultValue: "こんにちは" },
            },
          },
          {
            opcode: "getReceivedMessage",
            blockType: Scratch.BlockType.REPORTER,
            text: "親ウィンドウからreceiveMessageで受け取ったメッセージ",
            disableMonitor: false,
          },
        ],
      };
    }

    setObjectName(args) {
      const name = String(args.NAME || "").trim();
      if (!name) return;

      this.objectName = name;
      this.bridgeObject = null;

      // 既にチャンネルが開いていれば新しい名前で接続し直す
      if (this.channel) {
        this._connectObject(this.channel);
      } else {
        this._ensureQWebChannelLoaded();
      }
    }

    sendMessage(args) {
      const msg = String(args.MESSAGE);

      if (this.bridgeObject && typeof this.bridgeObject.sendMessage === "function") {
        this.bridgeObject.sendMessage(msg);
      } else {
        console.warn(
          "[PyQt5 Message] 親ウィンドウの公開オブジェクトに未接続のため送信できませんでした:",
          msg
        );
      }
    }

    getReceivedMessage() {
      return this.lastMessage;
    }
  }

  Scratch.extensions.register(new PyQt5MessageExtension());
})(Scratch);
