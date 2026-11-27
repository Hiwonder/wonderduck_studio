import json
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import Mock

from app.actions.action_playback import ActionPlayback
from app.robot.controller import Controller
from app.robot.hardware import Hardware, NoServoReply, RegisterReadTimeout
from app.robot.parameter_batch import save_parameters
from app.robot.protocol import POSE_SPEED, ServoLayout, ServoOperationError
from app.robot.robotd_state import optional_servo_observations


def batch_result(iterator):
    while True:
        try:
            next(iterator)
        except StopIteration as result:
            return result.value


class ServoIsolationTests(unittest.TestCase):
    def test_wing_status_preserves_observation_time_and_registers(self):
        configuration = dict(firmware_version=[1, 0], servo_version=[1, 1],
                             position_pid=[15, 0, 0], overtemperature_c=90, minimum_starting_torque=2)
        row = dict(id=35, valid=True, raw=2048, t_ns=1_000_000_000, observed_t_ns=1_100_000_000,
                   voltage=7.9, torque=0, packet_status=0, register_status=2, configuration=configuration)
        wing, = optional_servo_observations([row], 1_200_000_000)
        self.assertEqual((wing["sampled_monotonic"], wing["observed_monotonic"]), (1.0, 1.1))
        self.assertEqual(wing["torque"], 0)
        self.assertEqual(wing["faults"], ["传感器异常"])
        self.assertEqual(wing["configuration"], configuration)

    def test_batch_continues_after_failed_unlock_and_restores_each_lock(self):
        raw = {device_id: bytearray(56) for device_id in (20, 21, 22)}
        for device_id, registers in raw.items():
            registers[5], registers[55] = device_id, 1
        writes = []

        def read(device_id, address, length, phase):
            if device_id == 21 and phase == '批量解除写保护':
                raise NoServoReply('no reply')
            return bytes(raw[device_id][address:address + length])

        def write(device_id, address, data):
            writes.append((device_id, address, data))
            raw[device_id][address:address + len(data)] = data

        command = {'ids': [20, 21, 22], 'parameters': [{'address': 21, 'value': 15}]}
        result = batch_result(save_parameters(command, raw, read, write, lambda: None, Mock()))
        self.assertEqual((result['confirmed'], result['total']), (2, 3))
        self.assertTrue(result['locks_restored'])
        self.assertIn('ID 21', result['errors'][0])
        self.assertNotIn((21, 21, b'\x0f'), writes)
        for device_id in raw:
            self.assertEqual(raw[device_id][55], 1)

    def test_bus_fault_during_batch_preflight_prevents_writes(self):
        def read(*args):
            raise RegisterReadTimeout('bad checksum', corrupted=True)

        write = Mock()
        command = {'ids': [20, 21], 'parameters': [{'address': 21, 'value': 15}]}
        result = batch_result(save_parameters(command, [20, 21], read, write, lambda: None, Mock()))
        self.assertFalse(result['verified'])
        self.assertIn('bad checksum', result['errors'][0])
        write.assert_not_called()

    def test_pose_skips_individual_failures_in_preparation_and_readback(self):
        hardware = Hardware.__new__(Hardware)
        hardware.baud_codes = {}
        hardware.select_baud = Mock()
        hardware.live = Mock()
        hardware.fd = 123

        def read(device_id, address, length):
            if device_id == 21:
                raise NoServoReply('missing during preflight')
            if address == 42 and device_id == 23:
                raise NoServoReply('missing during readback')
            return {33: b'\x00', 40: b'\x01', 56: b'\x00\x08', 42: b'\x00\x08\x00\x00' + speed}[address]

        speed = POSE_SPEED.to_bytes(2, 'little')
        hardware.read = read
        result = hardware.move_targets('center_all', dict.fromkeys((20, 21, 23), 2048))
        self.assertEqual(result['targets'], {20: 2048})
        self.assertEqual(set(result['errors']), {21, 23})
        hardware.live.write_all.assert_called_once()
        self.assertEqual(hardware.live.write_all.call_args.args[1][7:-1:7], bytes((20, 23)))

    def test_playback_keeps_other_targets_and_does_not_retry_failed_preparation(self):
        now = [0.0]
        playback = ActionPlayback(lambda _: True, clock=lambda: now[0])
        hardware = Mock()
        hardware.prepare_action_playback.return_value = {21: 'no reply'}
        hardware.move_action_frame.return_value = {'sent': True}
        playback.start([(100, {20: 2000, 21: 2100}), (100, {20: 2200, 21: 2300})], 'owner', False)
        self.assertEqual(playback.step(hardware), {20: 2000})
        now[0] = .1
        self.assertEqual(playback.step(hardware), {20: 2200})
        hardware.prepare_action_playback.assert_called_once_with([20, 21])
        self.assertEqual(playback.snapshot()['errors'], {21: 'no reply'})

    def test_temporary_gain_restore_failure_does_not_disable_other_servos(self):
        controller = Controller.__new__(Controller)
        controller.lock = threading.Lock()
        controller.joints = [{'id': 20}, {'id': 21}]
        controller.servo_debug = 'on'
        controller.servo_debug_ids = {20, 21}
        controller.unavailable_servo_ids = Mock(return_value={21})
        controller.hardware = Mock()
        gain = controller.hardware.set_temporary_position_p_gain
        gain.side_effect = [{21: 'no reply'}, {}]
        restored = controller._set_servo_debug(False)
        self.assertEqual(restored['servo_debug'], 'off')
        self.assertEqual(restored['errors'], {21: 'no reply'})
        self.assertEqual(controller.servo_debug_ids, {21})
        self.assertEqual(controller._set_servo_debug(True)['servo_debug'], 'on')
        gain.assert_called_with(66, ids=[20])

    def test_scanned_replacement_can_take_an_unanswered_joint_id(self):
        hardware = Hardware.__new__(Hardware)
        hardware.init_layout(None, False)
        hardware.offset_lock_cache = {}
        hardware.pending_offset_locks = {}
        hardware.servo_timeouts = {21}
        hardware.torque = {}
        registers = {1: bytearray(56)}
        registers[1][5], registers[1][55] = 1, 1

        def read(device_id, address, length, **options):
            if device_id not in registers:
                raise NoServoReply('no reply')
            return bytes(registers[device_id][address:address + length])

        def write(device_id, address, data, **options):
            raw = registers[device_id]
            raw[address:address + len(data)] = data
            if address == 5:
                registers[data[0]] = registers.pop(device_id)

        hardware.read = read
        hardware.send_write = write
        self.assertTrue(hardware.execute({'action': 'scan_servo', 'id': 1})['found'])
        result = hardware.execute({'action': 'write_register', 'id': 1, 'address': 5, 'value': 21})
        self.assertTrue(result['verified'])
        self.assertEqual((result['previous_id'], result['id']), (1, 21))
        self.assertEqual(registers[21][55], 1)
        self.assertNotIn(1, hardware.ids)
        self.assertIn(21, hardware.ids)

    def test_renumbering_uses_the_fixed_joint_map_and_moves_baud_by_bus_id(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'servo-layout.json'
            path.write_text(json.dumps({'left_hip_yaw': {'id': 10, 'baud': 2},
                                        'right_hip_yaw': {'id': 20, 'baud': 1}}), encoding='utf-8')
            hardware = Hardware.__new__(Hardware)
            hardware.init_layout(path)
            hardware.offset_lock_cache = {}
            hardware.pending_offset_locks = {}
            hardware.servo_timeouts = set()
            hardware.torque = {}
            registers = {10: bytearray(56)}
            registers[10][5], registers[10][55] = 10, 1

            def read(device_id, address, length, **options):
                if device_id not in registers:
                    raise NoServoReply('no reply')
                return bytes(registers[device_id][address:address + length])

            def write(device_id, address, data, **options):
                registers[device_id][address:address + len(data)] = data
                if address == 5:
                    registers[data[0]] = registers.pop(device_id)

            hardware.read = read
            hardware.send_write = write
            self.assertEqual(hardware.baud_codes, {10: 2, 20: 1})
            for previous_id, new_id in ((10, 1), (1, 20)):
                result = hardware.execute({'action': 'write_register', 'id': previous_id, 'address': 5, 'value': new_id})
                self.assertEqual((result['previous_id'], result['id']), (previous_id, new_id))
                self.assertEqual(registers[new_id][55], 1)
                roles = {joint['id']: joint['name'] for joint in hardware.joints}
                self.assertEqual(roles[10], 'right_hip_yaw')
                self.assertEqual(roles[20], 'left_hip_yaw')
                if new_id == 1:
                    self.assertEqual(roles[1], 'servo_1')
                    reloaded = ServoLayout()
                    reloaded.init_layout(path)
                    self.assertEqual(reloaded.baud_codes[1], 2)

            reloaded = ServoLayout()
            reloaded.init_layout(path)
            self.assertNotIn(1, reloaded.baud_codes)
            self.assertEqual((reloaded.baud_codes[10], reloaded.baud_codes[20]), (0, 2))
            self.assertEqual(reloaded.joints, hardware.joints)

    def test_failed_offset_lock_restore_leaves_other_servos_available(self):
        hardware = Hardware.__new__(Hardware)
        hardware.offset_lock = (21, b'\x01', 0, True)
        hardware.offset_lock_cache = {21: b'\x00'}
        hardware.pending_offset_locks = {}
        hardware.write_verified = Mock(side_effect=ServoOperationError('no reply'))
        hardware.restore_offset_lock()
        self.assertIsNone(hardware.offset_lock)
        self.assertEqual(hardware.pending_offset_locks, {21: b'\x01'})
        hardware.require_restored_offset_lock(20)
        hardware.read = Mock(return_value=b'\x01')
        hardware.require_restored_offset_lock(21)
        hardware.write_verified.assert_called_once_with(21, 55, b'\x01')


if __name__ == '__main__':
    unittest.main()
