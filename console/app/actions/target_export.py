"""Read and save named servo target CSV files without accessing hardware."""

import csv
import math
from pathlib import Path

from app.robot.protocol import IDS, motion_targets, target_values

TARGET_COLUMNS = ['id', '下发目标']
ENCODER_COLUMNS = TARGET_COLUMNS + ['编码器']
IMU_FIELDS = [('angles_deg', 3), ('quaternion_wxyz', 4), ('gyro_rad_s', 3), ('gravity', 3)]
IMU_COLUMNS = ['Roll(°)', 'Pitch(°)', 'Yaw(°)', 'quat_w', 'quat_x', 'quat_y', 'quat_z',
               'gyro_x(rad/s)', 'gyro_y(rad/s)', 'gyro_z(rad/s)', 'gravity_x', 'gravity_y', 'gravity_z']
EXPORT_COLUMNS = ENCODER_COLUMNS + IMU_COLUMNS


def imu_values(imu):
    if imu is None:
        return [None] * len(IMU_COLUMNS)
    if not isinstance(imu, dict) or set(imu) != {name for name, size in IMU_FIELDS}:
        raise ValueError('IMU 必须包含姿态角、四元数、角速度和重力向量，未就绪时为 null')
    values = []
    for name, size in IMU_FIELDS:
        vector = imu[name]
        if not isinstance(vector, list) or len(vector) != size:
            raise ValueError(f'IMU {name} 必须包含 {size} 个数值')
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in vector):
            raise ValueError(f'IMU {name} 必须为有限数值')
        values.extend(vector)
    return values


def file_name(name):
    if not isinstance(name, str) or not name.strip():
        raise ValueError('请输入文件名')
    name = name.strip()
    if any(character in '/\\' or ord(character) < 32 for character in name):
        raise ValueError('文件名不能包含路径或控制字符')
    if not name.lower().endswith('.csv'):
        name += '.csv'
    if len(name.encode('utf-8')) > 255:
        raise ValueError('文件名过长')
    return name


def save_targets(directory, name, targets, ids, encoders, imu, full_servo_range=False):
    name = file_name(name)
    values = target_values(targets, ids, 4096 if full_servo_range else 4095)
    measured = target_values(encoders, ids)
    snapshot = imu_values(imu)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    with path.open('x', encoding='utf-8-sig', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(EXPORT_COLUMNS)
        writer.writerows((device_id, values[device_id], measured[device_id], *snapshot) for device_id in sorted(values))
    return {'path': str(path.resolve()), 'name': name, 'count': len(values)}


def list_targets(directory):
    directory = Path(directory).resolve()
    files = [] if not directory.exists() else [path.name for path in directory.iterdir()
        if path.is_file() and path.suffix.lower() == '.csv' and path.resolve().parent == directory]
    return {'files': sorted(files, key=str.casefold)}


def load_targets(directory, name, ids, full_servo_range=False):
    directory = Path(directory).resolve()
    path = directory / file_name(name)
    if path.resolve().parent != directory:
        raise ValueError('文件必须位于 actions 目录内')
    if not path.is_file():
        raise ValueError('文件不存在，请刷新文件列表')
    try:
        with path.open(encoding='utf-8-sig', newline='') as stream:
            rows = list(csv.reader(stream, strict=True))
        if not rows or rows[0] not in (TARGET_COLUMNS, ENCODER_COLUMNS, EXPORT_COLUMNS):
            raise ValueError('CSV 表头必须为 id、下发目标，可包含编码器或完整 IMU 列')
        width = len(rows[0])
        if any(len(row) != width for row in rows[1:]):
            raise ValueError('CSV 数据列数不一致')
        targets = [[int(row[0]), int(row[1]) if row[1].strip() else None] for row in rows[1:]]
        missing = set(ids) - {row[0] for row in targets}
        if missing.intersection(ids[:len(IDS)]):
            raise ValueError('CSV 必须包含全部配置舵机 ID')
        absent = [[device_id, None] for device_id in ids if device_id in missing]
        targets.extend(absent)
        values = target_values(targets, ids, 4096 if full_servo_range else 4095)
        if width >= 3:
            target_values([[int(row[0]), int(row[2]) if row[2].strip() else None] for row in rows[1:]] + absent, ids)
        if width == len(EXPORT_COLUMNS):
            for row in rows[1:]:
                if any(value.strip() for value in row[3:]):
                    offset, imu = 3, {}
                    for name, size in IMU_FIELDS:
                        imu[name] = [float(value) for value in row[offset:offset + size]]
                        offset += size
                    imu_values(imu)
        if any(value is not None for value in values.values()):
            motion_targets(targets, ids, full_servo_range)
    except (UnicodeError, csv.Error) as error:
        raise ValueError(f'CSV 编码或格式无效：{error}') from error
    return {'name': path.name, 'targets': [[device_id, values[device_id]] for device_id in ids]}
