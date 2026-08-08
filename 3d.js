// Name: BackLayer 3D
// ID: backlayer3d
// Description: 3D objects rendered behind every Scratch sprite.
// By: nofileteams
// License: MIT
// Version: 1.6.12

(async function (Scratch) {
  "use strict";
  if (!Scratch.extensions.unsandboxed) throw new Error("BackLayer 3D must run unsandboxed");

  const {BlockType, ArgumentType, Cast} = Scratch;
  const vm = Scratch.vm;
  const runtime = vm.runtime;
  const renderer = vm.renderer;
  const THREE = await import("https://esm.sh/three@0.160.0");
  const [{OBJLoader}, {GLTFLoader}] = await Promise.all([
    import("https://esm.sh/three@0.160.0/examples/jsm/loaders/OBJLoader.js"),
    import("https://esm.sh/three@0.160.0/examples/jsm/loaders/GLTFLoader.js")
  ]);

  const canvas = document.createElement("canvas");
  canvas.width = 480; canvas.height = 360;
  const glRenderer = new THREE.WebGLRenderer({canvas, alpha:true, antialias:true, preserveDrawingBuffer:true, powerPreference:"high-performance"});
  glRenderer.setPixelRatio(1);
  glRenderer.setSize(480, 360, false);
  glRenderer.outputColorSpace = THREE.SRGBColorSpace;
  glRenderer.setClearColor(0x000000, 0);
  glRenderer.autoClear = true;

  let contextLost = false;
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    contextLost = true;
    drawing = false;
  }, false);
  canvas.addEventListener("webglcontextrestored", () => {
    contextLost = false;
    installBackLayer();
    refreshReflectiveMaterials(); // [FIX v1.6.12] 反射中のオブジェクトがある場合のみGPUリソースを再生成する
    startRenderLoop();
  }, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 4/3, 0.1, 10000);
  camera.position.set(0, 0, 10);
  const ambient = new THREE.AmbientLight(0xffffff, 0.65);
  scene.add(ambient);
  // [FIX v1.6.11→v1.6.12] 「反射の強さ」を設定した時だけ、そのオブジェクトが環境を映り込むようにする。
  //   以前の修正でscene.environmentを常時グローバルに設定していたため、反射を一切上げていない
  //   デフォルトのオブジェクトまでうっすら環境を映り込んでしまっていた。
  //   → scene.environmentは使わず、setReflectivityで値が0より大きく設定されたマテリアルにだけ
  //   個別に envMap を割り当てる方式に変更。値を0に戻せばenvMapも外れ、反射しなくなる。
  const pmremGenerator = new THREE.PMREMGenerator(glRenderer);
  pmremGenerator.compileEquirectangularShader();
  let envTexture = null;
  let currentEnvRT = null;
  const reflectiveMaterials = new Set();
  const buildDefaultEnvironmentScene = () => {
    const envScene = new THREE.Scene();
    const gradient = new THREE.Mesh(
      new THREE.SphereGeometry(50, 32, 32),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: {
          topColor: {value: new THREE.Color(0xdfe9ff)},
          bottomColor: {value: new THREE.Color(0x33353d)}
        },
        vertexShader: "varying vec3 vPos;void main(){vPos=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
        fragmentShader: "varying vec3 vPos;uniform vec3 topColor;uniform vec3 bottomColor;void main(){float h=normalize(vPos).y*0.5+0.5;gl_FragColor=vec4(mix(bottomColor,topColor,h),1.0);}"
      })
    );
    envScene.add(gradient);
    const keyLight = new THREE.PointLight(0xffffff, 40, 200);
    keyLight.position.set(12, 18, 12);
    envScene.add(keyLight);
    const fillLight = new THREE.PointLight(0xffffff, 18, 200);
    fillLight.position.set(-14, 6, -10);
    envScene.add(fillLight);
    return envScene;
  };
  // 環境マップ本体を(必要なら再)生成するだけで、どのマテリアルにも自動では適用しない。
  const regenerateEnvTexture = () => {
    const prevRT = currentEnvRT;
    if (skyTexture && skyTexture.image) {
      currentEnvRT = pmremGenerator.fromEquirectangular(skyTexture);
    } else {
      const envScene = buildDefaultEnvironmentScene();
      currentEnvRT = pmremGenerator.fromScene(envScene, 0.04);
      envScene.traverse(child => { if (child.isMesh) { child.geometry.dispose(); child.material.dispose(); } });
    }
    envTexture = currentEnvRT.texture;
    if (prevRT) prevRT.dispose();
    return envTexture;
  };
  // 既に反射がonになっている(=envMapを持っている)マテリアルだけに、最新の環境マップを配り直す。
  //   反射を上げていないオブジェクトのマテリアルはこのSetに入らないため一切影響を受けない。
  const refreshReflectiveMaterials = () => {
    if (reflectiveMaterials.size === 0) return;
    regenerateEnvTexture();
    for (const m of reflectiveMaterials) { m.envMap = envTexture; m.needsUpdate = true; }
  };
  const objects = new Map();
  const lights = new Map();
  let drawing = false;
  let loopRunning = false;
  let frame = 0;
  let fogDistance = 100;
  let fogColor = "#ffffff";
  let fogEnabled = false;
  let fogHueEffect = 0;
  let fogBrightnessEffect = 0;
  let worldBrightness = 0.65;
  let shadowsEnabled = false;
  let shadowUpdateCounter = 0;
  const shadowMapSize = 2048;
  // [FIX v1.6.6] 深度テクスチャを既定の8bit(UnsignedByteType)から16bit浮動小数点(HalfFloatType)に変更。
  //   8bitだと深度が256段階にしか量子化されず、壁のような緩やかな傾斜面で「等高線」状の
  //   段差(=不自然な一直線の影)が出ていた。HalfFloatにすることで滑らかな深度勾配になる。
  const shadowTarget = new THREE.WebGLRenderTarget(shadowMapSize, shadowMapSize, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: true
  });
  // [FIX v1.6.9] 影の深度パス(shadowMaterial)がオブジェクトのテクスチャ(alphaTest/map)を
  //   一切無視していたため、透明にしたい部分まで「完全な不透明の箱」として深度マップに焼き込まれ、
  //   オブジェクト自身がその誤った深度と衝突してセルフシャドウ判定されてしまい、
  //   本来テクスチャが透明で背景が見えるはずの面が(減光係数のかかった)黒一色に潰れて見えていた。
  //   → 深度パスにも uMap(現在描画中メッシュの実テクスチャ)/uAlphaTest を渡し、
  //   通常描画と同じ条件で discard するようにして、透明部分は深度も書き込まれないようにする。
  const shadowMaterial = new THREE.ShaderMaterial({
    vertexShader: "varying float vDepth;varying vec2 vUv;void main(){vUv=uv;vec4 mv=modelViewMatrix*vec4(position,1.0);vDepth=-mv.z;gl_Position=projectionMatrix*mv;}",
    fragmentShader: "varying float vDepth;varying vec2 vUv;uniform float uNear;uniform float uFar;uniform sampler2D uMap;uniform float uUseMap;uniform float uAlphaTest;void main(){if(uUseMap>0.5){float a=texture2D(uMap,vUv).a;if(a<uAlphaTest)discard;}float d=(vDepth-uNear)/(uFar-uNear);gl_FragColor=vec4(d,d,d,1.0);}",
    uniforms: { uNear: { value: 0.1 }, uFar: { value: 500 }, uMap: { value: null }, uUseMap: { value: 0 }, uAlphaTest: { value: 0 } }
  });
  const shadowCamera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 500);
  const shadowBiasMatrix = new THREE.Matrix4();
  shadowBiasMatrix.set(0.5, 0.0, 0.0, 0.5, 0.0, 0.5, 0.0, 0.5, 0.0, 0.0, 0.5, 0.5, 0.0, 0.0, 0.0, 1.0);
  const shadowMatrix = new THREE.Matrix4();
  // [FIX v1.6.6] 追加uniform: ライト方向・法線バイアス量・シャドウマップ1テクセルのワールドサイズ。
  //   これらを使ってスロープスケール法線オフセットバイアスを行い、壁のシャドウアクネ(ギザギザの影)と
  //   ボックス背後の影の浮き/めり込みを両方解消する。
  const shadowUniforms = {
    shadowMap: { value: shadowTarget.texture },
    shadowMatrix: { value: shadowMatrix },
    shadowsEnabled: { value: 0.0 },
    shadowLightDir: { value: new THREE.Vector3(0, -1, 0) },
    shadowTexelSize: { value: 0.05 }
  };
  const patchedMaterials = new WeakSet();
  let skyDome = null;
  let skyTexture = null;
  let skyEffectTexture = null;
  let skyHueEffect = 0;
  let skyBrightnessEffect = 0;
  let cameraObject = null;
  let drawableId = null;
  let skinId = null;
  let materialBaseURL = "https://data.nofileteams.com/templeate/";
  let materialNames = [];

  const normalizeBaseURL = value => {
    const url = name(value).trim();
    return url.endsWith("/") ? url : url + "/";
  };
  const loadTextureFromURL = async url => {
    if (!await Scratch.canFetch(url)) return null;
    const response = await Scratch.fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    const local = URL.createObjectURL(blob);
    try {
      const texture = await new THREE.TextureLoader().loadAsync(local);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    } finally { URL.revokeObjectURL(local); }
  };
  const refreshMaterialList = async () => {
    try {
      const url = materialBaseURL + "list.txt";
      if (!await Scratch.canFetch(url)) return;
      const response = await Scratch.fetch(url);
      if (!response.ok) return;
      materialNames = (await response.text()).split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    } catch (error) { console.warn("BackLayer 3D: 素材一覧を取得できませんでした", error); }
  };
  const markTiling = texture => { texture.wrapS=THREE.RepeatWrapping; texture.wrapT=THREE.RepeatWrapping; texture.userData=texture.userData||{}; texture.userData.tile=true; return texture; };
  const updateTilingRepeat = root => {
    // [FIX v1.6.1] 面ごとにUVを再計算して、画像(100x100)が各面の実寸に合わせてタイルされるようにする。
    //   Before: texture.repeat を bounding-box の size.x/size.y で一律設定 → 面によって伸縮/縦長化
    //   After:  BoxGeometry の6面それぞれの UV に面ごとのワールド寸法を baked → 面ごとに正しくタイル
    const texture = root.userData.materialTexture;
    if (!texture || !texture.userData || !texture.userData.tile) return;
    let usedUV = false;
    allMeshes(root).forEach(mesh => {
      const geo = mesh.geometry;
      if (!geo || !geo.attributes || !geo.attributes.uv) return;
      const isBox = geo.type === "BoxGeometry" || (geo.parameters && geo.parameters.width !== undefined && geo.parameters.height !== undefined);
      if (!isBox) return;
      usedUV = true;
      if (!geo.userData._origUV) geo.userData._origUV = Float32Array.from(geo.attributes.uv.array);
      const orig = geo.userData._origUV;
      const sx = mesh.scale.x, sy = mesh.scale.y, sz = mesh.scale.z;
      const w = geo.parameters.width || 1, h = geo.parameters.height || 1, d = geo.parameters.depth || 1;
      // three.js BoxGeometry の面順: +X,-X,+Y,-Y,+Z,-Z (各4頂点)
      // 各面の (U方向, V方向) のワールドサイズ (画像1枚 = 1ワールド単位 = 100スケール)
      const faces = [
        [sz * d, sy * h], [sz * d, sy * h], // ±X: U=Z(depth), V=Y(height)
        [sx * w, sz * d], [sx * w, sz * d], // ±Y: U=X(width),  V=Z(depth)
        [sx * w, sy * h], [sx * w, sy * h]  // ±Z: U=X(width),  V=Y(height)
      ];
      const arr = geo.attributes.uv.array;
      for (let f = 0; f < 6; f++) {
        const ru = Math.max(0.01, faces[f][0]);
        const rv = Math.max(0.01, faces[f][1]);
        for (let v = 0; v < 4; v++) {
          const idx = f * 4 + v;
          arr[idx * 2]     = orig[idx * 2]     * ru;
          arr[idx * 2 + 1] = orig[idx * 2 + 1] * rv;
        }
      }
      geo.attributes.uv.needsUpdate = true;
    });
    if (usedUV) {
      // UVに焼き込んだので repeat は 1:1 に戻す
      texture.repeat.set(1, 1);
    } else {
      // Box以外(OBJ/GLTF)は従来の repeat 方式をフォールバック
      const size = box(root).getSize(new THREE.Vector3());
      texture.repeat.set(Math.max(0.01, size.x), Math.max(0.01, size.y));
    }
    texture.needsUpdate = true;
  };
  let materialLoadMethod = "毎回urlから読み込む";
  let preloadingMaterials = false;
  const openMaterialDB = () => new Promise((resolve, reject) => {
    const req = indexedDB.open("backlayer3d_materials", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("materials");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const getCachedBlob = async material => {
    try { const db = await openMaterialDB(); return await new Promise((resolve, reject) => { const tx = db.transaction("materials","readonly"); const req = tx.objectStore("materials").get(material); req.onsuccess = () => resolve(req.result || null); req.onerror = () => reject(req.error); }); } catch (error) { return null; }
  };
  const setCachedBlob = async (material, blob) => {
    try { const db = await openMaterialDB(); await new Promise((resolve, reject) => { const tx = db.transaction("materials","readwrite"); tx.objectStore("materials").put(blob, material); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); } catch (error) {}
  };
  const blobToTexture = async blob => {
    const local = URL.createObjectURL(blob);
    try { const texture = await new THREE.TextureLoader().loadAsync(local); texture.colorSpace = THREE.SRGBColorSpace; return texture; } finally { URL.revokeObjectURL(local); }
  };
  const preloadAllMaterials = async () => {
    if (preloadingMaterials) return;
    preloadingMaterials = true;
    try {
      await refreshMaterialList();
      for (const material of materialNames) {
        const cached = await getCachedBlob(material);
        if (cached) continue;
        const url = materialBaseURL + encodeURIComponent(material) + ".png";
        if (!await Scratch.canFetch(url)) continue;
        const response = await Scratch.fetch(url);
        if (!response.ok) continue;
        await setCachedBlob(material, await response.blob());
      }
    } catch (error) { console.warn("BackLayer 3D: 素材の事前ダウンロードに失敗", error); }
    finally { preloadingMaterials = false; }
  };
  const applyPreferredTexture = root => {
    const override = Boolean(root.userData.textureOverride);
    const texture = root.userData.textureOverride || root.userData.materialTexture || null;
    // [FIX v1.6.7] テクスチャを貼るたびに transparent=true / depthWrite=false にしていたため、
    // 不透明テクスチャでも深度が書き込まれず、箱の裏側/内側の面が手前の面を突き抜けて
    // 見える描画崩れ(ソート崩れ)が発生していた。
    // 通常のブレンディングではなく alphaTest によるカットアウトに切り替えることで、
    // 不透明テクスチャは正しく深度を書き込みつつ、部分的に透明なテクスチャ(葉っぱ等)も
    // 引き続き扱えるようにする。
    setMaterial(root, m => {
      m.map = texture;
      m.transparent = false;
      m.alphaTest = texture ? 0.5 : 0;
      m.depthWrite = true;
      m.needsUpdate = true;
    });
    if (!override) updateTilingRepeat(root);
  };

  // [FIX] Reusable scratch objects to avoid per-call allocation
  const _localAxisX = new THREE.Vector3(1, 0, 0);
  const _localAxisY = new THREE.Vector3(0, 1, 0);
  const _localAxisZ = new THREE.Vector3(0, 0, 1);
  const _deltaQuat = new THREE.Quaternion();
  const _shadowLightDirTmp = new THREE.Vector3();
  const _physicsClock = new THREE.Clock();
  const _physicsCenterA = new THREE.Vector3();
  const _physicsCenterB = new THREE.Vector3();
  const GRAVITY = -9.8;
  // [FIX v1.6.11] 「触れたら真上にTP」する不自然な重力を廃止し、自然な落下/バウンド/傾きに変更するための係数
  const RESTITUTION = 0.35;       // 反発係数(0=跳ねない〜1=完全に跳ね返る)
  const GROUND_FRICTION = 0.85;   // 着地時に水平方向の速度へかける摩擦(1フレームごと)
  const ANGULAR_DAMPING = 0.98;   // 回転速度の空気抵抗による減衰(1フレームあたり, 60fps基準)
  const REST_LINEAR_SPEED = 0.05; // これより遅い速度は静止とみなして0にする(跳ね続ける微振動を防止)
  const REST_ANGULAR_SPEED = 0.02;
  const TUMBLE_FACTOR = 0.6;      // 衝突時、水平速度をどれくらい回転(傾き)に変換するか

  class CanvasSkin extends renderer.exports.Skin {
    constructor(id) {
      super(id, renderer);
      const gl = renderer.gl;
      this._texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      this._nativeSize = renderer.getNativeSize();
      this._rotationCenter = [this._nativeSize[0]/2, this._nativeSize[1]/2];
    }
    get size() { return this._nativeSize; }
    getTexture() { return this._texture || super.getTexture(); }
    update() {
      const gl = renderer.gl;
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.bindTexture(gl.TEXTURE_2D, this._texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      this._silhouette.update(canvas);
      this.emitWasAltered();
    }
    dispose() {
      if (this._texture) renderer.gl.deleteTexture(this._texture);
      this._texture = null;
      super.dispose();
    }
  }

  function clearSkin() {
    glRenderer.setRenderTarget(null);
    glRenderer.clear();
    const skin = renderer._allSkins[skinId];
    if (skin) skin.update();
    runtime.requestRedraw();
  }
  function installBackLayer() {
    if (!renderer._layerGroups.backlayer3d) {
      const videoIndex = Math.max(0, renderer._groupOrdering.indexOf("video"));
      renderer._groupOrdering.splice(videoIndex + 1, 0, "backlayer3d");
      const videoGroup = renderer._layerGroups.video || {drawListOffset:0};
      renderer._layerGroups.backlayer3d = {groupIndex:0, drawListOffset:videoGroup.drawListOffset};
      renderer._groupOrdering.forEach((n, index) => renderer._layerGroups[n].groupIndex = index);
    }
    if (!renderer._allSkins[skinId] || !renderer._allDrawables[drawableId]) {
      skinId = renderer._nextSkinId++;
      const skin = new CanvasSkin(skinId);
      renderer._allSkins[skinId] = skin;
      drawableId = renderer.createDrawable("backlayer3d");
      renderer.updateDrawableSkinId(drawableId, skinId);
      if (renderer.markDrawableAsNoninteractive) renderer.markDrawableAsNoninteractive(drawableId);
    }
    clearSkin();
  }
  installBackLayer();

  const num = value => Cast.toNumber(value);
  const name = value => Cast.toString(value);
  const color = value => {
    const s = Cast.toString(value).trim();
    return /^#[0-9a-f]{3,8}$/i.test(s) ? s : "#ffffff";
  };
  const object = value => objects.get(name(value));
  const allMeshes = root => {
    const result = [];
    root.traverse(child => { if (child.isMesh) result.push(child); });
    return result;
  };
  const setMaterial = (root, fn) => allMeshes(root).forEach(mesh => {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach(fn);
  });
  const makeObject = n => {
    const old = objects.get(n);
    if (old) { scene.remove(old); disposeObject(old); }
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({color:0xffffff}));
    mesh.name = n;
    mesh.userData.passThrough = false;
    mesh.userData.physics = false;
    mesh.userData.velocityX = 0;
    mesh.userData.velocityY = 0;
    mesh.userData.velocityZ = 0;
    mesh.userData.angularVelocityX = 0;
    mesh.userData.angularVelocityY = 0;
    mesh.userData.angularVelocityZ = 0;
    mesh.userData.lightType = "全体";
    // [FIX v1.6.8] 光源offのタイミングで強さ/色を保持しておくための初期値。
    mesh.userData.lightIntensity = 10;
    mesh.userData.lightColor = 0xffffff;
    mesh.userData.materialTexture = null;
    mesh.userData.textureOverride = null;
    patchShadowShader(mesh.material);
    attachDepthMapSync(mesh);
    scene.add(mesh); objects.set(n, mesh);
    return mesh;
  };
  const replaceObject = (n, next) => {
    const old = objects.get(n);
    if (!old) return;
    next.name = n;
    next.position.copy(old.position); next.rotation.copy(old.rotation); next.scale.copy(old.scale);
    next.userData.passThrough = old.userData.passThrough;
    next.userData.physics = old.userData.physics || false;
    next.userData.velocityX = old.userData.velocityX || 0;
    next.userData.velocityY = old.userData.velocityY || 0;
    next.userData.velocityZ = old.userData.velocityZ || 0;
    next.userData.angularVelocityX = old.userData.angularVelocityX || 0;
    next.userData.angularVelocityY = old.userData.angularVelocityY || 0;
    next.userData.angularVelocityZ = old.userData.angularVelocityZ || 0;
    next.userData.lightType = old.userData.lightType || "全体";
    next.userData.lightIntensity = old.userData.lightIntensity != null ? old.userData.lightIntensity : 10;
    next.userData.lightColor = old.userData.lightColor != null ? old.userData.lightColor : 0xffffff;
    next.userData.materialTexture = old.userData.materialTexture || null;
    next.userData.textureOverride = old.userData.textureOverride || null;
    applyPreferredTexture(next);
    allMeshes(next).forEach(mesh => { patchShadowShader(mesh.material); attachDepthMapSync(mesh); });
    scene.remove(old); disposeObject(old); scene.add(next); objects.set(n, next);
  };
  const disposeObject = root => {
    root.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => { reflectiveMaterials.delete(m); m.dispose(); });
    });
  };
  const listValue = (listName, util) => {
    const variable = util.target.lookupVariableByNameAndType(name(listName), "list");
    return variable ? variable.value : [];
  };
  const loadGLTFList = async items => {
    const numeric = items.length > 0 && items.every(v => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 255);
    const data = numeric ? Uint8Array.from(items, Number).buffer : items.join("\n").trim();
    const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(data, "", resolve, reject));
    gltf.scene.userData.animationClips = gltf.animations || [];
    gltf.scene.userData.animationMixer = new THREE.AnimationMixer(gltf.scene);
    return gltf.scene;
  };
  const playObjectAnimation = (root, animationName) => {
    if (!root || !root.userData.animationMixer) return null;
    const clip = root.userData.animationClips.find(item => item.name === name(animationName));
    if (!clip) return null;
    const mixer = root.userData.animationMixer;
    mixer.stopAllAction();
    const action = mixer.clipAction(clip);
    action.reset().setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    return action;
  };
  const effectedFogColor = () => {
    const c = new THREE.Color(fogColor);
    const hsl = {}; c.getHSL(hsl);
    hsl.h = (hsl.h + fogHueEffect / 200) % 1;
    if (hsl.h < 0) hsl.h += 1;
    if (fogBrightnessEffect >= 0) hsl.l += (1 - hsl.l) * fogBrightnessEffect / 100;
    else hsl.l *= 1 + fogBrightnessEffect / 100;
    return new THREE.Color().setHSL(hsl.h, hsl.s, THREE.MathUtils.clamp(hsl.l, 0, 1));
  };
  const updateFog = () => {
    if (!fogEnabled) { scene.fog = null; return; }
    const far = Math.max(1, fogDistance);
    scene.fog = new THREE.Fog(effectedFogColor(), Math.max(0, far * 0.12), far);
  };
  const box = root => new THREE.Box3().setFromObject(root);
  const touching = (a,b) => Boolean(a && b && !a.userData.passThrough && !b.userData.passThrough && box(a).intersectsBox(box(b)));
  const removeLight = light => { if (light.target) scene.remove(light.target); scene.remove(light); };
  const makeLight = (type, intensity=10, lightColor=0xffffff) => {
    let light;
    if (type === "向いてる方向") {
      light = new THREE.SpotLight(lightColor, intensity, 100, Math.PI / 4, 0.25, 1);
      scene.add(light.target);
    } else {
      light = new THREE.PointLight(lightColor, intensity, 100);
    }
    return light;
  };
  const syncLight = (source, light) => {
    source.getWorldPosition(light.position);
    if (light.isSpotLight) {
      const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(source.getWorldQuaternion(new THREE.Quaternion()));
      light.target.position.copy(light.position).add(direction);
      light.target.updateMatrixWorld();
    }
  };
  const applySkyEffects = () => {
    if (!skyDome || !skyTexture || !skyTexture.image) return;
    const image = skyTexture.image;
    const width = image.naturalWidth || image.videoWidth || image.width;
    const height = image.naturalHeight || image.videoHeight || image.height;
    if (!width || !height) return;
    const effectCanvas = document.createElement("canvas");
    effectCanvas.width = width; effectCanvas.height = height;
    const context = effectCanvas.getContext("2d", {willReadFrequently:true});
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    const angle = skyHueEffect / 200 * Math.PI * 2;
    const c = Math.cos(angle), s = Math.sin(angle);
    const matrix = [
      .213+c*.787-s*.213, .715-c*.715-s*.715, .072-c*.072+s*.928,
      .213-c*.213+s*.143, .715+c*.285+s*.140, .072-c*.072-s*.283,
      .213-c*.213-s*.787, .715-c*.715+s*.715, .072+c*.928+s*.072
    ];
    const brightness = THREE.MathUtils.clamp(skyBrightnessEffect, -100, 100) / 100;
    for (let i=0; i<pixels.data.length; i+=4) {
      const r=pixels.data[i], g=pixels.data[i+1], b=pixels.data[i+2];
      let nr=r*matrix[0]+g*matrix[1]+b*matrix[2];
      let ng=r*matrix[3]+g*matrix[4]+b*matrix[5];
      let nb=r*matrix[6]+g*matrix[7]+b*matrix[8];
      if (brightness >= 0) { nr+=(255-nr)*brightness; ng+=(255-ng)*brightness; nb+=(255-nb)*brightness; }
      else { nr*=1+brightness; ng*=1+brightness; nb*=1+brightness; }
      pixels.data[i]=nr; pixels.data[i+1]=ng; pixels.data[i+2]=nb;
    }
    context.putImageData(pixels, 0, 0);
    if (skyEffectTexture) skyEffectTexture.dispose();
    skyEffectTexture = new THREE.CanvasTexture(effectCanvas);
    skyEffectTexture.colorSpace = THREE.SRGBColorSpace;
    skyDome.material.map = skyEffectTexture;
    const factor = THREE.MathUtils.clamp(worldBrightness / 5, 0, 10);
    skyDome.material.color.setRGB(factor, factor, factor);
    skyDome.material.needsUpdate = true;
  };
  const pointToward = (from, target) => {
    const p = target instanceof THREE.Vector3 ? target : target.position;
    const savedPos = from.position.clone();
    const worldPos = new THREE.Vector3();
    from.getWorldPosition(worldPos);
    const m = new THREE.Matrix4();
    if (cameraObject && from === objects.get(cameraObject)) {
      m.lookAt(worldPos, p, from.up);
    } else {
      m.lookAt(p, worldPos, from.up);
    }
    from.quaternion.setFromRotationMatrix(m);
    from.rotation.setFromQuaternion(from.quaternion);
    from.position.copy(savedPos);
  };

  const updateShadowMap = () => {
    const box = new THREE.Box3();
    for (const o of objects.values()) box.expandByObject(o);
    if (box.isEmpty()) return;
    const sz = box.getSize(new THREE.Vector3());
    const ctr = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(sz.x, sz.z, 10);
    // 光源の位置を取得（最初のライト）。光源があればそこから影を落とす
    let lightPos = null;
    for (const [lightName] of lights) {
      const src = objects.get(lightName);
      if (src) { lightPos = new THREE.Vector3(); src.getWorldPosition(lightPos); break; }
    }
    if (lightPos) {
      const dist = lightPos.distanceTo(ctr);
      const frust = Math.max(maxDim * 1.6, 15);
      shadowCamera.left = -frust;
      shadowCamera.right = frust;
      shadowCamera.top = frust;
      shadowCamera.bottom = -frust;
      shadowCamera.near = 0.1;
      shadowCamera.far = dist + sz.length() / 2 + 100;
      shadowCamera.position.copy(lightPos);
    } else {
      shadowCamera.left = -maxDim;
      shadowCamera.right = maxDim;
      shadowCamera.top = maxDim;
      shadowCamera.bottom = -maxDim;
      shadowCamera.near = 0.1;
      shadowCamera.far = maxDim * 4 + sz.y + 100;
      shadowCamera.position.set(ctr.x, box.max.y + maxDim * 2, ctr.z);
    }
    shadowCamera.lookAt(ctr);
    shadowCamera.updateMatrixWorld();
    shadowCamera.updateProjectionMatrix();
    shadowMatrix.multiplyMatrices(shadowBiasMatrix, shadowCamera.projectionMatrix);
    shadowMatrix.multiplyMatrices(shadowMatrix, shadowCamera.matrixWorldInverse);
    shadowMaterial.uniforms.uNear.value = shadowCamera.near;
    shadowMaterial.uniforms.uFar.value = shadowCamera.far;
    // [FIX v1.6.6] ライトの向き(影を落とす方向)とシャドウマップ1テクセルが表すワールド上の実寸を計算。
    //   これをシェーダー側のスロープスケールバイアス/PCFサンプリング半径に使う。
    shadowCamera.getWorldDirection(_shadowLightDirTmp);
    shadowUniforms.shadowLightDir.value.copy(_shadowLightDirTmp);
    shadowUniforms.shadowTexelSize.value = (shadowCamera.right - shadowCamera.left) / shadowMapSize;
    const hiddenObjs = [];
    for (const o of objects.values()) { if (o.userData.passThrough) { hiddenObjs.push(o); o.visible = false; } }
    for (const [lightName] of lights) { const src = objects.get(lightName); if (src && src.visible) { hiddenObjs.push(src); src.visible = false; } }
    const skyVis = skyDome ? skyDome.visible : null;
    if (skyDome) skyDome.visible = false;
    const oldOverride = scene.overrideMaterial;
    const oldT = glRenderer.getRenderTarget();
    scene.overrideMaterial = shadowMaterial;
    glRenderer.setRenderTarget(shadowTarget);
    glRenderer.clear();
    glRenderer.render(scene, shadowCamera);
    scene.overrideMaterial = oldOverride;
    glRenderer.setRenderTarget(oldT);
    hiddenObjs.forEach(o => o.visible = true);
    if (skyDome) skyDome.visible = skyVis;
  };
  // [FIX v1.6.9] scene.overrideMaterial は全オブジェクトの描画に同じ shadowMaterial インスタンスを
  //   使い回すため、メッシュごとに違うテクスチャ/alphaTestを渡す必要がある。
  //   Object3D.onBeforeRender は各メッシュの描画直前に呼ばれ、その時点で実際に使われる material
  //   (overrideMaterial適用時はshadowMaterialそのもの)を受け取れるので、それが shadowMaterial の
  //   場合(=影の深度パス中)だけ、このメッシュ自身の本来のmap/alphaTestを uMap/uAlphaTest に反映する。
  //   通常のカラーパス(material !== shadowMaterial)では何もしないので、他の描画には影響しない。
  const attachDepthMapSync = mesh => {
    mesh.onBeforeRender = (r, s, c, geometry, material) => {
      if (material !== shadowMaterial) return;
      const own = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const tex = own && own.map ? own.map : null;
      shadowMaterial.uniforms.uMap.value = tex;
      shadowMaterial.uniforms.uUseMap.value = tex ? 1 : 0;
      shadowMaterial.uniforms.uAlphaTest.value = (own && tex) ? own.alphaTest : 0;
    };
  };
  const patchShadowShader = (material) => {
    if (Array.isArray(material)) { material.forEach(m => patchShadowShader(m)); return; }
    if (!material || patchedMaterials.has(material)) return;
    patchedMaterials.add(material);
    const origOnBeforeCompile = material.onBeforeCompile;
    material.onBeforeCompile = (shader) => {
      if (origOnBeforeCompile) origOnBeforeCompile(shader);
      shader.uniforms.shadowMap = shadowUniforms.shadowMap;
      shader.uniforms.shadowMatrix = shadowUniforms.shadowMatrix;
      shader.uniforms.shadowsEnabled = shadowUniforms.shadowsEnabled;
      shader.uniforms.shadowLightDir = shadowUniforms.shadowLightDir;
      shader.uniforms.shadowTexelSize = shadowUniforms.shadowTexelSize;

      // [FIX v1.6.6] ワールド法線(vWorldNormal)を追加で渡す。
      //   これが無いと「面が光にほぼ平行(壁など)」な場所でバイアスが一律になり、
      //   ギザギザのシャドウアクネ(画像内の稲妻状の影)が発生していた。
      shader.vertexShader = "varying vec3 vWorldPos;\nvarying vec3 vWorldNormal;\n" + shader.vertexShader;
      // 注意: three.jsの標準チャンク順序は #include<beginnormal_vertex> → #include<begin_vertex> の順で、
      // どちらも void main(){...} の内側にある(#include<common> はmain()の外なので文を置けない)。
      // 法線チャンクを持たないマテリアル(MeshBasicMaterial等)向けに、無い場合だけbegin_vertex側で既定値を入れる。
      const hasNormalChunk = shader.vertexShader.includes("#include <beginnormal_vertex>");
      shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n  vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;" + (hasNormalChunk ? "" : "\n  vWorldNormal = vec3(0.0, 1.0, 0.0);"));
      if (hasNormalChunk) {
        shader.vertexShader = shader.vertexShader.replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\n  vWorldNormal = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);");
      }

      shader.fragmentShader = [
        "varying vec3 vWorldPos;",
        "varying vec3 vWorldNormal;",
        "uniform sampler2D shadowMap;",
        "uniform mat4 shadowMatrix;",
        "uniform float shadowsEnabled;",
        "uniform vec3 shadowLightDir;",
        "uniform float shadowTexelSize;",
        shader.fragmentShader
      ].join("\n");

      // 16方向のポアソンディスクオフセット。配列コンストラクタ(GLSL ES 3.00以降のみ)や
      // 動的配列インデックスに依存すると環境によってコンパイルできない/遅いため、
      // for文を使わず16サンプル分を展開(unroll)して確実に動くようにしている。
      // フラグメントごとにこの円を回転させることで、固定グリッドPCFで出ていた
      // 「格子状・一直線状」のアーティファクトを消し、影の濃淡の段階数も実質連続に近づける。
      const poissonDisk = [
        [-0.94201624, -0.39906216], [0.94558609, -0.76890725],
        [-0.09418410, -0.92938870], [0.34495938, 0.29387760],
        [-0.91588581, 0.45771432], [-0.81544232, -0.87912464],
        [-0.38277543, 0.27676845], [0.97484398, 0.75648379],
        [0.44323325, -0.97511554], [0.53742981, -0.47373420],
        [-0.26496911, -0.41893023], [0.79197514, 0.19090188],
        [-0.24188840, 0.99706507], [-0.81409955, 0.91437590],
        [0.19984126, 0.78641367], [0.14383161, -0.14100790]
      ];
      const sampleLines = poissonDisk.map(([x, y]) =>
        `      { vec2 sOff = sRot * vec2(${x}, ${y}) * sRadius; float sDepth = texture2D(shadowMap, sCoord.xy + sOff).r; float sDiff = sCoord.z - sDepth - sDepthBias; shadow += smoothstep(0.0, shadowTexelSize * 4.0, sDiff); }`
      ).join("\n");

      shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", [
        "#include <color_fragment>",
        "  if (shadowsEnabled > 0.5) {",
        "    vec3 sNormal = normalize(vWorldNormal);",
        // ライトに正対しているほどバイアスを小さく、かすめる角度(壁など)ほど大きくする
        // スロープスケールバイアス。固定バイアスだけだと、正対面では浮き影(ボックス背後の不自然な隙間)、
        // かすめ面ではアクネ(画像内の壁の稲妻状の影)のどちらかしか解消できなかった。
        "    float sNdotL = clamp(dot(sNormal, -normalize(shadowLightDir)), 0.0, 1.0);",
        "    float sSlope = clamp(1.0 - sNdotL, 0.0, 1.0);",
        "    float sNormalBias = shadowTexelSize * (1.0 + sSlope * 6.0);",
        "    float sDepthBias = mix(0.0006, 0.006, sSlope);",
        "    vec3 sOffsetPos = vWorldPos + sNormal * sNormalBias;",
        "    vec4 sCoord = shadowMatrix * vec4(sOffsetPos, 1.0);",
        "    sCoord.xyz /= sCoord.w;",
        "    if (sCoord.x >= 0.0 && sCoord.x <= 1.0 && sCoord.y >= 0.0 && sCoord.y <= 1.0 && sCoord.z >= 0.0 && sCoord.z <= 1.0) {",
        // フラグメント位置から疑似乱数角度を作り、サンプル円を回転(=ディザリング)。バンディングや
        // 目に見える一直線パターンを消し、なだらかな半影(ペナンブラ)にする。
        "      float sAngle = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.28318530718;",
        "      float sCa = cos(sAngle), sSa = sin(sAngle);",
        "      mat2 sRot = mat2(sCa, -sSa, sSa, sCa);",
        // [FIX v1.6.8] shadowTexelSize はワールド空間の1テクセルの実寸(バイアス計算用)だが、
        // ここでの sOff は shadowMap の「UV空間(0〜1)」上のオフセットとして sCoord.xy に加算される。
        // 単位が違う値をそのまま使っていたため、シーン全体(全オブジェクト)のバウンディングボックスから
        // 求めた frust が大きいシーンほど shadowTexelSize(ワールド単位)が大きくなり、
        // UVオフセットとして解釈すると数百px規模のとても広い範囲をサンプリングしてしまっていた。
        // 大きな低ポリオブジェクト(壁など)は影の範囲が広いため誤差が目立たないが、
        // 小さく丸みのある(面が多い＝滑らかな曲面の)オブジェクトは影の範囲がその誤ったサンプル半径より
        // 小さいため、無関係な(影になっていない)テクセルばかり平均されて影がほぼ消えてしまっていた。
        // → shadowMap解像度(shadowMapSize)を基準にした「UV空間の1テクセル分」を使うよう修正。
        `      float sRadius = (1.0 / ${shadowMapSize.toFixed(1)}) * 3.0;`,
        "      float shadow = 0.0;",
        // 二値比較ではなくsmoothstepで各サンプルを連続値化 → 影の濃淡段階が16サンプル×連続値でなめらかに
        sampleLines,
        "      shadow /= 16.0;",
        "      diffuseColor.rgb *= 1.0 - shadow * 0.65;",
        "    }",
        "  }"
      ].join("\n"));
    };
    material.needsUpdate = true;
  };
  function updatePhysics(delta) {
    if (delta <= 0) return;
    for (const moving of objects.values()) {
      if (!moving.userData.physics) continue;
      const u = moving.userData;

      // --- 自由落下(重力はYのみに作用するが、X/Zの速度があればそちらにも動く) ---
      u.velocityY = (u.velocityY || 0) + GRAVITY * delta;
      moving.position.x += (u.velocityX || 0) * delta;
      moving.position.y += u.velocityY * delta;
      moving.position.z += (u.velocityZ || 0) * delta;

      // --- 角速度による自然な傾き/転がり(見た目の演出。空気抵抗で徐々に収まる) ---
      const avx = u.angularVelocityX || 0, avy = u.angularVelocityY || 0, avz = u.angularVelocityZ || 0;
      if (avx || avy || avz) {
        if (avx) { _deltaQuat.setFromAxisAngle(_localAxisX, avx * delta); moving.quaternion.premultiply(_deltaQuat); }
        if (avy) { _deltaQuat.setFromAxisAngle(_localAxisY, avy * delta); moving.quaternion.premultiply(_deltaQuat); }
        if (avz) { _deltaQuat.setFromAxisAngle(_localAxisZ, avz * delta); moving.quaternion.premultiply(_deltaQuat); }
        moving.rotation.setFromQuaternion(moving.quaternion);
        const damp = Math.pow(ANGULAR_DAMPING, delta * 60);
        const navx = avx * damp, navy = avy * damp, navz = avz * damp;
        u.angularVelocityX = Math.abs(navx) < REST_ANGULAR_SPEED ? 0 : navx;
        u.angularVelocityY = Math.abs(navy) < REST_ANGULAR_SPEED ? 0 : navy;
        u.angularVelocityZ = Math.abs(navz) < REST_ANGULAR_SPEED ? 0 : navz;
      }

      if (moving.userData.passThrough) continue;
      let movingBox = box(moving);
      for (const other of objects.values()) {
        if (other === moving || other.userData.passThrough) continue;
        const otherBox = box(other);
        if (!movingBox.intersectsBox(otherBox)) continue;

        // [FIX v1.6.11] 「触れた瞬間に相手の真上へワープする」不自然な重力を廃止。
        // 3軸それぞれのめり込み量(overlap)を比較し、最も浅い軸を衝突面とみなす標準的なMTV法で
        // "めり込んだ分だけ" 押し戻す(＝ワープではなく実際に接触した位置に留める)。
        // さらに速度を0にして止めるのではなく反発係数(RESTITUTION)で跳ね返し、摩擦(GROUND_FRICTION)で
        // 水平方向の勢いを減衰させ、着地の勢いを回転(TUMBLE_FACTOR)に変換することで、
        // 「自然に落下→バウンドしながら傾いて→やがて静止する」重力らしい挙動にする。
        const overlapX = Math.min(movingBox.max.x - otherBox.min.x, otherBox.max.x - movingBox.min.x);
        const overlapY = Math.min(movingBox.max.y - otherBox.min.y, otherBox.max.y - movingBox.min.y);
        const overlapZ = Math.min(movingBox.max.z - otherBox.min.z, otherBox.max.z - movingBox.min.z);
        const overlaps = [overlapX, overlapY, overlapZ];
        const axis = overlaps.indexOf(Math.min(overlapX, overlapY, overlapZ));
        if (overlaps[axis] <= 1e-7) continue;
        const key = ["x", "y", "z"][axis];

        const movingCenter = movingBox.getCenter(_physicsCenterA);
        const otherCenter = otherBox.getCenter(_physicsCenterB);
        const direction = movingCenter[key] >= otherCenter[key] ? 1 : -1;

        // めり込んだ分だけ押し戻す(実測のめり込み量ぶんの最小移動。相手の上面へのワープはしない)
        moving.position[key] += direction * (overlaps[axis] + 1e-5);

        const velKey = "velocity" + key.toUpperCase();
        const v = u[velKey] || 0;
        // 衝突面へ向かっていた速度成分だけを反発させる(既に離れる向きに動いていれば何もしない)
        if (v * direction < 0) {
          const bounced = -v * RESTITUTION;
          u[velKey] = Math.abs(bounced) < REST_LINEAR_SPEED ? 0 : bounced;

          if (key === "y" && direction > 0) {
            // 物の上に着地したケース: 摩擦で水平速度を減衰させ、その勢いを回転(傾き)に変換する
            u.velocityX = (u.velocityX || 0) * GROUND_FRICTION;
            u.velocityZ = (u.velocityZ || 0) * GROUND_FRICTION;
            u.angularVelocityZ = (u.angularVelocityZ || 0) - u.velocityX * TUMBLE_FACTOR;
            u.angularVelocityX = (u.angularVelocityX || 0) + u.velocityZ * TUMBLE_FACTOR;
          } else if (key !== "y") {
            // 側面(壁や他のオブジェクトの横)にぶつかったケース: 少し傾ける演出
            u.angularVelocityY = (u.angularVelocityY || 0) + v * TUMBLE_FACTOR * 0.5;
          }
        }
        movingBox = box(moving);
      }
    }
  }

  function startRenderLoop() {
    if (loopRunning) return;
    loopRunning = true;
    renderLoop();
  }

  function renderLoop() {
    if (!loopRunning) return;
    frame = requestAnimationFrame(renderLoop);
    if (!drawing) return;
    if (contextLost) return;
    const delta = Math.min(_physicsClock.getDelta(), 0.05);
    updatePhysics(delta);
    shadowUniforms.shadowsEnabled.value = shadowsEnabled ? 1.0 : 0.0;
    if (shadowsEnabled && ++shadowUpdateCounter >= 3) { shadowUpdateCounter = 0; updateShadowMap(); }
    for (const o of objects.values()) if (o.userData.animationMixer) o.userData.animationMixer.update(delta);
    const size = renderer.getNativeSize();
    if (canvas.width !== size[0] || canvas.height !== size[1]) {
      glRenderer.setSize(size[0], size[1], false);
      camera.aspect = size[0] / size[1]; camera.updateProjectionMatrix();
      const skin = renderer._allSkins[skinId];
      if (skin) { skin._nativeSize = size; skin._rotationCenter = [size[0]/2,size[1]/2]; }
    }
    if (cameraObject && objects.has(cameraObject)) {
      const sourceObject = objects.get(cameraObject);
      sourceObject.getWorldPosition(camera.position);
      sourceObject.getWorldQuaternion(camera.quaternion);
    }
    if (skyDome) skyDome.position.copy(camera.position);
    for (const [lightName, light] of lights) {
      const sourceObject = objects.get(lightName);
      if (sourceObject) syncLight(sourceObject, light);
    }
    for (const o of objects.values()){const t=o.userData.materialTexture;if(t&&t.userData&&t.userData.tile){const s=o.scale;if(o.userData.lastTileX!==s.x||o.userData.lastTileY!==s.y||o.userData.lastTileZ!==s.z){updateTilingRepeat(o);o.userData.lastTileX=s.x;o.userData.lastTileY=s.y;o.userData.lastTileZ=s.z;}}}
    glRenderer.render(scene, camera);
    const skin = renderer._allSkins[skinId];
    if (skin) skin.update();
    runtime.requestRedraw();
  }
  startRenderLoop();

  class BackLayer3D {
    getInfo() {
      const S = ArgumentType.STRING, N = ArgumentType.NUMBER, C = ArgumentType.COLOR;
      const onoff = {acceptReporters:true, items:["on","off"]};
      const lighttype = {acceptReporters:true, items:["全体","向いてる方向"]};
      const materials = {acceptReporters:true, items:"getMaterialMenu"};
      const materialLoadMethod = {acceptReporters:true, items:["事前に素材の画像をダウンロードする","毎回urlから読み込む"]};
      return {id:"backlayer3d", name:"BackLayer 3D", color1:"#5B5FEF", color2:"#4549C4", blocks:[
        {opcode:"reset", blockType:BlockType.COMMAND, text:"reset all"},
        {opcode:"create", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] を作成する", arguments:{NAME:{type:S,defaultValue:"box"}}},
        {opcode:"textureCostume", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] のテクスチャを [COSTUME] に設定する", arguments:{NAME:{type:S,defaultValue:"box"},COSTUME:{type:S,defaultValue:"costume1"}}},
        {opcode:"textureURL", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] のテクスチャをURL [URL] から読み込む", arguments:{NAME:{type:S,defaultValue:"box"},URL:{type:S,defaultValue:"https://example.com/test.png"}}},
        {opcode:"setObjectMaterial", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の素材を [MATERIAL] にする", arguments:{NAME:{type:S,defaultValue:"box"},MATERIAL:{type:S,menu:"materials"}}},
        {opcode:"removeTexture", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] のテクスチャを削除する", arguments:{NAME:{type:S,defaultValue:"box"}}},
        {opcode:"setMaterialURL", blockType:BlockType.COMMAND, text:"素材のurlを [URL] に設定する", arguments:{URL:{type:S,defaultValue:"https://data.nofileteams.com/templeate/"}}},
        {opcode:"setMaterialLoadMethod", blockType:BlockType.COMMAND, text:"素材の読み込み方法を [METHOD] に設定する", arguments:{METHOD:{type:S,menu:"materialLoadMethod"}}},
        {opcode:"loadMaterials", blockType:BlockType.COMMAND, text:"素材を読み込むまたはアップデートする"},
        {opcode:"modelOBJList", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] のobjモデルをリスト [LIST] に設定する", arguments:{NAME:{type:S,defaultValue:"box"},LIST:{type:S,defaultValue:"list1"}}},
        {opcode:"modelGLTFList", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の(gltf/glb)モデルをリスト [LIST] に設定する", arguments:{NAME:{type:S,defaultValue:"box"},LIST:{type:S,defaultValue:"list1"}}},
        {opcode:"playAnimation", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] にアニメーション [ANIMATION] を再生する", arguments:{NAME:{type:S,defaultValue:"box"},ANIMATION:{type:S,defaultValue:"Animation"}}},
        {opcode:"playAnimationUntilDone", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] にアニメーション [ANIMATION] を終わるまで再生する", arguments:{NAME:{type:S,defaultValue:"box"},ANIMATION:{type:S,defaultValue:"Animation"}}},
        {opcode:"remove", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] を削除する", arguments:{NAME:{type:S,defaultValue:"box"}}},
        "---",
        {opcode:"setPosition", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の位置を x [X] y [Y] z [Z] に設定する", arguments:{NAME:{type:S,defaultValue:"box"},X:{type:N,defaultValue:0},Y:{type:N,defaultValue:0},Z:{type:N,defaultValue:0}}},
        {opcode:"setPositionX", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の位置を x [VALUE] に設定する", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:0}}},
        {opcode:"setPositionY", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の位置を y [VALUE] に設定する", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:0}}},
        {opcode:"setPositionZ", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の位置を z [VALUE] に設定する", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:0}}},
        {opcode:"changePositionX", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の位置を x [VALUE] ずつ変える", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:1}}},
        {opcode:"changePositionY", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の位置を y [VALUE] ずつ変える", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:1}}},
        {opcode:"changePositionZ", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の位置を z [VALUE] ずつ変える", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:1}}},
        {opcode:"setRotation", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の向きを x [X] y [Y] z [Z] に設定する", arguments:{NAME:{type:S,defaultValue:"box"},X:{type:N,defaultValue:0},Y:{type:N,defaultValue:0},Z:{type:N,defaultValue:0}}},
        {opcode:"setRotationX", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の向きを x [VALUE] に設定する", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:0}}},
        {opcode:"setRotationY", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の向きを y [VALUE] に設定する", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:0}}},
        {opcode:"setRotationZ", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の向きを z [VALUE] に設定する", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:0}}},
        {opcode:"changeRotationX", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の向きを x [VALUE] ずつ変える", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:1}}},
        {opcode:"changeRotationY", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の向きを y [VALUE] ずつ変える", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:1}}},
        {opcode:"changeRotationZ", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の向きを z [VALUE] ずつ変える", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:1}}},
        {opcode:"changeRotationXWorld", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の向きを x [VALUE] ずつ変える しかしオブジェクトが向いてる方向ではない", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:1}}},
        {opcode:"changeRotationYWorld", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の向きを y [VALUE] ずつ変える しかしオブジェクトが向いてる方向ではない", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:1}}},
        {opcode:"changeRotationZWorld", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の向きを z [VALUE] ずつ変える しかしオブジェクトが向いてる方向ではない", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:1}}},
        {opcode:"setScale", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の大きさを x [X] y [Y] z [Z] に設定する", arguments:{NAME:{type:S,defaultValue:"box"},X:{type:N,defaultValue:100},Y:{type:N,defaultValue:100},Z:{type:N,defaultValue:100}}},
        {opcode:"setScaleX", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の大きさを x [VALUE] に設定する", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:100}}},
        {opcode:"setScaleY", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の大きさを y [VALUE] に設定する", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:100}}},
        {opcode:"setScaleZ", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の大きさを z [VALUE] に設定する", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:100}}},
        {opcode:"changeScaleX", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の大きさを x [VALUE] ずつ変える", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:10}}},
        {opcode:"changeScaleY", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の大きさを y [VALUE] ずつ変える", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:10}}},
        {opcode:"changeScaleZ", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の大きさを z [VALUE] ずつ変える", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:10}}},
        {opcode:"moveSteps", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] を [STEPS] 歩動かす", arguments:{NAME:{type:S,defaultValue:"box"},STEPS:{type:N,defaultValue:10}}},
        {opcode:"moveToward", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] を x [X] y [Y] z [Z] に向かって [STEPS] 歩動かす", arguments:{NAME:{type:S,defaultValue:"box"},X:{type:N,defaultValue:0},Y:{type:N,defaultValue:0},Z:{type:N,defaultValue:0},STEPS:{type:N,defaultValue:10}}},
        {opcode:"pointObject", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の向きをオブジェクト [TARGET] に向ける", arguments:{NAME:{type:S,defaultValue:"box"},TARGET:{type:S,defaultValue:"target"}}},
        {opcode:"pointXYZ", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の向きを x [X] y [Y] z [Z] に向ける", arguments:{NAME:{type:S,defaultValue:"box"},X:{type:N,defaultValue:0},Y:{type:N,defaultValue:0},Z:{type:N,defaultValue:0}}},
        {opcode:"glide", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] を [SECONDS] 秒で x [X] y [Y] z [Z] に変える", arguments:{NAME:{type:S,defaultValue:"box"},SECONDS:{type:N,defaultValue:1},X:{type:N,defaultValue:0},Y:{type:N,defaultValue:0},Z:{type:N,defaultValue:0}}},
        "---",
        {opcode:"useCamera", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] を視点カメラに", arguments:{NAME:{type:S,defaultValue:"box"}}},
        {opcode:"setColor", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の色を [COLOR] に設定する", arguments:{NAME:{type:S,defaultValue:"box"},COLOR:{type:C,defaultValue:"#ffffff"}}},
        {opcode:"setOpacity", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の透明度を [VALUE] % にする", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:0}}},
        {opcode:"setPassThrough", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の貫通を [STATE] にする", arguments:{NAME:{type:S,defaultValue:"box"},STATE:{type:S,menu:"onoff"}}},
        {opcode:"setPhysics", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] のphysicsを [STATE] にする", arguments:{NAME:{type:S,defaultValue:"box"},STATE:{type:S,menu:"onoff"}}},
        {opcode:"bounce", blockType:BlockType.COMMAND, text:"もしオブジェクト [NAME] が他のオブジェクトに触れたら跳ね返る", arguments:{NAME:{type:S,defaultValue:"box"}}},
        {opcode:"isTouching", blockType:BlockType.BOOLEAN, text:"オブジェクト [NAME] がオブジェクト [TARGET] に触れた", arguments:{NAME:{type:S,defaultValue:"box"},TARGET:{type:S,defaultValue:"target"}}},
        {opcode:"objectExists", blockType:BlockType.BOOLEAN, text:"オブジェクト [NAME] が存在する？", arguments:{NAME:{type:S,defaultValue:"box"}}},
        "---",
        {opcode:"start", blockType:BlockType.COMMAND, text:"描画を開始する"},
        {opcode:"stop", blockType:BlockType.COMMAND, text:"描画を止める"},
        {opcode:"isDrawing", blockType:BlockType.BOOLEAN, text:"今は描画中？"},
        {opcode:"setFogDistance", blockType:BlockType.COMMAND, text:"fogの距離を [VALUE] にする", arguments:{VALUE:{type:N,defaultValue:100}}},
        {opcode:"setFogColor", blockType:BlockType.COMMAND, text:"fogの色を [COLOR] にする", arguments:{COLOR:{type:C,defaultValue:"#ffffff"}}},
        {opcode:"changeFogColor", blockType:BlockType.COMMAND, text:"fogの色を [VALUE] ずつ変える", arguments:{VALUE:{type:N,defaultValue:10}}},
        {opcode:"changeFogBrightness", blockType:BlockType.COMMAND, text:"fogの明るさを [VALUE] ずつ変える", arguments:{VALUE:{type:N,defaultValue:1}}},
        {opcode:"setFog", blockType:BlockType.COMMAND, text:"fogを [STATE] にする", arguments:{STATE:{type:S,menu:"onoff"}}},
        {opcode:"setWorldBrightness", blockType:BlockType.COMMAND, text:"世界の明るさを [VALUE] にする", arguments:{VALUE:{type:N,defaultValue:5}}},
        {opcode:"changeWorldBrightness", blockType:BlockType.COMMAND, text:"世界の明るさを [VALUE] ずつ変える", arguments:{VALUE:{type:N,defaultValue:1}}},
        {opcode:"setShadows", blockType:BlockType.COMMAND, text:"影を [STATE] にする", arguments:{STATE:{type:S,menu:"onoff",defaultValue:"off"}}},
        "---",
        {opcode:"setLight", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] を光源にする [STATE]", arguments:{NAME:{type:S,defaultValue:"light"},STATE:{type:S,menu:"onoff"}}},
        {opcode:"setLightIntensity", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の光の強さを [VALUE] に設定する", arguments:{NAME:{type:S,defaultValue:"light"},VALUE:{type:N,defaultValue:10}}},
        {opcode:"setLightColor", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の光の色を [COLOR] に設定する", arguments:{NAME:{type:S,defaultValue:"light"},COLOR:{type:C,defaultValue:"#ffffff"}}},
        {opcode:"setLightType", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の光タイプを [TYPE] に設定する", arguments:{NAME:{type:S,defaultValue:"light"},TYPE:{type:S,menu:"lighttype"}}},
        {opcode:"setSkyCostume", blockType:BlockType.COMMAND, text:"空を [COSTUME] に設定する", arguments:{COSTUME:{type:S,defaultValue:"costume1"}}},
        {opcode:"changeSkyColor", blockType:BlockType.COMMAND, text:"空の色の効果を [VALUE] ずつ変える", arguments:{VALUE:{type:N,defaultValue:1}}},
        {opcode:"changeSkyBrightness", blockType:BlockType.COMMAND, text:"空の明るさの効果を [VALUE] ずつ変える", arguments:{VALUE:{type:N,defaultValue:1}}},
        {opcode:"setSkyColorEffect", blockType:BlockType.COMMAND, text:"空の色の効果を [VALUE] にする", arguments:{VALUE:{type:N,defaultValue:0}}},
        {opcode:"setSkyBrightnessEffect", blockType:BlockType.COMMAND, text:"空の明るさの効果を [VALUE] にする", arguments:{VALUE:{type:N,defaultValue:0}}},
        {opcode:"setReflectivity", blockType:BlockType.COMMAND, text:"オブジェクト [NAME] の反射の強さを [VALUE] に設定する", arguments:{NAME:{type:S,defaultValue:"box"},VALUE:{type:N,defaultValue:1}}},
        "---",
        {opcode:"getPositionX", blockType:BlockType.REPORTER, text:"オブジェクト [NAME] の x の位置", arguments:{NAME:{type:S,defaultValue:"box"}}},
        {opcode:"getPositionY", blockType:BlockType.REPORTER, text:"オブジェクト [NAME] の y の位置", arguments:{NAME:{type:S,defaultValue:"box"}}},
        {opcode:"getPositionZ", blockType:BlockType.REPORTER, text:"オブジェクト [NAME] の z の位置", arguments:{NAME:{type:S,defaultValue:"box"}}},
        {opcode:"getRotationX", blockType:BlockType.REPORTER, text:"オブジェクト [NAME] の x の向き", arguments:{NAME:{type:S,defaultValue:"box"}}},
        {opcode:"getRotationY", blockType:BlockType.REPORTER, text:"オブジェクト [NAME] の y の向き", arguments:{NAME:{type:S,defaultValue:"box"}}},
        {opcode:"getRotationZ", blockType:BlockType.REPORTER, text:"オブジェクト [NAME] の z の向き", arguments:{NAME:{type:S,defaultValue:"box"}}},
        {opcode:"getScaleX", blockType:BlockType.REPORTER, text:"オブジェクト [NAME] の x の大きさ", arguments:{NAME:{type:S,defaultValue:"box"}}},
        {opcode:"getScaleY", blockType:BlockType.REPORTER, text:"オブジェクト [NAME] の y の大きさ", arguments:{NAME:{type:S,defaultValue:"box"}}},
        {opcode:"getScaleZ", blockType:BlockType.REPORTER, text:"オブジェクト [NAME] の z の大きさ", arguments:{NAME:{type:S,defaultValue:"box"}}},
        {opcode:"distance", blockType:BlockType.REPORTER, text:"オブジェクト [NAME] からオブジェクト [TARGET] までの距離", arguments:{NAME:{type:S,defaultValue:"box"},TARGET:{type:S,defaultValue:"target"}}}
      ], menus:{axis:{acceptReporters:true,items:["x","y","z"]},onoff,lighttype,materials,materialLoadMethod}};
    }

    reset(){ for(const o of objects.values()){scene.remove(o);disposeObject(o);} objects.clear(); for(const l of lights.values())removeLight(l); lights.clear(); reflectiveMaterials.clear(); if(skyDome){scene.remove(skyDome);disposeObject(skyDome);skyDome=null;skyTexture=null;} cameraObject=null; camera.position.set(0,0,10); camera.rotation.set(0,0,0); shadowsEnabled=false; }
    getMaterialMenu(){return materialNames.length ? materialNames : ["(素材なし)"];}
    create(a){makeObject(name(a.NAME));}
    async setMaterialURL(a){materialBaseURL=normalizeBaseURL(a.URL);await refreshMaterialList();if(runtime.extensionManager&&runtime.extensionManager.refreshBlocks)runtime.extensionManager.refreshBlocks();}
    async setObjectMaterial(a){const o=object(a.NAME),material=name(a.MATERIAL);if(!o||!materialNames.includes(material))return;let texture;if(materialLoadMethod==="事前に素材の画像をダウンロードする"){let blob=await getCachedBlob(material);if(!blob){const url=materialBaseURL+encodeURIComponent(material)+".png";if(await Scratch.canFetch(url)){const response=await Scratch.fetch(url);if(response.ok){blob=await response.blob();await setCachedBlob(material,blob);}}}if(!blob)return;texture=await blobToTexture(blob);}else{texture=await loadTextureFromURL(materialBaseURL+encodeURIComponent(material)+".png");}if(!texture)return;markTiling(texture);o.userData.materialTexture=texture;applyPreferredTexture(o);updateTilingRepeat(o);}
    async setMaterialLoadMethod(a){materialLoadMethod=name(a.METHOD);if(materialLoadMethod==="事前に素材の画像をダウンロードする")await preloadAllMaterials();}
    async loadMaterials(){await refreshMaterialList();if(runtime.extensionManager&&runtime.extensionManager.refreshBlocks)runtime.extensionManager.refreshBlocks();}
    removeTexture(a){const o=object(a.NAME);if(!o)return;const texture=o.userData.textureOverride;o.userData.textureOverride=null;applyPreferredTexture(o);if(texture&&texture!==o.userData.materialTexture)texture.dispose();}
    remove(a){const n=name(a.NAME),o=objects.get(n);if(o){scene.remove(o);disposeObject(o);objects.delete(n);} const l=lights.get(n);if(l){removeLight(l);lights.delete(n);}}
    setPosition(a){const o=object(a.NAME);if(o)o.position.set(num(a.X),num(a.Y),num(a.Z));}
    setPositionX(a){const o=object(a.NAME);if(o)o.position.x=num(a.VALUE);}
    setPositionY(a){const o=object(a.NAME);if(o)o.position.y=num(a.VALUE);}
    setPositionZ(a){const o=object(a.NAME);if(o)o.position.z=num(a.VALUE);}
    changePositionX(a){const o=object(a.NAME);if(o)o.position.x+=num(a.VALUE);}
    changePositionY(a){const o=object(a.NAME);if(o)o.position.y+=num(a.VALUE);}
    changePositionZ(a){const o=object(a.NAME);if(o)o.position.z+=num(a.VALUE);}
    setRotation(a){const o=object(a.NAME);if(o)o.rotation.set(THREE.MathUtils.degToRad(num(a.X)),THREE.MathUtils.degToRad(num(a.Y)),THREE.MathUtils.degToRad(num(a.Z)));}
    setRotationX(a){const o=object(a.NAME);if(o)o.rotation.x=THREE.MathUtils.degToRad(num(a.VALUE));}
    setRotationY(a){const o=object(a.NAME);if(o)o.rotation.y=THREE.MathUtils.degToRad(num(a.VALUE));}
    setRotationZ(a){const o=object(a.NAME);if(o)o.rotation.z=THREE.MathUtils.degToRad(num(a.VALUE));}
    // [FIX v1.2.1] ローカル軸回転: オブジェクトの向き基準で回転する
    //   Before: o.rotation.x += deg (ワールド軸の Euler 回転 → オブジェクトが向いてる方向と無関係)
    //   After:  quaternion.multiply(deltaQuat on local axis) → オブジェクトのローカル軸で回転
    changeRotationX(a){const o=object(a.NAME);if(o){_deltaQuat.setFromAxisAngle(_localAxisX,THREE.MathUtils.degToRad(num(a.VALUE)));o.quaternion.multiply(_deltaQuat);o.rotation.setFromQuaternion(o.quaternion);}}
    changeRotationY(a){const o=object(a.NAME);if(o){_deltaQuat.setFromAxisAngle(_localAxisY,THREE.MathUtils.degToRad(num(a.VALUE)));o.quaternion.multiply(_deltaQuat);o.rotation.setFromQuaternion(o.quaternion);}}
    changeRotationZ(a){const o=object(a.NAME);if(o){_deltaQuat.setFromAxisAngle(_localAxisZ,THREE.MathUtils.degToRad(num(a.VALUE)));o.quaternion.multiply(_deltaQuat);o.rotation.setFromQuaternion(o.quaternion);}}
    // ワールド軸回転（オブジェクト自身の向きに影響されない）
    changeRotationXWorld(a){const o=object(a.NAME);if(o){_deltaQuat.setFromAxisAngle(_localAxisX,THREE.MathUtils.degToRad(num(a.VALUE)));o.quaternion.premultiply(_deltaQuat);o.rotation.setFromQuaternion(o.quaternion);}}
    changeRotationYWorld(a){const o=object(a.NAME);if(o){_deltaQuat.setFromAxisAngle(_localAxisY,THREE.MathUtils.degToRad(num(a.VALUE)));o.quaternion.premultiply(_deltaQuat);o.rotation.setFromQuaternion(o.quaternion);}}
    changeRotationZWorld(a){const o=object(a.NAME);if(o){_deltaQuat.setFromAxisAngle(_localAxisZ,THREE.MathUtils.degToRad(num(a.VALUE)));o.quaternion.premultiply(_deltaQuat);o.rotation.setFromQuaternion(o.quaternion);}}
    setScale(a){const o=object(a.NAME);if(o)o.scale.set(num(a.X)/100,num(a.Y)/100,num(a.Z)/100);}
    setScaleX(a){const o=object(a.NAME);if(o)o.scale.x=num(a.VALUE)/100;}
    setScaleY(a){const o=object(a.NAME);if(o)o.scale.y=num(a.VALUE)/100;}
    setScaleZ(a){const o=object(a.NAME);if(o)o.scale.z=num(a.VALUE)/100;}
    changeScaleX(a){const o=object(a.NAME);if(o)o.scale.x+=num(a.VALUE)/100;}
    changeScaleY(a){const o=object(a.NAME);if(o)o.scale.y+=num(a.VALUE)/100;}
    changeScaleZ(a){const o=object(a.NAME);if(o)o.scale.z+=num(a.VALUE)/100;}
    moveSteps(a){const o=object(a.NAME);if(o){const d=new THREE.Vector3(0,0,-1).applyQuaternion(o.quaternion);o.position.addScaledVector(d,num(a.STEPS)/10);}}
    moveToward(a){const o=object(a.NAME);if(o){const d=new THREE.Vector3(num(a.X),num(a.Y),num(a.Z)).sub(o.position).normalize();o.position.addScaledVector(d,num(a.STEPS)/10);}}
    pointObject(a){const o=object(a.NAME),t=object(a.TARGET);if(o&&t)pointToward(o,t);}
    pointXYZ(a){const o=object(a.NAME);if(o)pointToward(o,new THREE.Vector3(num(a.X),num(a.Y),num(a.Z)));}
    glide(a,util){const o=object(a.NAME);if(!o)return;const seconds=Math.max(0,num(a.SECONDS));if(seconds===0){o.position.set(num(a.X),num(a.Y),num(a.Z));return;}if(!util.stackFrame.start){util.stackFrame.start=performance.now();util.stackFrame.from=o.position.clone();}const t=Math.min(1,(performance.now()-util.stackFrame.start)/(seconds*1000));o.position.lerpVectors(util.stackFrame.from,new THREE.Vector3(num(a.X),num(a.Y),num(a.Z)),t);if(t<1)util.yield();}
    useCamera(a){const n=name(a.NAME),o=objects.get(n);if(o){cameraObject=n;o.getWorldPosition(camera.position);o.getWorldQuaternion(camera.quaternion);}}
    setColor(a){const o=object(a.NAME);if(o)setMaterial(o,m=>m.color&&m.color.set(color(a.COLOR)));}
    setOpacity(a){const o=object(a.NAME),opacity=THREE.MathUtils.clamp(1-num(a.VALUE)/100,0,1);if(o)setMaterial(o,m=>{m.transparent=opacity<1;m.opacity=opacity;m.needsUpdate=true;});}
    setPassThrough(a){const o=object(a.NAME);if(o)o.userData.passThrough=name(a.STATE)==="on";}
    setPhysics(a){const o=object(a.NAME);if(o){o.userData.physics=name(a.STATE)==="on";if(!o.userData.physics){o.userData.velocityX=0;o.userData.velocityY=0;o.userData.velocityZ=0;o.userData.angularVelocityX=0;o.userData.angularVelocityY=0;o.userData.angularVelocityZ=0;}}}
    isTouching(a){return Boolean(touching(object(a.NAME),object(a.TARGET)));}
    objectExists(a){return objects.has(name(a.NAME));}
    bounce(a){
      const o=object(a.NAME); if(!o||o.userData.passThrough)return;
      for(const other of objects.values()){
        if(other===o||other.userData.passThrough)continue;
        const aBox=box(o),bBox=box(other); if(!aBox.intersectsBox(bBox))continue;
        const overlaps=[Math.min(aBox.max.x-bBox.min.x,bBox.max.x-aBox.min.x),Math.min(aBox.max.y-bBox.min.y,bBox.max.y-aBox.min.y),Math.min(aBox.max.z-bBox.min.z,bBox.max.z-aBox.min.z)];
        const axis=overlaps.indexOf(Math.min(...overlaps)); if(overlaps[axis]<=1e-7)continue;
        const centerA=aBox.getCenter(new THREE.Vector3()),centerB=bBox.getCenter(new THREE.Vector3());
        const key=["x","y","z"][axis],direction=centerA[key]>=centerB[key]?1:-1;
        o.position[key]+=direction*(overlaps[axis]+1e-5);
        o.userData["velocity"+key.toUpperCase()]=0;
      }
    }
    start(){drawing=true;}
    stop(){drawing=false;clearSkin();}
    isDrawing(){return drawing;}
    setFogDistance(a){fogDistance=num(a.VALUE);updateFog();}
    setFogColor(a){fogColor=color(a.COLOR);updateFog();}
    changeFogColor(a){fogHueEffect=(fogHueEffect+num(a.VALUE))%200;updateFog();}
    changeFogBrightness(a){fogBrightnessEffect=THREE.MathUtils.clamp(fogBrightnessEffect+num(a.VALUE),-100,100);updateFog();}
    setFog(a){fogEnabled=name(a.STATE)==="on";updateFog();}
    setWorldBrightness(a){worldBrightness=Math.max(0,num(a.VALUE));applySkyEffects();}
    changeWorldBrightness(a){worldBrightness=Math.max(0,worldBrightness+num(a.VALUE));applySkyEffects();}
    setShadows(a){shadowsEnabled=name(a.STATE)==="on";if(shadowsEnabled)updateShadowMap();}
    // [FIX v1.6.8] 一度光源をonにしたあとoffにし、再度onにすると光の強さ/色がデフォルト(10, 白)に
    // 戻ってしまう不具合を修正。原因は off で lights から light インスタンスごと削除してしまい、
    // 再度 on にするとき makeLight() に強さ/色を渡していなかったため常に既定値で作り直されていたこと。
    // → off にする前の強さ/色をオブジェクトの userData に保持しておき、再度 on にするときそれを使う。
    setLight(a){const n=name(a.NAME),o=objects.get(n);if(!o)return;if(name(a.STATE)==="on"){let l=lights.get(n);if(!l){l=makeLight(o.userData.lightType||"全体",o.userData.lightIntensity!=null?o.userData.lightIntensity:10,o.userData.lightColor!=null?o.userData.lightColor:0xffffff);lights.set(n,l);scene.add(l);}syncLight(o,l);}else{const l=lights.get(n);if(l){removeLight(l);lights.delete(n);}}}
    setLightIntensity(a){const n=name(a.NAME),o=objects.get(n);const v=num(a.VALUE);if(o)o.userData.lightIntensity=v;const l=lights.get(n);if(l)l.intensity=v;}
    setLightColor(a){const n=name(a.NAME),o=objects.get(n);const c=color(a.COLOR);if(o)o.userData.lightColor=c;const l=lights.get(n);if(l)l.color.set(c);}
    setLightType(a){const n=name(a.NAME),o=objects.get(n);if(!o)return;const type=name(a.TYPE)==="向いてる方向"?"向いてる方向":"全体";o.userData.lightType=type;const old=lights.get(n);if(old){const next=makeLight(type,old.intensity,old.color);removeLight(old);lights.set(n,next);scene.add(next);syncLight(o,next);}}
    async setSkyCostume(a,util){const costume=util.target.sprite.costumes.find(c=>c.name===name(a.COSTUME));if(!costume||!costume.asset)return;const texture=await new THREE.TextureLoader().loadAsync(costume.asset.encodeDataURI());texture.colorSpace=THREE.SRGBColorSpace;if(skyDome){scene.remove(skyDome);disposeObject(skyDome);}skyTexture=texture;skyDome=new THREE.Mesh(new THREE.SphereGeometry(500,60,40),new THREE.MeshBasicMaterial({map:texture,side:THREE.BackSide,fog:false,depthWrite:false}));skyDome.renderOrder=-1;scene.add(skyDome);applySkyEffects();refreshReflectiveMaterials();}
    changeSkyColor(a){skyHueEffect=(skyHueEffect+num(a.VALUE))%200;applySkyEffects();}
    changeSkyBrightness(a){skyBrightnessEffect=THREE.MathUtils.clamp(skyBrightnessEffect+num(a.VALUE),-100,100);applySkyEffects();}
    setSkyColorEffect(a){skyHueEffect=num(a.VALUE)%200;applySkyEffects();}
    setSkyBrightnessEffect(a){skyBrightnessEffect=THREE.MathUtils.clamp(num(a.VALUE),-100,100);applySkyEffects();}
    setReflectivity(a){const o=object(a.NAME),v=THREE.MathUtils.clamp(num(a.VALUE),0,1);if(o)setMaterial(o,m=>{if("metalness" in m)m.metalness=v;if("roughness" in m)m.roughness=1-v;if(v>0){if(!envTexture)regenerateEnvTexture();m.envMap=envTexture;m.envMapIntensity=1;reflectiveMaterials.add(m);}else{m.envMap=null;reflectiveMaterials.delete(m);}m.needsUpdate=true;});}
    getPositionX(a){const o=object(a.NAME);return o?o.position.x:0;}
    getPositionY(a){const o=object(a.NAME);return o?o.position.y:0;}
    getPositionZ(a){const o=object(a.NAME);return o?o.position.z:0;}
    getRotationX(a){const o=object(a.NAME);return o?THREE.MathUtils.radToDeg(o.rotation.x):0;}
    getRotationY(a){const o=object(a.NAME);return o?THREE.MathUtils.radToDeg(o.rotation.y):0;}
    getRotationZ(a){const o=object(a.NAME);return o?THREE.MathUtils.radToDeg(o.rotation.z):0;}
    getScaleX(a){const o=object(a.NAME);return o?o.scale.x*100:0;}
    getScaleY(a){const o=object(a.NAME);return o?o.scale.y*100:0;}
    getScaleZ(a){const o=object(a.NAME);return o?o.scale.z*100:0;}
    distance(a){const o=object(a.NAME),t=object(a.TARGET);return o&&t?o.position.distanceTo(t.position):0;}

    async textureCostume(a,util){const o=object(a.NAME);if(!o)return;const costume=util.target.sprite.costumes.find(c=>c.name===name(a.COSTUME));if(!costume||!costume.asset)return;const texture=await new THREE.TextureLoader().loadAsync(costume.asset.encodeDataURI());texture.colorSpace=THREE.SRGBColorSpace;o.userData.textureOverride=texture;applyPreferredTexture(o);}
    async textureURL(a){const o=object(a.NAME);if(!o)return;const texture=await loadTextureFromURL(name(a.URL));if(!texture)return;o.userData.textureOverride=texture;applyPreferredTexture(o);}
    modelOBJList(a,util){const n=name(a.NAME),items=listValue(a.LIST,util);if(!objects.has(n)||!items.length)return;replaceObject(n,new OBJLoader().parse(items.join("\n")));}
    async modelGLTFList(a,util){const n=name(a.NAME),items=listValue(a.LIST,util);if(!objects.has(n)||!items.length)return;replaceObject(n,await loadGLTFList(items));}
    playAnimation(a){playObjectAnimation(object(a.NAME),a.ANIMATION);}
    playAnimationUntilDone(a,util){const o=object(a.NAME);if(!o)return;if(!util.stackFrame.action){const action=playObjectAnimation(o,a.ANIMATION);if(!action)return;util.stackFrame.action=action;}if(util.stackFrame.action.isRunning())util.yield();}
  }

  runtime.on("PROJECT_STOP_ALL", () => { drawing = false; clearSkin(); });

  runtime.on("PROJECT_LOADED", async () => {
    drawing = false;
    installBackLayer();
    startRenderLoop();
  });

  runtime.on("RUNTIME_DISPOSED", () => {
    drawing = false;
    clearSkin();
  });

  Scratch.extensions.register(new BackLayer3D());
})(Scratch);
