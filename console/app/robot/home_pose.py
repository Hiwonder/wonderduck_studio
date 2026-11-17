"""Read current Home metadata without loading ONNX tensors or running a policy."""

import io
import math
from pathlib import Path


def _varint(stream, end):
    value = 0
    for shift in range(0, 70, 7):
        if stream.tell() >= end:
            raise ValueError("Home 模型的 protobuf 数据不完整")
        encoded = stream.read(1)
        if not encoded:
            raise ValueError("Home 模型的 protobuf 数据不完整")
        byte = encoded[0]
        if shift == 63 and byte > 1:
            break
        value |= (byte & 127) << shift
        if byte < 128:
            return value
    raise ValueError("Home 模型的 protobuf 整数无效")


def _length_fields(stream, end):
    while stream.tell() < end:
        tag = _varint(stream, end)
        field, wire = tag >> 3, tag & 7
        if not 0 < field < (1 << 29):
            raise ValueError("Home 模型的 protobuf 字段无效")
        if wire == 0:
            _varint(stream, end)
            continue
        if wire == 2:
            size = _varint(stream, end)
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
        else:
            raise ValueError("Home 模型的 protobuf 类型无效")
        next_field = stream.tell() + size
        if next_field > end:
            raise ValueError("Home 模型的 protobuf 数据不完整")
        if wire == 2:
            yield field, size
        stream.seek(next_field)


def read_home_radians(path, names):
    # ONNX ModelProto.metadata_props is field 14; entries have key=1, value=2.
    # https://github.com/onnx/onnx/blob/main/onnx/onnx.proto
    metadata = {}
    with Path(path).open("rb") as stream:
        end = stream.seek(0, 2)
        stream.seek(0)
        for field, size in _length_fields(stream, end):
            if field != 14:
                continue
            encoded = stream.read(size)
            if len(encoded) != size:
                raise ValueError("Home 模型读取不完整")
            entry = io.BytesIO(encoded)
            values = {number: entry.read(length).decode("utf-8")
                      for number, length in _length_fields(entry, len(encoded)) if number in (1, 2)}
            if 1 not in values or 2 not in values or values[1] in metadata:
                raise ValueError("Home 模型元数据缺失或重复")
            metadata[values[1]] = values[2]
    if "joint_names" not in metadata or "default_joint_pos" not in metadata:
        raise ValueError("Home 模型缺少 joint_names / default_joint_pos")
    joints = [value.strip() for value in metadata["joint_names"].split(",")]
    angles = [float(value) for value in metadata["default_joint_pos"].split(",")]
    missing = set(names) - set(joints)
    # Simulation backlash hinges are metadata, not physical servo channels.
    passive = {f"passive_{name}_backlash" for name in names if name != "mouth"}
    if (len(joints) != len(angles) or len(set(joints)) != len(joints)
            or set(joints) - set(names) - passive or missing - {"mouth"}
            or not all(math.isfinite(value) for value in angles)):
        raise ValueError("Home 模型的关节名称或位置无效")
    positions = dict(zip(joints, angles))
    positions.setdefault("mouth", 0.0)
    return tuple(positions[name] for name in names)
