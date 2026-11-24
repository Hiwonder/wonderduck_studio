const viewerPages = new Set(['action', 'status', 'debug', 'calibration']);

export function createWorkspaceVisuals({ request, confirmAction, toast, context, onCalibrationSourceChange }) {
  const calibrationPanel = document.querySelector('#calibration-workspace .calibration-panel');
  calibrationPanel.inert = true;
  const palette = document.getElementById('model-palette');
  const resetView = document.getElementById('reset-view');
  palette.disabled = true;
  resetView.disabled = true;
  let page = '', calibrationActive = false, chartsActive = false;
  let viewer, viewerLoad, calibrationControls, calibrationCharts, calibrationLoad;
  let calibrationSource = 'body', headAvailable = true;
  let latestPose, latestStatuses, referenceTargets, pendingAlignment;

  function updateCalibration() {
    const { info, state, elapsed, connectionError } = context();
    if (state) {
      calibrationControls?.render(state.calibration, info?.demo, state.imu_source, state.head_calibration, state.aux_imu);
      calibrationCharts?.updateState(state, connectionError);
    } else if (info?.readonly) {
      calibrationControls?.render({}, false, 'robotd');
    }
    if (page === 'calibration') {
      viewer?.updateCalibration(calibrationSource, [state, elapsed, connectionError]);
    }
  }

  function refreshCharts() {
    if (!calibrationCharts) return;
    const active = page === 'calibration' && calibrationActive;
    if (chartsActive === active) return;
    chartsActive = active;
    calibrationCharts.setActive(active);
  }

  function loadCalibration() {
    if (calibrationLoad || calibrationControls) return;
    calibrationLoad = Promise.all([
      import('./calibration-controls.js'),
      import('./calibration-charts.js'),
    ]).then(([{ createCalibrationControls }, { createCalibrationCharts }]) => {
      calibrationControls = createCalibrationControls({ request, confirmAction, toast });
      calibrationControls.setHeadAvailable(headAvailable);
      calibrationCharts = createCalibrationCharts({
        request, context, onError: message => toast(message, true),
        onStatus: message => toast(message), onClear: toast.dismiss,
      });
      updateCalibration();
      refreshCharts();
      calibrationPanel.inert = false;
    }).catch(error => {
      console.error('加载校准组件失败', error);
      toast(`校准组件加载失败：${error.message}`, true);
    }).finally(() => { calibrationLoad = null; });
  }

  function applyPage() {
    if (viewer) {
      viewer.setPage(page);
      viewer.setCalibrationVisible(page === 'calibration');
    }
    refreshCharts();
  }

  function loadViewer() {
    if (viewerLoad || viewer) return;
    viewerLoad = import('./robot-viewer.js').then(({ createRobotViewer }) => {
      if (!viewerPages.has(page)) return;
      viewer = createRobotViewer({ request, toast, context });
      palette.disabled = false;
      resetView.disabled = false;
      if (latestPose) viewer.updatePose(latestPose);
      if (latestStatuses) viewer.updateStatuses(latestStatuses);
      if (referenceTargets) viewer.updateReferenceTargets(...referenceTargets);
      if (pendingAlignment) {
        viewer.alignPoseToPlatform(pendingAlignment);
        pendingAlignment = null;
      }
      updateCalibration();
      applyPage();
    }).catch(error => {
      console.error('加载模型查看器失败', error);
      toast(`模型查看器加载失败：${error.message}`, true);
    }).finally(() => { viewerLoad = null; });
  }

  function preview(value) {
    page = value;
    if (viewerPages.has(page)) loadViewer();
    if (page === 'calibration') loadCalibration();
    else calibrationActive = false;
    applyPage();
  }

  document.addEventListener('calibration-source-change', event => {
    calibrationSource = event.detail;
    calibrationCharts?.setSource(calibrationSource);
    updateCalibration();
    onCalibrationSourceChange();
  });

  return {
    preview,
    setCalibrationActive(active) {
      calibrationActive = active;
      refreshCharts();
    },
    calibrationSource: () => calibrationSource,
    setHeadAvailable(available) {
      headAvailable = available;
      calibrationControls?.setHeadAvailable(available);
    },
    updateCalibration,
    updateSelection: () => viewer?.updateSelection(),
    updateReferenceTargets(targets, joints) {
      referenceTargets = [targets, joints];
      viewer?.updateReferenceTargets(targets, joints);
    },
    updateStatuses(statuses) {
      latestStatuses = statuses;
      viewer?.updateStatuses(statuses);
    },
    updatePose(pose) {
      latestPose = pose;
      viewer?.updatePose(pose);
    },
    alignPoseToPlatform(targets) {
      if (viewer) viewer.alignPoseToPlatform(targets);
      else pendingAlignment = targets;
    },
  };
}
