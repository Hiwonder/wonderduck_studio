import { SERVO_STATUS_MAX_AGE_MS, servoStatus as sharedServoStatus } from '../state-status.js';

export { sampleFresh } from '../state-status.js';

export function servoStatus(servo, state, elapsed = 0, connectionError = '') {
  return sharedServoStatus(servo, state, elapsed, connectionError, SERVO_STATUS_MAX_AGE_MS);
}
