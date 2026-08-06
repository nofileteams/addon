// Name: BackLayer 3D
// ID: backlayer3d
// Description: 3D objects rendered behind every Scratch sprite.
// By: nofileteams
// License: MIT
// Version: 1.6.5

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
    startRenderLoop();
  }, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 4/3, 0.1, 10000);
  camera.position.set(0, 0, 10);
  const ambient = new THREE.AmbientLight(0xffffff, 0.65);
  scene.add(ambient);
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
  const shadowTarget = new THREE.WebGLRenderTarget(shadowMapSize, shadowMapSize);
  const shadowMaterial = new THREE.ShaderMaterial({
    vertexShader: "varying float vDepth;void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);vDepth=-mv.z;gl_Position=projectionMatrix*mv;}",
    fragmentShader: "varying float vDepth;uniform float uNear;uniform float uFar;void main(){float d=(vDepth-uNear)/(uFar-uNear);gl_FragColor=vec4(d,d,d,1.0);}",
    uniforms: { uNear: { value: 0.1 }, uFar: { value: 500 } }
  });
  const shadowCamera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 500);
  const shadowBiasMatrix = new THREE.Matrix4();
  shadowBiasMatrix.set(0.5, 0.0, 0.0, 0.5, 0.0, 0.5, 0.0, 0.5, 0.0, 0.0, 0.5, 0.5, 0.0, 0.0, 0.0, 1.0);
  const shadowMatrix = new THREE.Matrix4();
  const shadowUniforms = { shadowMap: { value: shadowTarget.texture }, shadowMatrix: { value: shadowMatrix }, shadowsEnabled: { value: 0.0 } };
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
    setMaterial(root, m => { m.map=texture; m.transparent=Boolean(texture); m.depthWrite=!texture; m.needsUpdate=true; });
    if (!override) updateTilingRepeat(root);
  };

  // [FIX] Reusable scratch objects to avoid per-call allocation
  const _localAxisX = new THREE.Vector3(1, 0, 0);
  const _localAxisY = new THREE.Vector3(0, 1, 0);
  const _localAxisZ = new THREE.Vector3(0, 0, 1);
  const _deltaQuat = new THREE.Quaternion();
  const _physicsClock = new THREE.Clock();
  const GRAVITY = -9.8;

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
    mesh.userData.velocityY = 0;
    mesh.userData.lightType = "全体";
    mesh.userData.materialTexture = null;
    mesh.userData.textureOverride = null;
    patchShadowShader(mesh.material);
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
    next.userData.velocityY = old.userData.velocityY || 0;
    next.userData.lightType = old.userData.lightType || "全体";
    next.userData.materialTexture = old.userData.materialTexture || null;
    next.userData.textureOverride = old.userData.textureOverride || null;
    applyPreferredTexture(next);
    allMeshes(next).forEach(mesh => patchShadowShader(mesh.material));
    scene.remove(old); disposeObject(old); scene.add(next); objects.set(n, next);
  };
  const disposeObject = root => {
    root.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => m.dispose());
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
      shader.vertexShader = "varying vec3 vWorldPos;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n  vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      shader.fragmentShader = "varying vec3 vWorldPos;\nuniform sampler2D shadowMap;\nuniform mat4 shadowMatrix;\nuniform float shadowsEnabled;\n" + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", "#include <color_fragment>\n  if (shadowsEnabled > 0.5) {\n    vec4 sCoord = shadowMatrix * vec4(vWorldPos, 1.0);\n    sCoord.xyz /= sCoord.w;\n    if (sCoord.x >= 0.0 && sCoord.x <= 1.0 && sCoord.y >= 0.0 && sCoord.y <= 1.0 && sCoord.z >= 0.0 && sCoord.z <= 1.0) {\n      float shadow = 0.0;\n      float texelSize = 1.5 / 2048.0;\n      for (int x = -2; x <= 2; x++) {\n        for (int y = -2; y <= 2; y++) {\n          vec2 offset = vec2(float(x), float(y)) * texelSize;\n          float sDepth = texture2D(shadowMap, sCoord.xy + offset).r;\n          shadow += (sCoord.z > sDepth + 0.003) ? 1.0 : 0.0;\n        }\n      }\n      shadow /= 25.0;\n      diffuseColor.rgb *= 1.0 - shadow * 0.5;\n    }\n  }\n");
    };
    material.needsUpdate = true;
  };
  function updatePhysics(delta) {
    if (delta <= 0) return;
    for (const moving of objects.values()) {
      if (!moving.userData.physics) continue;
      moving.userData.velocityY = (moving.userData.velocityY || 0) + GRAVITY * delta;
      moving.position.y += moving.userData.velocityY * delta;
      if (moving.userData.passThrough) continue;
      let movingBox = box(moving);
      for (const other of objects.values()) {
        if (other === moving || other.userData.passThrough) continue;
        const otherBox = box(other);
        if (!movingBox.intersectsBox(otherBox)) continue;
        if (moving.userData.velocityY <= 0) moving.position.y += otherBox.max.y - movingBox.min.y;
        else moving.position.y -= movingBox.max.y - otherBox.min.y;
        moving.userData.velocityY = 0;
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

    reset(){ for(const o of objects.values()){scene.remove(o);disposeObject(o);} objects.clear(); for(const l of lights.values())removeLight(l); lights.clear(); if(skyDome){scene.remove(skyDome);disposeObject(skyDome);skyDome=null;skyTexture=null;} cameraObject=null; camera.position.set(0,0,10); camera.rotation.set(0,0,0); shadowsEnabled=false; }
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
    setPhysics(a){const o=object(a.NAME);if(o){o.userData.physics=name(a.STATE)==="on";if(!o.userData.physics)o.userData.velocityY=0;}}
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
        if(key==="y")o.userData.velocityY=0;
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
    setLight(a){const n=name(a.NAME),o=objects.get(n);if(!o)return;if(name(a.STATE)==="on"){let l=lights.get(n);if(!l){l=makeLight(o.userData.lightType||"全体");lights.set(n,l);scene.add(l);}syncLight(o,l);}else{const l=lights.get(n);if(l){removeLight(l);lights.delete(n);}}}
    setLightIntensity(a){const l=lights.get(name(a.NAME));if(l)l.intensity=num(a.VALUE);}
    setLightColor(a){const l=lights.get(name(a.NAME));if(l)l.color.set(color(a.COLOR));}
    setLightType(a){const n=name(a.NAME),o=objects.get(n);if(!o)return;const type=name(a.TYPE)==="向いてる方向"?"向いてる方向":"全体";o.userData.lightType=type;const old=lights.get(n);if(old){const next=makeLight(type,old.intensity,old.color);removeLight(old);lights.set(n,next);scene.add(next);syncLight(o,next);}}
    async setSkyCostume(a,util){const costume=util.target.sprite.costumes.find(c=>c.name===name(a.COSTUME));if(!costume||!costume.asset)return;const texture=await new THREE.TextureLoader().loadAsync(costume.asset.encodeDataURI());texture.colorSpace=THREE.SRGBColorSpace;if(skyDome){scene.remove(skyDome);disposeObject(skyDome);}skyTexture=texture;skyDome=new THREE.Mesh(new THREE.SphereGeometry(500,60,40),new THREE.MeshBasicMaterial({map:texture,side:THREE.BackSide,fog:false,depthWrite:false}));skyDome.renderOrder=-1;scene.add(skyDome);applySkyEffects();}
    changeSkyColor(a){skyHueEffect=(skyHueEffect+num(a.VALUE))%200;applySkyEffects();}
    changeSkyBrightness(a){skyBrightnessEffect=THREE.MathUtils.clamp(skyBrightnessEffect+num(a.VALUE),-100,100);applySkyEffects();}
    setSkyColorEffect(a){skyHueEffect=num(a.VALUE)%200;applySkyEffects();}
    setSkyBrightnessEffect(a){skyBrightnessEffect=THREE.MathUtils.clamp(num(a.VALUE),-100,100);applySkyEffects();}
    setReflectivity(a){const o=object(a.NAME),v=THREE.MathUtils.clamp(num(a.VALUE),0,1);if(o)setMaterial(o,m=>{if("metalness" in m)m.metalness=v;if("roughness" in m)m.roughness=1-v;m.needsUpdate=true;});}
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
