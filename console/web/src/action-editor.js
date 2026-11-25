import { ACTION_POSITION_LIMITS } from './servo-panel.js';

const $ = id => document.getElementById(id);
const csvPickerType = { description: 'CSV', accept: { 'text/csv': ['.csv'] } };

function csvFilename(name) {
  return /\.csv$/i.test(name) ? name : `${name}.csv`;
}

function chooseDialog(dialog) {
  const form = dialog.querySelector('form');
  return new Promise(resolve => {
    const finish = value => {
      dialog.removeEventListener('cancel', cancel);
      form.removeEventListener('submit', submit);
      dialog.close();
      resolve(value);
    };
    const cancel = event => {
      event.preventDefault();
      finish('cancel');
    };
    const submit = event => {
      event.preventDefault();
      finish(event.submitter?.value ?? 'cancel');
    };
    dialog.addEventListener('cancel', cancel);
    form.addEventListener('submit', submit);
    dialog.showModal();
  });
}

export function createActionEditor({ request, toast, confirmAction, context, servoPanel, iconsRefresh }) {
  let frames = [], selected = -1, importedLayout = [], actionId = 1, choosing = false, starting = false, stopping = false;
  let playbackMode = sessionStorage.getItem('console-action-playback-mode');
  let playbackGeneration = 0, pendingStart = null, awaitingState = null, trackedPlayback = null, frameGraceUntil = 0;
  let playbackVisualControls = null, playbackVisualReleaseAt = null;
  let offsets = null, lastPlayback = '';
  const table = $('action-table'), head = table.querySelector('thead'), body = table.querySelector('tbody');

  function integerInput(id, min, max) {
    const input = $(id), value = Number(input.value);
    if (!input.value || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${input.labels?.[0]?.textContent.trim() || input.ariaLabel || id} 必须为 ${min}～${max} 的整数`);
    }
    return value;
  }

  function makeDocument(source = frames) {
    if (!source.length) throw new Error('请先添加动作帧');
    const layout = servoPanel.layout();
    const known = new Set(layout.map(entry => entry[0]));
    for (const entry of importedLayout) if (!known.has(entry[0])) { layout.push([...entry]); known.add(entry[0]); }
    for (const frame of source) for (const [id, value] of Object.entries(frame.positions)) {
      if (!Number.isInteger(value) || value < 0 || value > 4095) throw new Error(`ID ${id} 的位置不在通用动作范围 0～4095`);
      if (!known.has(Number(id))) throw new Error(`ID ${id} 缺少动作布局`);
    }
    return { action_id: actionId, frames: source.map(frame => ({
      duration_ms: frame.duration_ms, positions: { ...frame.positions },
    })), layout, layout_scale_percent: servoPanel.scale() };
  }

  function validatePlaybackPositions(source, lockedIds) {
    for (const frame of source) {
      for (const [id, { min, max }] of Object.entries(ACTION_POSITION_LIMITS)) {
        const value = frame.positions[id];
        if (value != null && !lockedIds.includes(Number(id)) && (value < min || value > max)) {
          throw new Error(`ID ${id} 的动作位置须在 ${min}～${max} 步之间`);
        }
      }
    }
  }

  function applySelection(index, followPlayback = false) {
    selected = index;
    [...body.rows].forEach((row, i) => row.classList.toggle('selected', i === selected));
    if (selected >= 0) {
      if (!$('lock-duration').checked && (!followPlayback || document.activeElement !== $('frame-duration'))) {
        $('frame-duration').value = frames[selected].duration_ms;
      }
      if (!followPlayback) {
        try { servoPanel.setTargets(frames[selected].positions); } catch (error) { toast(error.message, true); }
      }
    }
  }

  function select(index) {
    applySelection(index);
    update();
  }

  function revealPlaybackRow(row) {
    const container = table.parentElement;
    if (!row || !container?.clientHeight) return;
    const bounds = container.getBoundingClientRect(), rowBounds = row.getBoundingClientRect();
    const top = Math.max(bounds.top + container.clientTop, head.getBoundingClientRect().bottom);
    const bottom = bounds.top + container.clientTop + container.clientHeight;
    if (rowBounds.top < top) container.scrollTop -= top - rowBounds.top;
    else if (rowBounds.bottom > bottom) container.scrollTop += rowBounds.bottom - bottom;
  }

  function followPlayback(state, playback) {
    if (!trackedPlayback) return;
    if (trackedPlayback.runId != null ? playback.run_id !== trackedPlayback.runId : state === trackedPlayback.snapshot) return;
    const index = playback.frame - 1;
    if (playback.state !== 'error' && Number.isInteger(index) && index >= 0 && index < frames.length &&
        (playback.dispatch == null || playback.dispatch > 0) && trackedPlayback.index !== index) {
      trackedPlayback.index = index;
      applySelection(index, true);
      revealPlaybackRow(body.rows[index]);
    }
    if (['stopped', 'completed', 'error'].includes(playback.state)) trackedPlayback = null;
  }

  function render() {
    const joints = context().info?.joints || [];
    const names = new Map(joints.map(joint => [joint.id, joint.label]));
    const ids = [...new Set([...joints.map(joint => joint.id), ...frames.flatMap(frame => Object.keys(frame.positions).map(Number))])].sort((a, b) => a - b);
    head.replaceChildren(); body.replaceChildren();
    const header = document.createElement('tr');
    for (const title of ['', '帧', '时长', ...ids.map(id => `ID ${id}`)]) {
      const th = document.createElement('th'); th.textContent = title;
      if (!title) th.setAttribute('aria-label', '运行');
      if (title.startsWith('ID ')) th.title = names.get(Number(title.slice(3))) || '文件中的舵机';
      header.append(th);
    }
    head.append(header);
    frames.forEach((frame, index) => {
      const row = document.createElement('tr');
      row.classList.toggle('selected', index === selected);
      row.addEventListener('click', () => { if (!playbackBusy() && selected !== index) select(index); });
      const playCell = document.createElement('td');
      const play = document.createElement('button');
      play.className = 'frame-play'; play.title = play.ariaLabel = `运行第 ${index + 1} 帧`;
      play.dataset.frameIndex = index; play.dataset.mode = 'run';
      play.innerHTML = '<i data-lucide="play"></i>';
      play.addEventListener('click', event => {
        event.stopPropagation();
        select(index);
        perform(() => sendFrame(frame));
      });
      playCell.append(play); row.append(playCell);
      const number = document.createElement('th'); number.textContent = String(index + 1); row.append(number);
      const durationCell = document.createElement('td');
      const duration = document.createElement('input'); duration.type = 'number'; duration.min = '1'; duration.max = '30000'; duration.step = '1'; duration.value = frame.duration_ms;
      duration.setAttribute('aria-label', `第 ${index + 1} 帧时长`);
      duration.addEventListener('change', () => {
        const value = Number(duration.value);
        if (!duration.value || !Number.isInteger(value) || value < 1 || value > 30000) { duration.value = frame.duration_ms; toast('帧时长必须为 1～30000 毫秒', true); return; }
        frame.duration_ms = value;
        if (index === selected && !$('lock-duration').checked) $('frame-duration').value = value;
        update();
      });
      durationCell.append(duration); row.append(durationCell);
      for (const id of ids) {
        const cell = document.createElement('td');
        const { min, max } = ACTION_POSITION_LIMITS[id] ?? { min: 0, max: 4095 };
        const input = document.createElement('input'); input.type = 'number'; input.min = min; input.max = max; input.step = '1';
        input.placeholder = '-';
        input.value = frame.positions[id] ?? '';
        input.setAttribute('aria-label', `第 ${index + 1} 帧 ID ${id} 位置`);
        input.addEventListener('change', () => {
          const value = Number(input.value);
          if (input.value === '') {
            if (Object.keys(frame.positions).length === 1 && id in frame.positions) { input.value = frame.positions[id]; toast('每帧至少需要一个舵机目标', true); return; }
            delete frame.positions[id];
          } else if (!Number.isInteger(value) || value < min || value > max) {
            input.value = frame.positions[id] ?? ''; toast(`舵机位置必须为 ${min}～${max} 的整数`, true); return;
          } else frame.positions[id] = value;
          if (index === selected) { try { servoPanel.setTargets(frame.positions); } catch (error) { toast(error.message, true); } }
        });
        cell.append(input); row.append(cell);
      }
      body.append(row);
    });
    $('action-empty').hidden = frames.length > 0;
    iconsRefresh();
    update();
  }

  function playbackBusy() {
    const { state, armed, connectionError } = context();
    if (awaitingState && (!armed || connectionError)) awaitingState = null;
    else if (awaitingState && state && state !== awaitingState.snapshot &&
        (awaitingState.runId == null || state.action_playback?.run_id === awaitingState.runId)) awaitingState = null;
    return starting || stopping || !!awaitingState || state?.action_playback?.state === 'playing';
  }

  function setPlaybackMode(mode) {
    playbackMode = mode;
    if (mode) sessionStorage.setItem('console-action-playback-mode', mode);
    else sessionStorage.removeItem('console-action-playback-mode');
  }

  function preservePlaybackAppearance(busy, healthy, fresh) {
    if (busy && healthy && !playbackVisualControls) {
      playbackVisualControls = [...document.querySelectorAll('#action-editor button:not(#center-all):not(#home-all), #action-editor select')]
        .filter(control => !control.disabled);
      for (const control of playbackVisualControls) control.classList.add('is-playback-pending');
    }
    if (busy) playbackVisualReleaseAt = null;
    else if (playbackVisualControls && playbackVisualReleaseAt === null) playbackVisualReleaseAt = performance.now() + 1500;
    if (playbackVisualControls && (!healthy || (!busy && (fresh || performance.now() >= playbackVisualReleaseAt)))) {
      for (const control of playbackVisualControls) control.classList.remove('is-playback-pending');
      playbackVisualControls = null;
      playbackVisualReleaseAt = null;
    }
  }

  function updatePlaybackButton(id, stopMode) {
    const button = $(id), mode = stopMode ? 'stop' : 'run';
    if (button.dataset.mode === mode) return;
    const label = stopMode ? '停止' : id === 'group-run' ? '运行动作组' : '运行';
    button.dataset.mode = mode;
    button.classList.toggle('is-stopping', stopMode);
    button.title = stopMode ? '停止后不再下发后续帧，已下发的目标继续完成' : label;
    button.setAttribute('aria-label', label);
    button.innerHTML = `<i data-lucide="${stopMode ? 'square' : 'play'}"></i><span>${label}</span>`;
    iconsRefresh();
  }

  function update() {
    const { info, state, armed, fresh, connectionError } = context();
    const playback = state?.action_playback || { state: 'idle' };
    followPlayback(state, playback);
    const busy = playbackBusy();
    if (!busy && state && playbackMode) setPlaybackMode(null);
    const healthy = armed && !!info && !info.readonly && state?.online && !state?.error && !connectionError;
    preservePlaybackAppearance(busy, healthy, fresh);
    servoPanel.setPlaybackPending(busy);
    const groupPlaying = busy && playbackMode === 'group';
    const actionPlaying = busy && !groupPlaying;
    const controlFresh = fresh || (healthy && performance.now() < frameGraceUntil);
    const ready = !!info && !info.readonly && armed && controlFresh && !state?.calibration?.active && !state?.parameter_batch_active;
    const count = String(frames.length);
    const total = `${(frames.reduce((sum, frame) => sum + frame.duration_ms, 0) / 1000).toFixed(2)} s`;
    if ($('action-count').textContent !== count) $('action-count').textContent = count;
    if ($('action-total').textContent !== total) $('action-total').textContent = total;
    const labels = { idle: '未播放', playing: `播放中 ${playback.frame || '…'} / ${playback.count || frames.length}`,
      stopped: `已停止${playback.error && playback.error !== '已停止' ? `：${playback.error}` : ''}`,
      completed: '播放结束，目标已下发', error: `播放失败：${playback.error || '未知错误'}` };
    const statusText = stopping ? '停止中' : starting && playback.state !== 'playing'
      ? '正在启动' : labels[playback.state] || '未播放';
    const terminal = ['stopped', 'completed', 'error'].includes(playback.state) && !stopping;
    $('action-status').hidden = terminal;
    const visibleStatus = terminal ? '' : statusText;
    if ($('action-status').textContent !== visibleStatus) $('action-status').textContent = visibleStatus;
    $('action-status').title = terminal ? '' : statusText;
    if (['stopped', 'completed', 'error'].includes(playback.state) && lastPlayback !== JSON.stringify(playback)) {
      toast(statusText, playback.state === 'error');
    }
    lastPlayback = JSON.stringify(playback);
    updatePlaybackButton('action-run', actionPlaying);
    updatePlaybackButton('group-run', groupPlaying);
    $('action-run').disabled = actionPlaying ? stopping : busy || !ready || !frames.length;
    $('group-run').disabled = groupPlaying ? stopping : busy || !ready || !$('action-groups').value;
    $('action-groups').disabled = busy;
    for (const button of body.querySelectorAll('.frame-play')) button.disabled = busy || !ready;
    for (const id of ['frame-delete', 'frame-update', 'frame-up', 'frame-down', 'frame-mirror']) $(id).disabled = selected < 0 || busy;
    $('frames-mirror').disabled = !frames.length || busy;
    for (const id of ['frame-add', 'frame-insert', 'frame-read']) $(id).disabled = busy || !info;
    for (const id of ['offset-read', 'offset-load']) $(id).disabled = busy || !ready;
    $('offset-save').disabled = busy || !offsets;
    for (const button of document.querySelectorAll('[data-step-target]')) button.disabled = $(button.dataset.stepTarget).disabled;
  }

  function capture(actual = false) {
    const values = servoPanel.positions(actual);
    for (const [id, value] of Object.entries(values)) if (value < 0 || value > 4095) throw new Error(`ID ${id} 的位置不能写入通用动作`);
    return { duration_ms: integerInput('frame-duration', 1, 30000), positions: values };
  }

  function insert(frame, index) {
    frames.splice(index, 0, frame); selected = index; render(); select(index);
  }

  async function mirror(indices) {
    const result = await request('action-document', { operation: 'mirror', document: makeDocument(), indices });
    frames = result.document.frames;
    render(); if (selected >= 0) select(selected);
  }

  async function sendFrame(frame) {
    if (!context().info?.supports_direct_action_frame) throw new Error('请重启控制台服务后使用单帧运行');
    const document = makeDocument([frame]);
    const lockedIds = servoPanel.lockedIds();
    validatePlaybackPositions(document.frames, lockedIds);
    servoPanel.cancel();
    frameGraceUntil = performance.now() + 1500;
    servoPanel.holdForFrame(frameGraceUntil);
    const result = await request('action-playback', { operation: 'send_frame', document, locked_ids: lockedIds });
    if (!result.sent) throw new Error('动作帧未发送完成');
  }

  async function run(source = frames, loop = $('action-loop').checked, mode = 'action') {
    const generation = ++playbackGeneration;
    trackedPlayback = null;
    starting = true; setPlaybackMode(mode); servoPanel.cancel(); update();
    try {
      const loaded = typeof source === 'function' ? await source() : source;
      if (generation !== playbackGeneration) return;
      if (mode === 'group') {
        openDocument(loaded);
        $('action-name').value = $('action-groups').value.replace(/\.csv$/i, '');
      }
      const document = makeDocument(mode === 'group' ? frames : loaded);
      const lockedIds = servoPanel.lockedIds();
      validatePlaybackPositions(document.frames, lockedIds);
      const promise = request('action-playback', { operation: 'start', document, loop, locked_ids: lockedIds });
      pendingStart = { generation, promise };
      const result = await promise;
      if (generation === playbackGeneration && result.state === 'playing') {
        const snapshot = context().state;
        trackedPlayback = { snapshot, runId: result.run_id, index: null };
        awaitingState = { snapshot, runId: result.run_id };
      }
    } catch (error) {
      if (generation === playbackGeneration) { setPlaybackMode(null); throw error; }
    } finally {
      if (pendingStart?.generation === generation) pendingStart = null;
      if (generation === playbackGeneration) { starting = false; update(); }
    }
  }

  async function stop() {
    if (stopping) return;
    const pending = pendingStart?.promise;
    playbackGeneration++;
    stopping = true; awaitingState = null; update();
    let failure = null;
    try {
      try { await request('action-playback', { operation: 'stop' }); } catch (error) { failure = error; }
      if (pending) {
        const [result] = await Promise.allSettled([pending]);
        if (result.status === 'rejected') console.warn('停止前的动作启动未完成', result.reason);
        try { await request('action-playback', { operation: 'stop' }); failure = null; } catch (error) { failure = error; }
      }
      if (failure) throw failure;
    } finally {
      starting = false; stopping = false; awaitingState = { snapshot: context().state }; update();
    }
  }

  function openDocument(document, append = false) {
    if (append) {
      const speed = $('use-speed').checked ? integerInput('action-speed', 1, 1000) : 100;
      const additions = document.frames.map(frame => ({ ...frame, duration_ms: Math.round(frame.duration_ms * 100 / speed) }));
      if (additions.some(frame => frame.duration_ms < 1 || frame.duration_ms > 30000)) {
        throw new Error('串联动作应用速度后存在超出通用动作时长范围的帧');
      }
      frames.push(...additions);
      importedLayout.push(...document.layout.filter(entry => !importedLayout.some(existing => existing[0] === entry[0])));
      selected = frames.length - 1;
    } else {
      $('use-speed').checked = false;
      $('action-speed').disabled = false;
      frames = document.frames; importedLayout = document.layout; selected = frames.length ? 0 : -1;
      actionId = document.action_id;
      servoPanel.setLayout(document.layout, document.layout_scale_percent);
    }
    render(); if (selected >= 0) select(selected);
  }

  async function refreshGroups() {
    const current = $('action-groups').value;
    const { names } = await request('action-document', { operation: 'list' });
    $('action-groups').replaceChildren(new Option('选择动作组', ''));
    for (const name of names) $('action-groups').add(new Option(name, name));
    if (names.includes(current)) $('action-groups').value = current;
    update();
  }

  async function loadGroup() {
    const name = $('action-groups').value;
    if (!name) throw new Error('请选择动作组');
    return (await request('action-document', { operation: 'load', name })).document;
  }

  async function chooseLocation(title, local, robot) {
    if (choosing) return;
    choosing = true;
    $('action-location-title').textContent = title;
    try {
      const option = await chooseDialog($('action-location'));
      // The dialog resolves in the submit event so that local pickers retain user activation.
      if (option === 'local') await local();
      if (option === 'robot') await robot();
    } finally {
      choosing = false;
    }
  }

  async function chooseRobotFile(title, offsets = false, proposedName = null) {
    const { names } = await request('action-document', { operation: offsets ? 'list_offsets' : 'list' });
    const dialog = $('action-select'), options = $('action-select-name'), filename = $('action-select-filename');
    const saving = proposedName !== null;
    $('action-select-title').textContent = title;
    $('action-select-directory').textContent = offsets ? 'offset-profiles/' : 'action-groups/';
    $('action-select-open').hidden = saving;
    $('action-select-save').hidden = !saving;
    filename.disabled = !saving;
    options.disabled = saving;
    options.replaceChildren(new Option(names.length ? '请选择文件' : '暂无文件', ''));
    $('action-select-existing').replaceChildren(...names.map(name => new Option('', name)));
    for (const name of names) options.add(new Option(name, name));
    filename.value = proposedName ?? '';
    $('action-select-confirm').disabled = !saving && !names.length;
    if (await chooseDialog(dialog) !== 'ok') return '';
    return saving ? filename.value.trim() : options.value;
  }

  function chooseLocalFile() {
    const input = $('action-local-file');
    input.value = '';
    return new Promise(resolve => {
      const selected = () => {
        input.removeEventListener('change', selected);
        input.removeEventListener('cancel', selected);
        resolve(input.files[0] ?? null);
      };
      input.addEventListener('change', selected);
      input.addEventListener('cancel', selected);
      input.click();
    });
  }

  function applyDocument(document, name, append) {
    openDocument(document, append);
    if (!append) $('action-name').value = name.replace(/\.csv$/i, '');
    toast(append ? `已串联动作：${name}` : `已打开动作：${name}`);
  }

  function chooseDocument(append) {
    const title = append ? '串联动作' : '打开动作';
    return chooseLocation(title, async () => {
      const file = await chooseLocalFile();
      if (!file) return;
      const { document } = await request('action-document', { operation: 'parse', content: await file.text() });
      applyDocument(document, file.name, append);
    }, async () => {
      const name = await chooseRobotFile(title);
      if (!name) return;
      const { document } = await request('action-document', { operation: 'load', name });
      applyDocument(document, name, append);
    });
  }

  function download(content, name) {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function saveLocalFile(name, serialize) {
    let handle;
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        handle = await window.showSaveFilePicker({ suggestedName: csvFilename(name), types: [csvPickerType] });
      } catch (error) {
        if (error.name === 'AbortError') return;
        if (error.name !== 'SecurityError') throw error;
      }
    }
    if (!handle) {
      const choice = await chooseDialog($('action-local-save'));
      if (choice !== 'download') return;
      const { content } = await serialize();
      download(content, csvFilename(name));
      return;
    }
    const { content } = await serialize();
    const writable = await handle.createWritable();
    try {
      await writable.write(content);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  }

  async function saveRobotFile(command) {
    try {
      return await request('action-document', command);
    } catch (error) {
      if (error.status !== 409) throw error;
      if (!await confirmAction('覆盖文件', `文件“${command.name}”已存在，是否覆盖？`)) return null;
      return request('action-document', { ...command, overwrite: true });
    }
  }

  function perform(fn) { Promise.resolve().then(fn).catch(error => toast(error.message, true)); }
  function on(id, fn) { $(id).addEventListener('click', () => perform(fn)); }

  for (const button of document.querySelectorAll('[data-step-target]')) button.addEventListener('click', () => perform(() => {
    const input = $(button.dataset.stepTarget);
    integerInput(input.id, Number(input.min), Number(input.max));
    if (button.dataset.step === '1') input.stepUp(); else input.stepDown();
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }));

  on('frame-add', () => insert(capture(), frames.length));
  on('frame-insert', () => insert(capture(), selected < 0 ? frames.length : selected + 1));
  on('frame-read', () => insert(capture(true), frames.length));
  on('frame-update', () => { if (selected < 0) throw new Error('请选择动作帧'); frames[selected] = capture(); render(); });
  on('frame-delete', () => { if (selected < 0) return; frames.splice(selected, 1); selected = Math.min(selected, frames.length - 1); render(); if (selected >= 0) select(selected); });
  for (const [id, delta] of [['frame-up', -1], ['frame-down', 1]]) on(id, () => {
    const destination = selected + delta;
    if (selected < 0 || destination < 0 || destination >= frames.length) return;
    [frames[selected], frames[destination]] = [frames[destination], frames[selected]]; selected = destination; render();
  });
  on('frame-mirror', () => selected >= 0 ? mirror([selected]) : undefined);
  on('frames-mirror', () => mirror(frames.map((_, index) => index)));
  $('frame-duration').addEventListener('change', () => perform(() => {
    const value = integerInput('frame-duration', 1, 30000);
    if (selected >= 0 && !$('lock-duration').checked) { frames[selected].duration_ms = value; render(); }
  }));
  $('use-speed').addEventListener('change', () => perform(() => {
    const enabled = $('use-speed').checked;
    let speed;
    try { speed = integerInput('action-speed', 1, 1000); }
    catch (error) { $('use-speed').checked = !enabled; throw error; }
    const durations = frames.map(frame => Math.round(frame.duration_ms * (enabled ? 100 / speed : speed / 100)));
    if (durations.some(duration => duration < 1 || duration > 30000)) {
      $('use-speed').checked = !enabled;
      throw new Error('应用速度后存在超出通用动作时长范围的帧');
    }
    durations.forEach((duration, index) => { frames[index].duration_ms = duration; });
    $('action-speed').disabled = enabled;
    render(); if (selected >= 0 && !$('lock-duration').checked) $('frame-duration').value = frames[selected].duration_ms;
  }));
  on('action-run', () => playbackBusy() ? stop() : run());
  on('action-open', () => chooseDocument(false));
  on('action-append', () => chooseDocument(true));
  on('action-save', () => {
    const document = makeDocument(), title = '保存动作';
    const proposed = $('action-name').value.trim() || '动作1';
    return chooseLocation(title, () => saveLocalFile(proposed, () =>
      request('action-document', { operation: 'serialize', document })), async () => {
      const name = await chooseRobotFile(title, false, proposed);
      if (!name) return;
      const result = await saveRobotFile({ operation: 'save', name, document });
      if (!result) return;
      await refreshGroups();
      $('action-name').value = result.name.replace(/\.csv$/i, '');
      $('action-groups').value = result.name;
      update(); toast('动作组已保存');
    });
  });
  on('groups-refresh', refreshGroups);
  $('action-groups').addEventListener('change', update);
  on('group-run', () => playbackBusy() ? stop() : run(loadGroup, $('action-loop').checked, 'group'));
  on('offset-read', async () => { offsets = await servoPanel.readOffsets(); update(); toast('偏差已读取'); });
  on('offset-save', () => {
    if (!offsets) throw new Error('请先读取偏差');
    const title = '保存偏差', proposed = 'servo.offsets.csv', values = servoPanel.offsetValues();
    return chooseLocation(title, () => saveLocalFile(proposed, () =>
      request('action-document', { operation: 'serialize_offsets', offsets: values })), async () => {
      const name = await chooseRobotFile(title, true, proposed);
      if (!name) return;
      const result = await saveRobotFile({ operation: 'save_offsets', name, offsets: values });
      if (result) toast('偏差文件已保存');
    });
  });
  async function applyOffsetProfile(values) {
    if (!await confirmAction('加载位置偏差', `将向 ${Object.keys(values).length} 个舵机写入并读回位置偏差。继续？`)) return;
    const count = await servoPanel.applyOffsets(values);
    offsets = values; update(); toast(`已写入并读回 ${count} 个舵机偏差`);
  }
  on('offset-load', () => chooseLocation('加载偏差', async () => {
    const file = await chooseLocalFile();
    if (!file) return;
    const { offsets } = await request('action-document', { operation: 'parse_offsets', content: await file.text() });
    await applyOffsetProfile(offsets);
  }, async () => {
    const name = await chooseRobotFile('加载偏差', true);
    if (!name) return;
    const { offsets } = await request('action-document', { operation: 'load_offsets', name });
    await applyOffsetProfile(offsets);
  }));

  return { update, render, refreshGroups };
}
