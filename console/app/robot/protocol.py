"""HX robot coordinates and the register map verified on this device."""

import math
import json
from pathlib import Path

from app.paths import CONSOLE_ROOT

IDS = (20, 21, 22, 23, 24, 30, 31, 32, 33, 34, 10, 11, 12, 13, 14)
UNOQ_OPTIONAL_SERVO_IDS = (35, 36)
NAMES = (
    "left_hip_yaw", "left_hip_roll", "left_hip_pitch", "left_knee", "left_ankle",
    "neck_pitch", "head_pitch", "head_yaw", "head_roll", "mouth",
    "right_hip_yaw", "right_hip_roll", "right_hip_pitch", "right_knee", "right_ankle",
)
LABELS = (
    "左髋偏航", "左髋侧摆", "左髋俯仰", "左膝", "左踝",
    "颈部俯仰", "头部俯仰", "头部偏航", "头部侧摆", "嘴部",
    "右髋偏航", "右髋侧摆", "右髋俯仰", "右膝", "右踝",
)
# Mouth encoder endpoints: shut 2048, open 1600.
# The walking policy's pinned mouth slot does not describe maintenance travel.
MOUTH_LIMITS = (0.0, (2048 - 1600) * 360.0 / 4096.0)
LIMITS = (
    (-21.62109375, 83), (-22.1484375, 17), (-105, 52), (-70, 78), (-74.8828125, 70),
    (-119, 48.1640625), (-90, 90), (-119, 120), (-21.796875, 21.796875), MOUTH_LIMITS,
    (-83, 21.796875), (-17, 26), (-52, 105), (-78, 70), (-70, 83),
)
_HOME_POSE = json.loads((CONSOLE_ROOT / "reference" / "home-pose.json")
                       .read_text(encoding="utf-8"))
# Fixed physical targets are shared with the robot runtime.
HOME_ENCODER_TARGETS = _HOME_POSE["home_encoder_targets"]
# Kept as the angle equivalent of the same physical targets for pose displays and tests.
HOME_RADIANS = tuple(_HOME_POSE["radians"])
HOME = tuple(math.degrees(angle) for angle in HOME_RADIANS)
POSE_SPEED = 1000
JOINTS = [dict(id=i, name=n, label=l, limits=list(s))
          for i, n, l, s in zip(IDS, NAMES, LABELS, LIMITS)]

# Address, width, label, region, unit, documented bounds, sign bit.
# Source: the manufacturer's original HX-30HM V3.7 XLS register table.
REGISTER_ROWS = (
    (0, 1, "固件主版本", "ROM", "", None, None, None), (1, 1, "固件次版本", "ROM", "", None, None, None),
    (3, 1, "舵机主版本", "ROM", "", None, None, None), (4, 1, "舵机次版本", "ROM", "", None, None, None),
    (5, 1, "ID", "NVS", "", 0, 253, None), (6, 1, "波特率", "NVS", "索引", 0, 7, None),
    (8, 1, "应答级别", "NVS", "", 0, 1, None),
    (9, 2, "最小角度限制", "NVS", "步", 0, 4095, None),
    (11, 2, "最大角度限制", "NVS", "步", 0, 4095, None),
    (13, 1, "过温阈值", "NVS", "C", 0, 120, None), (14, 1, "过压阈值", "NVS", "0.1 V", 0, 254, None),
    (15, 1, "欠压阈值", "NVS", "0.1 V", 0, 254, None), (16, 2, "最大扭矩", "NVS", "0.001", 0, 1000, None),
    (19, 1, "保护控制", "NVS", "bits", 0, 254, None), (20, 1, "LED 报警条件", "NVS", "bits", 0, 254, None),
    (21, 1, "位置 P", "NVS", "", 0, 254, None), (22, 1, "位置 D", "NVS", "", 0, 254, None),
    (23, 1, "位置 I", "NVS", "", 0, 254, None), (24, 2, "最小启动力", "NVS", "0.001", 0, 1000, None),
    (26, 1, "顺时针死区", "NVS", "步", 0, 32, None), (27, 1, "逆时针死区", "NVS", "步", 0, 32, None),
    (28, 2, "过流阈值", "NVS", "mA", 0, 6000, None), (31, 2, "位置校正", "NVS", "步", -2047, 2047, 11),
    (33, 1, "运行模式", "NVS", "", 0, 2, None), (34, 1, "过载限制扭矩", "NVS", "0.01", 0, 100, None),
    (35, 1, "过载触发时间", "NVS", "10 ms", 0, 254, None), (36, 1, "过载扭矩阈值", "NVS", "0.01", 0, 100, None),
    (37, 1, "速度 P", "NVS", "", 0, 100, None), (38, 1, "过流保护时间", "NVS", "10 ms", 0, 254, None),
    (39, 1, "速度 I", "NVS", "0.1", 0, 254, None), (40, 1, "扭矩开关 / 中位校准", "SRAM", "", 0, 128, None),
    (41, 1, "加速度", "SRAM", "100 步/s2", 0, 254, None), (42, 2, "目标位置", "SRAM", "步", -30719, 30719, 15),
    (44, 2, "运行时间 / PWM", "SRAM", "ms", 0, 65535, None),
    (46, 2, "运行速度", "SRAM", "步/s", 0, 3400, None),
    (48, 2, "运行扭矩限制", "SRAM", "0.001", 0, 1000, None),
    (55, 1, "NVS 写保护锁", "SRAM", "", 0, 1, None),
    (56, 2, "当前位置", "SRAM", "步", None, None, 15), (58, 2, "当前速度", "SRAM", "步/s", None, None, 15),
    (60, 2, "当前负载", "SRAM", "0.001", None, None, 10), (62, 1, "当前电压", "SRAM", "0.1 V", None, None, None),
    (63, 1, "当前温度", "SRAM", "C", None, None, None), (64, 1, "异步写标志", "SRAM", "", None, None, None),
    (65, 1, "舵机状态", "SRAM", "bits", None, None, None), (66, 1, "移动标志", "SRAM", "", None, None, None),
    (69, 2, "当前电流", "SRAM", "mA", None, None, None),
)
REGISTERS = [dict(address=a, size=s, name=n, region=r, unit=u, minimum=lo, maximum=hi,
                  sign_bit=sign, writable=hi is not None)
             for a, s, n, r, u, lo, hi, sign in REGISTER_ROWS]
BY_ADDRESS = {r["address"]: r for r in REGISTERS}
BAUD_RATES = (1000000, 500000, 250000, 128000, 115200, 76800, 57600, 38400)
DISCOVERED_LIMITS = (-180, 180)
SERVO_FAULT_BITS = ((1, "电压异常"), (2, "传感器异常"), (4, "过温"),
                    (8, "过流"), (16, "角度异常"), (32, "过载"))


def servo_faults(status):
    faults = [label for bit, label in SERVO_FAULT_BITS if status & bit]
    if status & 0xC0:
        faults.append(f"未知故障 0x{status & 0xC0:02X}")
    return faults


def discovered_joint(device_id, full_servo_range=False):
    joint = dict(id=device_id, name=f"servo_{device_id}", label="扫描",
                 limits=list(DISCOVERED_LIMITS), discovered=True)
    if full_servo_range:
        joint["encoder_limits"] = [0, 4096]
    return joint


class ServoLayout:
    home_policy = None
    full_servo_range = False

    def init_layout(self, path=None, full_servo_range=False):
        self.full_servo_range = full_servo_range
        self.layout_path = Path(path) if path else None
        self.joints = [dict(j) for j in JOINTS]
        if full_servo_range:
            for joint in self.joints:
                joint['encoder_limits'] = [0, 4096]
        self.baud_codes = {}
        if self.layout_path and self.layout_path.exists():
            saved = json.loads(self.layout_path.read_text(encoding="utf-8"))
            for joint in self.joints:
                entry = saved.get(joint["name"], {})
                joint["id"] = integer(entry.get("id", joint["id"]), 0, 253, "ID")
                self.baud_codes[joint["id"]] = integer(entry.get("baud", 0), 0, 7, "波特率索引")
            if len(set(self.ids)) != len(self.ids):
                raise ValueError("保存的舵机 ID 重复")

    @property
    def ids(self):
        return tuple(j["id"] for j in self.joints)

    def register_discovery(self, device_id):
        scan_id(device_id)
        for joint in self.joints:
            if joint['id'] == device_id:
                return dict(joint)
        joint = discovered_joint(device_id, self.full_servo_range)
        self.joints.append(joint)
        self.joints[len(JOINTS):] = sorted(self.joints[len(JOINTS):], key=lambda item: item['id'])
        return dict(joint)

    def update_layout(self, device_id, new_id=None, baud=None, persist=True):
        joint = next(j for j in self.joints if j["id"] == device_id)
        if new_id is not None and new_id != device_id:
            old_baud = self.baud_codes.get(device_id, 0)
            target = next((j for j in self.joints if j["id"] == new_id), None)
            if target is None or target.get("discovered"):
                if target is not None:
                    self.joints.remove(target)
                joint["id"] = new_id
                self.baud_codes.pop(device_id, None)
            elif joint.get("discovered"):
                # A scanned replacement inherits the configured joint at its new ID.
                self.joints.remove(joint)
                self.baud_codes.pop(device_id, None)
                joint = target
            else:
                # Both IDs represent configured joints. Keep their slots, now with
                # the old ID empty and the replacement answering at the target ID.
                joint = target
            self.baud_codes[new_id] = old_baud
        if baud is not None:
            self.baud_codes[joint["id"]] = baud
        if persist:
            self.save_layout()

    def save_layout(self):
        if self.layout_path:
            saved = {j["name"]: dict(id=j["id"], baud=self.baud_codes.get(j["id"], 0))
                     for j in self.joints if not j.get('discovered')}
            temporary = self.layout_path.with_suffix(".new")
            temporary.write_text(json.dumps(saved, indent=2) + "\n", encoding="utf-8")
            temporary.replace(self.layout_path)


def register_definition(address, mode=0):
    register = dict(BY_ADDRESS[address])
    if address == 44 and mode != 0:
        register.update(minimum=-1000, maximum=1000, sign_bit=10, unit="0.001", name="PWM 开环输出")
    if address == 46 and mode == 1:
        register.update(minimum=-3400, sign_bit=15)
    return register


def decode_register(register, raw):
    value = int.from_bytes(raw, "little")
    sign = register["sign_bit"]
    if sign is not None:
        magnitude = value & ((1 << sign) - 1)
        return -magnitude if value & (1 << sign) else magnitude
    return value


def encode_register(register, value):
    if not register["writable"]:
        raise ValueError("厂家定义的只读寄存器")
    integer(value, register["minimum"], register["maximum"], "寄存器值")
    sign = register["sign_bit"]
    raw = abs(value) | ((1 << sign) if value < 0 else 0) if sign is not None else value
    return raw.to_bytes(register["size"], "little")


def integer(value, low, high, name):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{name} 必须为 {low}..{high} 的整数")
    return value


def joint_id(value, ids=IDS):
    if type(value) is not int or value not in ids:
        raise ValueError("未知舵机 ID")
    return value


def scan_id(value):
    integer(value, 1, 253, '扫描ID')
    if value == 200:
        raise ValueError('ID 200为IMU，不能作为舵机扫描')
    return value


def raw_to_degrees(raw, maximum=4095):
    integer(raw, 0, maximum, "编码器位置")
    return 180.0 - raw * 360.0 / 4096.0


def target_values(rows, ids, maximum=4095):
    if not isinstance(rows, list) or len(rows) != len(ids):
        raise ValueError("数据必须包含全部舵机 ID")
    values = {}
    for row in rows:
        if not isinstance(row, list) or len(row) != 2:
            raise ValueError("每项数据必须包含 ID 和数值")
        device_id, value = row
        if type(device_id) is not int or device_id not in ids or device_id in values:
            raise ValueError("舵机 ID 无效或重复")
        if value is not None:
            integer(value, 0, maximum, "编码器数值")
        values[device_id] = value
    return values


def motion_targets(rows, ids, full_servo_range=False):
    maximum = 4096 if full_servo_range else 4095
    values = target_values(rows, ids, maximum)
    targets = {device_id: values[device_id] for device_id in ids if values[device_id] is not None}
    if not targets:
        raise ValueError("没有可运行的下发目标")
    for device_id, raw in targets.items():
        encode_target(device_id, raw_to_degrees(raw, maximum), ids, full_servo_range)
    return targets


def mirror_action_targets(targets, joints, full_servo_range=False):
    """Reflect targets using the configured robot joint names and directions."""
    by_id = {joint["id"]: joint for joint in joints}
    by_name = {joint["name"]: joint for joint in joints}
    ids = tuple(joint["id"] for joint in joints)
    mirrored = {}
    for device_id, value in targets.items():
        joint = by_id.get(device_id)
        if joint is None:
            raise ValueError(f"ID {device_id} 不属于当前机器人，无法镜像")
        name = joint["name"]
        if name not in NAMES:
            raise ValueError(f"ID {device_id} 没有已定义的镜像关系")
        opposite_name = ("right_" + name[5:] if name.startswith("left_") else
                         "left_" + name[6:] if name.startswith("right_") else name)
        opposite = by_name.get(opposite_name)
        if opposite is None:
            raise ValueError(f"ID {device_id} 没有对应镜像关节")
        reverse = opposite_name != name or name in ("head_yaw", "head_roll")
        target = 4096 - value if reverse else value
        try:
            encode_target(opposite["id"], raw_to_degrees(target), ids, full_servo_range)
        except ValueError as error:
            raise ValueError(f"镜像后 ID {opposite['id']} 位置无效：{error}") from error
        mirrored[opposite["id"]] = target
    return mirrored


def encode_target(device_id, degrees, ids=IDS, full_servo_range=False):
    index = ids.index(joint_id(device_id, ids))
    if type(degrees) not in (int, float) or not math.isfinite(degrees):
        raise ValueError("目标角度必须是有限数值")
    limits = DISCOVERED_LIMITS if full_servo_range or index >= len(LIMITS) else LIMITS[index]
    if not limits[0] <= degrees <= limits[1]:
        raise ValueError(f"ID {device_id} 机械限位 {limits}")
    maximum = 4096 if full_servo_range else 4095
    return min(maximum, max(0, math.floor(4096 * (180 - degrees) / 360 + .5)))


def validate_hold_position(device_id, raw, ids=IDS, full_servo_range=False):
    degrees = raw_to_degrees(raw)
    if not full_servo_range and ids.index(device_id) == 9:
        low, high = MOUTH_LIMITS
        # Accept tracking/quantization error when seeding the measured hold target.
        if not low - 1 <= degrees <= high + 1:
            raise ValueError("嘴部实际位置超出行程及 1 度反馈容差")
        degrees = min(high, max(low, degrees))
    encode_target(device_id, degrees, ids, full_servo_range)


def pose_targets(action, ids=IDS, home_policy=None):
    if action not in ("center_all", "home_all"):
        raise ValueError("未知姿态操作")
    if action == "center_all":
        return dict.fromkeys(ids, 2048)
    configured_ids = ids[:len(NAMES)]
    if len(configured_ids) < len(NAMES):
        raise ValueError("Home 需要全部 15 个已配置舵机")
    if home_policy is None:
        angles = HOME_RADIANS
    else:
        from app.robot.home_pose import read_home_radians
        angles = read_home_radians(home_policy, NAMES)
    if len(angles) != len(configured_ids) or not all(math.isfinite(angle) for angle in angles):
        raise ValueError("Home 关节位置无效")
    targets = {device_id: math.floor(2048 - angle * 4096 / (2 * math.pi) + .5)
               for device_id, angle in zip(configured_ids, angles)}
    for target in targets.values():
        integer(target, 0, 4095, "Home 编码器位置")
    for name, target in HOME_ENCODER_TARGETS.items():
        targets[configured_ids[NAMES.index(name)]] = integer(target, 0, 4095, "Home 编码器位置")
    targets.update((device_id, 2048) for device_id in UNOQ_OPTIONAL_SERVO_IDS if device_id in ids)
    return targets


def packet(device_id, instruction, params):
    body = bytes((device_id, len(params) + 2, instruction)) + bytes(params)
    return b"\xff\xff" + body + bytes(((~sum(body)) & 255,))


def parse_registers(raw):
    if len(raw) != 71:
        raise ValueError("完整参数块必须为 71 字节")
    mode = raw[33]
    values = []
    for item in REGISTERS:
        register = register_definition(item["address"], mode)
        data = raw[register["address"]:register["address"] + register["size"]]
        values.append(dict(register, value=decode_register(register, data), raw_value=int.from_bytes(data, "little")))
    return values
