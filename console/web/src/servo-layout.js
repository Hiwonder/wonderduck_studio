const CARD_WIDTH = 144;
const CARD_HEIGHT = 111;
const MARGIN = 4;
const GAP = 6;
const ALIGNMENT_DISTANCE = 8;
const STORAGE_KEY = 'servo-canvas-layout';

export function createServoLayout({ viewport, canvas, scaleInput, layoutLockButton, arrangeButton, defaultButton, restoreButton, onSelect, getState, toast, defaultLayout }) {
  let items = new Map(), positions = new Map(), selected = new Set();
  let scale = 100, manual = false, previous = null, drag = null, marquee = null, lastWidth = 0, initialized = false;
  let layoutLocked = true;
  let saved = defaultLayout;

  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value) {
      const data = JSON.parse(value);
      if (!Array.isArray(data.layout) || !data.layout.every(entry => Array.isArray(entry) && entry.length === 3 &&
          entry.every(Number.isInteger) && entry[0] >= 0 && entry[1] >= 0 && entry[2] >= 0 &&
          entry[1] <= 1000000 && entry[2] <= 1000000) ||
          new Set(data.layout.map(entry => entry[0])).size !== data.layout.length ||
          !Number.isInteger(data.scale) || data.scale < 50 || data.scale > 300 ||
          typeof data.manual !== 'boolean' || !Array.isArray(data.hidden) || !Array.isArray(data.locked) ||
          !data.hidden.every(Number.isInteger) || !data.locked.every(Number.isInteger)) throw new Error('布局数据格式无效');
      saved = data;
    }
  } catch (error) { toast(`无法读取已保存的舵机布局：${error.message}`, true); }
  if (saved) {
    scale = saved.scale;
    manual = saved.manual;
    positions = new Map(saved.layout.map(([id, x, y]) => [id, { x, y }]));
  }

  const cardWidth = () => CARD_WIDTH * scale / 100;
  const cardHeight = () => CARD_HEIGHT * scale / 100;
  const columns = () => Math.max(1, Math.floor((Math.max(viewport.clientWidth, 1) - 2 * MARGIN + GAP) / (cardWidth() + GAP)));

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ layout: layout(), scale, manual, ...getState() }));
    } catch (error) { toast(`无法保存舵机布局：${error.message}`, true); }
  }

  function render() {
    canvas.style.setProperty('--servo-scale', scale / 100);
    let width = viewport.clientWidth, height = viewport.clientHeight;
    for (const [id, element] of items) {
      const position = positions.get(id);
      if (!position) continue;
      element.style.left = `${position.x}px`;
      element.style.top = `${position.y}px`;
      element.classList.toggle('is-selected', selected.has(id));
      if (!element.hidden) {
        width = Math.max(width, position.x + cardWidth() + MARGIN);
        height = Math.max(height, position.y + cardHeight() + MARGIN);
      }
    }
    canvas.style.width = `${Math.ceil(width)}px`;
    canvas.style.height = `${Math.ceil(height)}px`;
    scaleInput.value = scale;
  }

  function arrange(remember = false) {
    if (remember) {
      previous = { positions: new Map([...positions].map(([id, value]) => [id, { ...value }])), manual };
      restoreButton.disabled = false;
    }
    const ids = [...items.keys()], cols = columns(), rowCount = Math.ceil(ids.length / cols);
    const occupied = cols * cardWidth() + (cols - 1) * GAP;
    const left = Math.max(MARGIN, (viewport.clientWidth - occupied) / 2);
    ids.forEach((id, index) => positions.set(id, {
      x: Math.round(left + Math.floor(index / rowCount) * (cardWidth() + GAP)),
      y: Math.round(MARGIN + (index % rowCount) * (cardHeight() + GAP)),
    }));
    manual = false;
    render();
    if (remember) persist();
  }

  function placeMissing(ids) {
    if (!ids.length) return;
    let bottom = MARGIN;
    for (const [id, position] of positions) if (items.has(id)) bottom = Math.max(bottom, position.y + cardHeight() + GAP);
    const cols = columns();
    ids.forEach((id, index) => positions.set(id, {
      x: Math.round(MARGIN + (index % cols) * (cardWidth() + GAP)),
      y: Math.round(bottom + Math.floor(index / cols) * (cardHeight() + GAP)),
    }));
  }

  function setItems(entries) {
    items = new Map(entries);
    selected = new Set([...selected].filter(id => items.has(id) && !items.get(id).hidden));
    onSelect([...selected]);
    for (const id of [...positions.keys()]) if (!items.has(id)) positions.delete(id);
    if (!manual) arrange();
    else { placeMissing([...items.keys()].filter(id => !positions.has(id))); render(); }
    initialized = true;
    defaultButton.disabled = !items.size;
    lastWidth = viewport.clientWidth;
  }

  function visibilityChanged() {
    selected = new Set([...selected].filter(id => items.has(id) && !items.get(id).hidden));
    onSelect([...selected]);
    render();
    persist();
  }

  function layout() {
    return [...items.keys()].map(id => {
      const position = positions.get(id);
      return [id, Math.round(position.x), Math.round(position.y)];
    });
  }

  function setLayout(entries, newScale) {
    scale = newScale;
    const known = entries.filter(([id]) => items.has(id)).sort((a, b) => a[2] - b[2] || a[1] - b[1]);
    if (known.length) {
      const ordered = known.map(([id]) => items.get(id));
      const others = [...items.values()].filter(element => !ordered.includes(element));
      canvas.append(...ordered, ...others);
      positions = new Map(known.map(([id, x, y]) => [id, { x, y }]));
      placeMissing([...items.keys()].filter(id => !positions.has(id)));
      manual = true;
    } else if (!manual) arrange();
    render(); persist();
  }

  function select(id, additive) {
    if (additive) {
      if (selected.has(id)) selected.delete(id); else selected.add(id);
    } else if (!selected.has(id)) selected = new Set([id]);
    onSelect([...selected]);
    render();
  }

  function nearestGuide(edges, candidates) {
    let best = null;
    for (const edge of edges) for (const candidate of candidates) {
      const offset = candidate - edge;
      if (Math.abs(offset) <= ALIGNMENT_DISTANCE && (!best || Math.abs(offset) < Math.abs(best.offset))) {
        best = { offset, coordinate: candidate };
      }
    }
    return best;
  }

  function move(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    let dx = Math.round(event.clientX - drag.x + viewport.scrollLeft - drag.scrollLeft);
    let dy = Math.round(event.clientY - drag.y + viewport.scrollTop - drag.scrollTop);
    if (Math.abs(dx) + Math.abs(dy) < 2 && !drag.moved) return;
    drag.moved = true;
    const origins = [...drag.origins.values()];
    const left = Math.min(...origins.map(value => value.x)), top = Math.min(...origins.map(value => value.y));
    const right = Math.max(...origins.map(value => value.x + cardWidth()));
    const bottom = Math.max(...origins.map(value => value.y + cardHeight()));
    dx = Math.max(-left, dx); dy = Math.max(-top, dy);
    const others = [...positions].filter(([id]) => !drag.origins.has(id) && items.has(id) && !items.get(id).hidden);
    const xGuide = nearestGuide([left + dx, (left + right) / 2 + dx, right + dx],
      others.flatMap(([, value]) => [value.x, value.x + cardWidth() / 2, value.x + cardWidth()]));
    const yGuide = nearestGuide([top + dy, (top + bottom) / 2 + dy, bottom + dy],
      others.flatMap(([, value]) => [value.y, value.y + cardHeight() / 2, value.y + cardHeight()]));
    if (xGuide && left + dx + xGuide.offset >= 0) dx = Math.round(dx + xGuide.offset);
    if (yGuide && top + dy + yGuide.offset >= 0) dy = Math.round(dy + yGuide.offset);
    canvas.classList.toggle('has-x-guide', !!xGuide);
    canvas.classList.toggle('has-y-guide', !!yGuide);
    if (xGuide) canvas.style.setProperty('--guide-x', `${xGuide.coordinate}px`);
    if (yGuide) canvas.style.setProperty('--guide-y', `${yGuide.coordinate}px`);
    for (const [id, origin] of drag.origins) positions.set(id, { x: origin.x + dx, y: origin.y + dy });
    manual = true;
    render();
  }

  function stopDrag() {
    if (!drag) return;
    const { id, pointerId, moved } = drag;
    drag = null;
    const element = items.get(id);
    element?.classList.remove('is-dragging');
    if (element?.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    canvas.classList.remove('has-x-guide', 'has-y-guide');
    if (moved) persist();
  }

  function finish(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    stopDrag();
  }

  function moveSelected(dx, dy) {
    const values = [...selected].map(id => positions.get(id));
    if (!values.length) return;
    dx = Math.max(-Math.min(...values.map(value => value.x)), dx);
    dy = Math.max(-Math.min(...values.map(value => value.y)), dy);
    for (const id of selected) {
      const position = positions.get(id);
      positions.set(id, { x: position.x + dx, y: position.y + dy });
    }
    manual = true; render(); persist();
  }

  function attach(id, element) {
    element.tabIndex = 0;
    element.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('input,button,select,label')) return;
      if (!layoutLocked || event.pointerType === 'mouse') event.preventDefault();
      select(id, event.ctrlKey || event.metaKey);
      if (!selected.has(id)) return;
      element.focus({ preventScroll: true });
      if (layoutLocked) return;
      element.setPointerCapture(event.pointerId);
      drag = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop, moved: false,
        origins: new Map([...selected].map(item => [item, { ...positions.get(item) }])) };
      element.classList.add('is-dragging');
    });
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', finish);
    element.addEventListener('keydown', event => {
      if (event.target !== element) return;
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!direction || layoutLocked) return;
      event.preventDefault();
      if (!selected.has(id)) select(id, false);
      moveSelected(...direction);
    });
  }

  canvas.tabIndex = 0;
  canvas.addEventListener('pointerdown', event => {
    if (event.target !== canvas || event.pointerType !== 'mouse' || event.button !== 0) return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    const bounds = canvas.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'servo-marquee';
    canvas.append(box);
    marquee = { pointerId: event.pointerId, x: event.clientX - bounds.left, y: event.clientY - bounds.top,
      right: event.clientX - bounds.left, bottom: event.clientY - bounds.top, box,
      previous: event.ctrlKey || event.metaKey ? new Set(selected) : new Set() };
  });
  canvas.addEventListener('pointermove', event => {
    if (!marquee || event.pointerId !== marquee.pointerId) return;
    const bounds = canvas.getBoundingClientRect();
    marquee.right = event.clientX - bounds.left;
    marquee.bottom = event.clientY - bounds.top;
    Object.assign(marquee.box.style, {
      left: `${Math.min(marquee.x, marquee.right)}px`, top: `${Math.min(marquee.y, marquee.bottom)}px`,
      width: `${Math.abs(marquee.right - marquee.x)}px`, height: `${Math.abs(marquee.bottom - marquee.y)}px`,
    });
  });
  function finishMarquee(event) {
    if (!marquee || event.pointerId !== marquee.pointerId) return;
    const left = Math.min(marquee.x, marquee.right), right = Math.max(marquee.x, marquee.right);
    const top = Math.min(marquee.y, marquee.bottom), bottom = Math.max(marquee.y, marquee.bottom);
    selected = marquee.previous;
    for (const [id, element] of items) {
      const position = positions.get(id);
      if (!element.hidden && position.x < right && position.x + cardWidth() > left &&
          position.y < bottom && position.y + cardHeight() > top) selected.add(id);
    }
    marquee.box.remove();
    marquee = null;
    onSelect([...selected]);
    render();
  }
  canvas.addEventListener('pointerup', finishMarquee);
  canvas.addEventListener('pointercancel', finishMarquee);
  canvas.addEventListener('keydown', event => {
    if (event.target.closest('input,button,select')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selected = new Set([...items].filter(([, element]) => !element.hidden).map(([id]) => id));
      onSelect([...selected]);
      render();
    } else if (event.target === canvas) {
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (direction && selected.size && !layoutLocked) { event.preventDefault(); moveSelected(...direction); }
    }
  });

  canvas.classList.add('is-layout-locked');
  layoutLockButton.addEventListener('click', () => {
    layoutLocked = !layoutLocked;
    if (layoutLocked) stopDrag();
    canvas.classList.toggle('is-layout-locked', layoutLocked);
    layoutLockButton.setAttribute('aria-pressed', String(layoutLocked));
    layoutLockButton.title = layoutLocked ? '解锁卡片布局' : '锁定卡片布局';
  });

  scaleInput.addEventListener('change', () => {
    const value = Number(scaleInput.value);
    if (!scaleInput.value || !scaleInput.checkValidity() || !Number.isInteger(value)) {
      scaleInput.value = scale;
      toast('卡片大小必须为 50～300 的整数', true);
      return;
    }
    scale = value;
    if (!manual) arrange(); else render();
    persist();
  });
  arrangeButton.addEventListener('click', () => arrange(true));
  defaultButton.addEventListener('click', () => {
    setLayout(defaultLayout.layout, defaultLayout.scale);
    viewport.scrollTo({ left: 0, top: 0 });
  });
  restoreButton.addEventListener('click', () => {
    if (!previous) return;
    positions = previous.positions; manual = previous.manual; previous = null;
    for (const id of [...positions.keys()]) if (!items.has(id)) positions.delete(id);
    placeMissing([...items.keys()].filter(id => !positions.has(id)));
    restoreButton.disabled = true;
    render(); persist();
  });
  new ResizeObserver(() => {
    if (!initialized || viewport.clientWidth === lastWidth) return;
    lastWidth = viewport.clientWidth;
    if (!manual) arrange(); else render();
  }).observe(viewport);

  return { attach, setItems, layout, setLayout, persist, render, visibilityChanged,
    hidden: () => saved?.hidden || [], locked: () => saved?.locked || [], scale: () => scale };
}
