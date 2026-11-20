"""On-demand hardware H.264 camera over the board's existing GStreamer WebRTC."""

from concurrent.futures import Future, TimeoutError as FutureTimeout
import logging
import os
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time


CAMERA_WIDTH = 640
CAMERA_HEIGHT = 360
CAMERA_FPS = 30
CAMERA_BITRATE = 800_000


def h264_payload(sdp):
    """Select an offered H.264 packetization-mode=1 payload in the video media."""
    if not isinstance(sdp, str) or not 0 < len(sdp) <= 60000:
        raise ValueError("摄像头会话SDP无效")
    lines = sdp.replace("\r\n", "\n").splitlines()
    video, payloads, codecs, parameters = False, [], {}, {}
    for line in lines:
        if line.startswith("m="):
            if video:
                break
            fields = line.split()
            video = fields[0] == "m=video" and len(fields) >= 4 and fields[1] != "0"
            if video:
                payloads = fields[3:]
        elif video:
            match = re.fullmatch(r"a=rtpmap:(\d+) ([^ /]+)/90000", line, re.IGNORECASE)
            if match:
                codecs[match[1]] = match[2].lower()
            match = re.fullmatch(r"a=fmtp:(\d+) (.+)", line)
            if match:
                parameters[match[1]] = dict(item.strip().split("=", 1)
                    for item in match[2].split(";") if "=" in item)
    for payload in payloads:
        params = parameters.get(payload, {})
        if codecs.get(payload) == "h264" and params.get("packetization-mode") == "1":
            profile = params.get("profile-level-id", "42e01f").lower()
            if profile.startswith("42"):
                return int(payload)
    raise ValueError("浏览器未提供兼容的H.264视频格式")


def complete_sdp(sdp, candidates):
    """Include gathered candidates explicitly; webrtcbin signals them separately."""
    sections = []
    for line in sdp.replace("\r\n", "\n").splitlines():
        if line.startswith("m="):
            sections.append([])
        if not sections:
            sections.append([])
        if not line.startswith(("a=candidate:", "a=end-of-candidates")):
            sections[-1].append(line)
    for index, section in enumerate(sections[1:]):
        section.extend("a=" + candidate for candidate in candidates.get(index, []))
        section.append("a=end-of-candidates")
    return "\r\n".join(line for section in sections for line in section) + "\r\n"


class Camera:
    """One viewer, one encoder; all pipeline operations run on a GLib thread."""

    def __init__(self):
        self.lock = threading.Lock()
        self.loop = self.thread = self.active = None
        self.error = None
        self.closed = False
        self.stun = None
        self.stun_log = []

    def prepare(self):
        self._ensure_loop()
        if self.stun.poll() is not None:
            raise RuntimeError("摄像头地址发现服务启动失败：" + " ".join(self.stun_log[:3]))
        return dict(stun_port=3478)

    def _start_stun(self):
        executable = shutil.which("turnserver")
        if executable is None:
            raise RuntimeError("摄像头缺少本机STUN组件coturn")
        self.stun = subprocess.Popen([
            executable, '-n', '--stun-only', '--no-tcp', '--no-tls', '--no-dtls',
            '--no-cli',
            '--listening-ip=0.0.0.0', '--listening-port=3478', '--relay-threads=0',
            '--log-file=stdout', '--simple-log', '--pidfile=',
        ], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
        threading.Thread(target=self._stun_output, name='camera-stun', daemon=True).start()
        # A standard STUN binding request confirms the listener is ready before
        # the browser starts ICE gathering. No video or motor access is involved.
        request = b'\x00\x01\x00\x00\x21\x12\xa4\x42' + secrets.token_bytes(12)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.settimeout(.2)
            for _ in range(15):
                if self.stun.poll() is not None:
                    raise RuntimeError("摄像头地址发现启动失败：" + " ".join(self.stun_log[:3]))
                probe.sendto(request, ('127.0.0.1', 3478))
                try:
                    response = probe.recv(512)
                except socket.timeout:
                    continue
                if response[:2] == b'\x01\x01' and response[4:20] == request[4:20]:
                    return
        self.stun.terminate()
        self.stun.wait(timeout=2)
        raise RuntimeError("摄像头地址发现服务未就绪")

    def _stun_output(self):
        for line in self.stun.stdout:
            if len(self.stun_log) < 20:
                self.stun_log.append(line.strip())
        if not self.closed:
            logging.error("camera STUN exited: %s", " ".join(self.stun_log[:3]))

    def _ensure_loop(self):
        with self.lock:
            if self.closed:
                raise RuntimeError("摄像头服务已关闭")
            if self.thread is not None:
                return
            try:
                import gi
                gi.require_version("Gst", "1.0")
                gi.require_version("GstSdp", "1.0")
                gi.require_version("GstWebRTC", "1.0")
                from gi.repository import GLib, Gst, GstSdp, GstWebRTC
            except (ImportError, ValueError) as error:
                self.error = f"摄像头组件未安装：{error}"
                raise RuntimeError(self.error) from error
            Gst.init(None)
            required = ("v4l2src", "capssetter", "mpph264enc", "h264parse", "rtph264pay", "webrtcbin", "nicesrc")
            missing = [name for name in required if Gst.ElementFactory.find(name) is None]
            if missing:
                self.error = "摄像头组件缺失：" + ", ".join(missing)
                raise RuntimeError(self.error)
            self.GLib, self.Gst, self.GstSdp, self.WebRTC = GLib, Gst, GstSdp, GstWebRTC
            self._start_stun()
            self.loop = GLib.MainLoop()
            self.thread = threading.Thread(target=self._run, name="camera", daemon=True)
            self.thread.start()

    def _run(self):
        os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 5)
        self.GLib.timeout_add_seconds(2, self._expire)
        self.loop.run()

    def _post(self, function, *args):
        def call():
            function(*args)
            return False
        self.GLib.idle_add(call)

    def offer(self, client, sdp):
        payload = h264_payload(sdp)
        self._ensure_loop()
        reply = Future()
        self._post(self._start, client, sdp, payload, reply)
        try:
            return reply.result(timeout=12)
        except FutureTimeout as error:
            self._post(self._cancel_pending, reply)
            raise RuntimeError("摄像头连接超时，请重试") from error

    def _start(self, client, sdp, payload, reply):
        if self.active is not None:
            if self.active["client"] != client:
                reply.set_exception(RuntimeError("摄像头正在另一页面中观看"))
                return
            self._stop("观看页面重新连接")
        session = dict(id=secrets.token_hex(16), client=client, reply=reply,
                       touched=time.monotonic(), frames=0, started=time.monotonic(),
                       pipeline=None, bus=None, rtc=None, candidates={})
        self.active = session
        self.error = None
        try:
            Gst = self.Gst
            # The driver's 29.997 fps fraction breaks MPP rate control. Describe
            # it as nominal 30 fps without changing capture timing or pixels.
            pipeline = Gst.parse_launch(
                "v4l2src device=/dev/video0 io-mode=mmap do-timestamp=true ! "
                f"video/x-raw,format=NV12,width={CAMERA_WIDTH},height={CAMERA_HEIGHT} ! "
                "queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 leaky=downstream ! "
                f'capssetter caps="video/x-raw,framerate=(fraction){CAMERA_FPS}/1" ! '
                f"mpph264enc name=encoder bps={CAMERA_BITRATE} gop={CAMERA_FPS} rc-mode=cbr "
                "profile=baseline header-mode=each-idr ! h264parse ! "
                f"rtph264pay name=pay pt={payload} config-interval=-1 "
                "webrtcbin name=rtc bundle-policy=max-bundle")
            session["pipeline"] = pipeline
            rtc = session["rtc"] = pipeline.get_by_name("rtc")
            caps = Gst.Caps.from_string(
                "application/x-rtp,media=video,encoding-name=H264,clock-rate=90000,"
                f"payload={payload},packetization-mode=(string)1")
            transceiver = rtc.emit("add-transceiver", self.WebRTC.WebRTCRTPTransceiverDirection.SENDONLY, caps)
            if transceiver is None:
                raise RuntimeError("摄像头发送通道未建立")
            if not pipeline.get_by_name("pay").link(rtc):
                raise RuntimeError("摄像头视频通道连接失败")
            bus = session["bus"] = pipeline.get_bus()
            bus.add_signal_watch()
            bus.connect("message::error", self._pipeline_error, session)
            rtc.connect("on-ice-candidate", self._ice_candidate, session)
            rtc.connect("notify::ice-gathering-state", self._ice_state, session)
            rtc.connect("notify::connection-state", self._connection_state, session)
            pipeline.get_by_name("encoder").get_static_pad("src").add_probe(
                Gst.PadProbeType.BUFFER, self._frame, session)
            result, message = self.GstSdp.SDPMessage.new()
            if result != self.GstSdp.SDPResult.OK:
                raise RuntimeError("无法创建摄像头SDP")
            if self.GstSdp.sdp_message_parse_buffer(sdp.encode(), message) != self.GstSdp.SDPResult.OK:
                raise ValueError("摄像头会话SDP解析失败")
            offer = self.WebRTC.WebRTCSessionDescription.new(self.WebRTC.WebRTCSDPType.OFFER, message)
            if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
                raise RuntimeError("摄像头采集启动失败")
            promise = Gst.Promise.new_with_change_func(self._remote_set, session, None)
            rtc.emit("set-remote-description", offer, promise)
        except (self.GLib.Error, RuntimeError, ValueError, TypeError) as error:
            self._fail(session, str(error))

    def _remote_set(self, promise, session, *_):
        self._post(self._create_answer, session, promise)

    def _create_answer(self, session, promise):
        if self.active is not session:
            return
        result = promise.get_reply()
        if result is not None and result.has_field("error"):
            self._fail(session, str(result.get_value("error")))
            return
        promise = self.Gst.Promise.new_with_change_func(self._answer_created, session, None)
        session["rtc"].emit("create-answer", None, promise)

    def _answer_created(self, promise, session, *_):
        self._post(self._set_answer, session, promise)

    def _set_answer(self, session, promise):
        if self.active is not session:
            return
        result = promise.get_reply()
        if result is None or not result.has_field("answer"):
            self._fail(session, "无法创建摄像头应答")
            return
        session["rtc"].emit("set-local-description", result.get_value("answer"), self.Gst.Promise.new())
        self._complete_answer(session)

    def _ice_candidate(self, rtc, index, candidate, session):
        self._post(self._store_candidate, session, index, candidate)

    def _store_candidate(self, session, index, candidate):
        if self.active is session:
            session["candidates"].setdefault(index, []).append(candidate)

    def _ice_state(self, rtc, _, session):
        self._post(self._complete_answer, session)

    def _complete_answer(self, session):
        if self.active is not session or session["reply"].done():
            return
        rtc = session["rtc"]
        if rtc.get_property("ice-gathering-state") != self.WebRTC.WebRTCICEGatheringState.COMPLETE:
            return
        description = rtc.get_property("local-description")
        if description is not None:
            session["reply"].set_result(dict(session=session["id"], type="answer",
                sdp=complete_sdp(description.sdp.as_text(), session["candidates"]),
                width=CAMERA_WIDTH, height=CAMERA_HEIGHT, rotation=0))

    def _connection_state(self, rtc, _, session):
        if rtc.get_property("connection-state") in (
                self.WebRTC.WebRTCPeerConnectionState.FAILED, self.WebRTC.WebRTCPeerConnectionState.CLOSED):
            self._post(self._fail, session, "摄像头连接已断开")

    def _frame(self, _, info, session):
        if info.get_buffer() is not None:
            session["frames"] += 1
        return self.Gst.PadProbeReturn.OK

    def _pipeline_error(self, _, message, session):
        error, detail = message.parse_error()
        logging.error("camera pipeline: %s; %s", error, detail)
        self._fail(session, f"摄像头采集失败：{error.message}")

    def _fail(self, session, message):
        if self.active is session:
            self.error = message
            self._stop(message)

    def _cancel_pending(self, reply):
        if self.active is not None and self.active["reply"] is reply:
            self._stop("摄像头连接超时")

    def _stop(self, reason):
        session, self.active = self.active, None
        if session is None:
            return
        if not session["reply"].done():
            session["reply"].set_exception(RuntimeError(reason))
        if session["pipeline"] is not None:
            session["pipeline"].set_state(self.Gst.State.NULL)
        if session["bus"] is not None:
            session["bus"].remove_signal_watch()

    def _expire(self):
        if self.active is not None and time.monotonic() - self.active["touched"] > 15:
            self._stop("摄像头观看会话已过期")
        return not self.closed

    def touch(self, client, session_id):
        session = self.active
        if session is None or session["id"] != session_id:
            raise RuntimeError(self.error or "摄像头会话已结束")
        if session["client"] != client:
            raise PermissionError("摄像头会话属于另一页面")
        session["touched"] = time.monotonic()
        return self.status()

    def release(self, client, session_id):
        session = self.active
        if session is None or session["id"] != session_id:
            return dict(closed=True)
        if session["client"] != client:
            raise PermissionError("摄像头会话属于另一页面")
        self._post(self._release, session)
        return dict(closed=True)

    def _release(self, session):
        if self.active is session:
            self._stop("观看页面已关闭")

    def status(self):
        session = self.active
        return dict(active=session is not None, error=self.error, encoder="mpph264enc",
                    width=CAMERA_WIDTH, height=CAMERA_HEIGHT, fps=CAMERA_FPS, bitrate=CAMERA_BITRATE,
                    frames=session["frames"] if session else 0)

    def close(self):
        self.closed = True
        if self.stun is not None:
            self.stun.terminate()
            try:
                self.stun.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.stun.kill()
                self.stun.wait(timeout=1)
        if self.loop is not None:
            done = threading.Event()
            def shutdown():
                self._stop("摄像头服务已关闭")
                self.loop.quit()
                done.set()
            self._post(shutdown)
            if not done.wait(5):
                logging.error("camera shutdown timed out")
            self.thread.join(timeout=1)
