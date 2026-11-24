import { createControlSession } from './control-session.js';
import { createControlPages, createRun, createVisionState } from './control-pages.js';
import { bindMotionInput } from './motion-input.js';

(() => {
      // Keep the original validation message so an invalid input changes
      // language without changing its value or validation state.
      const validationMessages = new Map();
      const setValidity = (input, message) => {
        if (message) validationMessages.set(input, message);
        else validationMessages.delete(input);
        input.setCustomValidity(window.WonderduckLanguage?.translate(message) || message);
      };
      window.addEventListener('studio-language-change', () => {
        for (const [input, message] of validationMessages) {
          if (!input.isConnected) validationMessages.delete(input);
          else input.setCustomValidity(window.WonderduckLanguage?.translate(message) || message);
        }
      });
      const tofEnabled = document.body.dataset.tofEnabled !== 'false';
      const isVisionPage = () => document.body.hasAttribute('data-vision-page');
      const targetHeadOnly = () => document.body.dataset.consolePage === 'target';
      const lineFollowing = () => document.body.dataset.consolePage === 'line';
      const pickupPage = () => document.body.dataset.consolePage === 'pickup';
      const pages = createControlPages();
      const state = pages.control.input;
      state.active = !document.hidden;
      const {headStickAxes} = pages.control;
      const headStickPosition = [document.querySelector('#head-stick-pitch'), document.querySelector('#head-stick-yaw')];
      const headCenterButton = document.querySelector('[data-action="center_head"]');
      let studioLeaveRequest = null;
      let nextActionRequestId = 0, powerActionRequestId = null;
      let controlLeaseReady = false;
      const controlBusy = document.querySelector('#control-busy');
      const embeddedStudio = document.documentElement.dataset.studioEmbedded === 'true' && window.parent !== window;
      let studioActive = !embeddedStudio;
      let driveControlReady = false;
      let restPhase = null, motionEnabled = null, motionHomed = null, powerSequence = 0;
      let powerPending = null, powerAcknowledged = false, powerRequestSequence = 0;
      const skillLabels = { sit_toggle: "坐下 / 站起", ground_pick: "地面拾取", roulade: "翻滚", headstand: "倒立", kick_left: "左踢", kick_right: "右踢" };
      let linearSpeed = 0.30;
      let turnSpeed = 1;
      const modeCopy = {
        drive: {
          label: "移动控制",
          leftHint: "移动", leftSummary: "前后或横移方向 ±20° 内，仅输出对应主轴分量。",
          rightHint: "转向", rightSummary: "当前模式仅使用左右转向。",
          axes: { "left-top": "前进", "left-bottom": "后退", "left-left": "左移", "left-right": "右移", "right-top": "未使用", "right-bottom": "未使用", "right-left": "左转", "right-right": "右转" },
        },
        head: {
          label: "头部控制",
          leftHint: "头部偏航 / 俯仰", leftSummary: "左右头部偏航，上下头部俯仰。",
          rightHint: "头部横滚 / 颈部", rightSummary: "左右头部横滚，上下颈部俯仰。",
          axes: { "left-top": "头部俯仰", "left-bottom": "头部俯仰", "left-left": "头部偏航", "left-right": "头部偏航", "right-top": "颈部俯仰", "right-bottom": "颈部俯仰", "right-left": "头部横滚", "right-right": "头部横滚" },
        },
        head_drive: {
          label: "头部＋行走",
          leftHint: "行走 / 转向", leftSummary: "上下前后，左右转向；无横移。",
          rightHint: "头部", rightSummary: "上下俯仰，左右偏航。",
          axes: { "left-top": "前进", "left-bottom": "后退", "left-left": "左转", "left-right": "右转", "right-top": "头部俯仰", "right-bottom": "头部俯仰", "right-left": "头部偏航", "right-right": "头部偏航" },
        },
        body_pose: {
          label: "躯干姿态",
          leftHint: "躯干高度 / 横滚", leftSummary: "上抬高，下降低；左右躯干横滚。",
          rightHint: "头部", rightSummary: "上下头部俯仰，左右头部偏航。",
          axes: { "left-top": "抬高", "left-bottom": "降低", "left-left": "躯干横滚", "left-right": "躯干横滚", "right-top": "头部俯仰", "right-bottom": "头部俯仰", "right-left": "头部偏航", "right-right": "头部偏航" },
        },
      };
      const actionNames = {
        init: "初始化机器人", prepare_drive: "初始化并启用行走策略", toggle_policy: "启用 / 停止策略", drive_mode: "移动控制",
        head_mode: "头部控制", body_pose_mode: "躯干姿态", ground_pick: "地面拾取",
        sit_toggle: "坐下 / 站起", kick_left: "左踢", kick_right: "右踢", roulade: "翻滚",
        headstand: "倒立", home: "回HOME", center_head: "头部回中", rest: "休息卸力", shutdown: "关机", sit_on_loss: "失联后坐下", stop: "停止当前动作", relax: "关闭所有关节扭矩",
      };
      const actionButtons = [...document.querySelectorAll('[data-action]')];
      const skillButtons = [...document.querySelectorAll('.skill-actions [data-action]')];
      const skillActions = new Set(skillButtons.map(button => button.dataset.action));
      const pendingSkills = new Map();
      let activeSkill = null, skillStatusSequence = null, lastSkillTimeoutSequence = null;
      const skillRefusals = {
        'a scripted move is already running': '已有动作正在执行',
        'the skill request is already pending': '已收到动作请求，正在等待确认',
        'the skill is already running': '该动作正在执行',
        'the skill request timed out before it could start': '动作启动请求超时',
        'the skill request was stopped': '动作请求已取消',
        'the robot is recovering after a skill timeout': '机器人正在从动作超时中恢复',
        'recovering after a skill timed out': '机器人正在从动作超时中恢复',
        'the policy is not ready': '运动策略尚未就绪',
        'automatic seated recovery is running': '机器人正在从坐姿自动恢复',
        'no ground-pick policy loaded': '未加载地面拾取策略',
        'ground pick already running': '地面拾取正在执行',
        'a ground pick is running': '地面拾取正在执行',
        'a roll is in progress': '翻滚正在执行',
        'no such skill on this robot': '机器人没有该动作',
        'skill is no longer loaded': '该动作已卸载',
        'skill was already running': '该动作正在执行',
        'headstand requires a headstand_phase policy': '倒立需要已加载的倒立策略',
        'stand up before starting a headstand': '请先站起再执行倒立',
        'stand up before starting this skill': '请先站起再执行该动作',
        'the policy is not driving — press Start on the pad': '请先启动运动控制',
        'the robot is still going to its home pose; try again in a moment': '机器人正在回到初始姿态，请稍后再试',
        'this robot has no skills configured': '机器人没有配置动作',
      };
      let sequence = 0;
      const session = createControlSession({
        onMessage: handleControlMessage,
        onClose: handleControlClose,
        onPulse: () => sendInput(),
      });
      let mode = "drive";
      let visionModeRequested = false;
      let ownsControl = false;
      let otherController = false;
      const dot = document.querySelector("#dot");
      const connection = document.querySelector("#connection");
      const notice = document.querySelector("#notice");
      const motionPower = document.querySelector('#motion-power');
      const motionBlockedDialog = document.querySelector('#motion-blocked');
      const shutdownConfirm = document.querySelector('#shutdown-confirm');
      const leftHint = document.querySelector("#left-hint");
      const rightHint = document.querySelector("#right-hint");
      const leftSummary = document.querySelector("#left-summary");
      const rightSummary = document.querySelector("#right-summary");
      const robotdSummary = document.querySelector("#robotd-summary");
      const robotdStatus = document.querySelector("#robotd-status");
      const healthStatus = document.querySelector("#health-status");
      const batteryStatus = document.querySelector("#battery-status");
      const batteryVoltage = document.querySelector("#battery-voltage");
      const batteryIndicator = document.querySelector("#battery-indicator");
      const batteryFill = document.querySelector("#battery-fill");
      const motorStatus = document.querySelector("#motor-status");
      const cpuStatus = document.querySelector("#cpu-status");
      const robotModeStatus = document.querySelector("#robot-mode-status");
      const policyStatus = document.querySelector("#policy-status");
      const loopStatus = document.querySelector("#loop-status");
      const gyroStatus = document.querySelector("#gyro-status");
      const rpyStatus = document.querySelector("#rpy-status");
      const safetyStatus = document.querySelector("#safety-status");
      const statusDetail = document.querySelector("#status-detail");
      const tofDistance = document.querySelector("#tof-distance");
      const obstacleEnabled = document.querySelector("#obstacle-enabled");
      const obstacleDistance = document.querySelector("#obstacle-distance");
      const obstacleDelay = document.querySelector("#obstacle-delay");
      const obstacleDistanceValue = document.querySelector("#obstacle-distance-value");
      const obstacleDelayValue = document.querySelector("#obstacle-delay-value");
      const obstacleState = document.querySelector("#obstacle-state");
      let confirmedObstacle = null;
      let obstaclePending = false;
      const speedInput = document.querySelector("#speed-input");
      const speedRange = document.querySelector("#speed-range");
      const turnInput = document.querySelector("#turn-input");
      const turnRange = document.querySelector("#turn-range");
      const triggerRanges = [...document.querySelectorAll("[data-trigger-range]")];
      const motion = bindMotionInput({
        state, headStickAxes, isVisionPage, triggerRanges,
        headStickAvailable: () => mode !== 'body_pose' && document.body.dataset.consolePage === 'control',
        displayMode: () => displayMode(),
        sticksBlocked: () => sticksBlocked(),
        motionUnavailable: () => motionUnavailable(),
        remindMotion: () => remindMotion(),
        sendInput: () => sendInput(),
      });
      const {keys} = motion;
      let pickMouthTimer = null, pickMouthActive = false, pickMouthOpened = false, pickMouthButton = null;
      function cancelPickMouth(close = false) {
        clearTimeout(pickMouthTimer);
        pickMouthTimer = null;
        const wasOpened = pickMouthOpened;
        pickMouthActive = false;
        pickMouthOpened = false;
        pickMouthButton = null;
        if (close && wasOpened) {
          state.left_trigger = 0;
          triggerRanges.filter(range => range.dataset.triggerRange === 'left_trigger')
            .forEach(range => { range.value = '0'; });
          sendInput();
        }
      }
      function schedulePickMouth(button) {
        cancelPickMouth(true);
        pickMouthActive = true;
        pickMouthButton = button;
        const startedAt = performance.now();
        pickMouthTimer = setTimeout(() => {
          if (!studioActive || !state.active || document.body.dataset.consolePage !== 'control'
              || motionUnavailable() || !ownsControl || !session.open
              || performance.now() - startedAt >= 1500) {
            cancelPickMouth(true);
            return;
          }
          pickMouthOpened = true;
          state.left_trigger = 1;
          triggerRanges.filter(range => range.dataset.triggerRange === 'left_trigger')
            .forEach(range => { range.value = '1'; });
          sendInput();
          pickMouthTimer = setTimeout(() => cancelPickMouth(true), Math.max(0, 1500 - (performance.now() - startedAt)));
        }, 200);
      }
      const audioVolume = document.querySelector('#audio-volume');
      const audioVolumeValue = document.querySelector('#audio-volume-value');
      const trackingStart = document.querySelector('#tracking-start');
      const pickupSequenceStart = document.querySelector('#pickup-sequence-start');
      const headPosition = document.querySelector('#head-position');
      const headPositionSetting = document.querySelector('#head-position-setting');
      const followStopArea = document.querySelector('#follow-stop-area');
      const followAreaDeadzone = document.querySelector('#follow-area-deadzone');
      const followStopDistance = document.querySelector('#follow-stop-distance');
      const followDistanceDeadzone = document.querySelector('#follow-distance-deadzone');
      const personDefaults = {headPosition: 2100, area: 320000, areaDeadzone: 80000,
        distance: 900, distanceDeadzone: 100};
      const targetHeadDefault = 2200;
      const savedFollowStopArea = Number(localStorage.getItem('person-follow-stop-area'));
      pages.person.limits.area = Number.isSafeInteger(savedFollowStopArea) && savedFollowStopArea > 0
        ? savedFollowStopArea : personDefaults.area;
      followStopArea.value = String(pages.person.limits.area);
      const savedAreaDeadzone = localStorage.getItem('person-follow-area-deadzone');
      const parsedAreaDeadzone = Number(savedAreaDeadzone);
      pages.person.limits.areaDeadzone = savedAreaDeadzone !== null && Number.isSafeInteger(parsedAreaDeadzone)
        && parsedAreaDeadzone >= 0 ? parsedAreaDeadzone : personDefaults.areaDeadzone;
      followAreaDeadzone.value = String(pages.person.limits.areaDeadzone);
      const savedFollowDistance = Number(localStorage.getItem('person-follow-stop-distance'));
      pages.person.limits.distance = Number.isSafeInteger(savedFollowDistance)
        && savedFollowDistance > 0 && savedFollowDistance <= 4294967295 ? savedFollowDistance : personDefaults.distance;
      followStopDistance.value = String(pages.person.limits.distance);
      const savedDistanceDeadzone = localStorage.getItem('person-follow-distance-deadzone');
      const parsedDistanceDeadzone = Number(savedDistanceDeadzone);
      pages.person.limits.distanceDeadzone = savedDistanceDeadzone !== null && Number.isSafeInteger(parsedDistanceDeadzone)
        && parsedDistanceDeadzone >= 0 && parsedDistanceDeadzone <= 4294967295 ? parsedDistanceDeadzone : personDefaults.distanceDeadzone;
      followDistanceDeadzone.value = String(pages.person.limits.distanceDeadzone);
      let headPositionState = 'idle', headPositionWanted = false;
      const currentHeadPositionScope = () => targetHeadOnly() ? 'home'
        : document.body.dataset.consolePage === 'person' ? 'person'
          : pickupPage() ? trackingScope : 'target';
      let headPositionScope = 'target';
      let targetHeadHome = null, headPositionTarget = null;
      const headPositionKey = scope => `${scope}-follow-head-position`;
      const applyHeadPositionScope = scope => {
        let value = scope === 'home'
          ? (targetHeadHome === null ? '' : String(targetHeadHome))
          : localStorage.getItem(headPositionKey(scope))
            ?? String(scope === 'person' ? personDefaults.headPosition : targetHeadDefault);
        if (scope === 'person' && [2200, 2150].includes(Number(value))) {
          value = String(personDefaults.headPosition);
          localStorage.setItem(headPositionKey(scope), value);
        }
        headPosition.value = value;
        headPositionTarget = value !== '' && Number.isInteger(Number(value))
          && Number(value) >= 1024 && Number(value) <= 2250 ? Number(value) : null;
      };
      applyHeadPositionScope(headPositionScope);
      const trackingStop = document.querySelector('#tracking-stop');
      const coordinatedStatus = document.querySelector("#coordinated-status");
      const trackingGuide = document.querySelector('#tracking-guide');
      const trackingGoal = document.querySelector('#tracking-goal');
      const trackingTargetMarker = document.querySelector('#tracking-target');
      const coordinatedInputSelector = '[data-coordinated-pid-axis], [data-coordinated-pid-range], [data-coordinated-deadzone], [data-coordinated-body-gain], [data-coordinated-final-point], [data-coordinated-final-tolerance], [data-coordinated-arrival-skill], [data-coordinated-mouth], #coordinated-arrival-delay';
      const phaseInputSelector = '[data-coordinated-phase-gain], [data-coordinated-phase-limit]';
      const coordinatedInputs = [...document.querySelectorAll(coordinatedInputSelector)];
      const phaseInputs = [...document.querySelectorAll(phaseInputSelector)];
      const arrivalSkillInput = document.querySelector('#coordinated-arrival-skill');
      const arrivalDelayInput = document.querySelector('#coordinated-arrival-delay');
      const lineSpeedInput = document.querySelector('#line-speed');
      const colorPresetSelect = document.querySelector('#color-presets');
      const colorPresetName = document.querySelector('#color-preset-name');
      const colorPresetSave = document.querySelector('#color-preset-save');
      const colorPresetDelete = document.querySelector('#color-preset-delete');
      const colorThreshold = document.querySelector('#color-threshold');
      const mazeButton = document.querySelector("#maze");
      const mazeStop = document.querySelector("#maze-stop");
      const mazeStatus = document.querySelector("#maze-status");
      const resetSettings = document.querySelector('#reset-settings');
      const settingsStatus = document.querySelector('#settings-status');
      let settingsSaving = false, colorReference = null, colorChosen = false, objectLabelPreference = null;
      let settingsLoaded = false, settingsDirty = false, applyingSettings = false, settingsFailed = false;
      let settingsTimer = null, settingsMessageTimer = null, settingsDefaults = null, pendingSettingsJson = null, savedSettingsJson = null;
      let settingsRequest = 0, settingsPendingId = null, robotConnected = false;
      let colorPresets = new Map(), colorPresetsLoaded = false, colorPresetPending = null, colorPresetRevision = 0;
      let headSettingsDirty = false, headSettingsSaving = false, headSettingsFailed = false;
      let headSettingsTimer = null, headSettingsDefaults = null, headSettingsPendingId = null;
      let headPendingJson = null, headSavedJson = null;
      let coordinatedSettingsReady = false, coordinatedLeaseReady = false, coordinatedDefaults = null;
      let phaseReady = false, phaseDefaults = null;
      let personCoordinatedDefaults = null, personPhaseDefaults = null;
      const trackingProfiles = {target: pages.pickup.before, pickup_after: pages.pickup.after, person: pages.person.profile};
      let trackingScope = 'target';
      const pickupStageButtons = [...document.querySelectorAll('[data-pickup-stage]')];
      const trackingProfile = () => trackingProfiles[trackingScope];
      const trackingBusy = () => Object.values(trackingProfiles).some(profile =>
        profile.coordinatedSaving || profile.phaseSaving);
      const trackingUnsaved = () => Object.values(trackingProfiles).some(profile =>
        profile.coordinatedSaving || profile.coordinatedDirty || profile.phaseSaving || profile.phaseDirty);
      let restoreObstacle = null;
      const mazeInputs = [...document.querySelectorAll('[data-maze]')];
      pages.maze.settings = Object.fromEntries(mazeInputs.map(input => [input.dataset.maze, Number(input.value)]));
      let selectedPage = pages[document.body.dataset.consolePage];
      const nonVision = createVisionState();
      let vision = selectedPage?.vision ?? nonVision;
      let camera = null;
      const visionDirect = {color: false, object: false};
      let visionSource = 'color';
      const lineRun = pages.line.run;
      const mazeRun = pages.maze.run;
      // Start replies carry only the command type and action. Keep ownership
      // with the sending page until its reply arrives or the session closes.
      let coordinatedOwner = null;
      const idleCoordinated = createRun();
      let coordinatedRun = selectedPage?.coordinatedRun ?? idleCoordinated;
      const coordinatedHeadDeadzone = [0.1, 0.05];
      const coordinatedGains = [[0.5, 0.04, 0.01], [0.5, 0.04, 0.01]];
      const coordinatedBodyGains = [0.2, 0.3, 1.0];
      const finalBodyGains = [0.2, 0.3, 1.0];
      let approachLinearLimit = null, finalLinearLimit = 0.1, finalLateralLimit = 0.1;
      const coordinatedFinalPoint = [180, 150];
      const coordinatedFinalTolerance = [10, 10];
      const coordinatedMouth = {
        before: {enabled: false, open: 0, duration_s: 0.5},
        after: {enabled: false, open: 0, duration_s: 0.5},
      };
      const updateTrackingGuide = () => {
        const showGoal = ['pickup', 'person'].includes(document.body.dataset.consolePage);
        trackingGuide.hidden = !isVisionPage() || (showGoal && !coordinatedSettingsReady);
        trackingGoal.hidden = !showGoal;
        trackingGoal.style.left = `${(coordinatedFinalPoint[0] - coordinatedFinalTolerance[0]) / 320 * 100}%`;
        trackingGoal.style.top = `${(coordinatedFinalPoint[1] - coordinatedFinalTolerance[1]) / 180 * 100}%`;
        trackingGoal.style.width = `${coordinatedFinalTolerance[0] / 160 * 100}%`;
        trackingGoal.style.height = `${coordinatedFinalTolerance[1] / 90 * 100}%`;
      };
      const updateTrackingMarker = point => {
        const valid = Array.isArray(point) && point.length === 2
          && point.every(value => Number.isFinite(value) && Math.abs(value) <= 1);
        trackingTargetMarker.hidden = !valid;
        if (valid) {
          trackingTargetMarker.style.left = `${(point[0] + 1) * 50}%`;
          trackingTargetMarker.style.top = `${(point[1] + 1) * 50}%`;
        }
      };
      let coordinatedArrivalDelay = 1;
      let coordinatedArrivalSkill = '', availableSkills = [];
      let savedAudioVolume = null, confirmedVolume = null, desiredVolume = null;
      let volumeBusy = false, volumeTimer = null, volumeRevision = 0;
      const sticksBlocked = () => !controlLeaseReady || !driveControlReady || otherController || !session.open || mazeRun.active || mazeRun.pending || vision.awaitingTarget
        || lineRun.active || lineRun.pending || coordinatedOwner !== null;
      const updateSticksAvailability = () => {
        const disabled = sticksBlocked();
        motion.setDisabled(disabled);
        headCenterButton.disabled = headCenterUnavailable();
      };
      const zero = () => {
        cancelPickMouth();
        visionModeRequested = false;
        motion.reset();
        sendInput();
      };
      const setNotice = (text, error = false) => {
        notice.textContent = text;
        notice.title = text;
        notice.classList.toggle("error", error);
      };
      const motionUnavailable = () => powerPending !== null || restPhase !== 'idle'
        || motionEnabled !== true || motionHomed !== true;
      const headCenterUnavailable = () => motionUnavailable() || sticksBlocked() || mode === 'body_pose';
      const remindMotion = () => {
        if (motionBlockedDialog.open || shutdownConfirm.open) return;
        const text = restPhase === 'resting' || powerPending === 'rest'
          ? '机器人正在休息，请等待休息完成，再点击启动。'
          : restPhase === 'failed' ? '休息未完成，请先重试休息。'
          : powerPending === 'start' ? '机器人正在启动，请等待初始化完成。'
          : restPhase === null ? '机器人状态尚未就绪，请稍后重试。'
          : '机器人已休息，请点击运动控制中的启动后再操控。';
        document.querySelector('#motion-blocked-text').textContent = text;
        motionBlockedDialog.showModal();
      };
      const renderMotionPower = () => {
        const connected = session.open && restPhase !== null;
        let label = '等待状态', icon = '#icon-moon';
        if (powerPending === 'rest' || restPhase === 'resting') label = '休息中';
        else if (powerPending === 'start') label = '启动中';
        else if (restPhase === 'failed') label = '重试休息';
        else if (restPhase === 'rested' || motionEnabled === false || motionHomed === false) {
          label = '启动'; icon = '#icon-circle-play';
        } else if (connected && motionEnabled === true && motionHomed === true) label = '休息';
        setText(motionPower.querySelector('span'), label);
        motionPower.querySelector('use').setAttribute('href', icon);
        motionPower.disabled = !connected || powerPending !== null || restPhase === 'resting'
          || motionEnabled === null || motionHomed === null;
        updateSticksAvailability();
      };
      const updatePowerState = status => {
        const wasAvailable = !motionUnavailable();
        const previousPhase = restPhase, previousPending = powerPending;
        restPhase = status.robotd_connected === true ? status.rest_phase || null : null;
        motionEnabled = status.robotd_connected === true && typeof status.motion_enabled === 'boolean'
          ? status.motion_enabled : null;
        motionHomed = status.robotd_connected === true && typeof status.motion_homed === 'boolean'
          ? status.motion_homed : null;
        powerSequence = Number.isSafeInteger(status.power_status_sequence) ? status.power_status_sequence : 0;
        if (powerPending && powerAcknowledged && powerSequence > powerRequestSequence) {
          if (powerPending === 'rest' && ['resting', 'rested', 'failed'].includes(restPhase)) powerPending = null;
          if (powerPending === 'start' && restPhase === 'idle' && motionEnabled && motionHomed) powerPending = null;
        }
        if (wasAvailable && motionUnavailable()) { keys.clear(); zero(); stopAllTracking(false); stopMaze(false); }
        if (previousPending === 'start' && powerPending === null && !motionUnavailable()) setNotice('行走控制已就绪。');
        if (previousPhase === 'resting' && restPhase === 'rested') setNotice('休息已完成，点击启动可恢复操控。');
        if (previousPhase === 'resting' && restPhase === 'failed') setNotice('休息未完成，请重试休息。', true);
        renderMotionPower();
        reconcileHeadPosition();
      };
      const settingsReady = () => session.open && (!tofEnabled || !!confirmedObstacle);
      const markSettingsSaved = () => {
        if (!settingsDirty && !settingsSaving && !headSettingsDirty && !headSettingsSaving
          && !trackingUnsaved()) {
          settingsStatus.textContent = '参数已自动保存';
          clearTimeout(settingsMessageTimer);
          settingsMessageTimer = setTimeout(() => {
            if (settingsStatus.textContent === (window.WonderduckLanguage?.translate('参数已自动保存') || '参数已自动保存')) settingsStatus.textContent = '';
          }, 3000);
        }
      };
      const updateSettingsState = () => {
        resetSettings.disabled = !settingsLoaded || !settingsDefaults || !headSettingsDefaults || !coordinatedLeaseReady || !phaseReady || !settingsReady()
          || Object.values(trackingProfiles).some(profile => !profile.coordinatedReady || !profile.phaseReady)
          || settingsSaving || headSettingsSaving || trackingBusy();
        if (settingsDirty && !settingsSaving && settingsTimer === null) flushSettings();
        if (headSettingsDirty && !headSettingsSaving && headSettingsTimer === null) flushHeadSettings();
        for (const [scope, profile] of Object.entries(trackingProfiles)) {
          if (profile.coordinatedDirty && !profile.coordinatedSaving && profile.coordinatedTimer === null) flushCoordinatedSettings(false, scope);
          if (profile.phaseDirty && !profile.phaseSaving && profile.phaseTimer === null) flushPhaseSettings(false, scope);
        }
      };
      const updateHeadPidRange = (input, value) => {
        const range = input.previousElementSibling;
        range.min = String(Math.min(0, value));
        range.max = String(Math.max(10, value));
        range.value = String(value);
      };
      const applyHeadSettings = (saved) => {
        const previous = applyingSettings;
        applyingSettings = true;
        for (const input of document.querySelectorAll('[data-head-tracking-deadzone]')) {
          const axis = Number(input.dataset.headTrackingDeadzone);
          pages.target.deadzone[axis] = saved.deadzone[axis];
          input.value = String(pages.target.deadzone[axis] * 100);
          setValidity(input, '');
        }
        for (const input of document.querySelectorAll('[data-head-pid-axis]')) {
          const axis = Number(input.dataset.headPidAxis), term = Number(input.dataset.headPidTerm);
          pages.target.gains[axis][term] = saved.gains[axis][term];
          input.value = String(pages.target.gains[axis][term]);
          setValidity(input, '');
          updateHeadPidRange(input, pages.target.gains[axis][term]);
        }
        applyingSettings = previous;
      };
      const collectHeadSettings = () => ({ deadzone: [...pages.target.deadzone], gains: pages.target.gains.map(axis => [...axis]) });
      const validGains = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
      const validDeadzone = value => Number.isFinite(value) && value >= 0;
      const validMouth = value => value && Object.keys(value).length === 3
        && typeof value.enabled === 'boolean' && Number.isFinite(value.open)
        && value.open >= 0 && value.open <= 1 && validDeadzone(value.duration_s);
      const validCoordinatedSettings = value => value && Object.keys(value).length === 9
        && Object.hasOwn(value, 'head_deadzone') && Object.hasOwn(value, 'head_gains') && Object.hasOwn(value, 'body_gains') && Object.hasOwn(value, 'final_point') && Object.hasOwn(value, 'final_tolerance') && Object.hasOwn(value, 'arrival_skill') && Object.hasOwn(value, 'arrival_delay_s')
        && Array.isArray(value.head_deadzone) && value.head_deadzone.length === 2 && value.head_deadzone.every(validDeadzone)
        && Array.isArray(value.head_gains) && value.head_gains.length === 2 && value.head_gains.every(validGains)
        && validGains(value.body_gains)
        && Array.isArray(value.final_point) && value.final_point.length === 2
        && value.final_point.every((point, axis) => Number.isFinite(point) && point >= 0 && point <= [320, 180][axis])
        && Array.isArray(value.final_tolerance) && value.final_tolerance.length === 2 && value.final_tolerance.every(validDeadzone)
        && validDeadzone(value.arrival_delay_s) && typeof value.arrival_skill === 'string'
        && validMouth(value.mouth_before) && validMouth(value.mouth_after);
      const renderArrivalSkills = () => {
        const label = name => Object.hasOwn(skillLabels, name) ? skillLabels[name] : name;
        const options = [new Option('无', '')];
        for (const skill of availableSkills) options.push(new Option(label(skill), skill));
        if (coordinatedArrivalSkill && !availableSkills.includes(coordinatedArrivalSkill)) {
          const unavailable = new Option(`${label(coordinatedArrivalSkill)}（不可用）`, coordinatedArrivalSkill);
          unavailable.disabled = true;
          options.push(unavailable);
        }
        arrivalSkillInput.replaceChildren(...options);
        arrivalSkillInput.value = coordinatedArrivalSkill;
      };
      const applyCoordinatedSettings = saved => {
        coordinatedHeadDeadzone.splice(0, 2, ...saved.head_deadzone);
        const gains = saved.head_gains;
        for (const input of document.querySelectorAll('[data-coordinated-pid-axis]')) {
          const axis = Number(input.dataset.coordinatedPidAxis), term = Number(input.dataset.coordinatedPidTerm);
          coordinatedGains[axis][term] = gains[axis][term];
          input.value = String(gains[axis][term]);
          setValidity(input, '');
          updateHeadPidRange(input, gains[axis][term]);
        }
        for (const input of document.querySelectorAll('[data-coordinated-deadzone]')) {
          const field = input.dataset.coordinatedDeadzone;
          const value = coordinatedHeadDeadzone[field === 'head-0' ? 0 : 1] * 100;
          input.value = String(value);
          setValidity(input, '');
        }
        coordinatedBodyGains.splice(0, 3, ...saved.body_gains);
        for (const input of document.querySelectorAll('[data-coordinated-body-gain]')) {
          const axis = Number(input.dataset.coordinatedBodyGain);
          coordinatedBodyGains[axis] = saved.body_gains[axis];
          input.value = String(coordinatedBodyGains[axis]);
          setValidity(input, '');
        }
        for (const input of document.querySelectorAll('[data-coordinated-final-point]')) {
          const axis = Number(input.dataset.coordinatedFinalPoint);
          coordinatedFinalPoint[axis] = saved.final_point[axis];
          input.value = String(coordinatedFinalPoint[axis]);
          setValidity(input, '');
        }
        for (const input of document.querySelectorAll('[data-coordinated-final-tolerance]')) {
          const axis = Number(input.dataset.coordinatedFinalTolerance);
          coordinatedFinalTolerance[axis] = saved.final_tolerance[axis];
          input.value = String(coordinatedFinalTolerance[axis]);
          setValidity(input, '');
        }
        coordinatedArrivalDelay = saved.arrival_delay_s;
        arrivalDelayInput.value = String(coordinatedArrivalDelay);
        setValidity(arrivalDelayInput, '');
        coordinatedArrivalSkill = saved.arrival_skill;
        for (const stage of ['before', 'after']) {
          Object.assign(coordinatedMouth[stage], saved[`mouth_${stage}`]);
          for (const input of document.querySelectorAll(`[data-coordinated-mouth="${stage}"]`)) {
            const field = input.dataset.mouthField;
            if (field === 'enabled') input.checked = coordinatedMouth[stage].enabled;
            else input.value = String(coordinatedMouth[stage][field] * (field === 'open' ? 100 : 1));
            setValidity(input, '');
          }
        }
        renderArrivalSkills();
        updateTrackingGuide();
      };
      const collectCoordinatedSettings = () => ({
        head_deadzone: [...coordinatedHeadDeadzone], head_gains: coordinatedGains.map(axis => [...axis]),
        body_gains: [...coordinatedBodyGains], final_point: [...coordinatedFinalPoint],
        final_tolerance: [...coordinatedFinalTolerance], arrival_delay_s: coordinatedArrivalDelay,
        arrival_skill: coordinatedArrivalSkill,
        mouth_before: {...coordinatedMouth.before}, mouth_after: {...coordinatedMouth.after},
      });
      const validPhaseSettings = value => value && Object.keys(value).length === 4
        && validGains(value.final_body_gains)
        && (value.approach_linear_limit === null || validDeadzone(value.approach_linear_limit))
        && validDeadzone(value.final_linear_limit) && validDeadzone(value.final_lateral_limit);
      const phaseLimit = kind => kind === 'approach' ? approachLinearLimit
        : kind === 'final' ? finalLinearLimit : finalLateralLimit;
      const applyPhaseSettings = saved => {
        finalBodyGains.splice(0, 3, ...saved.final_body_gains);
        approachLinearLimit = saved.approach_linear_limit;
        finalLinearLimit = saved.final_linear_limit;
        finalLateralLimit = saved.final_lateral_limit;
        for (const input of document.querySelectorAll('[data-coordinated-phase-gain]')) {
          input.value = String(finalBodyGains[Number(input.dataset.coordinatedPhaseGain)]);
          setValidity(input, '');
        }
        for (const input of document.querySelectorAll('[data-coordinated-phase-limit]')) {
          const value = phaseLimit(input.dataset.coordinatedPhaseLimit);
          input.value = value === null ? '' : String(value);
          setValidity(input, '');
        }
      };
      const collectPhaseSettings = () => ({final_body_gains: [...finalBodyGains],
        approach_linear_limit: approachLinearLimit, final_linear_limit: finalLinearLimit,
        final_lateral_limit: finalLateralLimit});
      const applyTrackingProfile = scope => {
        trackingScope = scope;
        const profile = trackingProfile();
        coordinatedSettingsReady = profile.coordinatedReady;
        phaseReady = profile.phaseReady;
        coordinatedLeaseReady = coordinatedSettingsReady && phaseReady;
        coordinatedInputs.forEach(input => { input.disabled = !coordinatedSettingsReady; });
        phaseInputs.forEach(input => { input.disabled = !phaseReady; });
        const previous = applyingSettings;
        applyingSettings = true;
        if (coordinatedSettingsReady) applyCoordinatedSettings(profile.coordinated);
        else updateTrackingGuide();
        if (phaseReady) applyPhaseSettings(profile.phases);
        applyingSettings = previous;
      };
      const selectPickupStage = scope => {
        applyTrackingProfile(scope);
        headPositionScope = scope;
        applyHeadPositionScope(scope);
        pickupStageButtons.forEach(button => {
          button.setAttribute('aria-pressed', String(button.dataset.pickupStage === scope));
        });
        updateSettingsState();
      };
      pickupStageButtons.forEach(button => button.addEventListener('click', () => {
        const previousPosition = headPositionTarget;
        selectPickupStage(button.dataset.pickupStage);
        if (!vision.awaitingTarget && !coordinatedRun.active && !coordinatedRun.pending) {
          headPositionWanted = true;
          if (headPositionState === 'active' && headPositionTarget !== null && headPositionTarget !== previousPosition) {
            sendHeadPosition('update');
          }
          reconcileHeadPosition();
        }
        updateTrackingButton();
      }));
      const applySettings = (saved, forceColor = false) => {
        if (!saved) return;
        applyingSettings = true;
        applySpeed(saved.linear_speed, false);
        applyTurn(saved.turn_speed, false);
        for (const input of mazeInputs) {
          input.value = String(saved.maze[input.dataset.maze]);
          pages.maze.settings[input.dataset.maze] = saved.maze[input.dataset.maze];
          setValidity(input, '');
        }
        pages.line.referenceArea = saved.tracking.reference_area;
        pages.line.speed = saved.tracking.line_speed ?? 0.15;
        lineSpeedInput.value = String(pages.line.speed);
        pages.line.deadzone.splice(0, 2, ...saved.tracking.deadzone);
        pages.line.gains.splice(0, 2, ...saved.tracking.gains.map(axis => [...axis]));
        for (const input of document.querySelectorAll('[data-tracking-deadzone]')) {
          const axis = Number(input.dataset.trackingDeadzone);
          input.value = String(pages.line.deadzone[axis] * 100);
        }
        for (const input of document.querySelectorAll('[data-pid-axis]')) {
          const axis = Number(input.dataset.pidAxis), term = Number(input.dataset.pidTerm);
          input.value = String(pages.line.gains[axis][term]);
          input.nextElementSibling.value = String(pages.line.gains[axis][term]);
          setValidity(input.nextElementSibling, '');
        }
        const threshold = document.querySelector('#color-threshold');
        threshold.value = String(saved.color_threshold);
        threshold.dispatchEvent(new Event('input'));
        objectLabelPreference = saved.object_label;
        if (studioActive && document.body.dataset.consolePage === 'person') {
          window.dispatchEvent(new CustomEvent('vision-recognition-start', {detail: 'object'}));
        }
        const colorLoad = new CustomEvent('color-reference-load', {
          detail: saved.color_reference, cancelable: !forceColor,
        });
        if (window.dispatchEvent(colorLoad)) {
          colorReference = saved.color_reference;
          colorChosen = false;
          updateTrackingButton();
          updateColorPresetControls();
        }
        else settingsDirty = true;
        if (tofEnabled) {
          restoreObstacle = saved.obstacle;
          restoreSharedSettings();
        } else {
          applyObstacle(saved.obstacle);
        }
        if (forceColor || (!volumeBusy && desiredVolume === null && volumeTimer === null)) {
          savedAudioVolume = saved.audio_volume;
          if (savedAudioVolume !== null) {
            volumeRevision++;
            clearTimeout(volumeTimer); volumeTimer = null;
            desiredVolume = savedAudioVolume;
            showVolume(savedAudioVolume);
            sendVolume();
          }
        }
        applyingSettings = false;
      };
      const collectSettings = () => ({
          linear_speed: linearSpeed, turn_speed: turnSpeed, maze: {...pages.maze.settings},
          tracking: {
            reference_area: pages.line.referenceArea,
            line_speed: pages.line.speed,
            deadzone: [...pages.line.deadzone],
            gains: pages.line.gains.map(axis => [...axis]),
          },
          color_threshold: Number(document.querySelector('#color-threshold').value),
          color_reference: colorReference,
          object_label: objectLabelPreference,
          obstacle: {enabled: obstacleEnabled.checked, threshold_mm: Number(obstacleDistance.value), clear_delay_ms: Number(obstacleDelay.value)},
          low_voltage: settingsDefaults?.low_voltage ?? {threshold_v: 7.0, duration_s: 30},
          audio_volume: savedAudioVolume,
      });
      const flushSettings = (finalSave = false) => {
        clearTimeout(settingsTimer); settingsTimer = null;
        if (!settingsLoaded || applyingSettings || settingsFailed || !settingsDirty || !settingsReady()) return;
        if (settingsSaving && !finalSave) return;
        if (obstaclePending || volumeBusy || desiredVolume !== null || volumeTimer !== null || restoreObstacle) return;
        const invalid = [...document.querySelectorAll('input:not(#follow-stop-area):not(#follow-area-deadzone):not(#follow-stop-distance):not(#follow-distance-deadzone):not([data-trigger-range]):not([data-stick-lock]):not([data-head-pid-axis]):not([data-head-pid-range-axis]):not([data-head-tracking-deadzone]):not([data-coordinated-pid-axis]):not([data-coordinated-pid-range]):not([data-coordinated-deadzone]):not([data-coordinated-body-gain])')]
          .find(input => !input.validity.valid);
        if (invalid) { settingsStatus.textContent = '参数无效，未自动保存'; return; }
        const saved = collectSettings(), serialized = JSON.stringify(saved);
        if (serialized === savedSettingsJson) {
          settingsDirty = false;
          markSettingsSaved();
          return;
        }
        if (settingsSaving) {
          settingsDirty = false;
          session.send({type: 'save_settings', request_id: ++settingsRequest, settings: saved});
          return;
        }
        settingsSaving = true; settingsDirty = false;
        pendingSettingsJson = serialized;
        settingsPendingId = ++settingsRequest;
        resetSettings.disabled = true;
        settingsStatus.textContent = '正在自动保存…';
        session.send({type: 'save_settings', request_id: settingsPendingId, settings: saved});
      };
      const queueSettings = () => {
        if (!settingsLoaded || applyingSettings) return;
        settingsDirty = true; settingsFailed = false;
        clearTimeout(settingsTimer);
        settingsStatus.textContent = '参数已修改，等待保存…';
        settingsTimer = setTimeout(flushSettings, 250);
      };
      const flushHeadSettings = (finalSave = false) => {
        clearTimeout(headSettingsTimer); headSettingsTimer = null;
        if (!settingsLoaded || applyingSettings || headSettingsFailed || !headSettingsDirty || !settingsReady()) return;
        if (headSettingsSaving && !finalSave) return;
        if ([...document.querySelectorAll('[data-head-pid-axis], [data-head-tracking-deadzone]')].some(input => !input.validity.valid)) {
          settingsStatus.textContent = '参数无效，未自动保存'; return;
        }
        const saved = collectHeadSettings(), serialized = JSON.stringify(saved);
        if (serialized === headSavedJson) { headSettingsDirty = false; markSettingsSaved(); return; }
        const requestId = ++settingsRequest;
        if (headSettingsSaving) {
          headSettingsDirty = false;
          session.send({type: 'save_head_settings', request_id: requestId, settings: saved});
          return;
        }
        headSettingsSaving = true; headSettingsDirty = false;
        headPendingJson = serialized; headSettingsPendingId = requestId;
        resetSettings.disabled = true;
        settingsStatus.textContent = '正在自动保存…';
        session.send({type: 'save_head_settings', request_id: requestId, settings: saved});
      };
      const queueHeadSettings = () => {
        if (!settingsLoaded || applyingSettings) return;
        headSettingsDirty = true; headSettingsFailed = false;
        clearTimeout(headSettingsTimer);
        settingsStatus.textContent = '参数已修改，等待保存…';
        headSettingsTimer = setTimeout(flushHeadSettings, 250);
      };
      const flushCoordinatedSettings = (finalSave = false, scope = trackingScope) => {
        const profile = trackingProfiles[scope];
        clearTimeout(profile.coordinatedTimer); profile.coordinatedTimer = null;
        if (!profile.coordinatedReady || applyingSettings || profile.coordinatedFailed || !profile.coordinatedDirty || !settingsReady()) return;
        if (profile.coordinatedSaving && !finalSave) return;
        if (scope === trackingScope && coordinatedInputs.some(input => !input.validity.valid)) {
          settingsStatus.textContent = '参数无效，未自动保存'; return;
        }
        const saved = profile.coordinated, serialized = JSON.stringify(saved);
        if (serialized === profile.coordinatedSavedJson) { profile.coordinatedDirty = false; markSettingsSaved(); return; }
        const requestId = ++settingsRequest;
        if (profile.coordinatedSaving) {
          profile.coordinatedDirty = false;
          session.send({type: 'save_coordinated_settings', request_id: requestId, scope, settings: saved});
          return;
        }
        profile.coordinatedSaving = true; profile.coordinatedDirty = false;
        profile.coordinatedPendingJson = serialized; profile.coordinatedPendingId = requestId;
        resetSettings.disabled = true;
        settingsStatus.textContent = '正在自动保存…';
        session.send({type: 'save_coordinated_settings', request_id: requestId, scope, settings: saved});
      };
      const queueCoordinatedSettings = () => {
        if (!coordinatedSettingsReady || applyingSettings) return;
        const scope = trackingScope, profile = trackingProfiles[scope];
        profile.coordinated = collectCoordinatedSettings();
        profile.coordinatedDirty = true; profile.coordinatedFailed = false;
        clearTimeout(profile.coordinatedTimer);
        settingsStatus.textContent = '参数已修改，等待保存…';
        profile.coordinatedTimer = setTimeout(() => flushCoordinatedSettings(false, scope), 250);
      };
      const flushPhaseSettings = (finalSave = false, scope = trackingScope) => {
        const profile = trackingProfiles[scope];
        clearTimeout(profile.phaseTimer); profile.phaseTimer = null;
        if (!profile.phaseReady || applyingSettings || profile.phaseFailed || !profile.phaseDirty || !settingsReady()) return;
        if (profile.phaseSaving && !finalSave) return;
        if (scope === trackingScope && phaseInputs.some(input => !input.validity.valid)) { settingsStatus.textContent = '参数无效，未自动保存'; return; }
        const saved = profile.phases, serialized = JSON.stringify(saved);
        if (serialized === profile.phaseSavedJson) { profile.phaseDirty = false; markSettingsSaved(); return; }
        if (profile.phaseSaving) {
          profile.phaseDirty = false;
          session.send({type: 'save_tracking_phases', request_id: ++settingsRequest, scope, settings: saved});
          return;
        }
        profile.phaseSaving = true; profile.phaseDirty = false; profile.phasePendingJson = serialized; profile.phasePendingId = ++settingsRequest;
        resetSettings.disabled = true;
        settingsStatus.textContent = '正在自动保存…';
        session.send({type: 'save_tracking_phases', request_id: profile.phasePendingId, scope, settings: saved});
      };
      const queuePhaseSettings = () => {
        if (!phaseReady || applyingSettings) return;
        const scope = trackingScope, profile = trackingProfiles[scope];
        profile.phases = collectPhaseSettings();
        profile.phaseDirty = true; profile.phaseFailed = false;
        clearTimeout(profile.phaseTimer);
        settingsStatus.textContent = '参数已修改，等待保存…';
        profile.phaseTimer = setTimeout(() => flushPhaseSettings(false, scope), 250);
      };
      const changedParameter = event => {
        const field = event.target;
        if (!field.matches('input, select') || field.matches(`[data-stick-lock], [data-trigger-range], [data-head-pid-axis], [data-head-pid-range-axis], [data-head-tracking-deadzone], ${coordinatedInputSelector}, ${phaseInputSelector}, #follow-stop-area, #follow-area-deadzone, #follow-stop-distance, #follow-distance-deadzone, #color-presets, #color-preset-name, #audio-volume, #network-announcement-enabled, #person-model`)) return;
        queueSettings();
      };
      document.addEventListener('input', changedParameter);
      document.addEventListener('change', event => {
        if (event.target.matches('#network-announcement-enabled, #person-model')) return;
        changedParameter(event);
        if (event.target.matches('[data-head-pid-axis], [data-head-pid-range-axis], [data-head-tracking-deadzone]')) flushHeadSettings();
        else if (event.target.matches(coordinatedInputSelector)) flushCoordinatedSettings();
        else if (event.target.matches(phaseInputSelector)) flushPhaseSettings();
        else flushSettings();
      });
      resetSettings.addEventListener('click', () => {
        if (!settingsDefaults || !headSettingsDefaults || !coordinatedLeaseReady || !phaseReady || !settingsReady()
          || Object.values(trackingProfiles).some(profile => !profile.coordinatedReady || !profile.phaseReady)
          || settingsSaving || headSettingsSaving || trackingBusy()) return;
        window.dispatchEvent(new CustomEvent('console-view-change'));
        stopAllTracking(); stopMaze();
        window.dispatchEvent(new Event('vision-recognition-stop'));
        applySettings(settingsDefaults, true);
        applyHeadSettings(headSettingsDefaults);
        applyCoordinatedSettings(trackingScope === 'person' ? personCoordinatedDefaults : coordinatedDefaults);
        applyPhaseSettings(trackingScope === 'person' ? personPhaseDefaults : phaseDefaults);
        const defaultHeadPosition = headPositionScope === 'person' ? personDefaults.headPosition : targetHeadDefault;
        headPosition.value = defaultHeadPosition === null ? '' : String(defaultHeadPosition);
        headPositionTarget = defaultHeadPosition;
        headPositionWanted = false;
        followStopArea.value = String(pages.person.limits.area = personDefaults.area);
        followAreaDeadzone.value = String(pages.person.limits.areaDeadzone = personDefaults.areaDeadzone);
        followStopDistance.value = String(pages.person.limits.distance = personDefaults.distance);
        followDistanceDeadzone.value = String(pages.person.limits.distanceDeadzone = personDefaults.distanceDeadzone);
        const followDefaults = {
          'person-follow-head-position': personDefaults.headPosition,
          'target-follow-head-position': targetHeadDefault,
          'pickup_after-follow-head-position': targetHeadDefault,
          'person-follow-stop-area': pages.person.limits.area,
          'person-follow-area-deadzone': pages.person.limits.areaDeadzone, 'person-follow-stop-distance': pages.person.limits.distance,
          'person-follow-distance-deadzone': pages.person.limits.distanceDeadzone,
        };
        for (const [key, value] of Object.entries(followDefaults)) localStorage.setItem(key, String(value));
        applySpeed(settingsDefaults.linear_speed);
        queueSettings(); queueHeadSettings();
        for (const [scope, profile] of Object.entries(trackingProfiles)) {
          profile.coordinated = JSON.parse(JSON.stringify(scope === 'person' ? personCoordinatedDefaults : coordinatedDefaults));
          profile.phases = JSON.parse(JSON.stringify(scope === 'person' ? personPhaseDefaults : phaseDefaults));
          profile.coordinatedDirty = profile.phaseDirty = true;
          profile.coordinatedFailed = profile.phaseFailed = false;
          flushCoordinatedSettings(false, scope);
          flushPhaseSettings(false, scope);
        }
      });
      window.addEventListener('color-reference-changed', event => {
        colorReference = event.detail;
        colorChosen = Boolean(event.detail);
        if (!colorReference && visionSource === 'color') stopAllTracking();
        updateTrackingButton();
        updateColorPresetControls();
        queueSettings();
      });
      const updateColorPresetControls = () => {
        colorPresetSelect.disabled = !colorPresetsLoaded || colorPresets.size === 0;
        colorPresetSave.disabled = !colorPresetsLoaded || !session.open
          || !colorChosen || !colorReference || !colorPresetName.value.trim() || colorPresetPending !== null;
        colorPresetDelete.disabled = !colorPresetsLoaded || !session.open
          || !colorPresets.has(colorPresetSelect.value) || colorPresetPending !== null;
      };
      const renderColorPresets = () => {
        const selected = colorPresetSelect.value;
        colorPresetSelect.replaceChildren(new Option('请选择', ''),
          ...[...colorPresets.keys()].map(name => new Option(name, name)));
        colorPresetSelect.value = colorPresets.has(selected) ? selected : '';
        updateColorPresetControls();
      };
      colorPresetName.addEventListener('input', () => { colorPresetRevision++; updateColorPresetControls(); });
      window.addEventListener('color-pick-start', () => {
        colorPresetRevision++;
        colorPresetSelect.value = '';
        colorPresetName.value = '';
        updateColorPresetControls();
      });
      colorPresetSelect.addEventListener('change', () => {
        colorPresetRevision++;
        const name = colorPresetSelect.value;
        if (!name) {
          colorPresetName.value = '';
          window.dispatchEvent(new CustomEvent('color-reference-load', {detail: null}));
          updateColorPresetControls();
          return;
        }
        const preset = colorPresets.get(name);
        colorPresetName.value = name;
        window.dispatchEvent(new CustomEvent('color-preset-load', {detail: preset}));
        updateColorPresetControls();
      });
      colorPresetSave.addEventListener('click', () => {
        if (colorPresetSave.disabled) return;
        const name = colorPresetName.value.trim();
        const preset = {reference: structuredClone(colorReference), threshold: Number(colorThreshold.value)};
        const request_id = ++settingsRequest;
        colorPresetPending = {operation: 'save', request_id, name, preset, revision: colorPresetRevision};
        updateColorPresetControls();
        session.send({type: 'save_color_preset', request_id, name, preset});
      });
      colorPresetDelete.addEventListener('click', () => {
        if (colorPresetDelete.disabled) return;
        const name = colorPresetSelect.value;
        const request_id = ++settingsRequest;
        colorPresetPending = {operation: 'delete', request_id, name};
        updateColorPresetControls();
        try {
          session.send({type: 'delete_color_preset', request_id, name});
        } catch (error) {
          colorPresetPending = null;
          setNotice(`颜色删除失败：${error.message || '连接中断'}`, true);
          updateColorPresetControls();
        }
      });
      const updateTrackingButton = () => {
        updateSticksAvailability();
        const busy = vision.awaitingTarget || lineRun.active || lineRun.pending || coordinatedOwner !== null;
        const configured = visionSource === 'color' ? Boolean(colorReference && colorChosen) : true;
        const pickupProfileReady = scope => trackingProfiles[scope].coordinatedReady && trackingProfiles[scope].phaseReady;
        const parametersReady = targetHeadOnly()
          ? settingsLoaded && !!headSettingsDefaults && targetHeadHome !== null
          : lineFollowing() ? settingsLoaded && lineSpeedInput.validity.valid
            : coordinatedLeaseReady;
        const startBlocked = !configured || !visionDirect[visionSource] || busy || mazeRun.active || mazeRun.pending || !session.open;
        trackingStart.disabled = startBlocked || !parametersReady || (document.body.dataset.consolePage === 'person'
            && (!followStopArea.validity.valid || !followAreaDeadzone.validity.valid
              || !followStopDistance.validity.valid || !followDistanceDeadzone.validity.valid));
        const firstArrivalSkill = trackingProfiles.target.coordinated?.arrival_skill;
        pickupSequenceStart.disabled = startBlocked || !pickupProfileReady('target')
          || !pickupProfileReady('pickup_after') || !firstArrivalSkill;
        pickupSequenceStart.title = firstArrivalSkill ? '' : '请先设置动作前的到位动作';
        trackingStart.title = !parametersReady
          ? (targetHeadOnly() ? '头部追踪参数不可用' : lineFollowing() || document.body.dataset.consolePage === 'person'
            ? '身体追踪参数不可用' : '联合追踪参数不可用') : '';
        trackingStop.disabled = !(vision.awaitingTarget || lineRun.active || coordinatedRun.active
          || (lineRun.pending && !lineRun.cancelled)
          || (coordinatedRun.pending && !coordinatedRun.cancelled));
        const phases = {
          initial_head: '头部初始化', approach: '接近目标', final_alignment: '最终对准',
          confirming: '到位确认', returning_head: '头部归位', standing: '切换站立',
          waiting_action: '等待动作', mouth_before_action: '动作前调整嘴部', running_action: '执行动作',
          mouth_after_action: '动作后调整嘴部', holding_stand: '站立保持',
          waiting_target: '目标暂时丢失', searching: '扫描寻找目标', paused_vision: '画面中断，运动暂停',
          waiting_feedback: '等待舵机反馈', waiting_robot: '等待机器人就绪', fallen: '机器人已跌倒',
        };
        const headOnlyPhase = vision.robotPhase === 'approach' ? '头部追踪'
          : vision.robotPhase === 'waiting_target' ? '头部追踪 · 等待目标' : phases[vision.robotPhase];
        const phase = vision.awaitingTarget ? '等待识别画面'
          : lineRun.active ? (pages.line.point ? '自主巡线' : '等待识别巡线')
          : coordinatedRun.active || (coordinatedRun.pending && !coordinatedRun.cancelled)
            ? ((targetHeadOnly() ? headOnlyPhase : phases[vision.robotPhase])
              || (!vision.frameReady ? '等待识别画面' : '等待机器人状态'))
          : (lineRun.pending && !lineRun.cancelled) ? '正在启动' : '';
        const pickupLabel = pickupPage() && (vision.awaitingTarget || coordinatedRun.pending || coordinatedRun.active)
          ? (pages.pickup.runScope === 'pickup_after' || pages.pickup.robotStage === 'after' ? '动作后' : '动作前') : '';
        coordinatedStatus.textContent = [pickupLabel, phase ? `追踪阶段：${phase}` : ''].filter(Boolean).join(' · ');
      };
      const sendTracking = (action, target = null) => {
        const initial_pitch = action === 'start' && isVisionPage() ? headPositionTarget : null;
        if (studioActive && session.open) session.send({
          type: 'motion_tracking', action, initial_pitch, target, line_speed: pages.line.speed,
          reference_area: pages.line.referenceArea ?? 0.01, deadzone: pages.line.deadzone, gains: pages.line.gains,
        });
      };
      const pickupParameters = scope => {
        const profile = trackingProfiles[scope];
        const pitch = scope === headPositionScope ? headPositionTarget
          : Number(localStorage.getItem(headPositionKey(scope)) ?? targetHeadDefault);
        return {
          ...(scope === trackingScope ? collectCoordinatedSettings() : profile.coordinated),
          ...(scope === trackingScope ? collectPhaseSettings() : profile.phases),
          initial_pitch: Number.isInteger(pitch) && pitch >= 1024 && pitch <= 2250 ? pitch : null,
        };
      };
      const sendCoordinated = (action, target = null, newPitch = null) => {
        const trackingCamera = vision.frameReady ? camera : null;
        // Saved area settings use 720p pixels; the robot compares against native frame pixels.
        const areaScale = camera ? (camera.width * camera.height) / (1280 * 720) : 1;
        const personFollow = document.body.dataset.consolePage === 'person';
        const headOnly = targetHeadOnly();
        const startPitch = headOnly ? targetHeadHome : headPositionTarget;
        if (action === 'start') vision.startPitch = startPitch ?? 1500;
        const pickup = pickupPage() && action !== 'stop' ? pickupParameters(pages.pickup.runScope ?? 'target') : null;
        const pickupAfter = pickup && pages.pickup.runScope === null ? {
          action: 'start', target: null, camera: null, stop_area_px: null, stop_area_deadzone_px: 0,
          stop_distance_mm: null, stop_distance_deadzone_mm: 0, ...pickupParameters('pickup_after'),
        } : null;
        if (studioActive && session.open) session.send({
          type: 'coordinated_tracking', action,
          initial_pitch: action === 'start' ? startPitch : (personFollow && action === 'update' ? newPitch : null),
          // Native detection goes directly to the robot; the browser only supplies settings.
          target: null, camera: trackingCamera,
          head_deadzone: headOnly ? pages.target.deadzone : coordinatedHeadDeadzone,
          head_gains: headOnly ? pages.target.gains : coordinatedGains,
          body_gains: headOnly ? [0, 0, 0] : coordinatedBodyGains,
          final_body_gains: headOnly ? [0, 0, 0] : finalBodyGains,
          approach_linear_limit: approachLinearLimit, final_linear_limit: finalLinearLimit,
          final_lateral_limit: finalLateralLimit,
          final_point: coordinatedFinalPoint,
          final_tolerance: coordinatedFinalTolerance,
          stop_area_px: personFollow ? Math.max(1, Math.round(pages.person.limits.area * areaScale)) : null,
          stop_area_deadzone_px: personFollow ? Math.round(pages.person.limits.areaDeadzone * areaScale) : 0,
          stop_distance_mm: personFollow && tofEnabled ? pages.person.limits.distance : null,
          stop_distance_deadzone_mm: personFollow && tofEnabled ? pages.person.limits.distanceDeadzone : 0,
          arrival_skill: personFollow || headOnly ? '' : coordinatedArrivalSkill,
          arrival_delay_s: personFollow || headOnly ? 0 : coordinatedArrivalDelay,
          mouth_before: {...coordinatedMouth.before, enabled: !personFollow && !headOnly && coordinatedMouth.before.enabled},
          mouth_after: {...coordinatedMouth.after, enabled: !personFollow && !headOnly && coordinatedMouth.after.enabled},
          ...(pickup ? {...pickup, initial_pitch: action === 'start' ? pickup.initial_pitch : null, pickup_after: pickupAfter} : {}),
        });
      };
      const updateCoordinated = () => { if (coordinatedRun.active) sendCoordinated('update', vision.target); };
      const bindPidTabs = (tabSelector, paneSelector, tabKey, paneKey, onSelect = () => {}) => {
        const tabs = [...document.querySelectorAll(tabSelector)];
        const select = tab => {
          for (const item of tabs) {
            const selected = item === tab;
            item.setAttribute('aria-selected', String(selected));
            item.tabIndex = selected ? 0 : -1;
          }
          document.querySelectorAll(paneSelector).forEach(pane => { pane.hidden = pane.dataset[paneKey] !== tab.dataset[tabKey]; });
          onSelect(tab);
        };
        tabs.forEach((tab, index) => {
          tab.addEventListener('click', () => select(tab));
          tab.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
              : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            select(tabs[next]);
            tabs[next].focus();
          });
        });
      };
      bindPidTabs('[data-coordinated-tab]', '[data-coordinated-pane]', 'coordinatedTab', 'coordinatedPane', tab => {
        document.querySelector('.body-phase-tabs').hidden = tab.dataset.coordinatedTab !== 'body'
          || document.body.dataset.consolePage === 'person';
      });
      bindPidTabs('[data-body-stage-tab]', '[data-body-stage-pane]', 'bodyStageTab', 'bodyStagePane');
      lineSpeedInput.addEventListener('input', () => {
        if (lineSpeedInput.validity.valid) pages.line.speed = lineSpeedInput.valueAsNumber;
        updateTrackingButton();
      });
      const bindPidInputs = (range, input, gains, axis, term, head, queue = head ? queueHeadSettings : null,
        error = head ? '头部 PID 需要有限数值' : '身体 PID 范围为 0～10', onUpdate = null) => {
        const apply = (value, source) => {
          gains[axis][term] = value;
          if (source === range) {
            input.value = String(value);
            setValidity(input, '');
          } else if (head) updateHeadPidRange(input, value);
          else range.value = String(value);
          if (queue) queue();
          if (onUpdate) onUpdate();
        };
        range.addEventListener('input', () => {
          if (Number.isFinite(range.valueAsNumber)) apply(range.valueAsNumber, range);
        });
        input.addEventListener('input', () => {
          setValidity(input, '');
          if (input.value === '' || !Number.isFinite(input.valueAsNumber) || !input.validity.valid) {
            setValidity(input, error);
            if (queue) queue();
            return;
          }
          apply(input.valueAsNumber, input);
        });
        input.addEventListener('change', () => {
          if (input.value !== '' && Number.isFinite(input.valueAsNumber) && input.validity.valid) return;
          input.value = String(gains[axis][term]);
          setValidity(input, '');
          setNotice(error, true);
        });
      };
      document.querySelectorAll('[data-pid-axis]').forEach(range => {
        bindPidInputs(range, range.nextElementSibling, pages.line.gains,
          Number(range.dataset.pidAxis), Number(range.dataset.pidTerm), false);
      });
      document.querySelectorAll('[data-head-pid-axis]').forEach(input => {
        bindPidInputs(input.previousElementSibling, input, pages.target.gains,
          Number(input.dataset.headPidAxis), Number(input.dataset.headPidTerm), true,
          queueHeadSettings, '头部 PID 需要有限数值', () => {
            if (targetHeadOnly()) updateCoordinated();
          });
      });
      document.querySelectorAll('[data-coordinated-pid-axis]').forEach(input => {
        bindPidInputs(input.previousElementSibling, input, coordinatedGains,
          Number(input.dataset.coordinatedPidAxis), Number(input.dataset.coordinatedPidTerm),
          true, queueCoordinatedSettings, '联合 PID 需要有限数值', updateCoordinated);
      });
      document.querySelectorAll('[data-coordinated-body-gain]').forEach(input => {
        const axis = Number(input.dataset.coordinatedBodyGain);
        const error = '联合 PID 需要有限数值';
        input.addEventListener('input', () => {
          setValidity(input, '');
          const value = input.valueAsNumber;
          if (!Number.isFinite(value) || !input.validity.valid) setValidity(input, error);
          else { coordinatedBodyGains[axis] = value; updateCoordinated(); }
          queueCoordinatedSettings();
        });
        input.addEventListener('change', () => {
          if (input.validity.valid) return;
          input.value = String(coordinatedBodyGains[axis]);
          setValidity(input, '');
          setNotice(error, true);
        });
      });
      document.querySelectorAll('[data-coordinated-phase-gain]').forEach(input => {
        const axis = Number(input.dataset.coordinatedPhaseGain);
        const error = '身体增益需要有限数值';
        input.addEventListener('input', () => {
          setValidity(input, '');
          if (input.value === '' || !Number.isFinite(input.valueAsNumber) || !input.validity.valid) setValidity(input, error);
          else { finalBodyGains[axis] = input.valueAsNumber; updateCoordinated(); }
          queuePhaseSettings();
        });
        input.addEventListener('change', () => {
          if (input.validity.valid) return;
          input.value = String(finalBodyGains[axis]);
          setValidity(input, '');
          setNotice(error, true);
        });
      });
      document.querySelectorAll('[data-coordinated-phase-limit]').forEach(input => {
        const kind = input.dataset.coordinatedPhaseLimit;
        const approach = kind === 'approach';
        const error = '线速度上限需要非负有限数值';
        input.addEventListener('input', () => {
          setValidity(input, '');
          const value = approach && input.value === '' ? null : input.valueAsNumber;
          if ((value !== null && !validDeadzone(value)) || !input.validity.valid) setValidity(input, error);
          else {
            if (approach) approachLinearLimit = value;
            else if (kind === 'final') finalLinearLimit = value;
            else finalLateralLimit = value;
            updateCoordinated();
          }
          queuePhaseSettings();
        });
        input.addEventListener('change', () => {
          if (input.validity.valid) return;
          const value = phaseLimit(kind);
          input.value = value === null ? '' : String(value);
          setValidity(input, '');
          setNotice(error, true);
        });
      });
      document.querySelectorAll('[data-coordinated-final-point]').forEach(input => {
        const axis = Number(input.dataset.coordinatedFinalPoint);
        const error = '最终目标需要画面范围内的有限坐标';
        input.addEventListener('input', () => {
          setValidity(input, '');
          const value = input.valueAsNumber;
          if (!Number.isFinite(value) || !input.validity.valid) setValidity(input, error);
          else { coordinatedFinalPoint[axis] = value; updateTrackingGuide(); updateCoordinated(); }
          queueCoordinatedSettings();
        });
        input.addEventListener('change', () => {
          if (input.validity.valid) return;
          input.value = String(coordinatedFinalPoint[axis]);
          setValidity(input, '');
          setNotice(error, true);
        });
      });
      document.querySelectorAll('[data-coordinated-final-tolerance]').forEach(input => {
        const axis = Number(input.dataset.coordinatedFinalTolerance);
        const error = '目标误差需要非负有限数值';
        input.addEventListener('input', () => {
          setValidity(input, '');
          const value = input.valueAsNumber;
          if (!Number.isFinite(value) || !input.validity.valid) setValidity(input, error);
          else { coordinatedFinalTolerance[axis] = value; updateTrackingGuide(); updateCoordinated(); }
          queueCoordinatedSettings();
        });
        input.addEventListener('change', () => {
          if (input.validity.valid) return;
          input.value = String(coordinatedFinalTolerance[axis]);
          setValidity(input, '');
          setNotice(error, true);
        });
      });
      arrivalDelayInput.addEventListener('input', () => {
        setValidity(arrivalDelayInput, '');
        const value = arrivalDelayInput.valueAsNumber;
        if (!Number.isFinite(value) || !arrivalDelayInput.validity.valid) setValidity(arrivalDelayInput, '动作延时需要非负有限数值');
        else { coordinatedArrivalDelay = value; updateCoordinated(); }
        queueCoordinatedSettings();
      });
      arrivalDelayInput.addEventListener('change', () => {
        if (arrivalDelayInput.validity.valid) return;
        arrivalDelayInput.value = String(coordinatedArrivalDelay);
        setValidity(arrivalDelayInput, '');
        setNotice('动作延时需要非负有限数值', true);
      });
      arrivalSkillInput.addEventListener('change', () => {
        coordinatedArrivalSkill = arrivalSkillInput.value;
        updateCoordinated();
        queueCoordinatedSettings();
        updateTrackingButton();
      });
      document.querySelectorAll('[data-coordinated-mouth]').forEach(input => {
        const stage = input.dataset.coordinatedMouth, field = input.dataset.mouthField;
        const error = field === 'open' ? '嘴部开度需要 0 到 100 的有限数值' : '转动时间需要非负有限数值';
        input.addEventListener('input', () => {
          setValidity(input, '');
          const value = field === 'enabled' ? input.checked : input.valueAsNumber;
          if (field !== 'enabled' && (!Number.isFinite(value) || !input.validity.valid)) setValidity(input, error);
          else { coordinatedMouth[stage][field] = field === 'open' ? value / 100 : value; updateCoordinated(); }
          queueCoordinatedSettings();
        });
        input.addEventListener('change', () => {
          if (input.validity.valid) return;
          input.value = String(coordinatedMouth[stage][field] * (field === 'open' ? 100 : 1));
          setValidity(input, '');
          setNotice(error, true);
        });
      });
      document.querySelectorAll('[data-coordinated-deadzone]').forEach(input => {
        const field = input.dataset.coordinatedDeadzone;
        const values = coordinatedHeadDeadzone;
        const axis = field === 'head-1' ? 1 : 0;
        const scale = 100;
        const error = '联合追踪死区需要非负有限数值';
        input.addEventListener('input', () => {
          setValidity(input, '');
          const value = input.valueAsNumber;
          if (!Number.isFinite(value) || !input.validity.valid) setValidity(input, error);
          else { values[axis] = value / scale; updateCoordinated(); }
          queueCoordinatedSettings();
        });
        input.addEventListener('change', () => {
          if (input.validity.valid) return;
          input.value = String(values[axis] * scale);
          setValidity(input, '');
          setNotice(error, true);
        });
      });
      document.querySelectorAll('[data-tracking-deadzone]').forEach((input) => input.addEventListener('input', () => {
        const value = Number(input.value);
        if (input.value !== '' && Number.isFinite(value) && value >= 0) pages.line.deadzone[Number(input.dataset.trackingDeadzone)] = value / 100;
      }));
      document.querySelectorAll('[data-head-tracking-deadzone]').forEach(input => {
        const axis = Number(input.dataset.headTrackingDeadzone);
        input.addEventListener('input', () => {
          setValidity(input, '');
          const value = input.valueAsNumber;
          if (!Number.isFinite(value) || value < 0) {
            setValidity(input, '头部死区需要非负有限数值');
          } else {
            pages.target.deadzone[axis] = value / 100;
            if (targetHeadOnly()) updateCoordinated();
          }
          queueHeadSettings();
        });
        input.addEventListener('change', () => {
          if (input.validity.valid) return;
          input.value = String(pages.target.deadzone[axis] * 100);
          setValidity(input, '');
          setNotice('头部死区需要非负有限数值', true);
        });
      });
      const stopTracking = (send = true) => {
        lineRun.stop(send ? () => sendTracking('stop') : null, session.open);
        updateMazeButton();
      };
      const pauseLineTracking = () => {
        lineRun.clearTimer();
        pages.line.point = null;
        vision.targetReady = false;
        if (lineRun.active) sendTracking('update');
        updateMazeButton();
      };
      const armLineWatchdog = () => {
        lineRun.clearTimer();
        lineRun.timer = setTimeout(pauseLineTracking, 500);
      };
      const stopCoordinated = (send = true) => {
        const owner = coordinatedOwner;
        if (owner) {
          owner.stop(send ? () => sendCoordinated('stop') : null, session.open);
          if (!owner.pending) coordinatedOwner = null;
        }
        vision.target = null;
        vision.frameReady = false;
        vision.robotPhase = null;
        if (selectedPage === pages.pickup) {
          pages.pickup.robotStage = null;
          pages.pickup.runScope = null;
        }
        updateMazeButton();
      };
      const stopAllTracking = (send = true) => {
        vision.awaitingTarget = false;
        stopTracking(send); stopCoordinated(send);
      };
      const armCoordinatedWatchdog = () => {
        coordinatedRun.clearTimer();
        if (visionDirect[visionSource]) return;
        coordinatedRun.timer = setTimeout(() => {
          vision.frameReady = false;
          vision.target = null;
          updateTrackingMarker(null);
          if (coordinatedRun.active) sendCoordinated('update');
          updateTrackingButton();
          setNotice('画面中断，联合追踪已暂停', true);
        }, 600);
      };
      const updateMazeButton = () => {
        mazeButton.disabled = !tofEnabled || !session.open || vision.awaitingTarget || lineRun.active || lineRun.pending
          || coordinatedOwner !== null || mazeRun.active || mazeRun.pending;
        mazeStop.disabled = !tofEnabled || !session.open || !(mazeRun.active || (mazeRun.pending && !mazeRun.cancelled));
        updateTrackingButton();
      };
      const sendMaze = (action) => {
        if (tofEnabled && studioActive && session.open && (state.active || action === 'stop')) {
          session.send({ type: 'maze', action, ...pages.maze.settings, linear_speed: linearSpeed, angular_speed: turnSpeed });
        }
      };
      const stopMaze = (send = true) => {
        mazeRun.stop(send ? () => sendMaze('stop') : null, session.open);
        mazeStatus.textContent = '';
        updateMazeButton();
      };
      mazeInputs.forEach((input) => input.addEventListener('input', () => {
        const value = Number(input.value);
        const headStep = input.dataset.maze === 'head_step_deg';
        const valid = input.value !== '' && (headStep
          ? Number.isFinite(value) && value >= 0
          : Number.isSafeInteger(value) && (input.dataset.maze === 'threshold_mm'
            ? value > 0 && value <= 4294967295 : value >= 0));
        const error = headStep ? '转头步进须为非负有限数，可填小数。' : '距离须为正整数，时间须为非负整数。';
        setValidity(input, valid ? '' : error);
        if (!valid) { setNotice(`避障参数无效：${error}`, true); return; }
        pages.maze.settings[input.dataset.maze] = value;
        if (mazeRun.active) sendMaze('update');
      }));
      mazeButton.addEventListener('click', () => {
        if (!tofEnabled || mazeRun.active || mazeRun.pending) return;
        if (vision.awaitingTarget || lineRun.active || lineRun.pending || coordinatedOwner !== null
          || !mazeInputs.every((input) => input.reportValidity())) return;
        keys.clear();
        zero();
        mazeRun.begin();
        updateMazeButton();
        sendMaze('start');
      });
      mazeStop.addEventListener('click', () => stopMaze());
      const sendHeadPosition = action => {
        if (session.open) session.send({
          type: 'head_position', action,
          position: action === 'stop' ? null : headPositionTarget,
        });
      };
      const reconcileHeadPosition = () => {
        const visible = isVisionPage();
        const headOnly = targetHeadOnly();
        headPositionSetting.hidden = !visible;
        headPosition.readOnly = headOnly;
        document.querySelector('#head-position-home').hidden = !headOnly;
        document.querySelector('#head-position-range').hidden = headOnly;
        // The server owns the head-home handoff until studio_leave completes.
        if (studioLeaveRequest !== null) return;
        const waitingForTarget = vision.awaitingTarget && !vision.targetReady && headPositionState !== 'idle';
        const wanted = (headPositionWanted || waitingForTarget) && visible && headPositionTarget !== null && studioActive
          && robotConnected && !motionUnavailable() && session.open && (!vision.awaitingTarget || waitingForTarget)
          && !lineRun.active && !lineRun.pending
          && !coordinatedRun.active && !coordinatedRun.pending && !mazeRun.active && !mazeRun.pending;
        if (wanted && headPositionState === 'idle') {
          headPositionState = 'starting';
          sendHeadPosition('start');
        } else if (!wanted && headPositionState === 'active') {
          headPositionState = 'stopping';
          sendHeadPosition('stop');
        }
      };
      headPosition.addEventListener('change', () => {
        if (targetHeadOnly()) {
          headPosition.value = targetHeadHome === null ? '' : String(targetHeadHome);
          return;
        }
        if (!headPosition.reportValidity()) return;
        headPositionTarget = headPosition.value === '' ? null : Number(headPosition.value);
        localStorage.setItem(headPositionKey(headPositionScope), headPosition.value);
        headPositionWanted = true;
        if (headPositionState === 'active' && headPositionTarget !== null) sendHeadPosition('update');
        if (coordinatedRun.active && document.body.dataset.consolePage === 'person') {
          sendCoordinated('update', vision.target, headPositionTarget ?? 1500);
        }
        reconcileHeadPosition();
      });
      followStopArea.addEventListener('input', () => {
        setValidity(followStopArea, '');
        if (!Number.isSafeInteger(followStopArea.valueAsNumber) || followStopArea.valueAsNumber <= 0) {
          setValidity(followStopArea, '停止面积需要填写大于零的整数');
        }
        updateTrackingButton();
      });
      followStopArea.addEventListener('change', () => {
        if (!followStopArea.validity.valid) {
          followStopArea.value = String(pages.person.limits.area);
          setValidity(followStopArea, '');
          setNotice('停止面积需要填写大于零的整数', true);
        } else {
          pages.person.limits.area = followStopArea.valueAsNumber;
          localStorage.setItem('person-follow-stop-area', String(pages.person.limits.area));
          updateCoordinated();
        }
        updateTrackingButton();
      });
      followAreaDeadzone.addEventListener('input', () => {
        const value = followAreaDeadzone.valueAsNumber;
        setValidity(followAreaDeadzone, Number.isSafeInteger(value) && value >= 0
          ? '' : '面积死区需要填写非负整数');
        updateTrackingButton();
      });
      followAreaDeadzone.addEventListener('change', () => {
        if (!followAreaDeadzone.validity.valid) {
          followAreaDeadzone.value = String(pages.person.limits.areaDeadzone);
          setValidity(followAreaDeadzone, '');
          setNotice('面积死区需要填写非负整数', true);
        } else {
          pages.person.limits.areaDeadzone = followAreaDeadzone.valueAsNumber;
          localStorage.setItem('person-follow-area-deadzone', String(pages.person.limits.areaDeadzone));
          updateCoordinated();
        }
        updateTrackingButton();
      });
      followStopDistance.addEventListener('input', () => {
        setValidity(followStopDistance, '');
        if (!Number.isSafeInteger(followStopDistance.valueAsNumber)
          || followStopDistance.valueAsNumber <= 0 || followStopDistance.valueAsNumber > 4294967295) {
          setValidity(followStopDistance, '跟踪距离需要填写大于零的整数');
        }
        updateTrackingButton();
      });
      followStopDistance.addEventListener('change', () => {
        if (!followStopDistance.validity.valid) {
          followStopDistance.value = String(pages.person.limits.distance);
          setValidity(followStopDistance, '');
          setNotice('跟踪距离需要填写大于零的整数', true);
        } else {
          pages.person.limits.distance = followStopDistance.valueAsNumber;
          localStorage.setItem('person-follow-stop-distance', String(pages.person.limits.distance));
          updateCoordinated();
        }
        updateTrackingButton();
      });
      followDistanceDeadzone.addEventListener('input', () => {
        const value = followDistanceDeadzone.valueAsNumber;
        setValidity(followDistanceDeadzone, Number.isSafeInteger(value) && value >= 0 && value <= 4294967295
          ? '' : '距离死区需要填写非负整数');
        updateTrackingButton();
      });
      followDistanceDeadzone.addEventListener('change', () => {
        if (!followDistanceDeadzone.validity.valid) {
          followDistanceDeadzone.value = String(pages.person.limits.distanceDeadzone);
          setValidity(followDistanceDeadzone, '');
          setNotice('距离死区需要填写非负整数', true);
        } else {
          pages.person.limits.distanceDeadzone = followDistanceDeadzone.valueAsNumber;
          localStorage.setItem('person-follow-distance-deadzone', String(pages.person.limits.distanceDeadzone));
          updateCoordinated();
        }
        updateTrackingButton();
      });
      const startSelectedTracking = () => {
        if (!studioActive || !session.open || !vision.awaitingTarget || !vision.targetReady || !visionDirect[visionSource]
          || lineRun.pending || coordinatedOwner !== null
          || (targetHeadOnly() && targetHeadHome === null)) return;
        if (headPositionState !== 'idle') {
          reconcileHeadPosition();
          return;
        }
        vision.awaitingTarget = false;
        if (pickupPage() && pages.pickup.runScope === null && !trackingProfiles.target.coordinated?.arrival_skill) {
          setNotice('请先设置动作前的到位动作', true);
          updateMazeButton();
          return;
        }
        if (lineFollowing()) {
          lineRun.begin();
          sendTracking('start', pages.line.point);
        } else {
          if (pickupPage()) selectPickupStage(pages.pickup.runScope ?? 'target');
          coordinatedOwner = coordinatedRun;
          coordinatedRun.begin();
          vision.robotPhase = null;
          armCoordinatedWatchdog();
          sendCoordinated('start');
        }
        updateMazeButton();
      };
      const beginTracking = scope => {
        if (!studioActive) return;
        if (pickupPage()) pages.pickup.runScope = scope;
        keys.clear();
        zero();
        if (lineFollowing()) {
          vision.targetReady = false;
          pages.line.point = null;
        }
        vision.awaitingTarget = true;
        headPositionWanted = false;
        reconcileHeadPosition();
        updateMazeButton();
        if (visionSource === 'object') window.dispatchEvent(new CustomEvent('vision-recognition-start', {detail: visionSource}));
        startSelectedTracking();
      };
      trackingStart.addEventListener('click', () => {
        if (!trackingStart.disabled) beginTracking(pickupPage() ? trackingScope : null);
      });
      pickupSequenceStart.addEventListener('click', () => {
        if (!pickupSequenceStart.disabled && pickupPage()) beginTracking(null);
      });
      trackingStop.addEventListener('click', () => stopAllTracking());
      const updateCoordinatedFields = () => {
        const personFollow = document.body.dataset.consolePage === 'person';
        const headOnly = targetHeadOnly();
        const stagedTarget = pickupPage();
        document.querySelector('#pickup-stages').hidden = !stagedTarget;
        const showCoordinated = personFollow || stagedTarget;
        document.querySelectorAll('.coordinated-goal').forEach(field => { field.hidden = !showCoordinated; });
        document.querySelector('#follow-stop-area-setting').hidden = !personFollow;
        document.querySelector('#follow-area-deadzone-setting').hidden = !personFollow;
        document.querySelector('#follow-stop-distance-setting').hidden = !personFollow || !tofEnabled;
        document.querySelector('#follow-distance-deadzone-setting').hidden = !personFollow || !tofEnabled;
        document.querySelectorAll('.coordinated-arrival, .coordinated-mouth').forEach(field => {
          field.hidden = !stagedTarget;
        });
        const headTab = document.querySelector('[data-coordinated-tab="head"]');
        const bodyTab = document.querySelector('[data-coordinated-tab="body"]');
        if (personFollow && headTab.getAttribute('aria-selected') === 'true') bodyTab.click();
        document.querySelector('.coordinated-tab-row').hidden = personFollow;
        if (personFollow && document.querySelector('[data-body-stage-tab="final"]').getAttribute('aria-selected') === 'true') {
          document.querySelector('[data-body-stage-tab="approach"]').click();
        }
        const bodySelected = document.querySelector('[data-coordinated-tab="body"]').getAttribute('aria-selected') === 'true';
        document.querySelector('.body-phase-tabs').hidden = !bodySelected || personFollow;
        document.querySelector('#approach-forward-unit').textContent = personFollow ? 'm/s/相对误差' : 'm/s/rad';
        document.querySelector('#approach-yaw-unit').textContent = personFollow ? 'rad/s/半画宽' : 'rad/s/rad';
        document.querySelector('#body-phase-approach legend').textContent = personFollow ? '身体追踪' : '接近阶段';
        document.querySelector('.vision-target').hidden = !showCoordinated;
        document.querySelector('#body-pid').hidden = !lineFollowing();
        document.querySelector('#head-pid').hidden = !headOnly;
        document.querySelector('#coordinated-pid').hidden = !showCoordinated;
      };
      updateCoordinatedFields();
      updateTrackingGuide();
      updateTrackingButton();
      const updateTrackingTarget = ({ ready, point, area, area_px: areaPx, captured_at_unix_us: captured }) => {
        const previouslyReady = vision.frameReady;
        updateTrackingMarker(ready && Number.isSafeInteger(captured) && captured > 0 && area > 0 ? point : null);
        vision.targetReady = ready;
        if (!vision.targetReady) {
          if (!vision.awaitingTarget) {
            stopTracking();
            vision.frameReady = false;
            vision.target = null;
            if (coordinatedRun.active && previouslyReady) sendCoordinated('update');
            updateTrackingButton();
          }
          vision.lastCaptured = null;
          return;
        }
        updateTrackingButton();
        if (!Number.isSafeInteger(captured) || captured <= 0) {
          vision.frameReady = false;
          vision.target = null;
          if (coordinatedRun.active && previouslyReady) sendCoordinated('update');
          updateTrackingButton();
          startSelectedTracking();
          return;
        }
        if (vision.lastCaptured !== null && captured <= vision.lastCaptured) return;
        vision.lastCaptured = captured;
        vision.frameReady = true;
        const personFollow = document.body.dataset.consolePage === 'person';
        vision.target = Array.isArray(point) && point.length === 2
          && point.every(value => Number.isFinite(value) && Math.abs(value) <= 1)
          && Number.isFinite(area) && area > 0 && area <= 1
          && (!personFollow || (Number.isSafeInteger(areaPx) && areaPx >= 0))
          ? {point: [...point], area, ...(personFollow ? {area_px: areaPx} : {}), captured_at_unix_us: captured} : null;
        updateTrackingButton();
        if (coordinatedRun.active || (coordinatedRun.pending && !coordinatedRun.cancelled)) {
          armCoordinatedWatchdog();
          if (coordinatedRun.active && !previouslyReady) sendCoordinated('update');
        }
        startSelectedTracking();
      };
      window.addEventListener('camera-metadata', event => {
        if (JSON.stringify(camera) === JSON.stringify(event.detail)) return;
        camera = event.detail;
        vision.frameReady = false;
        vision.target = null;
        updateTrackingMarker(null);
        if (coordinatedRun.active) sendCoordinated('update');
        updateTrackingButton();
      });
      const resetVisionTracking = () => {
        vision.targetReady = false;
        if (selectedPage === pages.line) pages.line.point = null;
        updateTrackingMarker(null);
        vision.lastCaptured = null;
        stopAllTracking();
      };
      window.addEventListener('vision-source-change', (event) => {
        if (visionSource === event.detail) return;
        visionSource = event.detail;
        resetVisionTracking();
      });
      window.addEventListener('person-model-change', () => {
        if (visionSource !== 'object') return;
        visionDirect.object = false;
        resetVisionTracking();
      });
      const selectVisionSource = selected => {
        if (selected === visionSource) return;
        document.querySelectorAll('[data-vision-fields]').forEach(field => { field.hidden = field.dataset.visionFields !== selected; });
        document.querySelectorAll('[data-vision-feedback]').forEach(field => { field.hidden = field.dataset.visionFeedback !== selected; });
        window.dispatchEvent(new CustomEvent('vision-source-change', {detail: selected}));
      };
      window.addEventListener('vision-recognition-failed', event => {
        if (event.detail.source === visionSource) {
          if (lineFollowing()) pauseLineTracking();
          vision.frameReady = false;
          vision.target = null;
          if (coordinatedRun.active) sendCoordinated('update');
          updateTrackingButton();
        }
      });
      window.addEventListener('vision-direct-binding', event => {
        const {source, bound} = event.detail;
        if (!Object.hasOwn(visionDirect, source)) return;
        visionDirect[source] = bound;
        if (source === visionSource && !bound) {
          if (lineFollowing()) pauseLineTracking();
          vision.frameReady = false;
          vision.target = null;
          if (coordinatedRun.active) sendCoordinated('update');
        }
        updateTrackingButton();
        if (bound && source === visionSource) startSelectedTracking();
      });
      window.addEventListener('color-target', (event) => {
        if (!selectedPage?.vision || visionSource !== 'color') return;
        if (!lineFollowing()) {
          updateTrackingTarget(event.detail);
          return;
        }
        const {ready, line} = event.detail;
        if (!ready || !line || line.center === null) {
          if (pages.line.point !== null) pauseLineTracking();
          return;
        }
        vision.targetReady = true;
        pages.line.point = [2 * line.center - 1, line.aspect];
        if (lineRun.active) {
          armLineWatchdog();
          sendTracking('update', pages.line.point);
        }
        updateTrackingButton();
        startSelectedTracking();
      });
      window.addEventListener('object-target', (event) => {
        if (selectedPage === pages.person && visionSource === 'object') updateTrackingTarget(event.detail);
      });
      const showVolume = value => {
        audioVolume.value = String(value);
        audioVolumeValue.textContent = `${value}%`;
      };
      const requestVolume = async options => {
        const response = await fetch('/audio-volume', options);
        if (!response.ok) throw new Error(await response.text());
        const value = (await response.json()).volume;
        if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('声卡返回无效音量');
        return value;
      };
      const sendVolume = async () => {
        if (volumeBusy || desiredVolume === null) return;
        const value = desiredVolume;
        desiredVolume = null;
        volumeBusy = true;
        try {
          const previousSavedVolume = savedAudioVolume;
          confirmedVolume = await requestVolume({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volume: value }) });
          savedAudioVolume = confirmedVolume;
          audioVolume.disabled = false;
          if (desiredVolume === null) showVolume(confirmedVolume);
          if (confirmedVolume !== previousSavedVolume) queueSettings();
        } catch (error) {
          if (desiredVolume === null && confirmedVolume !== null) showVolume(confirmedVolume);
          setNotice(`音量设置失败：${error.message}`, true);
        } finally {
          volumeBusy = false;
          if (desiredVolume !== null) sendVolume();
          else updateSettingsState();
        }
      };
      audioVolume.addEventListener('input', () => {
        volumeRevision++;
        desiredVolume = Number(audioVolume.value);
        audioVolumeValue.textContent = `${desiredVolume}%`;
        clearTimeout(volumeTimer);
        volumeTimer = setTimeout(() => { volumeTimer = null; sendVolume(); }, 120);
      });
      const initialVolumeRevision = volumeRevision;
      requestVolume().then(value => {
        if (volumeRevision !== initialVolumeRevision) return;
        confirmedVolume = value;
        showVolume(value);
        audioVolume.disabled = false;
      }).catch(error => setNotice(`音量不可用：${error.message}`, true));
      const setText = (element, value) => {
        if (window.WonderduckLanguage) window.WonderduckLanguage.setLocalizedText(element, value);
        else if (element.textContent !== String(value)) element.textContent = String(value);
      };
      const updateActionAvailability = (connected) => {
        skillButtons.forEach(button => {
          const skill = button.dataset.action;
          button.disabled = !connected || !availableSkills.includes(skill)
            || activeSkill === skill || pendingSkills.has(skill);
          button.setAttribute('aria-busy', String(activeSkill === skill || pendingSkills.has(skill)));
        });
        document.querySelector('[data-action="stop"]').disabled = !connected;
      };
      function clearPendingSkill(skill) {
        clearTimeout(pendingSkills.get(skill)?.timer);
        pendingSkills.delete(skill);
      }
      function clearSkillSession() {
        for (const skill of pendingSkills.keys()) clearPendingSkill(skill);
        activeSkill = skillStatusSequence = lastSkillTimeoutSequence = null;
      }
      function updateSkillStatus(status) {
        const sequence = status.power_status_sequence;
        if (status.robotd_connected !== true || !Number.isSafeInteger(sequence) || sequence <= 0
            || status.motion_enabled === undefined || sequence === skillStatusSequence) return;
        const previous = skillStatusSequence;
        skillStatusSequence = sequence;
        const skill = typeof status.active_skill === 'string' ? status.active_skill : null;
        if (skill !== activeSkill) {
          activeSkill = skill;
          if (skill) setNotice(`正在执行动作：${skillLabels[skill] || skill}`);
        }
        for (const [name, pending] of pendingSkills) {
          if (pending.acknowledged) clearPendingSkill(name);
        }
        const event = status.last_skill_timeout;
        if (Number.isSafeInteger(event?.sequence) && typeof event.skill === 'string') {
          if (previous !== null && event.sequence !== lastSkillTimeoutSequence) {
            clearPendingSkill(event.skill);
            if (pickMouthButton === event.skill) cancelPickMouth(true);
            setNotice(`动作超时：${skillLabels[event.skill] || event.skill}`, true);
          }
          lastSkillTimeoutSequence = event.sequence;
        }
        updateActionAvailability(controlLeaseReady);
      }
      const setConnected = (connected, text) => {
        dot.classList.toggle("online", connected);
        dot.setAttribute("aria-label", connected ? "控制已就绪" : "控制未连接");
        setText(connection, text || (connected ? '控制已连接' : '控制未连接'));
        updateActionAvailability(connected);
        renderMotionPower();
        speedInput.disabled = !connected;
        speedRange.disabled = !connected;
        turnInput.disabled = !connected;
        turnRange.disabled = !connected;
        triggerRanges.forEach((range) => { range.disabled = !connected; });
        updateSticksAvailability();
        obstacleEnabled.disabled = !connected || !confirmedObstacle || obstaclePending;
        obstacleDistance.disabled = !connected || !confirmedObstacle || obstaclePending;
        obstacleDelay.disabled = !connected || !confirmedObstacle || obstaclePending;
        if (!connected) {
          stopAllTracking(false); stopMaze(false);
          headPositionState = 'idle';
          targetHeadHome = null;
          if (headPositionScope === 'home') applyHeadPositionScope('home');
          robotConnected = false;
          renderControlStatus({});
          setStatusValue(motorStatus, '--');
          motorStatus.title = '';
          setStatusValue(tofDistance, '服务断开');
        }
        updateMazeButton();
        updateSettingsState();
      };
      const setStatusValue = (element, value, tone = "") => {
        setText(element, value);
        if (element.className !== tone) element.className = tone;
      };
      const controlStatus = Object.fromEntries(['safety', 'service', 'health', 'motor', 'cpu', 'loop']
        .map(name => [name, document.querySelector(`#control-${name}`)]));
      const cameraTof = document.querySelector('#camera-tof');
      const motorTemperature = (status, digits) => {
        if (status.robotd_connected !== true || !Number.isFinite(status.motor_temp_c)) return '--';
        const id = Number.isInteger(status.motor_id) ? ` · ID ${status.motor_id}` : '';
        return `${status.motor_temp_c.toFixed(digits)} °C${id}`;
      };
      const tofMessage = status => {
        if (status.robotd_connected !== true) return '服务断开';
        if (status.tof_sensor_status === 'valid') {
          return Number.isFinite(status.tof_distance_mm) ? `${status.tof_distance_mm} mm` : '数据异常';
        }
        const labels = {unknown: '暂无数据', unavailable: '设备不可用', error: '测距异常',
          filtering: '正在采样', invalid: '超出测量范围', out_of_range: '超出测量范围'};
        return Object.hasOwn(labels, status.tof_sensor_status) ? labels[status.tof_sensor_status]
          : status.tof_sensor_status == null ? '暂无数据' : '状态异常';
      };
      const renderControlStatus = status => {
        const connected = status.robotd_connected === true;
        headStickPosition.forEach((output, index) => {
          const count = status.head_positions?.[index];
          const value = connected && Number.isInteger(count) ? String(count) : '--';
          if (output.textContent !== value) output.textContent = value;
        });
        const number = (value, digits, unit) => connected && Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : '--';
        const health = !connected || typeof status.healthy !== 'boolean' ? '等待数据'
          : status.healthy ? '正常' : status.health_degraded ? '降级' : '异常';
        const safety = !connected ? '--' : status.fallen === true ? '摔倒'
          : status.limp === true ? '卸力状态' : status.fallen === false ? '正常' : '--';
        setStatusValue(cameraTof, tofMessage(status));
        setStatusValue(controlStatus.safety, safety, safety === '正常' ? 'good' : safety === '--' ? '' : 'warn');
        setStatusValue(controlStatus.service, connected ? '已连接' : '未连接', connected ? 'good' : 'bad');
        setStatusValue(controlStatus.health, health, health === '正常' ? 'good' : health === '等待数据' ? '' : health === '降级' ? 'warn' : 'bad');
        controlStatus.health.title = connected ? status.health_reason || '' : '';
        setStatusValue(controlStatus.motor, motorTemperature(status, 0));
        controlStatus.motor.title = connected ? status.motor_name || '' : '';
        setStatusValue(controlStatus.cpu, number(status.cpu_temp_c, 0, ' °C'));
        const hz = Number.isFinite(status.health_loop_hz) ? status.health_loop_hz : status.loop_hz;
        const period = Number.isFinite(hz) && hz > 0 ? 1000 / hz : null;
        const missed = connected && Number.isFinite(status.health_loop_missed) ? status.health_loop_missed : '--';
        const timeouts = connected && Number.isFinite(status.bus_read_timeouts) ? status.bus_read_timeouts : '--';
        setStatusValue(controlStatus.loop, `${number(period, 1, ' ms')} / ${missed} / ${timeouts}`);
      };
      const formatVector = (value, digits = 2) => Array.isArray(value)
        ? value.map((item) => Number(item).toFixed(digits)).join(" | ")
        : "--";
      const formatRpy = (value) => {
        if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) return "--";
        const norm = Math.hypot(...value);
        if (!Number.isFinite(norm) || norm === 0) return "--";
        const [w, x, y, z] = value.map(item => item / norm);
        // Trunk-to-world quaternion [w, x, y, z], displayed as roll, pitch, yaw.
        const angles = [Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
          Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))),
          Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))];
        return angles.map(angle => Number((angle * 180 / Math.PI).toFixed(1)).toFixed(1)).join(" | ");
      };
      const updateStatus = (status) => {
        const connected = status.robotd_connected === true;
        const nextTrackingPhase = connected && coordinatedRun.active ? status.tracking_phase || null : null;
        const nextPickupStage = connected && pickupPage() && coordinatedRun.active && pages.pickup.runScope === null
          ? status.pickup_stage || null : null;
        if (nextPickupStage !== pages.pickup.robotStage || nextTrackingPhase !== vision.robotPhase) {
          if (nextPickupStage === 'after' && pages.pickup.robotStage !== 'after') selectPickupStage('pickup_after');
          pages.pickup.robotStage = nextPickupStage;
          vision.robotPhase = nextTrackingPhase;
          updateTrackingButton();
        }
        const skills = connected && Array.isArray(status.skills) ? [...new Set(status.skills.filter(name => typeof name === 'string' && name !== ''))] : [];
        if (JSON.stringify(skills) !== JSON.stringify(availableSkills)) {
          availableSkills = skills;
          renderArrivalSkills();
          updateActionAvailability(session.open);
        }
        robotConnected = connected;
        updatePowerState(status);
        updateSkillStatus(status);
        renderControlStatus(status);
        if (!connected && (mazeRun.active || mazeRun.pending)) { stopMaze(); setNotice('机器人连接中断，避障行走已停止。', true); }
        if (!connected && (vision.awaitingTarget || lineRun.active || lineRun.pending || coordinatedRun.active || coordinatedRun.pending)) {
          stopAllTracking(false);
          setNotice('机器人连接中断，视觉追踪已停止。', true);
        }
        setStatusValue(robotdStatus, connected ? "在线" : "未连接", connected ? "good" : "bad");
        setText(robotdSummary, connected ? "" : (status.connection_error || "等待机器人服务。"));

        if (typeof status.healthy === "boolean") {
          setStatusValue(healthStatus, status.healthy ? "正常" : "异常", status.healthy ? "good" : "bad");
        } else {
          setStatusValue(healthStatus, "等待数据");
        }
        const batteryPercent = typeof status.battery_percent === "number" && Number.isFinite(status.battery_percent)
          ? status.battery_percent : null;
        const batteryText = batteryPercent === null ? "--%" : `${batteryPercent.toFixed(0)}%`;
        const batteryVolts = typeof status.battery_volts === "number" && Number.isFinite(status.battery_volts)
          ? status.battery_volts : null;
        setText(batteryStatus, batteryText);
        setText(batteryVoltage, batteryVolts === null ? "--V" : `${batteryVolts.toFixed(2)}V`);
        batteryFill.setAttribute("width", batteryPercent === null ? "0" : String(batteryPercent / 100 * 14));
        const batteryLabel = batteryPercent === null ? "电量未知" : `电量 ${batteryText}`;
        const batteryDescription = batteryVolts === null ? batteryLabel : `${batteryLabel}，${batteryVolts.toFixed(2)} V`;
        batteryIndicator.setAttribute("aria-label", batteryDescription);
        batteryIndicator.title = batteryDescription;
        setStatusValue(motorStatus, motorTemperature(status, 1));
        motorStatus.title = connected ? status.motor_name || '' : '';
        setStatusValue(cpuStatus, typeof status.cpu_temp_c === "number" ? `${status.cpu_temp_c.toFixed(1)} °C` : "--");
        setStatusValue(robotModeStatus, status.robot_mode || "--");
        setStatusValue(policyStatus, status.policy || "--");
        const period = connected && Number.isFinite(status.loop_hz) && status.loop_hz > 0
          ? `${Number((1000 / status.loop_hz).toFixed(2))} ms` : "--";
        const delays = connected && Number.isFinite(status.loop_missed) ? status.loop_missed : "--";
        const timeouts = connected && Number.isFinite(status.bus_read_timeouts) ? status.bus_read_timeouts : "--";
        setStatusValue(loopStatus, `${period} / ${delays} / ${timeouts}`);
        setStatusValue(gyroStatus, formatVector(status.imu_gyro, 3));
        setStatusValue(rpyStatus, formatRpy(status.imu_quat));
        setStatusValue(tofDistance, tofMessage(status));
        if (mazeRun.active) setText(mazeStatus, connected && typeof status.tof_distance_mm === 'number' ? '避障行走中' : '测距不可用，等待恢复');
        setText(obstacleState, connected && status.obstacle_active === true ? "避障中" : "");
        const safety = status.fallen === true ? "已倒下" : status.limp === true ? "已泄力" : status.fallen === false ? "正常" : "--";
        setStatusValue(safetyStatus, safety, safety === "正常" ? "good" : safety === "--" ? "" : "warn");
        setText(statusDetail, status.health_reason || status.policy_unavailable || (connected ? "" : "状态数据尚未到达。"));
        restoreSharedSettings();
        updateSettingsState();
      };
      const sendInput = () => {
        if (!studioActive || !controlLeaseReady || !session.open
            || session.backpressured || (state.active && (mazeRun.active || mazeRun.pending))) return;
        state.buttons = [];
        const visionInput = isVisionPage()
          && state.active && !sticksBlocked()
          && [state.left_x, state.left_y, state.right_x, state.right_y].some(value => value !== 0);
        if (visionInput && mode !== 'head_drive') {
          if (!visionModeRequested) {
            // Send a neutral edge first so the existing mode button can rise with this input.
            session.send({ type: 'input', seq: ++sequence, ...state,
              left_x: 0, left_y: 0, right_x: 0, right_y: 0, buttons: [] });
            visionModeRequested = true;
          }
          if (!state.buttons.includes('right')) state.buttons.push('right');
        }
        const head_stick = document.body.dataset.consolePage === 'control' && mode !== 'body_pose'
          ? headStickAxes : undefined;
        session.send({ type: "input", seq: ++sequence, ...state, head_stick });
      };
      function sendActionRequest(name) {
        const requestId = ++nextActionRequestId;
        session.send({ type: 'action', name, request_id: requestId });
        return requestId;
      }
      const sendAction = (name) => {
        if (!studioActive) return;
        if (!session.open) {
          setNotice("浏览器控制尚未连接。", true);
          return;
        }
        if (name === 'stop') { keys.clear(); zero(); stopAllTracking(false); }
        const mazeStopping = mazeRun.active || mazeRun.pending;
        if (mazeStopping) {
          if (name !== 'stop') return;
          stopMaze(false);
        }
        if (!skillActions.has(name)) return sendActionRequest(name);
        if (!controlLeaseReady || !availableSkills.includes(name)
            || activeSkill === name || pendingSkills.has(name)) return;
        const id = sendActionRequest(name);
        const timer = setTimeout(() => {
          const pending = pendingSkills.get(name);
          if (pending?.id !== id) return;
          clearPendingSkill(name);
          updateActionAvailability(controlLeaseReady);
          if (!pending.acknowledged) setNotice(`未收到动作确认：${skillLabels[name] || name}`, true);
        }, 5000);
        pendingSkills.set(name, { id, timer, acknowledged: false });
        updateActionAvailability(controlLeaseReady);
        return id;
      };
      motionPower.addEventListener('click', () => {
        if (motionPower.disabled || !studioActive) return;
        const resting = restPhase === 'failed'
          || (restPhase === 'idle' && motionEnabled === true && motionHomed === true);
        powerPending = resting ? 'rest' : 'start';
        powerAcknowledged = false;
        powerRequestSequence = powerSequence;
        keys.clear();
        zero();
        renderMotionPower();
        powerActionRequestId = sendAction(resting ? 'rest' : 'manual_prepare_drive');
      });
      document.querySelector('#standalone-shutdown').addEventListener('click', () => {
        if (!shutdownConfirm.open) { shutdownConfirm.returnValue = ''; shutdownConfirm.showModal(); }
      });
      shutdownConfirm.addEventListener('close', () => {
        if (shutdownConfirm.returnValue === 'confirm') sendAction('shutdown');
      });
      const blockedMotionTarget = target => target instanceof Element && target.closest(
        '.pad, .skill-actions [data-action], [data-trigger-range], #tracking-start, #pickup-sequence-start, #maze, #control-action-run, #head-position');
      for (const type of ['pointerdown', 'click']) document.addEventListener(type, event => {
        if (!motionUnavailable() || !blockedMotionTarget(event.target)) return;
        event.preventDefault(); event.stopImmediatePropagation(); remindMotion();
      }, true);
      document.addEventListener('keydown', event => {
        if (!motionUnavailable() || !['Enter', 'Space'].includes(event.code) || !blockedMotionTarget(event.target)) return;
        event.preventDefault(); event.stopImmediatePropagation(); remindMotion();
      }, true);
      const applySpeed = (rawValue, send = true) => {
        const value = Math.max(0, Math.min(Number(speedInput.max), Number(rawValue)));
        if (!Number.isFinite(value)) return;
        linearSpeed = value;
        const formatted = value.toFixed(2);
        speedInput.value = formatted;
        speedRange.value = formatted;
        if (send && session.open) {
          session.send({ type: "set_speed", linear_speed: value, turn_speed: turnSpeed });
          if (mazeRun.active) sendMaze('update');
        }
      };
      const applyTurn = (rawValue, send = true) => {
        const value = Math.max(0, Math.min(1, Number(rawValue)));
        if (!Number.isFinite(value)) return;
        turnSpeed = value; turnInput.value = value.toFixed(1); turnRange.value = value;
        if (send) applySpeed(linearSpeed);
      };
      const applyObstacle = (settings) => {
        if (!settings) return;
        if (tofEnabled) confirmedObstacle = settings;
        obstacleEnabled.checked = settings.enabled === true;
        obstacleDistance.value = settings.threshold_mm;
        obstacleDelay.value = settings.clear_delay_ms;
        setText(obstacleDistanceValue, `${settings.threshold_mm} mm`);
        setText(obstacleDelayValue, `${settings.clear_delay_ms} ms`);
      };
      const sendObstacle = (restoring = false) => {
        if (!tofEnabled || !session.open || !confirmedObstacle || obstaclePending) return;
        if (restoring !== true) restoreObstacle = null;
        obstaclePending = true;
        obstacleEnabled.disabled = obstacleDistance.disabled = obstacleDelay.disabled = true;
        session.send({ type: "set_obstacle", enabled: obstacleEnabled.checked,
          threshold_mm: Number(obstacleDistance.value), clear_delay_ms: Number(obstacleDelay.value) });
      };
      const restoreSharedSettings = () => {
        if (restoreObstacle && confirmedObstacle && !obstaclePending
            && Object.keys(restoreObstacle).every(key => restoreObstacle[key] === confirmedObstacle[key])) {
          restoreObstacle = null;
          updateSettingsState();
        }
        if (!session.open || !robotConnected || !state.active || !document.hasFocus()) return;
        if (restoreObstacle && confirmedObstacle && !obstaclePending) {
          const saved = restoreObstacle;
          obstacleEnabled.checked = saved.enabled;
          obstacleDistance.value = saved.threshold_mm;
          obstacleDelay.value = saved.clear_delay_ms;
          sendObstacle(true);
        }
      };
      const updateControls = (controls) => {
        const wasReady = driveControlReady;
        driveControlReady = controls.human_connected === true && controls.armed === true;
        const owner = Object.hasOwn(controls, 'control_owner') ? controls.control_owner : controls.human_owner;
        const previouslyOwned = ownsControl;
        const previouslyBlocked = otherController;
        ownsControl = controls.control_owned ?? (owner === 'web');
        otherController = owner !== null && owner !== undefined && !ownsControl;
        if ((wasReady && !driveControlReady) || (previouslyOwned && !ownsControl)
          || (!previouslyBlocked && otherController)) {
          keys.clear();
          zero();
        }
        if (previouslyOwned && !ownsControl) {
          const running = lineRun.active || coordinatedRun.active || mazeRun.active;
          headPositionWanted = false;
          headPositionState = 'idle';
          stopAllTracking(false);
          stopMaze(false);
          if (running) setNotice('自主运行已停止，控制权已释放。');
        }
        const controller = {
          app: '手机 App 正在控制',
          web: '另一网页正在控制',
          gamepad: '手柄正在控制',
          unknown: '其他设备正在控制',
        }[owner];
        setText(document.querySelector('#human-owner'), !controls.human_connected
          ? '连接失效' : ownsControl ? '本网页' : controller || '空闲');
        setText(controlBusy, otherController ? controller || '其他设备正在控制' : '');
        controlBusy.hidden = !otherController;
        const previousLinearSpeed = linearSpeed, previousTurnSpeed = turnSpeed;
        applySpeed(controls.linear_speed, false); applyTurn(controls.turn_speed, false);
        if (mazeRun.active && (linearSpeed !== previousLinearSpeed || turnSpeed !== previousTurnSpeed)) sendMaze('update');
        if (tofEnabled && !obstaclePending) {
          confirmedObstacle = controls.obstacle || null;
          applyObstacle(confirmedObstacle);
          const ready = !!confirmedObstacle && session.open;
          obstacleEnabled.disabled = obstacleDistance.disabled = obstacleDelay.disabled = !ready;
        }
        updateMode(controls.mode, false);
        updateSettingsState();
        restoreSharedSettings();
      };
      const displayMode = () => isVisionPage() ? 'head_drive' : mode;
      const updateMode = (nextMode, announce = true) => {
        const next = modeCopy[nextMode] ? nextMode : "drive";
        const visionSwitch = visionModeRequested && next === 'head_drive'
          && isVisionPage() && !sticksBlocked();
        if (mode !== next && !visionSwitch) { keys.clear(); zero(); }
        mode = next;
        const copy = modeCopy[displayMode()];
        setText(leftHint, copy.leftHint);
        setText(rightHint, copy.rightHint);
        setText(leftSummary, copy.leftSummary);
        setText(rightSummary, copy.rightSummary);
        Object.entries(copy.axes).forEach(([axis, text]) => {
          const label = document.querySelector(`[data-axis-label="${axis}"]`);
          setText(label, text);
          label.classList.toggle("unused", text === "未使用");
        });
        document.querySelectorAll("[data-mode]").forEach((button) => {
          button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
        });
        motion.renderMode();
        updateSticksAvailability();
        if (visionSwitch) { visionModeRequested = false; sendInput(); }
        if (announce) setNotice(`已切换到${copy.label}。`);
      };
      const connect = () => { if (studioActive) session.start(); };

      function handleControlMessage(message) {
        if (message.type === 'studio_leave_result' && message.request_id === studioLeaveRequest) {
          headPositionState = 'idle';
          completeStudioLeave(message.accepted, message.reason);
        } else if (message.type === "lease") {
          controlLeaseReady = true;
          controlBusy.hidden = true;
          setText(controlBusy, '');
          zero();
          setConnected(true, "");
          window.__visionControlToken = message.vision_token || null;
          window.dispatchEvent(new Event('vision-control-token'));
          targetHeadHome = Number.isInteger(message.head_home_pitch_raw)
            && message.head_home_pitch_raw >= 1024 && message.head_home_pitch_raw <= 2250
            ? message.head_home_pitch_raw : null;
          if (headPositionScope === 'home') applyHeadPositionScope('home');
          const draft = settingsDirty ? collectSettings() : null;
          const headDraft = headSettingsDirty ? collectHeadSettings() : null;
          const hadTrackingDraft = trackingUnsaved();
          updateControls(message.controls);
          settingsDefaults = message.defaults;
          headSettingsDefaults = message.head_defaults;
          coordinatedDefaults = validCoordinatedSettings(message.coordinated_defaults) ? message.coordinated_defaults : null;
          phaseDefaults = validPhaseSettings(message.tracking_phase_defaults) ? message.tracking_phase_defaults : null;
          personCoordinatedDefaults = validCoordinatedSettings(message.person_coordinated_defaults)
            ? message.person_coordinated_defaults : coordinatedDefaults;
          personPhaseDefaults = validPhaseSettings(message.person_tracking_phase_defaults)
            ? message.person_tracking_phase_defaults : phaseDefaults;
          const receivedProfiles = {
            target: [message.coordinated_settings, message.tracking_phases],
            pickup_after: [message.pickup_after_settings, message.pickup_after_phases],
            person: [message.person_coordinated_settings || message.coordinated_settings,
              message.person_tracking_phases || message.tracking_phases],
          };
          for (const [scope, [coordinatedSaved, phaseSaved]] of Object.entries(receivedProfiles)) {
            const profile = trackingProfiles[scope];
            profile.coordinatedReady = Boolean(coordinatedDefaults && validCoordinatedSettings(coordinatedSaved));
            profile.phaseReady = Boolean(phaseDefaults && validPhaseSettings(phaseSaved));
            if (!profile.coordinatedDirty) profile.coordinated = coordinatedSaved;
            if (!profile.phaseDirty) profile.phases = phaseSaved;
            profile.coordinatedSavedJson = profile.coordinatedReady ? JSON.stringify(coordinatedSaved) : null;
            profile.phaseSavedJson = profile.phaseReady ? JSON.stringify(phaseSaved) : null;
          }
          const selectedColor = colorPresetSelect.value;
          colorPresets = new Map(Object.entries(message.color_presets));
          colorPresetsLoaded = true;
          renderColorPresets();
          if (selectedColor && !colorPresets.has(selectedColor)) {
            colorPresetName.value = '';
            window.dispatchEvent(new CustomEvent('color-reference-load', {detail: null}));
          }
          applySettings(draft || message.settings);
          applyHeadSettings(headDraft || message.head_settings);
          applyTrackingProfile(document.body.dataset.consolePage === 'person' ? 'person' : trackingScope);
          settingsLoaded = true;
          savedSettingsJson = message.settings ? JSON.stringify(message.settings) : null;
          headSavedJson = JSON.stringify(message.head_settings);
          if (draft) queueSettings();
          if (headDraft) queueHeadSettings();
          if (!draft && !headDraft && !hadTrackingDraft) settingsStatus.textContent = '';
          updateSettingsState();
          updateMazeButton();
          reconcileHeadPosition();
          setNotice("");
        } else if (message.type === 'settings_result' && message.request_id === colorPresetPending?.request_id) {
          const pending = colorPresetPending;
          colorPresetPending = null;
          if (pending.operation === 'delete' && message.accepted) {
            const stillSelected = colorPresetSelect.value === pending.name;
            colorPresets.delete(pending.name);
            renderColorPresets();
            if (stillSelected) {
              colorPresetName.value = '';
              window.dispatchEvent(new CustomEvent('color-reference-load', {detail: null}));
            }
            setNotice('颜色已删除');
          } else if (pending.operation === 'delete') {
            setNotice(`颜色删除失败：${message.reason || '未知错误'}`, true);
          } else if (message.accepted) {
            colorPresets.set(pending.name, pending.preset);
            renderColorPresets();
            if (pending.revision === colorPresetRevision) {
              colorPresetName.value = pending.name;
              colorPresetSelect.value = pending.name;
            }
            setNotice('颜色已保存');
          } else setNotice(`颜色保存失败：${message.reason || '未知错误'}`, true);
          updateColorPresetControls();
        } else if (message.type === 'settings_result'
            && Object.values(trackingProfiles).some(profile => message.request_id === profile.phasePendingId)) {
          const profile = Object.values(trackingProfiles).find(item => message.request_id === item.phasePendingId);
          profile.phaseSaving = false;
          profile.phasePendingId = null;
          const completed = profile.phasePendingJson;
          profile.phasePendingJson = null;
          if (message.accepted) {
            profile.phaseSavedJson = completed;
            markSettingsSaved();
            updateSettingsState();
          } else {
            profile.phaseDirty = true; profile.phaseFailed = true;
            settingsStatus.textContent = `自动保存失败：${message.reason}`;
            setNotice(settingsStatus.textContent, true);
            updateSettingsState();
          }
        } else if (message.type === 'settings_result'
            && Object.values(trackingProfiles).some(profile => message.request_id === profile.coordinatedPendingId)) {
          const profile = Object.values(trackingProfiles).find(item => message.request_id === item.coordinatedPendingId);
          profile.coordinatedSaving = false;
          profile.coordinatedPendingId = null;
          const completedSettingsJson = profile.coordinatedPendingJson;
          profile.coordinatedPendingJson = null;
          if (message.accepted) {
            profile.coordinatedSavedJson = completedSettingsJson;
            markSettingsSaved();
            updateSettingsState();
          } else {
            profile.coordinatedDirty = true; profile.coordinatedFailed = true;
            settingsStatus.textContent = `自动保存失败：${message.reason}`;
            setNotice(settingsStatus.textContent, true);
            updateSettingsState();
          }
        } else if (message.type === 'settings_result' && message.request_id === headSettingsPendingId) {
          headSettingsSaving = false;
          headSettingsPendingId = null;
          const completedSettingsJson = headPendingJson;
          headPendingJson = null;
          if (message.accepted) {
            headSavedJson = completedSettingsJson;
            markSettingsSaved();
            updateSettingsState();
          } else {
            headSettingsDirty = true; headSettingsFailed = true;
            settingsStatus.textContent = `自动保存失败：${message.reason}`;
            setNotice(settingsStatus.textContent, true);
            updateSettingsState();
          }
        } else if (message.type === 'settings_result' && message.request_id === settingsPendingId) {
          settingsSaving = false;
          settingsPendingId = null;
          const completedSettingsJson = pendingSettingsJson;
          pendingSettingsJson = null;
          if (message.accepted) {
            savedSettingsJson = completedSettingsJson;
            markSettingsSaved();
            updateSettingsState();
          } else {
            settingsDirty = true; settingsFailed = true;
            settingsStatus.textContent = `自动保存失败：${message.reason}`;
            setNotice(settingsStatus.textContent, true);
            updateSettingsState();
          }
        } else if (message.type === "controls") {
          updateControls(message.controls);
        } else if (message.type === 'motion_tracking_result') {
          if (message.action === 'start' && lineRun.pending) {
            const mustStop = lineRun.accept(message.accepted, studioActive && state.active && lineFollowing());
            if (lineRun.active) {
              armLineWatchdog();
              sendTracking('update', pages.line.point);
            } else if (mustStop) sendTracking('stop');
          } else if (message.action === 'update' && !message.accepted && lineRun.active) {
            stopTracking(false);
          }
          if (lineFollowing() && !message.accepted && message.action !== 'stop') {
            setNotice(`身体追踪不可用：${message.reason || '机器人拒绝请求'}`, true);
          }
          updateMazeButton();
        } else if (message.type === 'head_position_result') {
          // A queued result can arrive after the workspace handoff has stopped
          // the old hold. It must not affect the new page or start a new hold.
          if (studioLeaveRequest !== null || (message.action === 'stop' && headPositionState !== 'stopping')) return;
          if (message.action === 'start') {
            headPositionState = message.accepted ? 'active' : 'idle';
            if (message.accepted && headPositionWanted) sendHeadPosition('update');
            if (!message.accepted) {
              headPositionWanted = false;
              setNotice(`头部定位不可用：${message.reason || '机器人拒绝请求'}`, true);
            }
          } else if (message.action === 'stop') {
            headPositionState = 'idle';
            if (!message.accepted) {
              vision.awaitingTarget = false;
              headPositionWanted = false;
              setNotice(`头部保持结束失败：${message.reason || '机器人拒绝请求'}`, true);
              updateMazeButton();
            }
          } else if (!message.accepted && headPositionState === 'active') {
            headPositionState = 'idle';
            headPositionWanted = false;
            setNotice(`头部保持已停止：${message.reason || '机器人拒绝请求'}`, true);
          }
          reconcileHeadPosition();
          if (headPositionState === 'idle') startSelectedTracking();
        } else if (message.type === 'coordinated_tracking_result') {
          const owner = coordinatedOwner;
          const current = owner === coordinatedRun && !owner.cancelled && studioActive;
          if (message.action === 'start' && owner?.pending) {
            const mustStop = owner.accept(message.accepted, current);
            if (owner.active) {
              const changedPitch = document.body.dataset.consolePage === 'person'
                && vision.startPitch !== (headPositionTarget ?? 1500);
              sendCoordinated('update', vision.target, changedPitch ? (headPositionTarget ?? 1500) : null);
            } else {
              owner.clearTimer();
              coordinatedOwner = null;
              if (mustStop) sendCoordinated('stop');
            }
          } else if (message.action === 'update' && !message.accepted && current && owner.active) {
            stopCoordinated(false);
          }
          if (current && !message.accepted && message.action !== 'stop') {
            const name = document.body.dataset.consolePage === 'person' ? '身体追踪' : targetHeadOnly() ? '头部追踪' : '联合追踪';
            setNotice(`${name}不可用：${message.reason || '机器人拒绝请求'}`, true);
          }
          updateMazeButton();
        } else if (message.type === 'maze_result') {
          if (message.action === 'start' && mazeRun.pending) {
            const cancelled = mazeRun.cancelled;
            const mustStop = mazeRun.accept(message.accepted, selectedPage === pages.maze);
            if (mazeRun.active) {
              sendMaze('update');
              mazeRun.timer = setInterval(() => sendMaze('update'), 200);
            } else if (mustStop) {
              sendMaze('stop');
            } else if (!cancelled && selectedPage === pages.maze) {
              setNotice(`避障行走不可用：${message.reason || '机器人拒绝请求'}`, true);
            }
          } else if (message.action === 'update' && !message.accepted && mazeRun.active) {
            stopMaze();
            setNotice(`避障行走已停止：${message.reason || '机器人拒绝请求'}`, true);
          } else if (message.action === 'stop' && !message.accepted) {
            setNotice(`避障行走停止失败：${message.reason || '机器人拒绝请求'}`, true);
          }
          updateMazeButton();
        } else if (message.type === "obstacle_settings") {
          obstaclePending = false;
          if (restoreObstacle && Object.keys(restoreObstacle).every(key => restoreObstacle[key] === message.settings[key])) restoreObstacle = null;
          applyObstacle(message.settings);
          obstacleEnabled.disabled = obstacleDistance.disabled = obstacleDelay.disabled = false;
          updateSettingsState();
        } else if (message.type === "action_result") {
          const pendingSkill = pendingSkills.get(message.name);
          if (skillActions.has(message.name) && message.request_id !== undefined) {
            if (pendingSkill?.id !== message.request_id) return;
            if (message.accepted) {
              pendingSkill.acknowledged = true;
              if (message.name === 'ground_pick' && state.active && studioActive) schedulePickMouth(message.name);
              setNotice(`正在执行动作：${skillLabels[message.name] || message.name}`);
              return;
            }
            clearPendingSkill(message.name);
            updateActionAvailability(controlLeaseReady);
          }
          if (!message.accepted && pickMouthActive && message.name === pickMouthButton) cancelPickMouth(true);
          if (message.name === 'prepare_drive' || message.name === 'manual_prepare_drive' || message.name === 'rest') {
            if (message.request_id !== undefined && message.request_id !== powerActionRequestId) return;
            powerActionRequestId = null;
            const operation = message.name === 'rest' ? 'rest' : 'start';
            if (powerPending === operation) {
              powerAcknowledged = message.accepted;
              if (!message.accepted) powerPending = null;
              else powerRequestSequence = powerSequence;
            }
            setNotice(message.accepted ? (operation === 'rest' ? '正在休息。' : '正在准备行走控制。')
              : `${operation === 'rest' ? '休息' : '启动'}失败：${message.reason || '机器人拒绝请求'}`, !message.accepted);
            renderMotionPower();
            return;
          }
          if (message.name === 'stop') {
            stopMaze();
            stopCoordinated(false);
            if (message.accepted) {
              for (const skill of pendingSkills.keys()) clearPendingSkill(skill);
              updateActionAvailability(controlLeaseReady);
            }
          }
          const action = actionNames[message.name] || message.name;
          const reason = message.reason === 'autonomous control owns the robot'
            ? '自主追踪或避障行走正在控制机器人。'
            : (Object.hasOwn(skillRefusals, message.reason) ? skillRefusals[message.reason]
              : message.reason || '机器人拒绝了该请求。');
          const text = message.accepted ? `已执行：${action}。` : `未执行：${action}。${reason}`;
          setNotice(text, !message.accepted);
        } else if (message.type === "error") {
          if (message.code === "control_busy") {
            setText(controlBusy, message.message);
            controlBusy.hidden = false;
            return;
          }
          if (visionModeRequested) { keys.clear(); zero(); }
          if (message.request_id !== undefined) {
            for (const [name, pending] of pendingSkills) {
              if (pending.id === message.request_id) clearPendingSkill(name);
            }
            updateActionAvailability(controlLeaseReady);
          }
          if (powerActionRequestId !== null && message.request_id === powerActionRequestId) {
            powerActionRequestId = null;
            powerPending = null;
            powerAcknowledged = false;
            renderMotionPower();
          }
          setNotice(`控制不可用：${message.message}`, true);
          obstaclePending = false;
          applyObstacle(confirmedObstacle);
          obstacleEnabled.disabled = obstacleDistance.disabled = obstacleDelay.disabled = !confirmedObstacle;
        } else if (message.type === "status") {
          updateStatus(message.status || {});
        }
      }

      function handleControlClose() {
        if (studioLeaveRequest !== null) completeStudioLeave(false, '操控连接不可用');
        controlLeaseReady = false;
        ownsControl = otherController = false;
        controlBusy.hidden = true;
        clearSkillSession();
        window.__visionControlToken = null;
        window.dispatchEvent(new Event('vision-control-token'));
        driveControlReady = false;
        powerActionRequestId = null;
        powerPending = null; powerAcknowledged = false;
        restPhase = motionEnabled = motionHomed = null;
        if (colorPresetPending) setNotice(`连接中断，请重连后确认颜色是否${colorPresetPending.operation === 'delete' ? '删除' : '保存'}`, true);
        colorPresetPending = null;
        colorPresetsLoaded = false;
        updateColorPresetControls();
        if (settingsSaving || settingsDirty || headSettingsSaving || headSettingsDirty
          || trackingUnsaved()) {
          settingsStatus.textContent = '连接中断，参数将在重连后自动保存';
        }
        if (settingsSaving) settingsDirty = true;
        settingsSaving = false;
        settingsPendingId = null;
        settingsFailed = false;
        if (headSettingsSaving || headSettingsDirty) headSettingsDirty = true;
        headSettingsSaving = false;
        headSettingsPendingId = null;
        headSettingsFailed = false;
        for (const profile of Object.values(trackingProfiles)) {
          if (profile.coordinatedSaving) profile.coordinatedDirty = true;
          profile.coordinatedSaving = false;
          profile.coordinatedPendingId = null;
          profile.coordinatedPendingJson = null;
          profile.coordinatedFailed = false;
          if (profile.phaseSaving) profile.phaseDirty = true;
          profile.phaseSaving = false;
          profile.phasePendingId = null;
          profile.phasePendingJson = null;
          profile.phaseFailed = false;
        }
        coordinatedLeaseReady = false;
        phaseReady = false;
        phaseInputs.forEach(input => { input.disabled = true; });
        availableSkills = [];
        renderArrivalSkills();
        resetSettings.disabled = true;
        obstaclePending = false;
        confirmedObstacle = null;
        zero();
        setConnected(false, "页面未连接");
      }

      actionButtons.forEach(button => {
        button.addEventListener('click', () => {
          const action = button.dataset.action;
          if (action === 'center_head' && (!state.active || headCenterUnavailable())) return;
          sendAction(action);
        });
      });
      triggerRanges.forEach((range) => range.addEventListener("input", () => {
        if (mazeRun.active || mazeRun.pending) { range.value = '0'; return; }
        cancelPickMouth();
        state[range.dataset.triggerRange] = Number(range.value); sendInput();
      }));
      turnInput.addEventListener("change", () => applyTurn(turnInput.value));
      turnRange.addEventListener("input", () => applyTurn(turnRange.value));
      speedInput.disabled = true;
      speedRange.disabled = true;
      speedRange.addEventListener("input", () => applySpeed(speedRange.value));
      speedInput.addEventListener("change", () => applySpeed(speedInput.value));
      obstacleEnabled.addEventListener("change", sendObstacle);
      obstacleDistance.addEventListener("input", () => { obstacleDistanceValue.textContent = `${obstacleDistance.value} mm`; });
      obstacleDelay.addEventListener("input", () => { obstacleDelayValue.textContent = `${obstacleDelay.value} ms`; });
      obstacleDistance.addEventListener("change", sendObstacle);
      obstacleDelay.addEventListener("change", sendObstacle);
      const suspend = (reconcile = true) => { state.active = false; keys.clear(); zero(); if (reconcile) reconcileHeadPosition(); };
      function completeStudioLeave(accepted, reason) {
        const requestId = studioLeaveRequest;
        studioLeaveRequest = null;
        session.close();
        if (requestId !== null) {
          window.parent.postMessage({ type: 'studio-leave-result', requestId, accepted, reason },
            new URL(document.referrer).origin);
        }
      }
      function deactivateStudio() {
        session.pause();
        studioActive = false;
        colorChosen = false;
        colorPresetSelect.value = '';
        colorPresetName.value = '';
        updateColorPresetControls();
        suspend(false);
        stopAllTracking(false);
        stopMaze(false);
        window.dispatchEvent(new Event('vision-recognition-stop'));
        if (lineRun.pending) lineRun.stopSent = true;
        if (coordinatedOwner?.pending) coordinatedOwner.stopSent = true;
        if (mazeRun.pending) mazeRun.stopSent = true;
      }
      window.addEventListener('studio-disconnect', () => {
        deactivateStudio();
        completeStudioLeave(false, '操控连接不可用');
      });
      window.addEventListener('studio-leave', event => {
        deactivateStudio();
        studioLeaveRequest = event.detail;
        if (controlLeaseReady && session.open) {
          session.send({ type: 'studio_leave', request_id: studioLeaveRequest,
            // Release the held head position when leaving a tracking page.
            person_follow: isVisionPage() });
        } else {
          completeStudioLeave(true);
        }
      });
      window.addEventListener('console-view-change', () => {
        const active = state.active;
        state.active = false;
        keys.clear();
        zero();
        state.active = active;
        sendInput();
      });
      window.addEventListener('console-page-changed', () => {
        if (document.body.dataset.consolePage !== 'control') cancelPickMouth(true);
        resetVisionTracking();
        selectedPage = pages[document.body.dataset.consolePage];
        vision = selectedPage?.vision ?? nonVision;
        coordinatedRun = selectedPage?.coordinatedRun ?? idleCoordinated;
        renderMotionPower();
        if (!document.body.hasAttribute('data-color-vision')) {
          colorChosen = false;
          colorPresetSelect.value = '';
          colorPresetName.value = '';
          updateColorPresetControls();
        }
        if (isVisionPage()) {
          const scope = document.body.dataset.consolePage === 'person' ? 'person' : 'target';
          if (pickupPage()) selectPickupStage('target');
          if (scope !== trackingScope) {
            applyTrackingProfile(scope);
            updateSettingsState();
          }
          if (currentHeadPositionScope() !== headPositionScope) {
            headPositionScope = currentHeadPositionScope();
            applyHeadPositionScope(headPositionScope);
            if (headPositionState === 'active' && headPositionTarget !== null) sendHeadPosition('update');
          }
          const source = scope === 'person' ? 'object' : 'color';
          selectVisionSource(source);
          if (studioActive && source === 'object') {
            window.dispatchEvent(new CustomEvent('vision-recognition-start', {detail: source}));
          }
        }
        if (document.body.dataset.consolePage !== 'maze') stopMaze();
        headPositionWanted = false;
        reconcileHeadPosition();
        updateCoordinatedFields();
        updateTrackingGuide();
        updateMode(mode, false);
      });
      const resume = (explicitWorkspace = false) => {
        if (studioActive && !document.hidden && (explicitWorkspace || document.hasFocus())) {
          if (!state.active || explicitWorkspace) {
            zero(); state.active = true; sendInput();
          }
          reconcileHeadPosition();
        }
      };
      window.addEventListener('studio-preview', () => {
        suspend();
        studioActive = false;
        renderMotionPower();
      });
      window.addEventListener('studio-enter', () => {
        studioActive = true;
        connect();
        renderMotionPower();
        resume(true);
        if (isVisionPage() && visionSource === 'object') window.dispatchEvent(new CustomEvent('vision-recognition-start', {detail: visionSource}));
      });
      window.addEventListener("blur", suspend);
      window.addEventListener("focus", () => resume());
      document.addEventListener("visibilitychange", () => { if (document.hidden) suspend(); else resume(); });
      const flushTrackingProfiles = () => {
        for (const scope of Object.keys(trackingProfiles)) {
          flushCoordinatedSettings(true, scope);
          flushPhaseSettings(true, scope);
        }
      };
      window.addEventListener('pagehide', () => {
        flushSettings(true);
        flushHeadSettings(true);
        flushTrackingProfiles();
        stopAllTracking();
        stopMaze();
        suspend();
        session.close();
      });
      window.addEventListener('pageshow', event => {
        if (event.persisted && !embeddedStudio) {
          connect();
          resume(true);
        }
      });
      updateMode("drive", false);
      motion.updateKnobs();
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', connect, {once: true});
      else connect();
    })();
