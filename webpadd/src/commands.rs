//! Browser command handling and control-session handoff.

use super::*;

pub(super) async fn leave_studio_workspace(session: u64, request_id: u64, return_tracking_head_home: bool, state: &AppState) -> ServerMessage {
    let failure = |reason| ServerMessage::StudioLeaveResult { request_id, accepted: false, reason: Some(reason) };
    {
        let mut control = state.control.lock().await;
        if control.owner != Some(session) {
            return failure("页面已失去控制连接".into());
        }
        control.active = false;
        control.last_input = None;
        control.lose_human_control();
        control.mode = MotionMode::Drive;
    }
    let mut return_error = None;
    if return_tracking_head_home && state.status.borrow().motion_enabled != Some(false)
        && state.status.borrow().limp != Some(true) && state.status.borrow().fallen != Some(true)
    {
        // The existing wire action stops either coordinated tracking mode before homing.
        match lease_request(state, proto::HumanControlAction::PersonFollowHome, vec![]).await {
            Ok(result) if result.accepted => {
                let home = duck_control::hx::PHYSICAL_HOME_ENCODER_TARGETS[6];
                {
                    let mut control = state.control.lock().await;
                    if control.owner == Some(session) {
                        control.head_position = Some(home);
                        control.head_tracking_started = true;
                    }
                }
                let mut status = state.status.clone();
                let mut last_sequence = status.borrow_and_update().head_feedback_sequence;
                let wait = async {
                    let mut arrivals = 0;
                    loop {
                        status.changed().await.map_err(|_| "舵机状态连接已关闭".to_owned())?;
                        let snapshot = status.borrow_and_update().clone();
                        if !snapshot.robotd_connected { return Err("机器人状态连接已断开".into()); }
                        if state.control.lock().await.head_position != Some(home) {
                            return Err("头部回位被其他操控中断".into());
                        }
                        if snapshot.head_feedback_sequence == last_sequence { continue; }
                        last_sequence = snapshot.head_feedback_sequence;
                        if snapshot.head_feedback.is_some_and(|(measured, target)|
                            measured.abs_diff(home) <= 20 && target.abs_diff(home) <= 20)
                        { arrivals += 1; } else { arrivals = 0; }
                        if arrivals >= 2 { return Ok(()); }
                    }
                };
                return_error = match timeout(Duration::from_secs(8), wait).await {
                    Ok(Ok(())) => None,
                    Ok(Err(error)) => Some(error),
                    Err(_) => Some("头部回位超时，请检查舵机并重试".into()),
                };
            }
            // Another controller has taken over; never steal its lease to reposition the head.
            Ok(result) if result.reason.as_deref() == Some("not_owner") => {}
            Ok(result) => return_error = Some(result.reason.unwrap_or_else(|| "无法让头部回位".into())),
            Err(error) => return_error = Some(error),
        }
    }
    match lease_request(state, proto::HumanControlAction::Abandon, vec![]).await {
        Ok(result) if result.accepted || result.reason.as_deref() == Some("not_owner") => {
            let mut control = state.control.lock().await;
            if control.owner == Some(session) {
                control.head_tracking_started = false;
                control.head_tracking_dirty = false;
                control.head_tracking_closing = false;
                control.coordinated_tracking_started = false;
                control.coordinated_tracking_dirty = false;
                control.coordinated_tracking_closing = false;
                control.head_position = None;
            }
            match return_error { Some(reason) => failure(reason),
                None => ServerMessage::StudioLeaveResult { request_id, accepted: true, reason: None } }
        }
        Ok(result) => failure(result.reason.unwrap_or_else(|| "无法停止当前页面的控制".into())),
        Err(error) => failure(error),
    }
}

pub(super) async fn dispatch_save_settings(request_id: u64, requested: settings::Settings, state: &AppState) -> ServerMessage {
    let error = |reason| ServerMessage::SettingsResult {request_id, accepted: false, reason: Some(reason)};
    if !requested.valid() {
        return error("页面参数无效，未保存".into());
    }
    let mut guard = state.settings.lock().await;
    let mut pending = guard.clone();
    match tokio::task::spawn_blocking(move || pending.save(requested).map(|()| pending)).await {
        Ok(Ok(saved)) => {
            *guard = saved;
            ServerMessage::SettingsResult {request_id, accepted: true, reason: None}
        },
        Ok(Err(reason)) => error(format!("参数保存失败：{reason}")),
        Err(reason) => error(format!("参数保存任务失败：{reason}")),
    }
}

pub(super) async fn dispatch_save_head_settings(request_id: u64, requested: settings::HeadTrackingSettings, state: &AppState) -> ServerMessage {
    let error = |reason| ServerMessage::SettingsResult { request_id, accepted: false, reason: Some(reason) };
    if !requested.valid() { return error("头部追踪参数无效，未保存".into()); }
    let mut guard = state.head_settings.lock().await;
    let mut pending = guard.clone();
    match tokio::task::spawn_blocking(move || pending.save(requested).map(|()| pending)).await {
        Ok(Ok(saved)) => { *guard = saved; ServerMessage::SettingsResult { request_id, accepted: true, reason: None } }
        Ok(Err(reason)) => error(format!("参数保存失败：{reason}")),
        Err(reason) => error(format!("参数保存任务失败：{reason}")),
    }
}

pub(super) async fn dispatch_save_coordinated_settings(request_id: u64, scope: settings::TrackingScope, requested: settings::CoordinatedTrackingSettings, state: &AppState) -> ServerMessage {
    let error = |reason| ServerMessage::SettingsResult { request_id, accepted: false, reason: Some(reason) };
    if !requested.valid() { return error("联合追踪参数无效，未保存".into()); }
    let store = match scope { settings::TrackingScope::Target => &state.coordinated_settings,
        settings::TrackingScope::Person => &state.person_coordinated_settings };
    let mut guard = store.lock().await;
    let mut pending = guard.clone();
    match tokio::task::spawn_blocking(move || pending.save(requested).map(|()| pending)).await {
        Ok(Ok(saved)) => { *guard = saved; ServerMessage::SettingsResult { request_id, accepted: true, reason: None } }
        Ok(Err(reason)) => error(format!("参数保存失败：{reason}")),
        Err(reason) => error(format!("参数保存任务失败：{reason}")),
    }
}

pub(super) async fn dispatch_save_tracking_phases(request_id: u64, scope: settings::TrackingScope, requested: settings::TrackingPhaseSettings, state: &AppState) -> ServerMessage {
    let error = |reason| ServerMessage::SettingsResult { request_id, accepted: false, reason: Some(reason) };
    let store = match scope { settings::TrackingScope::Target => &state.tracking_phases,
        settings::TrackingScope::Person => &state.person_tracking_phases };
    let mut guard = store.lock().await;
    let mut pending = guard.clone();
    match tokio::task::spawn_blocking(move || pending.save(requested).map(|()| pending)).await {
        Ok(Ok(saved)) => { *guard = saved; ServerMessage::SettingsResult { request_id, accepted: true, reason: None } }
        Ok(Err(reason)) => error(format!("分阶段参数保存失败：{reason}")),
        Err(reason) => error(format!("分阶段参数保存任务失败：{reason}")),
    }
}

pub(super) async fn dispatch_save_mouth_sound(request_id: u64, sound: String, state: &AppState) -> ServerMessage {
    let error = |reason| ServerMessage::SettingsResult { request_id, accepted: false, reason: Some(reason) };
    let mut guard = state.mouth_settings.lock().await;
    let mut pending = guard.clone();
    let directory = state.mouth_sound_directory.clone();
    match tokio::task::spawn_blocking(move || pending.save(sound, &directory).map(|()| pending)).await {
        Ok(Ok(saved)) => {
            state.control.lock().await.set_mouth_sound(saved.value.clone());
            *guard = saved;
            ServerMessage::SettingsResult { request_id, accepted: true, reason: None }
        }
        Ok(Err(reason)) => error(format!("嘴部声音未保存：{reason}")),
        Err(reason) => error(format!("嘴部声音保存任务失败：{reason}")),
    }
}

pub(super) async fn dispatch_save_color(request_id: u64, name: String, preset: settings::ColorPreset, state: &AppState) -> ServerMessage {
    let error = |reason| ServerMessage::SettingsResult { request_id, accepted: false, reason: Some(reason) };
    let mut guard = state.color_presets.lock().await;
    let mut pending = guard.clone();
    match tokio::task::spawn_blocking(move || pending.save(name, preset).map(|()| pending)).await {
        Ok(Ok(saved)) => { *guard = saved; ServerMessage::SettingsResult { request_id, accepted: true, reason: None } }
        Ok(Err(reason)) => error(format!("颜色未保存：{reason}")),
        Err(reason) => error(format!("颜色保存任务失败：{reason}")),
    }
}

pub(super) async fn dispatch_delete_color(request_id: u64, name: String, state: &AppState) -> ServerMessage {
    let error = |reason| ServerMessage::SettingsResult { request_id, accepted: false, reason: Some(reason) };
    let mut guard = state.color_presets.lock().await;
    let mut pending = guard.clone();
    match tokio::task::spawn_blocking(move || pending.delete(name).map(|()| pending)).await {
        Ok(Ok(saved)) => { *guard = saved; ServerMessage::SettingsResult { request_id, accepted: true, reason: None } }
        Ok(Err(reason)) => error(format!("颜色未删除：{reason}")),
        Err(reason) => error(format!("颜色删除任务失败：{reason}")),
    }
}

pub(super) async fn dispatch_maze(session: u64, params: proto::MazeParams, state: &AppState) -> ServerMessage {
    let response = |accepted, reason| ServerMessage::MazeResult { action: params.action, accepted, reason };
    if !params.valid() { return response(false, Some("迷宫参数无效".into())); }
    let (reply, receiver) = oneshot::channel();
    {
        let control = state.control.lock().await;
        if control.owner != Some(session) || !control.connected {
            return response(false, Some("控制连接不可用".into()));
        }
        if state.commands.try_send(RobotCommand::Request {
            calls: vec![proto::Call::RobotMaze(params)], sit_on_loss: false,
            generation: None, created: Instant::now(), reply,
        }).is_err() { return response(false, Some("迷宫指令发送失败".into())); }
    }
    let (accepted, reason) = match timeout(ACTION_TIMEOUT, receiver).await {
        Ok(Ok(Ok(result))) => (result.accepted, result.reason),
        Ok(Ok(Err(error))) => (false, Some(error)),
        _ => (false, Some("迷宫指令超时".into())),
    };
    let mut control = state.control.lock().await;
    if control.owner == Some(session) {
        match params.action {
            proto::MotionTrackingAction::Start => control.maze_active = accepted,
            proto::MotionTrackingAction::Stop => control.maze_active = false,
            proto::MotionTrackingAction::Update if !accepted => control.maze_active = false,
            _ => {}
        }
    }
    response(accepted, reason)
}

pub(super) async fn dispatch_motion_tracking(session: u64, params: proto::MotionTrackingParams, state: &AppState) -> ServerMessage {
    let response = |accepted, reason| ServerMessage::MotionTrackingResult { action: params.action, accepted, reason };
    if !params.valid() {
        return response(false, Some("目标坐标或 PID 参数无效".into()));
    }
    let (reply, receiver) = oneshot::channel();
    {
        let control = state.control.lock().await;
        if control.owner != Some(session) || !control.connected {
            return response(false, Some("控制连接不可用".into()));
        }
        if state.commands.try_send(RobotCommand::Request {
            calls: vec![proto::Call::RobotMotionTracking(params)], sit_on_loss: false,
            generation: None, created: Instant::now(), reply,
        }).is_err() {
            return response(false, Some("追踪指令发送失败".into()));
        }
    }
    match timeout(ACTION_TIMEOUT, receiver).await {
        Ok(Ok(Ok(result))) => response(result.accepted, result.reason),
        Ok(Ok(Err(error))) => response(false, Some(error)),
        _ => response(false, Some("追踪指令超时".into())),
    }
}

pub(super) async fn dispatch_head_tracking(session: u64, params: proto::HeadTrackingParams, state: &AppState) -> ServerMessage {
    let response = |accepted, reason| ServerMessage::HeadTrackingResult { action: params.action, accepted, reason };
    if !params.valid() { return response(false, Some("目标坐标或头部 PID 参数无效".into())); }
    let (reply, receiver) = oneshot::channel();
    let was_dirty = {
        let mut control = state.control.lock().await;
        if control.owner != Some(session) || !control.connected || control.head_tracking_closing {
            return response(false, Some("控制连接不可用".into()));
        }
        if params.action == proto::MotionTrackingAction::Update && !control.head_tracking_started {
            return response(false, Some("本网页尚未启动头部追踪".into()));
        }
        let was_dirty = control.head_tracking_dirty;
        if state.commands.try_send(RobotCommand::Request {
            calls: vec![proto::Call::RobotHeadTracking(params)], sit_on_loss: false,
            generation: None, created: Instant::now(), reply,
        }).is_err() { return response(false, Some("头部追踪指令发送失败".into())); }
        if params.action == proto::MotionTrackingAction::Start {
            control.head_tracking_dirty = true;
        } else if params.action == proto::MotionTrackingAction::Stop {
            control.head_tracking_started = false;
            control.head_position = None;
        } else if params.pitch_position.is_some() && control.head_position.is_some() {
            control.head_position = params.pitch_position;
        }
        was_dirty
    };
    let (accepted, reason, refused) = match timeout(ACTION_TIMEOUT, receiver).await {
        Ok(Ok(Ok(result))) => (result.accepted, result.reason, !result.accepted),
        Ok(Ok(Err(error))) => (false, Some(error), false),
        _ => (false, Some("头部追踪指令超时".into()), false),
    };
    let mut control = state.control.lock().await;
    if control.owner == Some(session) {
        if params.action == proto::MotionTrackingAction::Start && refused && !was_dirty {
            control.head_tracking_dirty = false;
        }
        if control.head_tracking_closing {
            return response(accepted, reason);
        }
        match params.action {
            proto::MotionTrackingAction::Start => {
                control.head_tracking_started = accepted;
                control.head_position = if accepted { params.pitch_position } else { None };
            }
            proto::MotionTrackingAction::Stop if accepted => control.head_tracking_dirty = false,
            proto::MotionTrackingAction::Update if !accepted => {
                control.head_tracking_started = false;
                control.head_position = None;
            }
            _ => {}
        }
    }
    response(accepted, reason)
}

pub(super) async fn dispatch_coordinated_tracking(session: u64, mut params: proto::CoordinatedTrackingParams, state: &AppState) -> ServerMessage {
    let action = params.action;
    let person_follow = params.stop_area_px.is_some();
    let response = |accepted, reason| ServerMessage::CoordinatedTrackingResult { action, accepted, reason };
    if !params.valid() { return response(false, Some("目标、相机或联合追踪参数无效".into())); }
    let (reply, receiver) = oneshot::channel();
    let (was_dirty, human_generation, tracking_generation, desired_params) = {
        let mut control = state.control.lock().await;
        if control.owner != Some(session) || !control.connected || control.coordinated_tracking_closing {
            return response(false, Some("控制连接不可用".into()));
        }
        if action == proto::MotionTrackingAction::Update && !control.coordinated_tracking_started {
            return response(false, Some("本网页尚未启动联合追踪".into()));
        }
        let mut desired_params = params.clone();
        // Once a native recognition stream is bound, browser samples are never
        // allowed to overwrite a newer locally captured frame.
        if control.vision_token.is_some() && action != proto::MotionTrackingAction::Stop {
            desired_params.target = None;
            if let Some(frame) = crate::vision_relay::current_frame(&control, &params) {
                params.target = frame.target;
            } else {
                params.target = None;
                params.camera = None;
            }
        }
        let was_dirty = control.coordinated_tracking_dirty;
        if matches!(action, proto::MotionTrackingAction::Start | proto::MotionTrackingAction::Stop) {
            control.coordinated_tracking_generation = control.coordinated_tracking_generation.wrapping_add(1);
            control.vision_pending = None;
            if action == proto::MotionTrackingAction::Stop {
                control.coordinated_tracking_started = false;
                control.coordinated_params = None;
            }
            if let Some(recorder) = &control.person_vision_record { recorder.set_following(false); }
            if let Some(recorder) = &control.target_vision_record { recorder.set_following(false); }
        }
        let human_generation = control.human_generation;
        let tracking_generation = control.coordinated_tracking_generation;
        if state.commands.try_send(RobotCommand::Request {
            calls: vec![proto::Call::RobotCoordinatedTracking(params.clone())], sit_on_loss: false,
            generation: None, created: Instant::now(), reply,
        }).is_err() { return response(false, Some("联合追踪指令发送失败".into())); }
        if action == proto::MotionTrackingAction::Start {
            control.coordinated_tracking_dirty = true;
        } else if action == proto::MotionTrackingAction::Update {
            control.coordinated_params = Some(desired_params.clone());
        } else if action == proto::MotionTrackingAction::Stop {
            control.coordinated_tracking_started = false;
            control.coordinated_params = None;
        }
        (was_dirty, human_generation, tracking_generation, desired_params)
    };
    let (accepted, reason, refused) = match timeout(ACTION_TIMEOUT, receiver).await {
        Ok(Ok(Ok(result))) => (result.accepted, result.reason, !result.accepted),
        Ok(Ok(Err(error))) => (false, Some(error), false),
        _ => (false, Some("联合追踪指令超时".into()), false),
    };
    let mut control = state.control.lock().await;
    if control.owner == Some(session) && control.human_generation == human_generation
        && control.coordinated_tracking_generation == tracking_generation
    {
        if action == proto::MotionTrackingAction::Start && refused && !was_dirty {
            control.coordinated_tracking_dirty = false;
        }
        if control.coordinated_tracking_closing { return response(accepted, reason); }
        match action {
            proto::MotionTrackingAction::Start => {
                control.coordinated_tracking_started = accepted;
                control.coordinated_params = accepted.then_some(desired_params);
                if let Some(recorder) = &control.person_vision_record {
                    recorder.set_following(accepted && person_follow);
                }
                if let Some(recorder) = &control.target_vision_record {
                    recorder.set_following(accepted && !person_follow);
                }
            },
            proto::MotionTrackingAction::Stop if accepted => control.coordinated_tracking_dirty = false,
            proto::MotionTrackingAction::Update if !accepted => {
                control.coordinated_tracking_started = false;
                if let Some(recorder) = &control.person_vision_record { recorder.set_following(false); }
                if let Some(recorder) = &control.target_vision_record { recorder.set_following(false); }
            },
            _ => {}
        }
    }
    response(accepted, reason)
}

pub(super) async fn dispatch_low_voltage(_session: u64, _params: proto::LowVoltageParams, _state: &AppState) -> ServerMessage {
    ServerMessage::Error { message: "低电压保护参数固定，不支持修改".into() }
}

pub(super) async fn dispatch_speed(
    session: u64,
    linear_speed: f64,
    turn_speed: f64,
    state: &AppState,
) -> ServerMessage {
    if !linear_speed.is_finite()
        || !(MIN_LINEAR_SPEED..=MAX_LINEAR).contains(&linear_speed)
        || !turn_speed.is_finite()
        || !(0.0..=MAX_ANGULAR).contains(&turn_speed)
    {
        return ServerMessage::Error {
            message: format!("线速度范围0～{MAX_LINEAR} m/s，转向范围0～{MAX_ANGULAR} rad/s"),
        };
    }
    let mut control = state.control.lock().await;
    if control.owner != Some(session) {
        return ServerMessage::Error {
            message: "control lease lost".into(),
        };
    }
    control.linear_speed = linear_speed;
    control.turn_speed = turn_speed;
    ServerMessage::Controls {
        controls: control.view(Instant::now()),
    }
}

pub(super) async fn dispatch_obstacle(
    session: u64,
    params: proto::ObstacleParams,
    state: &AppState,
) -> ServerMessage {
    if !(proto::OBSTACLE_MIN_THRESHOLD_MM..=proto::OBSTACLE_MAX_THRESHOLD_MM)
        .contains(&params.threshold_mm)
        || params.clear_delay_ms > proto::OBSTACLE_MAX_CLEAR_DELAY_MS
    {
        return ServerMessage::Error {
            message: "避障距离或延时超出范围".into(),
        };
    }
    let _guard = state.obstacle_lock.lock().await;
    let (reply, receiver) = oneshot::channel();
    {
        let control = state.control.lock().await;
        if control.owner != Some(session) || !control.connected || !control.fresh(Instant::now()) || control.obstacle.is_none() {
            return ServerMessage::Error {
                message: "控制连接不可用，避障设置未生效".into(),
            };
        }
        if state
            .commands
            .try_send(RobotCommand::Request {
                calls: vec![proto::Call::RobotSetObstacle(params)],
                sit_on_loss: false,
                generation: None,
                created: Instant::now(),
                reply,
            })
            .is_err()
        {
            return ServerMessage::Error {
                message: "避障设置发送失败".into(),
            };
        }
    }
    match timeout(ACTION_TIMEOUT * 3, receiver).await {
        Ok(Ok(Ok(result))) if result.accepted => {
            let mut control = state.control.lock().await;
            control.obstacle = Some(params);
            ServerMessage::ObstacleSettings { settings: params }
        }
        Ok(Ok(Ok(result))) => ServerMessage::Error {
            message: result.reason.unwrap_or_else(|| "机器人拒绝避障设置".into()),
        },
        Ok(Ok(Err(error))) => {
            state.control.lock().await.obstacle = None;
            ServerMessage::Error { message: format!("避障设置失败：{error}") }
        }
        _ => {
            state.control.lock().await.obstacle = None;
            ServerMessage::Error { message: "避障设置超时".into() }
        }
    }
}

pub(super) async fn dispatch_action(session: u64, action: Action, state: &AppState) -> ServerMessage {
    if action == Action::Shutdown {
        if state.control.lock().await.owner != Some(session) {
            return ServerMessage::Error { message: "control lease lost".into() };
        }
        let result = timeout(Duration::from_millis(400), async {
            let stream = UnixStream::connect(&state.socket).await.map_err(|error| error.to_string())?;
            let (read, mut write) = stream.into_split();
            let mut reader = BufReader::new(read);
            send_request::<proto::IntentResult>(&mut reader, &mut write, 1, &proto::Call::RobotShutdown).await
        }).await.unwrap_or_else(|_| Err("关机请求超时".into()));
        return action_result(action, result);
    }
    if action == Action::Stop {
        if state.control.lock().await.owner != Some(session) {
            return ServerMessage::Error { message: "control lease lost".into() };
        }
        let result = timeout(Duration::from_millis(400), async {
            let stream = UnixStream::connect(&state.socket).await.map_err(|error| error.to_string())?;
            let (read, mut write) = stream.into_split();
            let mut reader = BufReader::new(read);
            send_request::<proto::IntentResult>(&mut reader, &mut write, 1, &proto::Call::RobotStop).await
        }).await.unwrap_or_else(|_| Err("停止请求超时".into()));
        if result.as_ref().is_ok_and(|response| response.accepted) {
            let mut control = state.control.lock().await;
            control.lose_human_control();
            control.human_owner = None;
        }
        return action_result(action, result);
    }
    if action != Action::Stop {
        if let Err(reason) = acquire_human(session, state).await {
            return action_result(action, Err(reason));
        }
    }
    let generation = {
        let mut control = state.control.lock().await;
        if control.owner != Some(session) {
            return ServerMessage::Error {
                message: "control lease lost".into(),
            };
        }
        if !control.connected || (!control.armed && action != Action::Stop) {
            return action_result(action, Err("请等待机器人连接并松开所有控制，再操作".into()));
        }
        if let Some(mode) = action.mode() {
            let calls = control.set_mode(mode);
            enqueue_notifications(&state.commands, calls, Some(control.human_generation));
            return ServerMessage::Controls {
                controls: control.view(Instant::now()),
            };
        }
        if matches!(action, Action::PrepareDrive | Action::ManualPrepareDrive) {
            let calls = control.set_mode(MotionMode::Drive);
            enqueue_notifications(&state.commands, calls, Some(control.human_generation));
        }
        if matches!(
            action,
            Action::Stop | Action::Relax | Action::Home | Action::Rest | Action::Shutdown
        ) {
            control.cancel();
            if control.human_held {
                let mut calls = control.set_mode(MotionMode::Drive);
                calls.push(proto::Call::RobotSound(proto::SoundParams {
                    tag: proto::SoundTag::Wheee,
                    hold: Some(false),
                }));
                enqueue_notifications(&state.commands, calls, Some(control.human_generation));
            }
        }
        control.human_actions += 1;
        control.human_generation
    };
    let result = perform_action(action, generation, state).await;
    state.control.lock().await.human_actions -= 1;
    result
}

pub(super) async fn acquire_human(session: u64, state: &AppState) -> Result<(), String> {
    {
        let mut control = state.control.lock().await;
        if control.owner != Some(session)
            || !control.connected
            || !control.armed
            || !control.fresh(Instant::now())
        {
            return Err("请等待连接并松开所有控制后重新操作".into());
        }
        if control.human_held {
            return Ok(());
        }
        if control.human_blocked || control.human_acquiring {
            return Err("控制权繁忙或已失效，请松开所有控制后重新操作".into());
        }
        control.human_acquiring = true;
    }
    let result = lease_request(state, proto::HumanControlAction::Acquire, vec![]).await;
    let mut control = state.control.lock().await;
    control.human_acquiring = false;
    if control.owner != Some(session) {
        return Err("操作已失效，请重新操作".into());
    }
    if !control.fresh(Instant::now()) {
        control.lose_human_control();
        return Err("操作已失效，请重新操作".into());
    }
    match result {
        Ok(result) if result.accepted && control.human_held => Ok(()),
        Ok(result) => Err(result
            .reason
            .unwrap_or_else(|| "控制权繁忙，请松开所有控制后重新操作".into())),
        Err(error) => {
            control.lose_human_control();
            Err(error)
        }
    }
}

pub(super) async fn lease_request(
    state: &AppState,
    action: proto::HumanControlAction,
    final_calls: Vec<proto::Call>,
) -> Result<HumanControlResult, String> {
    let (reply, receiver) = oneshot::channel();
    state
        .commands
        .send(RobotCommand::Lease {
            action,
            final_calls,
            reply,
        })
        .await
        .map_err(|_| "控制连接不可用".to_owned())?;
    timeout(ACTION_TIMEOUT, receiver)
        .await
        .map_err(|_| "控制权请求超时".to_owned())?
        .map_err(|_| "控制连接已关闭".to_owned())?
}

fn action_result(action: Action, result: Result<proto::IntentResult, String>) -> ServerMessage {
    match result {
        Ok(result) => ServerMessage::ActionResult {
            name: action,
            accepted: result.accepted,
            reason: result.reason,
        },
        Err(reason) => ServerMessage::ActionResult {
            name: action,
            accepted: false,
            reason: Some(reason),
        },
    }
}

async fn drive_prepare_calls(socket: &Path, deadline: Duration) -> Result<Vec<proto::Call>, String> {
    let policies: proto::PoliciesResult = timeout(deadline, async {
        let stream = UnixStream::connect(socket).await.map_err(|error| error.to_string())?;
        let (read, mut write) = stream.into_split();
        let mut reader = BufReader::new(read);
        send_request_timed(&mut reader, &mut write, 1, &proto::Call::RobotPolicies, deadline).await
    }).await.map_err(|_| "读取机器人启动状态超时".to_owned())??;
    let (Some(homed), Some(enabled), Some(phase)) =
        (policies.homed, policies.motion_enabled, policies.rest_phase) else {
            return Err("机器人启动状态不可用，请稍后重试".into());
        };
    if phase == proto::RestPhase::Resting {
        return Err("机器人正在休息，请等待休息完成".into());
    }
    let mut calls = Vec::new();
    if !homed || phase != proto::RestPhase::Idle {
        calls.push(proto::Call::RobotInit);
    }
    if !enabled || phase != proto::RestPhase::Idle {
        calls.push(proto::Call::RobotEnable(proto::EnableParams { on: true, toggle: false }));
    }
    Ok(calls)
}

pub(super) async fn perform_action(action: Action, generation: u64, state: &AppState) -> ServerMessage {
    let calls = if matches!(action, Action::PrepareDrive | Action::ManualPrepareDrive) {
        let deadline = if action == Action::ManualPrepareDrive { Duration::from_secs(2) } else { Duration::from_millis(400) };
        match drive_prepare_calls(&state.socket, deadline).await {
            Ok(calls) if calls.is_empty() && action == Action::PrepareDrive => {
                let mut control = state.control.lock().await;
                if control.human_generation != generation || !control.human_held {
                    return action_result(action, Err("控制权已失效，请重新操作".into()));
                }
                control.up = true;
                return action_result(action, Ok(proto::IntentResult::accepted()));
            }
            Ok(calls) => calls,
            Err(error) => return action_result(action, Err(error)),
        }
    } else {
        action.calls()
    };
    if calls.is_empty() && !matches!(action, Action::SitOnLoss | Action::ManualPrepareDrive) {
        return action_result(action, Err("该按键未绑定动作".into()));
    }
    let (reply, receiver) = oneshot::channel();
    let command = if action == Action::ManualPrepareDrive {
        let control = state.control.lock().await;
        let Some(session) = control.owner.filter(|_| control.human_generation == generation) else {
            return action_result(action, Err("控制权已失效，请重新操作".into()));
        };
        RobotCommand::ManualStart { session, generation, calls, created: Instant::now(), reply }
    } else {
        RobotCommand::Request {
            calls,
            sit_on_loss: action == Action::SitOnLoss,
            generation: if action == Action::Stop {
                None
            } else {
                Some(generation)
            },
            created: Instant::now(),
            reply,
        }
    };
    if state.commands.try_send(command).is_err()
    {
        return action_result(action, Err("robot command queue unavailable".into()));
    }
    let action_timeout = if action == Action::ManualPrepareDrive { REARM_TIMEOUT + ACTION_TIMEOUT * 3 } else { ACTION_TIMEOUT * 3 };
    let result = match timeout(action_timeout, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("robot command worker stopped".into()),
        Err(_) => Err("robotd action timed out".into()),
    };
    if result.as_ref().is_ok_and(|r| r.accepted) {
        let mut control = state.control.lock().await;
        if control.human_generation == generation
            && matches!(action, Action::Init | Action::PrepareDrive | Action::ManualPrepareDrive | Action::Home)
        {
            control.up = true;
        }
        if control.human_generation == generation
            && matches!(action, Action::Relax | Action::Rest | Action::Shutdown)
        {
            control.up = false;
        }
    }
    action_result(action, result)
}

pub(super) async fn finish_head_tracking(session: u64, state: &AppState) {
    {
        let mut control = state.control.lock().await;
        if control.owner != Some(session) {
            return;
        }
        control.head_tracking_closing = true;
        control.head_tracking_started = false;
        control.head_position = None;
        if !control.head_tracking_dirty {
            return;
        }
    }

    // Queue the stop before a new browser can start tracking. A refused stop means
    // ownership or the old intent has already expired; it must not block handoff.
    let result = match timeout(ACTION_TIMEOUT, state.commands.reserve()).await {
        Ok(Ok(permit)) => {
            let (reply, receiver) = oneshot::channel();
            permit.send(RobotCommand::Request {
                calls: vec![proto::Call::RobotHeadTracking(proto::HeadTrackingParams { pitch_position: None,
                    action: proto::MotionTrackingAction::Stop,
                    target: None,
                    deadzone: [0.0; 2],
                    gains: [[0.0; 3]; 2],
                })],
                sit_on_loss: false,
                generation: None,
                created: Instant::now(),
                reply,
            });
            timeout(ACTION_TIMEOUT, receiver).await
        }
        _ => {
            tracing::warn!(session, "head tracking cleanup could not be queued");
            let mut control = state.control.lock().await;
            if control.owner == Some(session) { control.head_tracking_dirty = false; }
            return;
        }
    };
    if !matches!(result, Ok(Ok(Ok(_)))) {
        tracing::warn!(session, ?result, "head tracking cleanup was not acknowledged");
    }
    let mut control = state.control.lock().await;
    if control.owner == Some(session) { control.head_tracking_dirty = false; }
}

pub(super) async fn finish_coordinated_tracking(session: u64, state: &AppState) {
    {
        let mut control = state.control.lock().await;
        if control.owner != Some(session) { return; }
        control.coordinated_tracking_closing = true;
        control.coordinated_tracking_started = false;
        control.vision_pending = None;
        control.coordinated_params = None;
        if let Some(recorder) = &control.person_vision_record { recorder.set_following(false); }
        if let Some(recorder) = &control.target_vision_record { recorder.set_following(false); }
        if !control.coordinated_tracking_dirty { return; }
    }
    let result = match timeout(ACTION_TIMEOUT, state.commands.reserve()).await {
        Ok(Ok(permit)) => {
            let (reply, receiver) = oneshot::channel();
            permit.send(RobotCommand::Request {
                calls: vec![proto::Call::RobotCoordinatedTracking(proto::CoordinatedTrackingParams {
                    action: proto::MotionTrackingAction::Stop, initial_pitch: None, target: None, camera: None,
                    head_deadzone: [0.0; 2], head_gains: [[0.0; 3]; 2], body_gains: [0.0; 3],
                    final_body_gains: [0.0; 3], approach_linear_limit: None,
                    final_linear_limit: proto::COORDINATED_TRACKING_DEFAULT_FINAL_LINEAR_LIMIT,
                    final_lateral_limit: proto::COORDINATED_TRACKING_DEFAULT_FINAL_LINEAR_LIMIT,
                    final_point: proto::COORDINATED_TRACKING_DEFAULT_FINAL_POINT,
                    final_tolerance: proto::COORDINATED_TRACKING_DEFAULT_FINAL_TOLERANCE,
                    stop_area_px: None,
                    stop_area_deadzone_px: 0,
                    stop_distance_mm: None,
                    stop_distance_deadzone_mm: 0,
                    arrival_delay_s: proto::COORDINATED_TRACKING_DEFAULT_ARRIVAL_DELAY_S,
                    arrival_skill: String::new(),
                    mouth_before: proto::TimedMouthPosition::default(),
                    mouth_after: proto::TimedMouthPosition::default(),
                })],
                sit_on_loss: false, generation: None, created: Instant::now(), reply,
            });
            timeout(ACTION_TIMEOUT, receiver).await
        }
        _ => {
            tracing::warn!(session, "coordinated tracking cleanup could not be queued");
            let mut control = state.control.lock().await;
            if control.owner == Some(session) { control.coordinated_tracking_dirty = false; }
            return;
        }
    };
    if !matches!(result, Ok(Ok(Ok(_)))) {
        tracing::warn!(session, ?result, "coordinated tracking cleanup was not acknowledged");
    }
    let mut control = state.control.lock().await;
    if control.owner == Some(session) { control.coordinated_tracking_dirty = false; }
}

pub(super) async fn release_session(session: u64, state: &AppState) {
    {
        let mut control = state.control.lock().await;
        if control.owner == Some(session) {
            control.coordinated_tracking_started = false;
            control.vision_pending = None;
            control.vision_token = None;
            control.vision_binding = None;
            control.vision_latest = None;
        }
    }
    finish_head_tracking(session, state).await;
    finish_coordinated_tracking(session, state).await;
    let mut control = state.control.lock().await;
    if control.owner != Some(session) {
        return;
    }
    control.owner = None;
    control.last_input = None;
    control.maze_active = false;
    // The next tick releases held sound and schedules a sitting-state check after input loss.
    tracing::info!(session, "browser control lease released");
}
