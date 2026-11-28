//! Browser session transport. Device requests and replies cannot block the socket reader.

use super::*;
use futures_util::{SinkExt, StreamExt, stream::SplitSink};
use tokio::task::JoinHandle;

const REQUEST_QUEUE_CAPACITY: usize = 24;
const REPLY_QUEUE_CAPACITY: usize = 32;
const BROWSER_CLOSE_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Serialize)]
struct BrowserReply {
    #[serde(flatten)]
    message: ServerMessage,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<u64>,
}

impl BrowserReply {
    fn new(message: ServerMessage) -> Self {
        Self {
            message,
            request_id: None,
        }
    }

    fn error(message: impl Into<String>) -> Self {
        Self::new(ServerMessage::Error {
            message: message.into(),
        })
    }
}

struct ReceivedCommand {
    message: BrowserMessage,
    received: Instant,
}

pub(super) async fn serve(
    socket: WebSocket,
    session: u64,
    state: &AppState,
    status_rx: watch::Receiver<BrowserStatus>,
    views: watch::Receiver<ControlsView>,
    feedback: broadcast::Receiver<(u64, ServerMessage)>,
) {
    let (writer, mut reader) = socket.split();
    let (output, replies) = mpsc::channel(REPLY_QUEUE_CAPACITY);
    let (requests, ordered) = mpsc::channel(REQUEST_QUEUE_CAPACITY);
    let (save_tx, saves) = mpsc::channel(REQUEST_QUEUE_CAPACITY);
    let (stop, urgent) = mpsc::channel(1);
    let (closing, closed) = watch::channel(false);
    let (leave_result, mut leave_completed) = watch::channel(false);
    let (close_socket, socket_close) = oneshot::channel();

    let mut writer = tokio::spawn(write_session(
        writer,
        session,
        state.control.clone(),
        replies,
        status_rx,
        views,
        feedback,
        socket_close,
    ));
    let dispatcher = tokio::spawn(run_commands(
        session,
        state.clone(),
        ordered,
        output.clone(),
        closed.clone(),
        leave_result,
    ));
    let settings_worker = tokio::spawn(save_settings(state.clone(), saves, output.clone()));
    let stop_dispatcher = tokio::spawn(run_stop(
        session,
        state.clone(),
        urgent,
        output.clone(),
        closed,
    ));

    let mut last_seq = None;
    let mut input_acquire: Option<JoinHandle<Result<(), String>>> = None;
    let mut input_acquire_failed = false;
    let mut input_requested = false;
    let mut browser_ping_check = tokio::time::interval(BROWSER_PING_INTERVAL);
    browser_ping_check.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut last_browser_pong = Instant::now();
    let mut leaving = false;
    let mut writer_stopped = false;

    loop {
        tokio::select! {
            result = async { input_acquire.as_mut().expect("guarded").await }, if input_acquire.is_some() => {
                input_acquire = None;
                if let Err(reason) = result.unwrap_or_else(|error| Err(format!("控制权请求失败：{error}"))) {
                    input_acquire_failed = input_requested;
                    if let Some(peer) = state.control.lock().await.peers.get_mut(&session) {
                        if input_requested {
                            peer.require_neutral();
                        } else {
                            peer.cancel_mouth();
                        }
                    }
                    if input_requested {
                        if output.try_send(BrowserReply::error(reason)).is_err() { break; }
                    }
                }
            }
            _ = &mut writer => {
                writer_stopped = true;
                break;
            }
            _ = browser_ping_check.tick() => {
                let holding = {
                    let control = state.control.lock().await;
                    control.owner == Some(session) && control.head_position.is_some()
                };
                let pong_timeout = if holding { BROWSER_HOLD_PONG_TIMEOUT } else { BROWSER_PONG_TIMEOUT };
                if last_browser_pong.elapsed() > pong_timeout {
                    tracing::warn!(session, holding, "browser connection timed out");
                    break;
                }
            }
            changed = leave_completed.changed(), if leaving => {
                if changed.is_err() { break; }
                leaving = false;
            }
            message = reader.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    // Timestamp at ingress. Motion frames are never queued behind a device request.
                    let received = Instant::now();
                    let message = match serde_json::from_str::<BrowserMessage>(&text) {
                        Ok(message) => message,
                        Err(error) => {
                            tracing::warn!(session, %error, "invalid browser control message");
                            if output.try_send(BrowserReply::error(format!("invalid control message: {error}"))).is_err() {
                                break;
                            }
                            continue;
                        }
                    };
                    match message {
                    BrowserMessage::Input {
                        seq,
                        left_x,
                        left_y,
                        right_x,
                        right_y, head_stick, left_trigger, right_trigger, mouth_auto, mouth_cancel, mouth_held,
                        wing_flap, wing_flap_duration_ms, buttons, active,
                    } => {
                        if leaving { continue; }
                        let input = Input {
                            left_x,
                            left_y,
                            right_x,
                            right_y, head_stick, left_trigger, right_trigger, mouth_auto, mouth_cancel, mouth_held,
                            wing_flap: if state.status.borrow().wing_flap_enabled { wing_flap } else { proto::WingFlapMode::Off },
                            wing_flap_duration_ms,
                            buttons: buttons.into_iter().fold(0, |bits, button| bits | button.bit()),
                        };
                        if !input.valid() {
                            if output.try_send(BrowserReply::error("input axes must be finite numbers in [-1, 1]")).is_err() { break; }
                            continue;
                        }
                        if last_seq.is_some_and(|previous| seq <= previous) {
                            tracing::debug!(session, seq, "discarded stale browser input");
                            continue;
                        }
                        last_seq = Some(seq);
                        if received.elapsed() > INPUT_TTL { continue; }
                        let neutral = input.neutral();
                        input_requested = active && !neutral;
                        if !input_requested { input_acquire_failed = false; }
                        let claim = {
                            let mut control = state.control.lock().await;
                            if received.elapsed() > INPUT_TTL { continue; }
                            let Some(peer) = control.peers.get_mut(&session) else { continue; };
                            peer.receive(active, input, received);
                            if control.owner != Some(session) {
                                input_requested
                            } else {
                                if !control.owner_closing {
                                    if !input_requested || (control.armed && control.fresh(received)) {
                                        if control.human_held || !input_requested {
                                            control.receive(input, active, received);
                                        } else {
                                            // Keep the pending lease request fresh. Movement starts
                                            // with a frame received after robotd grants ownership.
                                            control.last_input = Some(received);
                                        }
                                    }
                                }
                                false
                            }
                        };
                        if claim && input_acquire.is_none() && !input_acquire_failed {
                            let state = state.clone();
                            input_acquire = Some(tokio::spawn(async move { acquire_human(session, &state).await }));
                        }
                    }
                        BrowserMessage::Action { name: Action::Stop, request_id } => {
                            // Stop uses an independent IPC path and cannot wait behind a start.
                            if stop.try_send(request_id).is_err()
                                && output.try_send(BrowserReply {
                                    message: ServerMessage::Error { message: "停止请求尚未完成".into() },
                                    request_id,
                                }).is_err()
                            {
                                break;
                            }
                        }
                        message => {
                            if leaving { continue; }
                            let message = match settings_save(message) {
                                Ok((request_id, save)) => {
                                    if save_tx.try_send(save).is_err() && output.try_send(BrowserReply::new(
                                        ServerMessage::SettingsResult {
                                            request_id, accepted: false, reason: Some("参数保存服务不可用".into()),
                                        })).is_err()
                                    {
                                        break;
                                    }
                                    continue;
                                }
                                Err(message) => message,
                            };
                            if matches!(message, BrowserMessage::StudioLeave { .. }) {
                                let mut control = state.control.lock().await;
                                if let Some(peer) = control.peers.get_mut(&session) {
                                    peer.require_neutral();
                                }
                                if control.owner == Some(session) {
                                    control.owner_closing = true;
                                    control.active = false;
                                    control.last_input = None;
                                }
                                input_requested = false;
                                input_acquire_failed = false;
                                leaving = true;
                                leave_completed.borrow_and_update();
                            }
                            if requests.try_send(ReceivedCommand { message, received }).is_err() {
                                tracing::warn!(session, "browser control request queue is full");
                                break;
                            }
                        }
                    }
                }
                Some(Ok(Message::Pong(_))) => last_browser_pong = Instant::now(),
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            }
        }
    }

    {
        let mut control = state.control.lock().await;
        if let Some(peer) = control.peers.get_mut(&session) {
            peer.require_neutral();
        }
        if control.owner == Some(session) {
            control.owner_closing = true;
            control.active = false;
            control.last_input = None;
            control.vision_pending = None;
        }
    }
    closing.send_replace(true);
    if !writer_stopped {
        let _ = close_socket.send(());
    }
    if !writer_stopped && timeout(BROWSER_CLOSE_TIMEOUT, &mut writer).await.is_err() {
        writer.abort();
        let _ = writer.await;
    }
    drop(reader);
    drop(requests);
    drop(stop);
    drop(save_tx);
    release_session(session, state).await;
    if let Some(task) = input_acquire.take() {
        let _ = task.await;
    }
    let _ = dispatcher.await;
    let _ = stop_dispatcher.await;
    if let Err(error) = settings_worker.await {
        tracing::error!(%error, "page settings worker failed");
    }
}

async fn write_session(
    mut socket: SplitSink<WebSocket, Message>,
    session: u64,
    control: Arc<Mutex<ControlState>>,
    mut replies: mpsc::Receiver<BrowserReply>,
    mut status: watch::Receiver<BrowserStatus>,
    mut views: watch::Receiver<ControlsView>,
    mut feedback: broadcast::Receiver<(u64, ServerMessage)>,
    mut closing: oneshot::Receiver<()>,
) {
    let mut previous_controls = None;
    let mut ping = tokio::time::interval(BROWSER_PING_INTERVAL);
    ping.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        let reply = tokio::select! {
            _ = &mut closing => {
                let _ = socket.close().await;
                break;
            }
            _ = ping.tick() => None,
            reply = replies.recv() => match reply {
                Some(reply) => Some(reply),
                None => break,
            },
            changed = views.changed() => {
                if changed.is_err() { break; }
                views.borrow_and_update();
                let controls = control.lock().await.view_for(Some(session), Instant::now());
                if previous_controls.as_ref() == Some(&controls) { continue; }
                previous_controls = Some(controls.clone());
                Some(BrowserReply::new(ServerMessage::Controls { controls }))
            }
            changed = status.changed() => {
                if changed.is_err() { break; }
                let status = status.borrow_and_update().clone();
                Some(BrowserReply::new(ServerMessage::Status { status }))
            }
            result = feedback.recv() => match result {
                Ok((owner, message)) if owner == session => Some(BrowserReply::new(message)),
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(_)) => Some(BrowserReply::error("动作反馈丢失，请检查机器人状态")),
                Err(broadcast::error::RecvError::Closed) => break,
            }
        };
        let frame = match reply {
            Some(reply) => match serde_json::to_string(&reply) {
                Ok(text) => Message::Text(text.into()),
                Err(error) => {
                    tracing::error!(session, %error, "could not encode browser response");
                    break;
                }
            },
            None => Message::Ping(Vec::new().into()),
        };
        match timeout(BROWSER_SEND_TIMEOUT, socket.send(frame)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::debug!(session, %error, "browser connection send failed");
                break;
            }
            Err(_) => {
                tracing::warn!(session, "browser connection send timed out");
                break;
            }
        }
    }
}

async fn run_stop(
    session: u64,
    state: AppState,
    mut requests: mpsc::Receiver<Option<u64>>,
    output: mpsc::Sender<BrowserReply>,
    mut closed: watch::Receiver<bool>,
) {
    loop {
        let request_id = tokio::select! {
            biased;
            _ = closed.changed() => break,
            request = requests.recv() => match request {
                Some(request_id) => request_id,
                None => break,
            }
        };
        let message = dispatch_action(session, Action::Stop, &state).await;
        if output
            .send(BrowserReply {
                message,
                request_id,
            })
            .await
            .is_err()
        {
            break;
        }
    }
}

fn settings_save(message: BrowserMessage) -> Result<(u64, SettingsSave), BrowserMessage> {
    match message {
        BrowserMessage::SaveSettings {
            request_id,
            settings,
        } => Ok((request_id, SettingsSave::Page(request_id, settings))),
        BrowserMessage::SaveHeadSettings {
            request_id,
            settings,
        } => Ok((request_id, SettingsSave::Head(request_id, settings))),
        BrowserMessage::SaveCoordinatedSettings {
            request_id,
            scope,
            settings,
        } => Ok((
            request_id,
            SettingsSave::Coordinated(request_id, scope, settings),
        )),
        BrowserMessage::SaveTrackingPhases {
            request_id,
            scope,
            settings,
        } => Ok((
            request_id,
            SettingsSave::Phases(request_id, scope, settings),
        )),
        BrowserMessage::SaveMouthSound { request_id, sound } => {
            Ok((request_id, SettingsSave::Mouth(request_id, sound)))
        }
        BrowserMessage::SaveColorPreset {
            request_id,
            name,
            preset,
        } => Ok((request_id, SettingsSave::Color(request_id, name, preset))),
        BrowserMessage::DeleteColorPreset { request_id, name } => {
            Ok((request_id, SettingsSave::DeleteColor(request_id, name)))
        }
        message => Err(message),
    }
}

async fn save_settings(
    save_state: AppState,
    mut save_rx: mpsc::Receiver<SettingsSave>,
    save_output: mpsc::Sender<BrowserReply>,
) {
    while let Some(requested) = save_rx.recv().await {
        let reply = match requested {
            SettingsSave::Page(request_id, requested) => {
                dispatch_save_settings(request_id, requested, &save_state).await
            }
            SettingsSave::Head(request_id, requested) => {
                dispatch_save_head_settings(request_id, requested, &save_state).await
            }
            SettingsSave::Coordinated(request_id, scope, requested) => {
                dispatch_save_coordinated_settings(request_id, scope, requested, &save_state).await
            }
            SettingsSave::Phases(request_id, scope, requested) => {
                dispatch_save_tracking_phases(request_id, scope, requested, &save_state).await
            }
            SettingsSave::Mouth(request_id, sound) => {
                dispatch_save_mouth_sound(request_id, sound, &save_state).await
            }
            SettingsSave::Color(request_id, name, preset) => {
                dispatch_save_color(request_id, name, preset, &save_state).await
            }
            SettingsSave::DeleteColor(request_id, name) => {
                dispatch_delete_color(request_id, name, &save_state).await
            }
        };
        if let ServerMessage::SettingsResult {
            accepted: false,
            reason: Some(reason),
            ..
        } = &reply
        {
            tracing::warn!(%reason, "page settings were not saved");
        }
        // Accepted saves still finish after a close. The result belongs to this socket.
        let _ = save_output.send(BrowserReply::new(reply)).await;
    }
}

async fn run_commands(
    session: u64,
    state: AppState,
    mut requests: mpsc::Receiver<ReceivedCommand>,
    output: mpsc::Sender<BrowserReply>,
    mut closed: watch::Receiver<bool>,
    leave_result: watch::Sender<bool>,
) {
    loop {
        let request = tokio::select! {
            biased;
            _ = closed.changed() => break,
            request = requests.recv() => match request { Some(request) => request, None => break },
        };
        let leave = matches!(request.message, BrowserMessage::StudioLeave { .. });
        if handle_command(session, &state, request, &output)
            .await
            .is_err()
        {
            break;
        }
        if leave {
            leave_result.send_replace(true);
        }
    }
}

async fn handle_command(
    session: u64,
    state: &AppState,
    request: ReceivedCommand,
    output: &mpsc::Sender<BrowserReply>,
) -> Result<(), mpsc::error::SendError<BrowserReply>> {
    let ReceivedCommand { message, received } = request;
    match message {
        BrowserMessage::Input { .. } => unreachable!("input belongs to the socket reader"),
        BrowserMessage::StudioLeave {
            request_id,
            return_tracking_head_home,
        } => {
            let reply =
                leave_studio_workspace(session, request_id, return_tracking_head_home, state).await;
            output.send(BrowserReply::new(reply)).await?;
        }
        BrowserMessage::Action { name, request_id } => {
            let message = if received.elapsed() <= INPUT_TTL {
                dispatch_action(session, name, state).await
            } else {
                ServerMessage::ActionResult {
                    name,
                    accepted: false,
                    reason: Some("操作已失效，请重新操作".into()),
                }
            };
            output
                .send(BrowserReply {
                    message,
                    request_id,
                })
                .await?;
        }
        BrowserMessage::SetSpeed {
            linear_speed,
            turn_speed,
        } => {
            let reply = dispatch_speed(session, linear_speed, turn_speed, &state).await;
            output.send(BrowserReply::new(reply)).await?;
        }
        BrowserMessage::SaveSettings { .. }
        | BrowserMessage::SaveHeadSettings { .. }
        | BrowserMessage::SaveCoordinatedSettings { .. }
        | BrowserMessage::SaveTrackingPhases { .. }
        | BrowserMessage::SaveMouthSound { .. }
        | BrowserMessage::SaveColorPreset { .. }
        | BrowserMessage::DeleteColorPreset { .. } => {
            unreachable!("settings belong to their worker")
        }
        BrowserMessage::SetObstacle {
            enabled,
            threshold_mm,
            clear_delay_ms,
        } => {
            let params = proto::ObstacleParams {
                enabled,
                threshold_mm,
                clear_delay_ms,
            };
            let reply = dispatch_obstacle(session, params, &state).await;
            output.send(BrowserReply::new(reply)).await?;
        }
        BrowserMessage::SetLowVoltage {
            threshold_v,
            duration_s,
        } => {
            let params = proto::LowVoltageParams {
                threshold_v,
                duration_s,
            };
            let reply = dispatch_low_voltage(session, params, &state).await;
            output.send(BrowserReply::new(reply)).await?;
        }
        BrowserMessage::MotionTracking {
            action,
            initial_pitch,
            target,
            line_speed,
            line_target_x,
            reference_area,
            deadzone,
            gains,
        } => {
            let params = proto::MotionTrackingParams {
                action,
                initial_pitch,
                target,
                line_speed,
                line_target_x,
                reference_area,
                deadzone,
                gains,
            };
            let reply = dispatch_motion_tracking(session, params, &state).await;
            output.send(BrowserReply::new(reply)).await?;
        }
        BrowserMessage::HeadPosition { action, position } => {
            if action != proto::MotionTrackingAction::Stop && position.is_none() {
                let reply = ServerMessage::HeadPositionResult {
                    action,
                    accepted: false,
                    reason: Some("请填写头部位置".into()),
                };
                output.send(BrowserReply::new(reply)).await?;
                return Ok(());
            }
            let params = proto::HeadTrackingParams {
                action,
                target: None,
                pitch_position: position,
                deadzone: [0.0; 2],
                gains: [[0.0; 3]; 2],
            };
            let reply = match dispatch_head_tracking(session, params, &state).await {
                ServerMessage::HeadTrackingResult {
                    action,
                    accepted,
                    reason,
                } => ServerMessage::HeadPositionResult {
                    action,
                    accepted,
                    reason,
                },
                _ => unreachable!("head tracking dispatch result"),
            };
            output.send(BrowserReply::new(reply)).await?;
        }
        BrowserMessage::HeadTracking {
            action,
            target,
            pitch_position,
            deadzone,
            gains,
        } => {
            let params = proto::HeadTrackingParams {
                action,
                target,
                pitch_position,
                deadzone,
                gains,
            };
            let reply = dispatch_head_tracking(session, params, &state).await;
            output.send(BrowserReply::new(reply)).await?;
        }
        BrowserMessage::CoordinatedTracking {
            action,
            initial_pitch,
            target,
            camera,
            head_deadzone,
            head_gains,
            head_target_point,
            body_gains,
            final_body_gains,
            approach_linear_limit,
            final_linear_limit,
            final_lateral_limit,
            final_point,
            final_tolerance,
            stop_area_px,
            stop_area_deadzone_px,
            arrival_delay_s,
            arrival_skill,
            mouth_before,
            mouth_after,
            pickup_after,
            ..
        } => {
            let params = proto::CoordinatedTrackingParams {
                action,
                initial_pitch,
                target,
                camera,
                head_deadzone,
                head_gains,
                head_target_point,
                body_gains,
                final_body_gains,
                approach_linear_limit,
                final_linear_limit,
                final_lateral_limit,
                final_point,
                final_tolerance,
                stop_area_px,
                stop_area_deadzone_px,
                stop_distance_mm: None,
                stop_distance_deadzone_mm: 0,
                arrival_delay_s,
                arrival_skill,
                mouth_before,
                mouth_after,
                pickup_after,
            };
            let reply = dispatch_coordinated_tracking(session, params, &state).await;
            output.send(BrowserReply::new(reply)).await?;
        }
        BrowserMessage::Maze {
            action,
            threshold_mm,
            head_step_deg,
            settle_ms,
            sample_ms,
            turn_initial_ms,
            turn_final_ms,
            restore_ms,
            linear_speed,
            angular_speed,
        } => {
            let params = proto::MazeParams {
                action,
                threshold_mm,
                head_step_deg,
                settle_ms,
                sample_ms,
                turn_initial_ms,
                turn_final_ms,
                restore_ms,
                linear_speed,
                angular_speed,
            };
            let reply = dispatch_maze(session, params, &state).await;
            output.send(BrowserReply::new(reply)).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_action_id_preserves_the_legacy_request_and_reply() {
        for (request, expected_id) in [
            (r#"{"type":"action","name":"stop"}"#, None),
            (
                r#"{"type":"action","name":"stop","request_id":52}"#,
                Some(52),
            ),
        ] {
            let BrowserMessage::Action { name, request_id } =
                serde_json::from_str(request).unwrap()
            else {
                panic!("expected an action");
            };
            assert_eq!(name, Action::Stop);
            assert_eq!(request_id, expected_id);
            let serialized = serde_json::to_value(BrowserReply {
                message: ServerMessage::ActionResult {
                    name,
                    accepted: true,
                    reason: None,
                },
                request_id,
            })
            .unwrap();
            assert_eq!(serialized["type"], "action_result");
            assert_eq!(serialized["name"], "stop");
            assert_eq!(
                serialized
                    .get("request_id")
                    .and_then(serde_json::Value::as_u64),
                expected_id
            );
            assert_eq!(
                serialized.get("request_id").is_some(),
                expected_id.is_some()
            );
        }
    }
}
