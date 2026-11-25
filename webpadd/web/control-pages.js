function createVisionState() {
  return {
    awaitingTarget: false,
    targetReady: false,
    frameReady: false,
    target: null,
    lastCaptured: null,
    robotPhase: null,
    startPitch: null,
  };
}

function createTrackingProfile() {
  return {
    coordinated: null, phases: null, coordinatedReady: false, phaseReady: false,
    coordinatedDirty: false, coordinatedSaving: false, coordinatedFailed: false,
    coordinatedTimer: null, coordinatedPendingId: null,
    coordinatedPendingJson: null, coordinatedSavedJson: null,
    phaseDirty: false, phaseSaving: false, phaseFailed: false,
    phaseTimer: null, phasePendingId: null, phasePendingJson: null, phaseSavedJson: null,
  };
}

export function createRun() {
  return {
    active: false,
    pending: false,
    cancelled: false,
    stopSent: false,
    timer: null,

    begin() {
      this.pending = true;
      this.cancelled = this.stopSent = false;
    },

    accept(accepted, ready = true) {
      const stopSent = this.stopSent;
      this.active = accepted && ready && !this.cancelled;
      this.pending = this.cancelled = this.stopSent = false;
      return accepted && !this.active && !stopSent;
    },

    stop(sendStop, waitingForReply) {
      if (sendStop && (this.active || (this.pending && !this.stopSent))) {
        sendStop();
        if (this.pending) this.stopSent = true;
      }
      this.active = false;
      if (this.pending && waitingForReply) this.cancelled = true;
      else this.pending = this.cancelled = this.stopSent = false;
      this.clearTimer();
    },

    clearTimer() {
      clearTimeout(this.timer);
      this.timer = null;
    },
  };
}

export function createControlPages() {
  const control = {
    headStickAxes: [0, 0],
    input: {left_x: 0, left_y: 0, right_x: 0, right_y: 0,
      left_trigger: 0, right_trigger: 0, buttons: [], active: false},
  };
  const person = {
    vision: createVisionState(),
    coordinatedRun: createRun(),
    profile: createTrackingProfile(),
    limits: {area: null, areaDeadzone: null, distance: null, distanceDeadzone: null},
  };
  const target = {vision: createVisionState(), coordinatedRun: createRun(), targetPoint: [160, 90], deadzone: [0.1, 0.05],
    gains: [[0.5, 0.04, 0.01], [0.5, 0.04, 0.01]]};
  const pickup = {vision: createVisionState(), coordinatedRun: createRun(), before: createTrackingProfile(),
    after: createTrackingProfile(), robotStage: null, runScope: null};
  const line = {vision: createVisionState(), run: createRun(), point: null,
    speed: 0.15, targetX: 160, referenceArea: null, deadzone: [0.1, 0.05], gains: [[0.5, 0.04, 0.01], [0.5, 0.04, 0.01]]};
  const maze = {run: createRun(), settings: null};
  return {control, person, target, pickup, line, maze};
}

export {createVisionState};
