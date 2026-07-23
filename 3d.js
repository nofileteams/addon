// TurboWarp 3D Extension
// 3Dオブジェクトの作成・移動・回転・拡大縮小・テクスチャ・モデル読み込み・光源・フォグ等を扱う拡張機能です。
// three.js (r128) を CDN から動的に読み込んで利用します。
// ※この拡張は「サンドボックス化しない (Unsandboxed)」設定で読み込む必要があります。
//   TurboWarp デスクトップ版 / turbowarp.org で「カスタム拡張機能を読み込む」→ このファイルを選択 →
//   「信頼してサンドボックス化せずに読み込む」を選択してください。

(function (Scratch) {
  'use strict';

  if (!Scratch.extensions.unsandboxed) {
    throw new Error('この3D拡張機能は「サンドボックス化しない (unsandboxed)」設定で読み込んでください。');
  }

  const vm = Scratch.vm;
  const runtime = vm.runtime;

  /* ===================== three.js 動的読み込み ===================== */

  const THREE_BASE = 'https://cdn.jsdelivr.net/npm/three@0.128.0';
  let THREE = null;
  let threeLoadingPromise = null;

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('スクリプトの読み込みに失敗しました: ' + url));
      document.head.appendChild(script);
    });
  }

  async function ensureThree() {
    if (THREE) return THREE;
    if (threeLoadingPromise) return threeLoadingPromise;
    threeLoadingPromise = (async () => {
      await loadScript(THREE_BASE + '/build/three.min.js');
      THREE = window.THREE;
      await loadScript(THREE_BASE + '/examples/js/loaders/GLTFLoader.js');
      await loadScript(THREE_BASE + '/examples/js/loaders/OBJLoader.js');
      return THREE;
    })();
    return threeLoadingPromise;
  }

  /* ===================== ユーティリティ ===================== */

  const DEG2RAD = Math.PI / 180;
  const RAD2DEG = 180 / Math.PI;

  function toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes.buffer;
  }

  /* ===================== メイン管理クラス ===================== */

  class ThreeManager {
    constructor() {
      this.objects = new Map(); // name -> { mesh, isLight, light, penetration, lastSafePos }
      this.scene = null;
      this.camera = null;
      this.renderer = null;
      this.canvas = null;
      this.cameraObjectName = null;
      this.rendering = false;
      this.fogEnabled = false;
      this._rafId = null;
      this._ready = false;
    }

    async init() {
      if (this._ready) return;
      await ensureThree();

      this.scene = new THREE.Scene();

      const stageW = runtime.stageWidth || 480;
      const stageH = runtime.stageHeight || 360;

      this.camera = new THREE.PerspectiveCamera(60, stageW / stageH, 0.1, 10000);
      this.camera.position.set(0, 0, 10);

      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      this.renderer.setSize(stageW, stageH);
      this.renderer.setClearColor(0x000000, 0);

      this.canvas = this.renderer.domElement;
      this.canvas.style.position = 'absolute';
      this.canvas.style.top = '0';
      this.canvas.style.left = '0';
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
      this.canvas.style.pointerEvents = 'none';
      this.canvas.style.zIndex = '100';

      const stageCanvas = runtime.renderer && runtime.renderer.canvas;
      const container = stageCanvas ? stageCanvas.parentNode : document.body;
      if (container) {
        container.style.position = container.style.position || 'relative';
        container.appendChild(this.canvas);
      }

      // 基本的なライト(オブジェクトを光源にしていない場合でも見えるように)
      this._ambient = new THREE.AmbientLight(0xffffff, 0.6);
      this.scene.add(this._ambient);

      this._ready = true;
      this._loop();
    }

    _loop() {
      const step = () => {
        this._rafId = requestAnimationFrame(step);
        if (!this._ready) return;

        // カメラ追従
        if (this.cameraObjectName) {
          const obj = this.objects.get(this.cameraObjectName);
          if (obj) {
            this.camera.position.copy(obj.mesh.position);
            this.camera.rotation.copy(obj.mesh.rotation);
          }
        }

        if (this.rendering) {
          this.renderer.render(this.scene, this.camera);
          this.canvas.style.display = 'block';
        } else {
          this.canvas.style.display = 'none';
        }
      };
      step();
    }

    resize() {
      if (!this._ready) return;
      const stageW = runtime.stageWidth || 480;
      const stageH = runtime.stageHeight || 360;
      this.camera.aspect = stageW / stageH;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(stageW, stageH);
    }

    getOrCreate(name) {
      let obj = this.objects.get(name);
      if (!obj) {
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const material = new THREE.MeshStandardMaterial({ color: 0x4c97ff });
        const mesh = new THREE.Mesh(geometry, material);
        this.scene.add(mesh);
        obj = {
          mesh,
          isLight: false,
          light: null,
          penetration: false,
          lastSafePos: mesh.position.clone()
        };
        this.objects.set(name, obj);
      }
      return obj;
    }

    get(name) {
      return this.objects.get(name) || null;
    }

    remove(name) {
      const obj = this.objects.get(name);
      if (!obj) return;
      this.scene.remove(obj.mesh);
      if (obj.mesh.geometry) obj.mesh.geometry.dispose();
      if (obj.mesh.material) {
        if (Array.isArray(obj.mesh.material)) obj.mesh.material.forEach((m) => m.dispose());
        else obj.mesh.material.dispose();
      }
      if (obj.light) this.scene.remove(obj.light);
      if (this.cameraObjectName === name) this.cameraObjectName = null;
      this.objects.delete(name);
    }

    resetAll() {
      for (const name of Array.from(this.objects.keys())) this.remove(name);
      this.cameraObjectName = null;
      this.camera.position.set(0, 0, 10);
      this.camera.rotation.set(0, 0, 0);
    }
  }

  const manager = new ThreeManager();

  runtime.on('RUNTIME_DISPOSED', () => {
    manager.resetAll();
  });

  /* ===================== 拡張機能本体 ===================== */

  class ThreeDExtension {
    constructor() {
      manager.init();
    }

    getInfo() {
      return {
        id: 'threeD',
        name: '3D',
        color1: '#7C4DFF',
        color2: '#6633CC',
        blocks: [
          { opcode: 'resetAll', blockType: Scratch.BlockType.COMMAND, text: '全てのオブジェクトをリセットする' },
          '---',
          {
            opcode: 'createObject',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]を作成する',
            arguments: { NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' } }
          },
          {
            opcode: 'deleteObject',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]を削除する',
            arguments: { NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' } }
          },
          '---',
          {
            opcode: 'setTextureCostume',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]のテクスチャを[COSTUME]に設定する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              COSTUME: { type: Scratch.ArgumentType.STRING, defaultValue: 'costume1', menu: 'costumeMenu' }
            }
          },
          {
            opcode: 'setTextureUrl',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]のテクスチャをURL[URL]から読み込んで設定する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              URL: { type: Scratch.ArgumentType.STRING, defaultValue: 'https://example.com/test.png' }
            }
          },
          {
            opcode: 'setColor',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の色を[COLOR]に設定する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              COLOR: { type: Scratch.ArgumentType.COLOR }
            }
          },
          {
            opcode: 'setModelFromList',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]のモデルを[DATA]に設定する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              DATA: { type: Scratch.ArgumentType.STRING, defaultValue: 'list1' }
            }
          },
          '---',
          {
            opcode: 'setPositionXYZ',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の位置をx[X]y[Y]z[Z]に設定する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              X: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 },
              Y: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 },
              Z: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 }
            }
          },
          {
            opcode: 'setPositionX',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の位置をx[X]に設定する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              X: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 }
            }
          },
          {
            opcode: 'setPositionY',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の位置をy[Y]に設定する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              Y: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 }
            }
          },
          {
            opcode: 'setPositionZ',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の位置をz[Z]に設定する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              Z: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 }
            }
          },
          {
            opcode: 'changePositionX',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の位置をx[X]ずつ変える',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              X: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }
            }
          },
          {
            opcode: 'changePositionY',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の位置をy[Y]ずつ変える',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              Y: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }
            }
          },
          {
            opcode: 'changePositionZ',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の位置をz[Z]ずつ変える',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              Z: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }
            }
          },
          '---',
          {
            opcode: 'setRotationXYZ',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の向きをx[X]y[Y]z[Z]に設定する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              X: { type: Scratch.ArgumentType.ANGLE, defaultValue: 0 },
              Y: { type: Scratch.ArgumentType.ANGLE, defaultValue: 0 },
              Z: { type: Scratch.ArgumentType.ANGLE, defaultValue: 0 }
            }
          },
          {
            opcode: 'setRotationX',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の向きをx[X]に設定する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              X: { type: Scratch.ArgumentType.ANGLE, defaultValue: 0 }
            }
          },
          {
            opcode: 'setRotationY',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の向きをy[Y]に設定する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              Y: { type: Scratch.ArgumentType.ANGLE, defaultValue: 0 }
            }
          },
          {
            opcode: 'setRotationZ',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の向きをz[Z]に設定する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              Z: { type: Scratch.ArgumentType.ANGLE, defaultValue: 0 }
            }
          },
          {
            opcode: 'changeRotationX',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の向きをx[X]ずつ変える',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              X: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }
            }
          },
          {
            opcode: 'changeRotationY',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の向きをy[Y]ずつ変える',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              Y: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }
            }
          },
          {
            opcode: 'changeRotationZ',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の向きをz[Z]ずつ変える',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              Z: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }
            }
          },
          '---',
          {
            opcode: 'setScaleXYZ',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の大きさをx[X]y[Y]z[Z]に設定する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              X: { type: Scratch.ArgumentType.NUMBER, defaultValue: 100 },
              Y: { type: Scratch.ArgumentType.NUMBER, defaultValue: 100 },
              Z: { type: Scratch.ArgumentType.NUMBER, defaultValue: 100 }
            }
          },
          {
            opcode: 'setScaleX',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の大きさをx[X]に設定する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              X: { type: Scratch.ArgumentType.NUMBER, defaultValue: 100 }
            }
          },
          {
            opcode: 'setScaleY',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の大きさをy[Y]に設定する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              Y: { type: Scratch.ArgumentType.NUMBER, defaultValue: 100 }
            }
          },
          {
            opcode: 'setScaleZ',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の大きさをz[Z]に設定する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              Z: { type: Scratch.ArgumentType.NUMBER, defaultValue: 100 }
            }
          },
          {
            opcode: 'changeScaleX',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の大きさをx[X]ずつ変える',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              X: { type: Scratch.ArgumentType.NUMBER, defaultValue: 10 }
            }
          },
          {
            opcode: 'changeScaleY',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の大きさをy[Y]ずつ変える',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              Y: { type: Scratch.ArgumentType.NUMBER, defaultValue: 10 }
            }
          },
          {
            opcode: 'changeScaleZ',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の大きさをz[Z]ずつ変える',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              Z: { type: Scratch.ArgumentType.NUMBER, defaultValue: 10 }
            }
          },
          '---',
          {
            opcode: 'moveSteps',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]を[STEPS]歩動かす',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              STEPS: { type: Scratch.ArgumentType.NUMBER, defaultValue: 10 }
            }
          },
          {
            opcode: 'moveTowardsXYZ',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]をx[X]y[Y]z[Z]に向かって[STEPS]歩動かす(向きは変えない)',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              X: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 },
              Y: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 },
              Z: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 },
              STEPS: { type: Scratch.ArgumentType.NUMBER, defaultValue: 10 }
            }
          },
          {
            opcode: 'pointDirectionXYZ',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の向きをx[X]y[Y]z[Z]に向ける',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              X: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 },
              Y: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 },
              Z: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 }
            }
          },
          {
            opcode: 'lookAtObject',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の向きをオブジェクト[TARGET]に向ける',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              TARGET: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj2' }
            }
          },
          {
            opcode: 'glideToXYZ',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]を[SECONDS]秒でx[X]y[Y]z[Z]に変える',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              SECONDS: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 },
              X: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 },
              Y: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 },
              Z: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 }
            }
          },
          '---',
          {
            opcode: 'setAsCamera',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]を視点カメラにする',
            arguments: { NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' } }
          },
          {
            opcode: 'setOpacity',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の透明度を[PERCENT]%にする',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              PERCENT: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 }
            }
          },
          {
            opcode: 'setPenetration',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の貫通を[ONOFF]にする',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              ONOFF: { type: Scratch.ArgumentType.STRING, defaultValue: 'on', menu: 'onOffMenu' }
            }
          },
          {
            opcode: 'bounceOnTouch',
            blockType: Scratch.BlockType.COMMAND,
            text: 'もしもオブジェクト[NAME]が他のオブジェクトに触れたら跳ね返る',
            arguments: { NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' } }
          },
          '---',
          {
            opcode: 'setAsLight',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]を光源に[ONOFF]する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              ONOFF: { type: Scratch.ArgumentType.STRING, defaultValue: 'on', menu: 'onOffMenu' }
            }
          },
          {
            opcode: 'setLightIntensity',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の光の強さを[VALUE]に設定する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              VALUE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 10 }
            }
          },
          {
            opcode: 'setReflectivity',
            blockType: Scratch.BlockType.COMMAND,
            text: 'オブジェクト[NAME]の反射の強さを[VALUE]に設定する',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              VALUE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }
            }
          },
          '---',
          { opcode: 'startRendering', blockType: Scratch.BlockType.COMMAND, text: '描画を開始する' },
          { opcode: 'stopRendering', blockType: Scratch.BlockType.COMMAND, text: '描画を止める' },
          {
            opcode: 'isRendering',
            blockType: Scratch.BlockType.BOOLEAN,
            text: '今は描画中？'
          },
          '---',
          {
            opcode: 'setFogDistance',
            blockType: Scratch.BlockType.COMMAND,
            text: 'fogの距離を[DIST]にする',
            arguments: { DIST: { type: Scratch.ArgumentType.NUMBER, defaultValue: 50 } }
          },
          {
            opcode: 'setFogColor',
            blockType: Scratch.BlockType.COMMAND,
            text: 'fogの色を[COLOR]にする',
            arguments: { COLOR: { type: Scratch.ArgumentType.COLOR } }
          },
          {
            opcode: 'setFogEnabled',
            blockType: Scratch.BlockType.COMMAND,
            text: 'fogを[ONOFF]にする',
            arguments: { ONOFF: { type: Scratch.ArgumentType.STRING, defaultValue: 'on', menu: 'onOffMenu' } }
          },
          '---',
          {
            opcode: 'isTouching',
            blockType: Scratch.BlockType.BOOLEAN,
            text: 'オブジェクト[NAME]がもしオブジェクト[OTHER]に触れたなら',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' },
              OTHER: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj2' }
            }
          },
          '---',
          {
            opcode: 'getPosX',
            blockType: Scratch.BlockType.REPORTER,
            text: 'オブジェクト[NAME]のxの位置',
            arguments: { NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' } }
          },
          {
            opcode: 'getPosY',
            blockType: Scratch.BlockType.REPORTER,
            text: 'オブジェクト[NAME]のyの位置',
            arguments: { NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' } }
          },
          {
            opcode: 'getPosZ',
            blockType: Scratch.BlockType.REPORTER,
            text: 'オブジェクト[NAME]のzの位置',
            arguments: { NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' } }
          },
          {
            opcode: 'getRotX',
            blockType: Scratch.BlockType.REPORTER,
            text: 'オブジェクト[NAME]のxの向き',
            arguments: { NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' } }
          },
          {
            opcode: 'getRotY',
            blockType: Scratch.BlockType.REPORTER,
            text: 'オブジェクト[NAME]のyの向き',
            arguments: { NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' } }
          },
          {
            opcode: 'getRotZ',
            blockType: Scratch.BlockType.REPORTER,
            text: 'オブジェクト[NAME]のzの向き',
            arguments: { NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' } }
          },
          {
            opcode: 'getScaleX',
            blockType: Scratch.BlockType.REPORTER,
            text: 'オブジェクト[NAME]のxの大きさ',
            arguments: { NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' } }
          },
          {
            opcode: 'getScaleY',
            blockType: Scratch.BlockType.REPORTER,
            text: 'オブジェクト[NAME]のyの大きさ',
            arguments: { NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' } }
          },
          {
            opcode: 'getScaleZ',
            blockType: Scratch.BlockType.REPORTER,
            text: 'オブジェクト[NAME]のzの大きさ',
            arguments: { NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'obj1' } }
          }
        ],
        menus: {
          onOffMenu: { acceptReporters: false, items: [{ text: 'オン', value: 'on' }, { text: 'オフ', value: 'off' }] },
          costumeMenu: { acceptReporters: true, items: 'getCostumeMenuItems' }
        }
      };
    }

    getCostumeMenuItems() {
      const target = runtime.getEditingTarget();
      if (!target || !target.sprite || !target.sprite.costumes_) return ['costume1'];
      return target.sprite.costumes_.map((c) => c.name);
    }

    /* ---------- 基本操作 ---------- */

    resetAll() {
      manager.resetAll();
    }

    createObject(args) {
      manager.getOrCreate(String(args.NAME));
    }

    deleteObject(args) {
      manager.remove(String(args.NAME));
    }

    /* ---------- テクスチャ / モデル ---------- */

    async setTextureCostume(args, util) {
      const obj = manager.get(String(args.NAME));
      if (!obj) return;
      const target = util.target;
      const costume = target.sprite.costumes_.find((c) => c.name === String(args.COSTUME));
      if (!costume || !costume.asset) return;
      try {
        const dataUri = costume.asset.encodeDataURI();
        const tex = await new THREE.TextureLoader().loadAsync(dataUri);
        obj.mesh.material.map = tex;
        obj.mesh.material.needsUpdate = true;
      } catch (e) {
        console.warn('[3D] テクスチャ(コスチューム)の読み込みに失敗:', e);
      }
    }

    async setTextureUrl(args) {
      const obj = manager.get(String(args.NAME));
      if (!obj) return;
      try {
        const loader = new THREE.TextureLoader();
        loader.crossOrigin = 'anonymous';
        const tex = await loader.loadAsync(String(args.URL));
        obj.mesh.material.map = tex;
        obj.mesh.material.needsUpdate = true;
      } catch (e) {
        console.warn('[3D] テクスチャ(URL)の読み込みに失敗:', e);
      }
    }

    setColor(args) {
      const obj = manager.get(String(args.NAME));
      if (!obj) return;
      const color = new THREE.Color(String(args.COLOR));
      obj.mesh.traverse((child) => {
        if (child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach((mat) => {
            if (mat.color) {
              mat.color.copy(color);
              mat.needsUpdate = true;
            }
          });
        }
      });
    }

    async setModelFromList(args) {
      const obj = manager.get(String(args.NAME));
      if (!obj) return;
      const data = String(args.DATA).trim();
      try {
        let newMesh = null;
        if (/^https?:\/\//i.test(data)) {
          // URLとして扱う(拡張子でローダーを判別)
          if (/\.gltf($|\?)/i.test(data) || /\.glb($|\?)/i.test(data)) {
            const gltf = await new THREE.GLTFLoader().loadAsync(data);
            newMesh = gltf.scene;
          } else {
            const obj3d = await new THREE.OBJLoader().loadAsync(data);
            newMesh = obj3d;
          }
        } else if (data.startsWith('{') || data.startsWith('data:')) {
          // GLTF(JSON)またはBase64のGLB/GLTFとして扱う
          let buffer;
          if (data.startsWith('data:')) {
            const base64 = data.split(',')[1];
            buffer = base64ToArrayBuffer(base64);
          } else {
            buffer = new TextEncoder().encode(data).buffer;
          }
          const gltf = await new THREE.GLTFLoader().parseAsync(buffer, '');
          newMesh = gltf.scene;
        } else {
          // OBJのテキストとして扱う
          const objLoader = new THREE.OBJLoader();
          newMesh = objLoader.parse(data);
        }

        if (newMesh) {
          const pos = obj.mesh.position.clone();
          const rot = obj.mesh.rotation.clone();
          const scale = obj.mesh.scale.clone();
          manager.scene.remove(obj.mesh);
          newMesh.position.copy(pos);
          newMesh.rotation.copy(rot);
          newMesh.scale.copy(scale);
          manager.scene.add(newMesh);
          obj.mesh = newMesh;
        }
      } catch (e) {
        console.warn('[3D] モデルの読み込みに失敗:', e);
      }
    }

    /* ---------- 位置 ---------- */

    setPositionXYZ(args) {
      const obj = manager.get(String(args.NAME));
      if (!obj) return;
      obj.mesh.position.set(toNumber(args.X), toNumber(args.Y), toNumber(args.Z));
    }
    setPositionX(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.mesh.position.x = toNumber(args.X);
    }
    setPositionY(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.mesh.position.y = toNumber(args.Y);
    }
    setPositionZ(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.mesh.position.z = toNumber(args.Z);
    }
    changePositionX(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.mesh.position.x += toNumber(args.X);
    }
    changePositionY(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.mesh.position.y += toNumber(args.Y);
    }
    changePositionZ(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.mesh.position.z += toNumber(args.Z);
    }

    /* ---------- 向き(度数で扱う) ---------- */

    setRotationXYZ(args) {
      const obj = manager.get(String(args.NAME));
      if (!obj) return;
      obj.mesh.rotation.set(toNumber(args.X) * DEG2RAD, toNumber(args.Y) * DEG2RAD, toNumber(args.Z) * DEG2RAD);
    }
    setRotationX(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.mesh.rotation.x = toNumber(args.X) * DEG2RAD;
    }
    setRotationY(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.mesh.rotation.y = toNumber(args.Y) * DEG2RAD;
    }
    setRotationZ(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.mesh.rotation.z = toNumber(args.Z) * DEG2RAD;
    }
    changeRotationX(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.mesh.rotation.x += toNumber(args.X) * DEG2RAD;
    }
    changeRotationY(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.mesh.rotation.y += toNumber(args.Y) * DEG2RAD;
    }
    changeRotationZ(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.mesh.rotation.z += toNumber(args.Z) * DEG2RAD;
    }

    /* ---------- 大きさ(%指定。100 = 元の大きさ) ---------- */

    setScaleXYZ(args) {
      const obj = manager.get(String(args.NAME));
      if (!obj) return;
      obj.mesh.scale.set(toNumber(args.X) / 100, toNumber(args.Y) / 100, toNumber(args.Z) / 100);
    }
    setScaleX(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.mesh.scale.x = toNumber(args.X) / 100;
    }
    setScaleY(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.mesh.scale.y = toNumber(args.Y) / 100;
    }
    setScaleZ(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.mesh.scale.z = toNumber(args.Z) / 100;
    }
    changeScaleX(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.mesh.scale.x += toNumber(args.X) / 100;
    }
    changeScaleY(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.mesh.scale.y += toNumber(args.Y) / 100;
    }
    changeScaleZ(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.mesh.scale.z += toNumber(args.Z) / 100;
    }

    /* ---------- 移動・向き変更 ---------- */

    moveSteps(args) {
      const obj = manager.get(String(args.NAME));
      if (!obj) return;
      const dir = new THREE.Vector3(0, 0, -1).applyEuler(obj.mesh.rotation);
      obj.mesh.position.addScaledVector(dir, toNumber(args.STEPS));
    }

    moveTowardsXYZ(args) {
      const obj = manager.get(String(args.NAME));
      if (!obj) return;
      const target = new THREE.Vector3(toNumber(args.X), toNumber(args.Y), toNumber(args.Z));
      const dir = target.clone().sub(obj.mesh.position);
      if (dir.lengthSq() === 0) return;
      dir.normalize();
      obj.mesh.position.addScaledVector(dir, toNumber(args.STEPS));
    }

    pointDirectionXYZ(args) {
      const obj = manager.get(String(args.NAME));
      if (!obj) return;
      obj.mesh.lookAt(toNumber(args.X), toNumber(args.Y), toNumber(args.Z));
    }

    lookAtObject(args) {
      const obj = manager.get(String(args.NAME));
      const target = manager.get(String(args.TARGET));
      if (!obj || !target) return;
      obj.mesh.lookAt(target.mesh.position);
    }

    glideToXYZ(args) {
      const obj = manager.get(String(args.NAME));
      if (!obj) return Promise.resolve();
      const seconds = Math.max(0, toNumber(args.SECONDS));
      const startPos = obj.mesh.position.clone();
      const endPos = new THREE.Vector3(toNumber(args.X), toNumber(args.Y), toNumber(args.Z));
      if (seconds === 0) {
        obj.mesh.position.copy(endPos);
        return Promise.resolve();
      }
      const startTime = performance.now();
      return new Promise((resolve) => {
        const step = () => {
          const elapsed = (performance.now() - startTime) / 1000;
          const t = Math.min(1, elapsed / seconds);
          obj.mesh.position.lerpVectors(startPos, endPos, t);
          if (t < 1) {
            requestAnimationFrame(step);
          } else {
            resolve();
          }
        };
        step();
      });
    }

    /* ---------- カメラ・不透明度・貫通 ---------- */

    setAsCamera(args) {
      manager.cameraObjectName = String(args.NAME);
    }

    setOpacity(args) {
      const obj = manager.get(String(args.NAME));
      if (!obj) return;
      const percent = Math.min(100, Math.max(0, toNumber(args.PERCENT)));
      const applyToMat = (mat) => {
        mat.transparent = percent > 0;
        mat.opacity = 1 - percent / 100;
        mat.needsUpdate = true;
      };
      obj.mesh.traverse((child) => {
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach(applyToMat);
          else applyToMat(child.material);
        }
      });
    }

    setPenetration(args) {
      const obj = manager.get(String(args.NAME));
      if (obj) obj.penetration = String(args.ONOFF) === 'on';
    }

    bounceOnTouch(args) {
      const obj = manager.get(String(args.NAME));
      if (!obj) return;
      const box = new THREE.Box3().setFromObject(obj.mesh);
      let collided = false;
      for (const [name, other] of manager.objects) {
        if (name === String(args.NAME)) continue;
        if (other.penetration) continue;
        const otherBox = new THREE.Box3().setFromObject(other.mesh);
        if (box.intersectsBox(otherBox)) {
          collided = true;
          break;
        }
      }
      if (collided) {
        obj.mesh.position.copy(obj.lastSafePos);
      } else {
        obj.lastSafePos = obj.mesh.position.clone();
      }
    }

    /* ---------- 光源・反射 ---------- */

    setAsLight(args) {
      const obj = manager.get(String(args.NAME));
      if (!obj) return;
      const on = String(args.ONOFF) === 'on';
      if (on && !obj.isLight) {
        obj.light = new THREE.PointLight(0xffffff, 10, 0);
        obj.mesh.add(obj.light);
        obj.isLight = true;
      } else if (!on && obj.isLight) {
        obj.mesh.remove(obj.light);
        obj.light = null;
        obj.isLight = false;
      }
    }

    setLightIntensity(args) {
      const obj = manager.get(String(args.NAME));
      if (obj && obj.light) obj.light.intensity = toNumber(args.VALUE);
    }

    setReflectivity(args) {
      const obj = manager.get(String(args.NAME));
      if (!obj) return;
      const value = Math.min(1, Math.max(0, toNumber(args.VALUE)));
      const applyToMat = (mat) => {
        if ('metalness' in mat) {
          mat.metalness = value;
          mat.roughness = 1 - value;
          mat.needsUpdate = true;
        }
      };
      obj.mesh.traverse((child) => {
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach(applyToMat);
          else applyToMat(child.material);
        }
      });
    }

    /* ---------- 描画制御 ---------- */

    startRendering() {
      manager.rendering = true;
    }
    stopRendering() {
      manager.rendering = false;
    }
    isRendering() {
      return manager.rendering;
    }

    /* ---------- フォグ ---------- */

    setFogDistance(args) {
      const dist = toNumber(args.DIST);
      if (manager.scene.fog) manager.scene.fog.far = dist;
      else manager._pendingFogFar = dist;
    }

    setFogColor(args) {
      const color = new THREE.Color(String(args.COLOR));
      if (manager.scene.fog) manager.scene.fog.color = color;
      manager._pendingFogColor = color;
    }

    setFogEnabled(args) {
      const on = String(args.ONOFF) === 'on';
      manager.fogEnabled = on;
      if (on) {
        const color = manager._pendingFogColor || new THREE.Color(0xffffff);
        const far = manager._pendingFogFar || 50;
        manager.scene.fog = new THREE.Fog(color, 1, far);
      } else {
        manager.scene.fog = null;
      }
    }

    /* ---------- 判定 ---------- */

    isTouching(args) {
      const a = manager.get(String(args.NAME));
      const b = manager.get(String(args.OTHER));
      if (!a || !b) return false;
      const boxA = new THREE.Box3().setFromObject(a.mesh);
      const boxB = new THREE.Box3().setFromObject(b.mesh);
      return boxA.intersectsBox(boxB);
    }

    /* ---------- 値の取得(引数) ---------- */

    getPosX(args) {
      const obj = manager.get(String(args.NAME));
      return obj ? obj.mesh.position.x : 0;
    }
    getPosY(args) {
      const obj = manager.get(String(args.NAME));
      return obj ? obj.mesh.position.y : 0;
    }
    getPosZ(args) {
      const obj = manager.get(String(args.NAME));
      return obj ? obj.mesh.position.z : 0;
    }
    getRotX(args) {
      const obj = manager.get(String(args.NAME));
      return obj ? obj.mesh.rotation.x * RAD2DEG : 0;
    }
    getRotY(args) {
      const obj = manager.get(String(args.NAME));
      return obj ? obj.mesh.rotation.y * RAD2DEG : 0;
    }
    getRotZ(args) {
      const obj = manager.get(String(args.NAME));
      return obj ? obj.mesh.rotation.z * RAD2DEG : 0;
    }
    getScaleX(args) {
      const obj = manager.get(String(args.NAME));
      return obj ? obj.mesh.scale.x * 100 : 0;
    }
    getScaleY(args) {
      const obj = manager.get(String(args.NAME));
      return obj ? obj.mesh.scale.y * 100 : 0;
    }
    getScaleZ(args) {
      const obj = manager.get(String(args.NAME));
      return obj ? obj.mesh.scale.z * 100 : 0;
    }
  }

  Scratch.extensions.register(new ThreeDExtension());
})(Scratch);
