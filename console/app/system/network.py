"""Read NetworkManager state and forward requests to the existing Wi-Fi service."""

import json
import logging
import os
import re
import socket
import subprocess
import time


INTERFACE = "wlan0"
ANNOUNCEMENT_SOCKET = "/run/wonderduck-network-speech.sock"


def _run(*args, timeout=15):
    environment = dict(os.environ, LC_ALL="C")
    try:
        result = subprocess.run(args, capture_output=True, text=True, env=environment,
                                timeout=timeout, check=False)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("网络状态查询超时") from error
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "网络状态查询失败")
    return result.stdout


def _fields(line):
    fields, value, escaped = [], [], False
    for character in line:
        if escaped:
            value.append(character)
            escaped = False
        elif character == "\\":
            escaped = True
        elif character == ":":
            fields.append("".join(value))
            value = []
        else:
            value.append(character)
    if escaped:
        value.append("\\")
    fields.append("".join(value))
    return fields


def _nmcli(*args):
    return _run("nmcli", "-t", "-e", "yes", *args)


def _networks():
    output = _nmcli("-f", "IN-USE,SSID,SIGNAL,SECURITY,CHAN,FREQ", "device", "wifi",
                    "list", "--rescan", "no", "ifname", INTERFACE)
    networks = {}
    for line in output.splitlines():
        fields = _fields(line)
        if len(fields) != 6 or not fields[1]:
            continue
        active, ssid, signal, security, channel, frequency = fields
        item = dict(ssid=ssid, active=active == "*", signal=int(signal),
                    security="开放" if security in ("", "--") else security,
                    channel=channel, frequency=frequency)
        previous = networks.get(ssid)
        if previous is None or (item["active"], item["signal"]) > (previous["active"], previous["signal"]):
            networks[ssid] = item
    return sorted(networks.values(), key=lambda item: (not item["active"], -item["signal"], item["ssid"]))


def _bluetooth_address():
    """Read the default adapter address used for Bluetooth pairing."""
    try:
        output = _run("bluetoothctl", "show", timeout=2)
    except (OSError, RuntimeError):
        return None
    match = re.search(r"(?m)^Controller\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})(?:\s|$)", output)
    if not match or match.group(1).lower() == "00:00:00:00:00:00":
        return None
    return match.group(1).upper()


def status():
    devices = [_fields(line) for line in
               _nmcli("-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status").splitlines()]
    addresses = json.loads(_run("ip", "-j", "-4", "address", "show"))
    ips = {entry["ifname"]: [address["local"] for address in entry.get("addr_info", [])
                              if address.get("family") == "inet" and address.get("scope") == "global"]
           for entry in addresses}
    wireless = next((device for device in devices if len(device) == 4 and device[0] == INTERFACE
                     and device[1] == "wifi"), None)
    wired = [dict(interface=device[0], state=device[2], addresses=ips.get(device[0], []))
             for device in devices if len(device) == 4 and device[1] == "ethernet"]
    result = dict(mode="unavailable" if wireless is None else "disconnected", ssid="",
                  wireless_addresses=ips.get(INTERFACE, []), wired=wired, frequency_mhz=None,
                  bluetooth_address=_bluetooth_address(), networks=[], networks_error="")
    if wireless is None:
        return result
    if wireless[2].startswith("connected"):
        active = [_fields(line) for line in
                  _nmcli("-f", "UUID,DEVICE", "connection", "show", "--active").splitlines()]
        uuid = next((entry[0] for entry in active if len(entry) == 2 and entry[1] == INTERFACE), None)
        if uuid is None:
            raise RuntimeError("无法读取当前无线连接")
        profile = _nmcli("-f", "802-11-wireless.mode,802-11-wireless.ssid",
                         "connection", "show", "uuid", uuid)
        settings = dict(parts for line in profile.splitlines() if len(parts := _fields(line)) == 2)
        mode = settings.get("802-11-wireless.mode")
        if mode not in ("ap", "infrastructure", "", "--"):
            raise RuntimeError("不支持的无线网络模式")
        result.update(mode="ap" if mode == "ap" else "station",
                      ssid=settings.get("802-11-wireless.ssid", ""))
        try:
            wireless_info = _run("iw", "dev", INTERFACE, "info")
        except (OSError, RuntimeError):
            wireless_info = ""
        match = re.search(r"channel\s+\d+\s+\((\d+)\s+MHz\)", wireless_info)
        if match:
            result["frequency_mhz"] = int(match.group(1))
    try:
        result["networks"] = _networks()
    except RuntimeError as error:
        result["networks_error"] = str(error)
    return result


def scan():
    device_path = _nmcli("-g", "GENERAL.DBUS-PATH", "device", "show", INTERFACE).strip()
    if not device_path.startswith("/org/freedesktop/NetworkManager/Devices/"):
        raise RuntimeError("无法读取无线网卡状态")
    before = _last_scan(device_path)
    # The console runs unprivileged; an accepted scan still needs LastScan to advance.
    try:
        _run("sudo", "-n", "nmcli", "device", "wifi", "rescan", "ifname", INTERFACE)
    except (RuntimeError, OSError) as error:
        raise RuntimeError(f"无法启动无线扫描：{error}") from error
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if _last_scan(device_path) != before:
            return dict(networks=_networks())
        time.sleep(.25)
    raise RuntimeError("无线扫描未完成，请重试")


def _last_scan(device_path):
    result = _run("busctl", "get-property", "org.freedesktop.NetworkManager", device_path,
                  "org.freedesktop.NetworkManager.Device.Wireless", "LastScan").split()
    if len(result) != 2 or result[0] != "x":
        raise RuntimeError("无法读取无线扫描进度")
    try:
        return int(result[1])
    except ValueError as error:
        raise RuntimeError("无线扫描进度无效") from error


def _send(port, payload):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=3) as connection:
            connection.sendall(payload)
    except OSError as error:
        raise RuntimeError("无法连接设备的 Wi-Fi 管理服务") from error
    return dict(sent=True)


def _current_mode():
    try:
        values = _run("nmcli", "-g", "GENERAL.STATE,GENERAL.CON-UUID",
                      "device", "show", INTERFACE, timeout=2).splitlines()
        if len(values) != 2 or not values[0].startswith("100 ") or not values[1]:
            return None
        mode = _run("nmcli", "-g", "802-11-wireless.mode", "connection", "show",
                    "uuid", values[1], timeout=2).strip()
        if mode == "ap":
            return "ap"
        if mode in ("infrastructure", "", "--"):
            return "station"
    except (OSError, RuntimeError):
        pass
    return None


def _announce_switch(mode, ssid=None):
    message = json.dumps(dict(watch=mode, ssid=ssid), ensure_ascii=True).encode("ascii") + b"\n"
    if len(message) > 512:
        return
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(0.5)
            client.connect(ANNOUNCEMENT_SOCKET)
            client.sendall(message)
            response = client.recv(32).strip()
            if response not in (b"queued", b"disabled"):
                logging.warning("网络切换播报请求未接受")
    except OSError:
        # A missing speaker service must not prevent a network change.
        logging.warning("网络切换播报服务不可用")


def connect(command):
    ssid, password = command.get("ssid"), command.get("password")
    if not isinstance(ssid, str) or not ssid or not isinstance(password, str):
        raise ValueError("请输入 Wi-Fi 名称和密码")
    payload = json.dumps({"setwifi": {"ssid": ssid, "passwd": password}},
                         ensure_ascii=False).encode("utf-8")
    before = _current_mode()
    result = _send(9026, payload)
    if before != "station":
        _announce_switch("station", ssid)
    return result


def hotspot():
    before = _current_mode()
    result = _send(9028, b"resetwifi")
    if before != "ap":
        _announce_switch("ap")
    return result
