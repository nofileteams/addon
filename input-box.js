(function (Scratch) {
  'use strict';

  if (!Scratch.extensions.unsandboxed) {
    throw new Error('Input Box must be loaded without the sandbox.');
  }

  const vm = Scratch.vm;
  const runtime = vm.runtime;
  const Cast = Scratch.Cast;
  const boxes = new Map();
  const pressedKeys = new Set();

  const nameOf = value => Cast.toString(value);
  const numberOf = value => {
    const number = Cast.toNumber(value);
    return Number.isFinite(number) ? number : 0;
  };
  const enabled = value => String(value).toLowerCase() === 'on';
  const normalizeKey = key => {
    const value = String(key).toLowerCase();
    const aliases = {space: ' ', 'space bar': ' ', enter: 'enter', return: 'enter', escape: 'escape', esc: 'escape'};
    return aliases[value] !== undefined ? aliases[value] : value;
  };

  const removeBox = name => {
    const box = boxes.get(name);
    if (!box) return;
    box.element.remove();
    box.styleElement.remove();
    boxes.delete(name);
  };

  // applyFontSize now accepts a scale parameter (default 1).
  // scale is used to adjust font size according to the canvas/editor scale.
  const applyFontSize = (box, scale = 1) => {
    // If autoFont: size based on the box.height (stage units) and scale (pixels per stage unit)
    // Otherwise: use user-set fontSize multiplied by scale so font responds to editor size changes.
    const size = box.autoFont ? Math.max(1, box.height * 0.52 * scale) : Math.max(1, box.fontSize * scale);
    box.element.style.fontSize = size + 'px';
    box.element.style.lineHeight = box.autoFont ? '1.15' : 'normal';
  };

  const updatePositions = () => {
    const canvas = vm.renderer && vm.renderer.canvas;
    const stageWidth = runtime.stageWidth || 480;
    const stageHeight = runtime.stageHeight || 360;
    if (!canvas || !canvas.isConnected || !canvas.parentNode) {
      for (const box of boxes.values()) box.element.style.display = 'none';
      requestAnimationFrame(updatePositions);
      return;
    }
    const parent = canvas.parentNode;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    const canvasRect = canvas.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const scaleX = canvasRect.width / stageWidth;
    const scaleY = canvasRect.height / stageHeight;
    for (const box of boxes.values()) {
      const element = box.element;
      if (!box.visible) { element.style.display = 'none'; continue; }
      if (element.parentNode !== parent) parent.appendChild(element);
      element.style.display = 'block';
      element.style.left = (canvasRect.left - parentRect.left + canvasRect.width / 2 + box.x * scaleX) + 'px';
      element.style.top = (canvasRect.top - parentRect.top + canvasRect.height / 2 - box.y * scaleY) + 'px';
      element.style.width = Math.max(1, box.width * scaleX) + 'px';
      element.style.height = Math.max(1, box.height * scaleY) + 'px';
      element.style.transform = 'translate(-50%, -50%)';
      element.style.borderWidth = box.outline ? Math.max(0, box.outlineWidth) + 'px' : '0px';

      // Update font size according to the vertical scale so text scales with editor size.
      applyFontSize(box, scaleY);
    }
    requestAnimationFrame(updatePositions);
  };

  requestAnimationFrame(updatePositions);
  window.addEventListener('keyup', event => pressedKeys.delete(normalizeKey(event.key)), true);
  window.addEventListener('blur', () => pressedKeys.clear());
  runtime.on('PROJECT_LOADED', () => {
    for (const name of Array.from(boxes.keys())) removeBox(name);
    pressedKeys.clear();
  });

  class InputBoxExtension {
    getInfo() {
      const stringArg = (defaultValue, menu) => ({type: Scratch.ArgumentType.STRING, defaultValue, ...(menu ? {menu} : {})});
      const numberArg = defaultValue => ({type: Scratch.ArgumentType.NUMBER, defaultValue});
      const colorArg = defaultValue => ({type: Scratch.ArgumentType.COLOR, defaultValue});
      const nameArg = () => stringArg('input-box');
      return {
        id: 'inputboxmod',
        name: 'Input Box',
        color1: '#635BFF',
        color2: '#5148E5',
        color3: '#4139C7',
        blocks: [
          {opcode: 'create', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] を作成する', arguments: {NAME: nameArg()}},
          {opcode: 'remove', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] を削除する', arguments: {NAME: nameArg()}},
          {opcode: 'show', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] を表示する', arguments: {NAME: nameArg()}},
          {opcode: 'hide', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] を隠す', arguments: {NAME: nameArg()}},
          '---',
          {opcode: 'setPosition', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] の位置を x [X] y [Y] にする', arguments: {NAME: nameArg(), X: numberArg(0), Y: numberArg(0)}},
          {opcode: 'setWidth', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] の大きさを x [SIZE] にする', arguments: {NAME: nameArg(), SIZE: numberArg(50)}},
          {opcode: 'setHeight', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] の大きさを y [SIZE] にする', arguments: {NAME: nameArg(), SIZE: numberArg(25)}},
          {opcode: 'setBackground', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] の色を [COLOR] にする', arguments: {NAME: nameArg(), COLOR: colorArg('#ffffff')}},
          {opcode: 'setOutline', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] の outline を [STATE] にする', arguments: {NAME: nameArg(), STATE: stringArg('on', 'ON_OFF')}},
          {opcode: 'setOutlineColor', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] の outline の色を [COLOR] にする', arguments: {NAME: nameArg(), COLOR: colorArg('#000000')}},
          {opcode: 'setOutlineWidth', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] の outline の太さを [SIZE] にする', arguments: {NAME: nameArg(), SIZE: numberArg(1)}},
          {opcode: 'setDisabled', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] を入力できなくする [STATE]', arguments: {NAME: nameArg(), STATE: stringArg('on', 'ON_OFF')}},
          '---',
          {opcode: 'setTextColor', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] の文字の色を [COLOR] にする', arguments: {NAME: nameArg(), COLOR: colorArg('#000000')}},
          {opcode: 'setFontSize', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] の文字の大きさを [SIZE] にする', arguments: {NAME: nameArg(), SIZE: numberArg(10)}},
          {opcode: 'setAutoFont', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] の文字の大きさを自動的に入力欄の大きさに合わせる [STATE]', arguments: {NAME: nameArg(), STATE: stringArg('on', 'ON_OFF')}},
          {opcode: 'setPlaceholderColor', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] の placeholder の色を [COLOR] にする', arguments: {NAME: nameArg(), COLOR: colorArg('#777777')}},
          {opcode: 'setPlaceholder', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] の文字を [TEXT] にする', arguments: {NAME: nameArg(), TEXT: stringArg('hello world')}},
          {opcode: 'setValue', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] の内容を [TEXT] にする', arguments: {NAME: nameArg(), TEXT: stringArg('turbowarp')}},
          {opcode: 'appendValue', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] の内容に [TEXT] を追加する', arguments: {NAME: nameArg(), TEXT: stringArg('turbowarp')}},
          {opcode: 'setMultiline', blockType: Scratch.BlockType.COMMAND, text: '入力欄 [NAME] が改行入力できるようにする [STATE]', arguments: {NAME: nameArg(), STATE: stringArg('on', 'ON_OFF')}},
          '---',
          {opcode: 'ifKeyPressed', blockType: Scratch.BlockType.BOOLEAN, text: '入力欄 [NAME] で [KEY] キーが押された場合', arguments: {NAME: nameArg(), KEY: stringArg('enter', 'KEYS')}},
          {opcode: 'isEditing', blockType: Scratch.BlockType.BOOLEAN, text: '入力欄 [NAME] は今入力中？', arguments: {NAME: nameArg()}},
          {opcode: 'exists', blockType: Scratch.BlockType.BOOLEAN, text: '入力欄 [NAME] は存在する？', arguments: {NAME: nameArg()}},
          '---',
          {opcode: 'getValue', blockType: Scratch.BlockType.REPORTER, text: '入力欄 [NAME] に書かれた内容', arguments: {NAME: nameArg()}},
          {opcode: 'getX', blockType: Scratch.BlockType.REPORTER, text: '入力欄 [NAME] の x の位置', arguments: {NAME: nameArg()}},
          {opcode: 'getY', blockType: Scratch.BlockType.REPORTER, text: '入力欄 [NAME] の y の位置', arguments: {NAME: nameArg()}},
          {opcode: 'getLines', blockType: Scratch.BlockType.REPORTER, text: '入力欄 [NAME] の行の数', arguments: {NAME: nameArg()}}
        ],
        menus: {
          ON_OFF: {acceptReporters: true, items: ['on', 'off']},
          KEYS: {acceptReporters: true, items: ['enter', 'space', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'escape', 'tab']}
        }
      };
    }

    getBox(args) { return boxes.get(nameOf(args.NAME)); }

    create(args) {
      const name = nameOf(args.NAME);
      removeBox(name);
      const element = document.createElement('textarea');
      const box = {element, x: 0, y: 0, width: 50, height: 25, visible: true, outline: true, outlineWidth: 1, fontSize: 10, autoFont: false, multiline: false};
      element.setAttribute('aria-label', name);
      element.spellcheck = false;
      element.wrap = 'off';
      Object.assign(element.style, {
        position: 'absolute', margin: '0', padding: '2px 4px', boxSizing: 'border-box', zIndex: '10',
        resize: 'none', overflow: 'hidden', background: '#ffffff', color: '#000000', borderStyle: 'solid',
        borderColor: '#000000', borderRadius: '0', fontFamily: 'sans-serif', outline: 'none'
      });
      const placeholderClass = 'inputboxmod-' + Math.random().toString(36).slice(2);
      element.classList.add(placeholderClass);
      const style = document.createElement('style');
      style.textContent = '.' + placeholderClass + '::placeholder{color:var(--input-box-placeholder,#777777);opacity:1}';
      document.head.appendChild(style);
      box.styleElement = style;
      element.addEventListener('keydown', event => {
        pressedKeys.add(normalizeKey(event.key));
        if (event.key === 'Enter' && !box.multiline) event.preventDefault();
      }, true);
      element.addEventListener('keyup', event => pressedKeys.delete(normalizeKey(event.key)), true);
      boxes.set(name, box);
      applyFontSize(box);
    }

    remove(args) { removeBox(nameOf(args.NAME)); }
    show(args) { const box = this.getBox(args); if (box) box.visible = true; }
    hide(args) { const box = this.getBox(args); if (box) box.visible = false; }
    setPosition(args) { const box = this.getBox(args); if (box) { box.x = numberOf(args.X); box.y = numberOf(args.Y); } }
    setWidth(args) { const box = this.getBox(args); if (box) box.width = Math.max(1, numberOf(args.SIZE)); }
    setHeight(args) { const box = this.getBox(args); if (box) { box.height = Math.max(1, numberOf(args.SIZE)); applyFontSize(box); } }
    setBackground(args) { const box = this.getBox(args); if (box) box.element.style.background = nameOf(args.COLOR); }
    setOutline(args) { const box = this.getBox(args); if (box) box.outline = enabled(args.STATE); }
    setOutlineColor(args) { const box = this.getBox(args); if (box) box.element.style.borderColor = nameOf(args.COLOR); }
    setOutlineWidth(args) { const box = this.getBox(args); if (box) box.outlineWidth = Math.max(0, numberOf(args.SIZE)); }
    setDisabled(args) { const box = this.getBox(args); if (box) box.element.disabled = enabled(args.STATE); }
    setTextColor(args) { const box = this.getBox(args); if (box) box.element.style.color = nameOf(args.COLOR); }
    setFontSize(args) { const box = this.getBox(args); if (box) { box.fontSize = Math.max(1, numberOf(args.SIZE)); applyFontSize(box); } }
    setAutoFont(args) { const box = this.getBox(args); if (box) { box.autoFont = enabled(args.STATE); applyFontSize(box); } }
    setPlaceholderColor(args) { const box = this.getBox(args); if (box) box.element.style.setProperty('--input-box-placeholder', nameOf(args.COLOR)); }
    setPlaceholder(args) { const box = this.getBox(args); if (box) box.element.placeholder = nameOf(args.TEXT); }
    setValue(args) { const box = this.getBox(args); if (box) box.element.value = nameOf(args.TEXT); }
    appendValue(args) { const box = this.getBox(args); if (box) box.element.value += nameOf(args.TEXT); }
    setMultiline(args) { const box = this.getBox(args); if (box) { box.multiline = enabled(args.STATE); box.element.wrap = box.multiline ? 'soft' : 'off'; box.element.style.overflowY = box.multiline ? 'auto' : 'hidden'; } }

    ifKeyPressed(args) {
      const box = this.getBox(args);
      return Boolean(box && document.activeElement === box.element && pressedKeys.has(normalizeKey(args.KEY)));
    }
    isEditing(args) { const box = this.getBox(args); return Boolean(box && document.activeElement === box.element); }
    exists(args) { return boxes.has(nameOf(args.NAME)); }
    getValue(args) { const box = this.getBox(args); return box ? box.element.value : ''; }
    getX(args) { const box = this.getBox(args); return box ? box.x : 0; }
    getY(args) { const box = this.getBox(args); return box ? box.y : 0; }
    getLines(args) { const box = this.getBox(args); return box ? Math.max(1, box.element.value.split(/\\r?\\n/).length) : 0; }
  }

  Scratch.extensions.register(new InputBoxExtension());
})(Scratch);