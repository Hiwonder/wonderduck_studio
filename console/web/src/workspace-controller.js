import { createWorkspaceFrames } from './workspace-frames.js';
import { friendlyErrorMessage } from './user-messages.js';

const restrictedPages = new Set(['target', 'pickup', 'line', 'person', 'maze']);
const controlPages = new Set(['control', ...restrictedPages, 'system']);
const maintenancePages = new Set(['action', 'debug', 'calibration']);
const restPages = new Set(['status', ...maintenancePages]);
const resumePages = new Set(['status', 'action', 'debug', ...restrictedPages]);
const preparing = '正在准备页面，设备操作暂不可用';

export const isControlWorkspace = page => controlPages.has(page);

export function createWorkspaceController({
  $, request, requestHeaders, session, refreshInfo, revise, toast,
  onDisarm, waitForLocalWork, beforeLeave, onTransition,
  onPreview, onSelection, onReady, onFailure, onSettled, syncFrame, controlUrl,
}) {
  const control = $('control-workspace');
  const debug = $('debug-frame');
  let current = 'action';
  let visible = current;
  let phase = 'idle';
  let operation = null;
  let queued = null;
  let resumePending = false;
  let queueTimer = null;
  let noticeTimer = null;
  let releaseUnconfirmed = false;
  let browserPageHidden = false;
  let pageRelease = Promise.resolve();
  document.body.dataset.workspace = current;

  const frames = createWorkspaceFrames({
    control, debug, controlUrl,
    onDebugPreview() { syncFrame('debug'); },
  });

  function show(page, message, ready = false, dismissible = false) {
    visible = page;
    document.body.dataset.workspace = page;
    if (ready) document.body.dataset.studioReady = 'true';
    else delete document.body.dataset.studioReady;
    for (const choice of document.querySelectorAll('button[data-workspace]')) {
      const active = choice.dataset.workspace === page;
      choice.classList.toggle('active', active);
      if (active) choice.setAttribute('aria-current', 'page');
      else choice.removeAttribute('aria-current');
    }
    if (controlPages.has(page) && !ready) control.classList.toggle('frame-clearing', !frames.hasControl());
    control.hidden = !controlPages.has(page);
    control.inert = !ready;
    $('monitor').hidden = controlPages.has(page) || page === 'network' || page === 'models';
    for (const id of ['network', 'models']) {
      const panel = $(id + '-workspace');
      panel.hidden = page !== id;
      panel.inert = !ready;
    }
    for (const panel of document.querySelectorAll('[data-workspace-panel]')) {
      panel.hidden = panel.dataset.workspacePanel !== page;
      panel.inert = !ready;
    }
    onPreview(page);
    const notice = $('workspace-notice');
    clearTimeout(noticeTimer);
    notice.hidden = !message;
    $('workspace-notice-message').textContent = message || '';
    $('workspace-notice-close').hidden = !message || !dismissible;
    if (message && dismissible) noticeTimer = setTimeout(() => { notice.hidden = true; }, 8000);
  }

  $('workspace-notice-close').addEventListener('click', () => {
    clearTimeout(noticeTimer);
    $('workspace-notice').hidden = true;
  });

  function preview(page) {
    if (controlPages.has(page)) return frames.previewControl(page, () => visible === page);
    if (page === 'debug') return frames.previewDebug(() => visible === page && phase !== 'ready');
    return Promise.resolve();
  }

  function resumeSupported() {
    // Active calibration owns its own session. Restore only its readonly observation.
    return resumePages.has(current) || (current === 'calibration' && session().readonly);
  }

  function acceptResult(page, result) {
    if (result?.ready === false) throw new Error(result.error || '设备操作尚未就绪');
    if (page === 'status' && result?.ready !== true) {
      throw new Error(result?.error || '设备状态采集尚未就绪');
    }
    const unconfirmed = result?.release_unconfirmed === true;
    if (maintenancePages.has(page) && result?.maintenance !== true && !(result?.readonly && unconfirmed)) {
      throw new Error(result?.error || '维护工作区尚未就绪');
    }
    if (unconfirmed) {
      return { unconfirmed, warning: friendlyErrorMessage(result.warning || '卸力未确认') + ' 当前页面仅可查看。' };
    }
    const missing = result?.partial === true && page !== 'calibration' && Array.isArray(result.unavailable_ids);
    return { unconfirmed, warning: missing ? 'ID ' + result.unavailable_ids.join('、') + ' 未连接，其他舵机可正常操作。' : '' };
  }

  function selectPage(page, unconfirmed) {
    const previous = current;
    current = page;
    releaseUnconfirmed = unconfirmed;
    onSelection(previous, page);
  }

  function scheduleQueue() {
    if (queueTimer || operation || !queued || browserPageHidden || document.hidden) return;
    queueTimer = setTimeout(() => {
      queueTimer = null;
      if (operation || browserPageHidden || document.hidden) return;
      if (waitForLocalWork()) {
        scheduleQueue();
        return;
      }
      const next = queued;
      queued = null;
      if (next) select(next);
    }, waitForLocalWork() ? 200 : 0);
  }

  function queue(page) {
    queued = page;
    onDisarm();
    show(page, preparing);
    preview(page).catch(error => console.debug('操控预览不可用', error.message));
    scheduleQueue();
  }

  function select(page) {
    if (page === 'maze' && session().tof_enabled === false) return;
    if (operation || waitForLocalWork()) {
      queue(page);
      return;
    }
    queued = null;
    clearTimeout(queueTimer);
    queueTimer = null;
    if (page === current && (!session().studio || phase === 'ready') && !releaseUnconfirmed) return;
    return enter(page, false);
  }

  function restore() {
    const { studio, token } = session();
    if (!studio || !token || document.hidden || browserPageHidden || phase === 'failed' || !resumeSupported()) return;
    if (operation || queued) {
      resumePending = true;
      return;
    }
    return enter(current, true);
  }

  async function enter(next, restoring) {
    const { studio } = session();
    const previous = current;
    const wasReady = phase === 'ready';
    const restBefore = !restoring && studio && restPages.has(next)
      && (previous !== next || !wasReady || releaseUnconfirmed);
    const abort = new AbortController();
    operation = { abort, restoring };
    phase = restoring ? 'restoring' : 'entering';
    try {
      onTransition(true, restoring);
      if (studio) {
        revise();
        onDisarm();
        if (previous === 'debug' && (previous !== next || restoring)) frames.clearDebug();
        show(next, restoring ? '' : preparing);
      }
      let previewResult = studio && !restoring ? preview(next).catch(error => error) : null;
      let readiness = { unconfirmed: false, warning: '' };
      let restFallback = false;
      if (!restoring) await beforeLeave(previous, next, wasReady);
      abort.signal.throwIfAborted();
      if (studio) {
        if (previous !== next && controlPages.has(previous)) {
          const leaving = frames.leaveControl(abort.signal);
          previewResult = preview(visible).catch(error => error);
          await leaving.catch(error => console.warn('退出操控页面时继续交接', error));
        }
        abort.signal.throwIfAborted();
        if (restBefore) toast('正在准备进入页面，请稍候', false, { routine: true });
        await pageRelease;
        abort.signal.throwIfAborted();
        // A switch can already be moving the robot. Keep its completion serialized;
        // pagehide uses a newer server revision to reclaim the workspace safely.
        const result = await request('workspace', { workspace: next, ...(restBefore ? { rest_before: true } : {}) });
        abort.signal.throwIfAborted();
        readiness = acceptResult(next, result);
        restFallback = result?.rest_fallback === true;
        if (!restoring || (readiness.unconfirmed && !session().readonly)) await refreshInfo(abort.signal);
      }
      abort.signal.throwIfAborted();
      selectPage(next, readiness.unconfirmed);
      if (previous === 'debug' && next !== 'debug') debug.style.height = '';
      if (!controlPages.has(next) && !controlPages.has(queued) && frames.hasControl()) {
        frames.clearControl();
      }
      if (queued && queued !== next) return;
      queued = null;

      const previewError = await previewResult;
      if (controlPages.has(next)) {
        if (previewError) throw previewError;
        await preview(next);
        abort.signal.throwIfAborted();
        if (queued && queued !== next) return;
        syncFrame(next, false);
        await frames.activate(next, abort.signal);
      } else if (next === 'debug') {
        await frames.loadDebug(session().readonly, abort.signal);
        syncFrame(next);
      }
      abort.signal.throwIfAborted();
      if (queued && queued !== next) return;
      queued = null;
      phase = 'ready';
      show(next, readiness.warning, true, !!readiness.warning);
      if (restFallback) toast('休息未完成，已关闭策略并卸力');
      else if (restBefore && !readiness.warning) toast('页面已就绪', false, { routine: true });
      onReady(next, restoring);
    } catch (error) {
      if (abort.signal.aborted) {
        frames.disconnect();
        return;
      }
      console.warn('页面切换失败', error);
      phase = 'failed';
      if (next === 'debug' || previous === 'debug') frames.clearDebug();
      frames.disconnect();
      selectPage(next, false);
      onDisarm();
      if (queued && queued !== next) return;
      queued = null;
      const message = friendlyErrorMessage(error.message) + ' 设备操作暂不可用，请重新点击当前页面重试。';
      show(next, message, false, true);
      preview(next).catch(error => console.debug('操控预览不可用', error.message));
      onFailure(next, error, restoring);
    } finally {
      if (phase === 'entering' || phase === 'restoring') phase = 'idle';
      operation = null;
      onTransition(false, restoring);
      if (queued) {
        resumePending = false;
        scheduleQueue();
      } else if (resumePending) {
        resumePending = false;
        restore();
      } else if (phase === 'ready') {
        onSettled(current);
      }
    }
  }

  function onVisibilityChange() {
    const { studio, token } = session();
    if (studio && token && document.hidden && current === 'status') {
      revise();
      request('state').catch(error => console.debug('设备状态采集切换失败', error.message));
    }
    if (document.hidden) {
      onDisarm(true);
      if (operation?.restoring) operation.abort.abort();
    } else if (queued) {
      scheduleQueue();
    } else if (studio && resumeSupported() && !(phase === 'ready' && controlPages.has(current))) {
      restore();
    } else {
      onSettled(current);
    }
  }

  function onPageHide() {
    browserPageHidden = true;
    clearTimeout(queueTimer);
    queueTimer = null;
    queued = null;
    resumePending = false;
    onDisarm(true);
    const releasePage = operation || restPages.has(current) || restrictedPages.has(current);
    if (session().studio && session().token && releasePage) {
      operation?.abort.abort();
      if (phase !== 'failed') phase = 'suspended';
      frames.disconnect();
      delete document.body.dataset.studioReady;
      control.inert = true;
      revise();
      pageRelease = fetch('/api/workspace', { method: 'POST', headers: requestHeaders(),
        body: JSON.stringify({ operation: 'leave' }), keepalive: true, signal: AbortSignal.timeout(5000) })
        .catch(error => console.debug('工作区关闭请求未送达', error.message));
    }
  }

  function onPageShow() {
    const returning = browserPageHidden;
    browserPageHidden = false;
    if (session().studio && resumeSupported()) {
      restore();
    } else if (returning && session().studio && phase === 'suspended') {
      select(current);
    } else {
      onSettled(current);
    }
  }

  control.addEventListener('load', () => {
    if (operation || phase !== 'ready' || !controlPages.has(current)) return;
    syncFrame(current, false);
    frames.resumeControl(current);
  });
  debug.addEventListener('load', () => frames.notify('studio-theme', { theme: document.documentElement.dataset.theme }));

  for (const button of document.querySelectorAll('button[data-workspace]')) {
    button.addEventListener('click', () => select(button.dataset.workspace));
  }
  setInterval(() => {
    const { studio, readonly } = session();
    if (studio && !readonly && phase === 'ready' && maintenancePages.has(current) && !document.hidden) {
      request('workspace', { operation: 'heartbeat' }).catch(error => { onDisarm(); toast(error.message, true); });
    }
  }, 5000);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);

  return {
    get current() { return current; },
    get busy() { return operation !== null; },
    get ready() { return phase === 'ready' && queued === null; },
    select,
    notify: frames.notify,
    leaveControl: frames.leaveControl,
    resumeControl() {
      if (phase === 'ready' && queued === null && !browserPageHidden) frames.resumeControl(current);
    },
  };
}
