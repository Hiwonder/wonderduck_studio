#!/usr/bin/env python3
"""QMI8658 I2C transport and attitude calculation."""

import ctypes
import math
import os
import time


I2C_RDWR = 0x0707
I2C_M_RD = 0x0001
WHO_AM_I = 0x00
EXPECTED_ID = 0x05
ACCEL_DATA = 0x35
ADDRESSES = (0x6A, 0x6B)


class I2cMsg(ctypes.Structure):
    _fields_ = [
        ("addr", ctypes.c_uint16),
        ("flags", ctypes.c_uint16),
        ("length", ctypes.c_uint16),
        ("buf", ctypes.POINTER(ctypes.c_uint8)),
    ]


class I2cRdwr(ctypes.Structure):
    _fields_ = [("msgs", ctypes.POINTER(I2cMsg)), ("nmsgs", ctypes.c_uint32)]


LIBC = ctypes.CDLL(None, use_errno=True)


class I2cDevice:
    def __init__(self, path, address):
        self.path = path
        self.address = address
        self.fd = os.open(path, os.O_RDWR)

    def close(self):
        os.close(self.fd)

    def transfer(self, payload, read_length=0):
        write_buf = (ctypes.c_uint8 * len(payload))(*payload)
        messages = [I2cMsg(self.address, 0, len(payload), write_buf)]
        if read_length:
            read_buf = (ctypes.c_uint8 * read_length)()
            messages.append(I2cMsg(self.address, I2C_M_RD, read_length, read_buf))
        msg_array = (I2cMsg * len(messages))(*messages)
        request = I2cRdwr(msg_array, len(messages))
        completed = LIBC.ioctl(self.fd, I2C_RDWR, ctypes.byref(request))
        if completed < 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error), self.path)
        if completed != len(messages):
            raise OSError(f"I2C transfer incomplete: {completed}/{len(messages)} messages")
        return bytes(read_buf) if read_length else b""

    def read(self, register, length=1):
        return self.transfer((register,), length)

    def write(self, register, value):
        self.transfer((register, value))






def configure(device):
    # Same +/-2 g and +/-256 dps, 1 kHz profile as the project's MCU driver.
    for register, value in ((0x02, 0x40), (0x03, 0x03), (0x04, 0x43),
                            (0x05, 0x00), (0x06, 0x11), (0x07, 0x00),
                            (0x08, 0x03)):
        device.write(register, value)
    if device.read(0x08)[0] != 0x03:
        raise RuntimeError("CTRL7 readback failed; accel/gyro not enabled")
    time.sleep(0.05)


def multiply(a, b):
    w, x, y, z = a
    u, i, j, k = b
    return (w*u-x*i-y*j-z*k, w*i+x*u+y*k-z*j,
            w*j-x*k+y*u+z*i, w*k+x*j-y*i+z*u)


class Attitude:
    """Six-axis gravity correction, following the MCU's gain and norm gate."""

    def __init__(self, max_gap=.1):
        self.q = None
        self.last_time = None
        self.gap = False
        self.max_gap = max_gap

    def update(self, accel, gyro, now):
        norm = math.sqrt(sum(v*v for v in accel))
        usable = .85 * 9.80665 <= norm <= 1.15 * 9.80665
        dt = 0 if self.last_time is None else now - self.last_time
        self.last_time = now
        self.gap = dt > self.max_gap
        if self.q is None:
            if not usable:
                return
            roll = math.atan2(accel[1], accel[2])
            pitch = math.atan2(-accel[0], math.hypot(accel[1], accel[2]))
            cr, sr = math.cos(roll/2), math.sin(roll/2)
            cp, sp = math.cos(pitch/2), math.sin(pitch/2)
            self.q = (cr*cp, sr*cp, cr*sp, -sr*sp)
            return
        if self.gap:
            return  # Missing motion during a read gap cannot be reconstructed.
        w, x, y, z = self.q
        up = (2*(x*z-w*y), 2*(y*z+w*x), 1-2*(x*x+y*y))
        rates = [math.radians(v) for v in gyro]
        if usable:
            a = [v/norm for v in accel]
            error = (a[1]*up[2]-a[2]*up[1], a[2]*up[0]-a[0]*up[2],
                     a[0]*up[1]-a[1]*up[0])
            rates = [rate+2*correction for rate, correction in zip(rates, error)]
        angle = math.sqrt(sum(v*v for v in rates)) * dt
        scale = math.sin(angle/2) * dt/angle if angle else 0
        delta = (math.cos(angle/2), *(v*scale for v in rates))
        q = multiply(self.q, delta)
        length = math.sqrt(sum(v*v for v in q))
        self.q = tuple(v/length for v in q)

    def rpy(self):
        w, x, y, z = self.q
        return tuple(math.degrees(v) for v in (
            math.atan2(2*(w*x+y*z), 1-2*(x*x+y*y)),
            math.asin(max(-1, min(1, 2*(w*y-z*x)))),
            math.atan2(2*(w*z+x*y), 1-2*(y*y+z*z))))
