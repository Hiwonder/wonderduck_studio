//! Ordered IPC transport and acknowledged actions. No hardware access.
use super::*;

pub(super) async fn robotd_worker(
    socket: PathBuf,
    mut commands: mpsc::Receiver<RobotCommand>,
    mut frames: watch::Receiver<Option<RealtimeFrame>>,
    connected: watch::Sender<bool>,
    control: Arc<Mutex<ControlState>>,
    settings: Arc<Mutex<settings::Store>>,
    feedback: broadcast::Sender<(u64, ServerMessage)>,
    tof_enabled: bool,
) {
    let mut connection: Option<RobotConnection> = None;
    let mut last_connect_attempt = None;
    let mut connected_at = Instant::now();
    let mut next_id = 1u64;
    let mut ticker = tokio::time::interval(LEASE_PERIOD);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        let command = tokio::select! {
            command = commands.recv() => match command { Some(command) => Some(command), None => break },
            changed = frames.changed() => {
                if changed.is_err() { break; }
                let Some(frame) = frames.borrow_and_update().clone() else { continue; };
                Some(RobotCommand::Notify {
                    calls: frame.calls, generation: Some(frame.generation), created: frame.created,
                })
            }
            _ = ticker.tick() => None,
        };
        if connection.is_none() {
            if let Some(RobotCommand::VisionUpdate { session, binding, generation }) = &command {
                let mut state = control.lock().await;
                if state.vision_pending == Some((*session, *binding, *generation)) { state.vision_pending = None; }
                continue;
            }
        }
        if connection.is_none() {
            if last_connect_attempt.is_some_and(|at: Instant| at.elapsed() < CONNECT_RETRY) {
                reject_command(command, "robotd is reconnecting");
                continue;
            }
            last_connect_attempt = Some(Instant::now());
            match UnixStream::connect(&socket).await {
                Ok(stream) => {
                    let (read, write) = stream.into_split();
                    let mut candidate = (BufReader::new(read), write);
                    let result = human_request(
                        &mut candidate.0,
                        &mut candidate.1,
                        &mut next_id,
                        proto::HumanControlAction::Register,
                    )
                    .await;
                    if !result.as_ref().is_ok_and(|r| r.accepted) {
                        tracing::warn!(?result, "human-control registration failed");
                        reject_command(command, "human-control registration failed");
                        continue;
                    }
                    let saved = settings.lock().await.value.clone();
                    if tof_enabled && let Some(saved) = saved {
                        let result = send_request::<proto::IntentResult>(
                            &mut candidate.0, &mut candidate.1, next_id,
                            &proto::Call::RobotSetObstacle(saved.obstacle),
                        ).await;
                        next_id += 1;
                        if !result.as_ref().is_ok_and(|result| result.accepted) {
                            let reason = format!("恢复保存参数失败：{result:?}");
                            tracing::error!(%reason, "cannot restore saved robot settings");
                            reject_command(command, &reason);
                            continue;
                        }
                    }
                    connection = Some(candidate);
                    connected_at = Instant::now();
                    connected.send_replace(true);
                    last_connect_attempt = None;
                    tracing::info!(socket = %socket.display(), "connected to robotd");
                }
                Err(error) => {
                    reject_command(command, &format!("cannot reach robotd: {error}"));
                    continue;
                }
            }
        }
        let Some(command) = command else {
            // A selected head position remains owned by the page, including while
            // the page is unfocused. Refresh it here rather than relying on browser timers.
            let position_owner = {
                let state = control.lock().await;
                state.head_position.zip(state.owner)
            };
            if let Some((position, session)) = position_owner {
                let call = proto::Call::RobotHeadTracking(proto::HeadTrackingParams {
                    action: proto::MotionTrackingAction::Update,
                    target: None,
                    pitch_position: Some(position),
                    deadzone: [0.0; 2],
                    gains: [[0.0; 3]; 2],
                });
                let (reader, writer) = connection.as_mut().expect("connected above");
                let result = timeout(Duration::from_millis(400),
                    send_request::<proto::IntentResult>(reader, writer, next_id, &call)).await;
                next_id += 1;
                let transport_failed = !matches!(&result, Ok(Ok(_)));
                let reason = match result {
                    Ok(Ok(result)) if result.accepted => None,
                    Ok(Ok(result)) => Some(result.reason.unwrap_or_else(|| "机器人拒绝保持".into())),
                    Ok(Err(error)) => Some(error),
                    Err(_) => Some("头部保持续期超时".into()),
                };
                if let Some(reason) = reason {
                    let mut state = control.lock().await;
                    if state.owner == Some(session)
                        && (transport_failed || state.head_position == Some(position))
                        && state.head_position.is_some()
                    {
                        state.head_position = None;
                        state.head_tracking_started = false;
                        let _ = feedback.send((session, ServerMessage::HeadPositionResult {
                            action: proto::MotionTrackingAction::Update,
                            accepted: false,
                            reason: Some(reason),
                        }));
                    }
                    if transport_failed { state.lose_human_control(); }
                }
                if transport_failed {
                    connection = None;
                    connected.send_replace(false);
                }
                continue;
            }
            let (refresh, maze) = {
                let state = control.lock().await;
                (state.human_held && !state.owner_closing,
                    state.maze.filter(|_| state.human_held && !state.owner_closing)
                        .zip(state.owner).map(|(params, session)| (params, session, state.human_generation)))
            };
            let (reader, writer) = connection.as_mut().expect("connected above");
            if let Some((mut params, session, generation)) = maze {
                params.action = proto::MotionTrackingAction::Update;
                let result = timeout(Duration::from_millis(400),
                    send_request::<proto::IntentResult>(reader, writer, next_id, &proto::Call::RobotMaze(params))).await;
                next_id += 1;
                match result {
                    Ok(Ok(result)) if result.accepted => {}
                    Ok(Ok(result)) => {
                        let mut state = control.lock().await;
                        if state.owner == Some(session) && state.human_generation == generation {
                            state.maze = None;
                            let _ = feedback.send((session, ServerMessage::MazeResult {
                                action: proto::MotionTrackingAction::Update, accepted: false, reason: result.reason,
                            }));
                        }
                    }
                    result => {
                        tracing::warn!(?result, "lost robotd while refreshing maze");
                        connection = None;
                        connected.send_replace(false);
                        let mut state = control.lock().await;
                        state.lose_human_control();
                        state.human_owner = None;
                    }
                }
                continue;
            }
            let result = human_request(
                reader,
                writer,
                &mut next_id,
                if refresh {
                    proto::HumanControlAction::Refresh
                } else {
                    proto::HumanControlAction::Status
                },
            )
            .await;
            match result {
                Ok(result) => {
                    let mut state = control.lock().await;
                    state.human_owner = result.owner;
                    if !refresh && !result.accepted {
                        state.lose_human_control();
                        state.human_owner = None;
                        connection = None;
                        connected.send_replace(false);
                        continue;
                    }
                    if refresh
                        && (!result.accepted
                            || result.owner != Some(proto::HumanControlSource::Web))
                    {
                        state.lose_human_control();
                    }
                }
                Err(error) => {
                    tracing::warn!(%error, "human-control heartbeat failed");
                    connection = None;
                    connected.send_replace(false);
                    let mut state = control.lock().await;
                    state.lose_human_control();
                    state.human_owner = None;
                }
            }
            continue;
        };
        let created = match &command {
            RobotCommand::Notify { created, .. } | RobotCommand::Request { created, .. }
                | RobotCommand::ManualStart { created, .. } => {
                Some(*created)
            }
            RobotCommand::Lease { .. } | RobotCommand::VisionUpdate { .. } => None,
        };
        if created.is_some_and(|created| created < connected_at || created.elapsed() > INPUT_TTL) {
            reject_command(
                Some(command),
                "expired control request; not replayed after reconnect",
            );
            continue;
        }
        let (held, generation) = {
            let state = control.lock().await;
            (state.human_held && !state.owner_closing, state.human_generation)
        };
        let (reader, writer) = connection.as_mut().expect("connected above");
        let failed = match command {
            RobotCommand::VisionUpdate { session, binding, generation } => {
                let call = {
                    let mut state = control.lock().await;
                    crate::vision_relay::take_update(&mut state, session, binding, generation)
                };
                if let Some(call) = call {
                    let line = matches!(call, proto::Call::RobotMotionTracking(_));
                    let result = timeout(Duration::from_millis(400),
                        request_action(reader, writer, &mut next_id,
                            vec![call], false)).await;
                    match result {
                        Ok(Ok(result)) if result.accepted => false,
                        Ok(Ok(result)) => {
                            let mut state = control.lock().await;
                            if state.owner == Some(session) && state.vision_generation == generation {
                                state.vision_pending = None;
                                let message = if line {
                                    state.motion_tracking = None;
                                    ServerMessage::MotionTrackingResult {
                                        action: proto::MotionTrackingAction::Update, accepted: false, reason: result.reason,
                                    }
                                } else {
                                    state.coordinated_tracking_started = false;
                                    if let Some(recorder) = &state.person_vision_record { recorder.set_following(false); }
                                    if let Some(recorder) = &state.target_vision_record { recorder.set_following(false); }
                                    ServerMessage::CoordinatedTrackingResult {
                                        action: proto::MotionTrackingAction::Update, accepted: false, reason: result.reason,
                                    }
                                };
                                let _ = feedback.send((session, message));
                            }
                            false
                        }
                        result => {
                            tracing::warn!(?result, "lost robotd while forwarding vision");
                            true
                        }
                    }
                } else { false }
            }
            RobotCommand::Notify {
                calls,
                generation: request_generation,
                ..
            } => {
                let calls: Vec<_> = calls
                    .into_iter()
                    .filter(|call| {
                        (held && request_generation == Some(generation))
                            || matches!(
                                call,
                                proto::Call::RobotSetObstacle(_) | proto::Call::RobotStop
                            )
                    })
                    .collect();
                match timeout(INPUT_TTL, write_notifications(writer, &calls)).await {
                    Ok(Ok(())) => false,
                    result => {
                        tracing::warn!(?result, "lost robotd while sending browser control");
                        true
                    }
                }
            }
            RobotCommand::Request {
                calls,
                sit_on_loss,
                generation: request_generation,
                reply,
                ..
            } => {
                let stop = calls
                    .iter()
                    .any(|call| matches!(call, proto::Call::RobotStop));
                let allowed = request_generation.is_none() && !sit_on_loss
                    && calls.iter().all(|call| {
                        matches!(
                            call,
                            proto::Call::RobotSetObstacle(_) | proto::Call::RobotSetLowVoltage(_) | proto::Call::RobotHeadTracking(_) | proto::Call::RobotMotionTracking(_) | proto::Call::RobotCoordinatedTracking(_) | proto::Call::RobotMaze(_) | proto::Call::RobotStop
                        )
                    });
                let result = if allowed || (held && request_generation == Some(generation)) {
                    match timeout(
                        Duration::from_millis(400),
                        request_action(reader, writer, &mut next_id, calls, sit_on_loss),
                    )
                    .await
                    {
                        Ok(result) => result,
                        Err(_) => Err("robot action timed out".into()),
                    }
                } else {
                    Ok(proto::IntentResult {
                        accepted: false,
                        reason: Some("没有网页控制权".into()),
                    })
                };
                let failed = result.is_err();
                if stop && result.as_ref().is_ok_and(|r| r.accepted) {
                    let mut state = control.lock().await;
                    state.lose_human_control();
                    state.human_owner = None;
                }
                let _ = reply.send(result);
                failed
            }
            RobotCommand::ManualStart { session, generation: request_generation, calls, reply, .. } => {
                let result = if held && request_generation == generation {
                    manual_start(reader, writer, &mut next_id, &control,
                        session, request_generation, calls, &reply).await
                } else {
                    Ok(proto::IntentResult::refused("控制权已失效，请重新操作"))
                };
                // Never replay input queued while the recovery was waiting.
                connected_at = Instant::now();
                let failed = result.is_err();
                let _ = reply.send(result);
                failed
            }
            RobotCommand::Lease {
                session,
                generation,
                action,
                reply,
            } => {
                let mut state = control.lock().await;
                if reply.is_closed() || state.owner != Some(session) || state.human_generation != generation
                    || (action == proto::HumanControlAction::AcquireIfFree
                        && (!state.human_acquiring || state.owner_closing || !state.fresh(Instant::now())))
                {
                    let _ = reply.send(Err("控制权请求已过期".into()));
                    continue;
                }
                if action == proto::HumanControlAction::Release
                    && !state.release_due(Instant::now())
                {
                    let _ = reply.send(Ok(HumanControlResult {
                        accepted: false,
                        owner: if state.human_held {
                            Some(proto::HumanControlSource::Web)
                        } else {
                            None
                        },
                        reason: Some("input active".into()),
                    }));
                    continue;
                }
                if action == proto::HumanControlAction::AcquireIfFree {
                    let generation = state.human_generation;
                    let owner = state.owner;
                    // The network round trip must not prevent fresh browser input
                    // or a stop from updating the control state.
                    drop(state);
                    let mut result = human_request(reader, writer, &mut next_id, action).await;
                    let mut homed = None;
                    if result.as_ref().is_ok_and(|value| {
                        value.accepted && value.owner == Some(proto::HumanControlSource::Web)
                    }) {
                        let policies = timeout(Duration::from_millis(400),
                            send_request::<proto::PoliciesResult>(reader, writer, next_id, &proto::Call::RobotPolicies)).await;
                        next_id += 1;
                        match policies {
                            Ok(Ok(policies)) => match policies.homed {
                                Some(value) => homed = Some(value),
                                None => result = Err("机器人未提供 HOME 状态".into()),
                            },
                            Ok(Err(error)) => result = Err(error),
                            Err(_) => result = Err("机器人状态查询超时".into()),
                        }
                    }
                    let mut state = control.lock().await;
                    let valid = state.owner == owner && state.human_generation == generation
                        && state.human_acquiring && state.connected && state.armed
                        && !state.owner_closing && state.stops_pending == 0
                        && state.fresh(Instant::now()) && !reply.is_closed();
                    let acquired = result.as_ref().is_ok_and(|value| {
                        value.accepted && value.owner == Some(proto::HumanControlSource::Web)
                    });
                    if acquired && !valid {
                        // The request was accepted after the browser released or
                        // disconnected. Return the lease without applying input.
                        drop(state);
                        let released = human_request(reader, writer, &mut next_id,
                            proto::HumanControlAction::Release).await;
                        let failed = !released.as_ref().is_ok_and(|value|
                            value.accepted || value.owner != Some(proto::HumanControlSource::Web));
                        let _ = reply.send(Err("控制权请求已过期".into()));
                        failed
                    } else {
                        let failed = result.is_err();
                        if valid && let Ok(ref value) = result {
                            state.human_owner = value.owner;
                            if acquired {
                                state.human_held = true;
                                state.up = homed.expect("successful acquisition checked HOME");
                            }
                        }
                        drop(state);
                        let _ = reply.send(result);
                        failed
                    }
                } else {
                    let result = if action == proto::HumanControlAction::Release {
                        // robotd freezes the latest manual head target on release.
                        // A default head command here would replace that target with HOME.
                        let zero = [
                            proto::Call::RobotMove(proto::MoveParams::default()),
                            proto::Call::RobotMouth(proto::MouthParams::default()),
                        ];
                        match timeout(INPUT_TTL, write_notifications(writer, &zero)).await {
                            Ok(Ok(())) => human_request(reader, writer, &mut next_id, action).await,
                            _ => Err("final zero could not be sent".into()),
                        }
                    } else {
                        human_request(reader, writer, &mut next_id, action).await
                    };
                    let failed = result.is_err();
                    if let Ok(ref value) = result {
                        state.human_owner = value.owner;
                        if action == proto::HumanControlAction::Release
                            && (value.accepted || value.owner != Some(proto::HumanControlSource::Web))
                        {
                            if value.accepted {
                                state.finish_idle_release(Instant::now());
                            } else {
                                state.lose_human_control();
                            }
                        }
                    }
                    drop(state);
                    let _ = reply.send(result);
                    failed
                }
            }
        };
        if failed {
            connection = None;
            connected.send_replace(false);
            let mut state = control.lock().await;
            state.lose_human_control();
            state.human_owner = None;
        }
    }
}

fn reject_command(command: Option<RobotCommand>, reason: &str) {
    match command {
        Some(RobotCommand::Request { reply, .. }) => {
            let _ = reply.send(Err(reason.into()));
        }
        Some(RobotCommand::ManualStart { reply, .. }) => {
            let _ = reply.send(Err(reason.into()));
        }
        Some(RobotCommand::Lease { reply, .. }) => {
            let _ = reply.send(Err(reason.into()));
        }
        _ => {}
    }
}

async fn human_request(
    reader: &mut BufReader<OwnedReadHalf>,
    writer: &mut OwnedWriteHalf,
    next_id: &mut u64,
    action: proto::HumanControlAction,
) -> Result<HumanControlResult, String> {
    let id = *next_id;
    *next_id += 1;
    let call = proto::Call::RobotHumanControl(proto::HumanControlParams {
        action,
        source: proto::HumanControlSource::Web,
    });
    timeout(
        Duration::from_millis(400),
        send_request(reader, writer, id, &call),
    )
    .await
    .map_err(|_| "human-control request timed out".to_owned())?
}

fn manual_start_valid(state: &ControlState, session: u64, generation: u64) -> bool {
    state.owner == Some(session) && state.human_generation == generation
        && state.human_held && state.connected && state.armed
        && state.fresh(Instant::now()) && state.input.neutral()
}

/// Atomically check the browser state with enqueueing the IPC request. The
/// response is read after releasing the mutex so page-leave/disconnect input
/// can invalidate the next step while storage or robotd is slow.
async fn guarded_manual_request<T: DeserializeOwned>(
    reader: &mut BufReader<OwnedReadHalf>, writer: &mut OwnedWriteHalf,
    id: u64, call: &proto::Call, response_timeout: Duration,
    control: &Arc<Mutex<ControlState>>, session: u64, generation: u64,
    reply: &oneshot::Sender<Result<proto::IntentResult, String>>,
) -> Result<Option<T>, String> {
    let mut line = serde_json::to_vec(&proto::Request::call(proto::Id::Number(id), call))
        .map_err(|error| format!("could not encode robot request: {error}"))?;
    line.push(b'\n');
    {
        let state = control.lock().await;
        if reply.is_closed() || !manual_start_valid(&state, session, generation) { return Ok(None); }
        timeout(INPUT_TTL, async {
            writer.write_all(&line).await?;
            writer.flush().await
        }).await.map_err(|_| "robotd request timed out".to_owned())?
            .map_err(|error| format!("could not send robot request: {error}"))?;
    }
    read_response(reader, id, response_timeout).await.map(Some)
}

async fn cancel_manual_start(
    reader: &mut BufReader<OwnedReadHalf>, writer: &mut OwnedWriteHalf, next_id: &mut u64,
    control: &Arc<Mutex<ControlState>>, session: u64, generation: u64,
) {
    // Abandon is connection-bound: it cannot release a later controller.
    let _ = human_request(reader, writer, next_id, proto::HumanControlAction::Abandon).await;
    let mut state = control.lock().await;
    if state.owner == Some(session) && state.human_generation == generation {
        state.lose_human_control();
        state.human_owner = None;
    }
}

async fn manual_start(
    reader: &mut BufReader<OwnedReadHalf>, writer: &mut OwnedWriteHalf, next_id: &mut u64,
    control: &Arc<Mutex<ControlState>>, session: u64, generation: u64,
    calls: Vec<proto::Call>, reply: &oneshot::Sender<Result<proto::IntentResult, String>>,
) -> Result<proto::IntentResult, String> {
    let rearm_id = *next_id; *next_id += 1;
    let rearm = guarded_manual_request::<proto::IntentResult>(reader, writer, rearm_id,
        &proto::Call::RobotLowVoltageRearm, REARM_TIMEOUT, control, session, generation, reply)
        .await.map_err(|error| format!("电压保护恢复结果未知：{error}"))?;
    let Some(rearm) = rearm else { return Ok(proto::IntentResult::refused("操作已取消")); };
    if !rearm.accepted { return Ok(rearm); }

    let acquire = proto::Call::RobotHumanControl(proto::HumanControlParams {
        // Only an actual low-voltage rearm revoked this session's lease.
        // Normal Start merely verifies the lease it already owns.
        action: if rearm.reason.as_deref() == Some(proto::LOW_VOLTAGE_REARMED) {
            proto::HumanControlAction::AcquireIfFree
        } else {
            proto::HumanControlAction::Refresh
        },
        source: proto::HumanControlSource::Web,
    });
    let acquire_id = *next_id; *next_id += 1;
    let acquired = guarded_manual_request::<HumanControlResult>(reader, writer, acquire_id, &acquire,
        ACTION_TIMEOUT, control, session, generation, reply).await?;
    let Some(acquired) = acquired else {
        cancel_manual_start(reader, writer, next_id, control, session, generation).await;
        return Ok(proto::IntentResult::refused("操作已取消"));
    };
    if !acquired.accepted || acquired.owner != Some(proto::HumanControlSource::Web) {
        let mut state = control.lock().await;
        if state.owner == Some(session) && state.human_generation == generation {
            state.lose_human_control();
            state.human_owner = acquired.owner;
        }
        return Ok(proto::IntentResult::refused("控制权已被其他设备占用"));
    }

    let mut result = proto::IntentResult::accepted();
    for call in calls {
        let id = *next_id; *next_id += 1;
        let next = guarded_manual_request::<proto::IntentResult>(reader, writer, id, &call,
            ACTION_TIMEOUT, control, session, generation, reply).await?;
        let Some(next) = next else {
            cancel_manual_start(reader, writer, next_id, control, session, generation).await;
            return Ok(proto::IntentResult::refused("操作已取消"));
        };
        result = next;
        if !result.accepted { break; }
    }
    Ok(result)
}

pub(super) async fn request_action(
    reader: &mut BufReader<OwnedReadHalf>,
    writer: &mut OwnedWriteHalf,
    next_id: &mut u64,
    mut calls: Vec<proto::Call>,
    sit_on_loss: bool,
) -> Result<proto::IntentResult, String> {
    if sit_on_loss {
        let policies: proto::PoliciesResult =
            send_request(reader, writer, *next_id, &proto::Call::RobotPolicies).await?;
        *next_id += 1;
        if policies.sitting != Some(false) {
            return Ok(proto::IntentResult {
                accepted: false,
                reason: Some("失联坐下已跳过：已坐下或状态未知".into()),
            });
        }
        calls.push(proto::Call::RobotDo(proto::DoParams {
            skill: "sit_toggle".into(),
        }));
    }
    let mut result = proto::IntentResult {
        accepted: false,
        reason: Some("empty action".into()),
    };
    for call in calls {
        result = send_request(reader, writer, *next_id, &call).await?;
        *next_id += 1;
        if !result.accepted {
            break;
        }
    }
    Ok(result)
}

async fn write_notifications(
    writer: &mut OwnedWriteHalf,
    calls: &[proto::Call],
) -> Result<(), String> {
    let mut line = Vec::new();
    for call in calls {
        serde_json::to_writer(&mut line, &proto::Request::notify(call))
            .map_err(|error| format!("could not encode robot notification: {error}"))?;
        line.push(b'\n');
    }
    writer
        .write_all(&line)
        .await
        .map_err(|error| format!("could not write robot notification: {error}"))?;
    writer
        .flush()
        .await
        .map_err(|error| format!("could not flush robot notification: {error}"))
}

pub(super) async fn send_request<T: DeserializeOwned>(
    reader: &mut BufReader<OwnedReadHalf>,
    writer: &mut OwnedWriteHalf,
    id: u64,
    call: &proto::Call,
) -> Result<T, String> {
    send_raw_request(
        reader,
        writer,
        id,
        &proto::Request::call(proto::Id::Number(id), call),
    )
    .await
}

pub(super) async fn send_request_timed<T: DeserializeOwned>(
    reader: &mut BufReader<OwnedReadHalf>, writer: &mut OwnedWriteHalf,
    id: u64, call: &proto::Call, response_timeout: Duration,
) -> Result<T, String> {
    let mut line = serde_json::to_vec(&proto::Request::call(proto::Id::Number(id), call))
        .map_err(|error| format!("could not encode robot request: {error}"))?;
    line.push(b'\n');
    writer.write_all(&line).await.map_err(|error| format!("could not write robot request: {error}"))?;
    writer.flush().await.map_err(|error| format!("could not flush robot request: {error}"))?;
    read_response(reader, id, response_timeout).await
}

async fn send_raw_request<T: DeserializeOwned>(
    reader: &mut BufReader<OwnedReadHalf>,
    writer: &mut OwnedWriteHalf,
    id: u64,
    request: &proto::Request,
) -> Result<T, String> {
    let mut line = serde_json::to_vec(request)
        .map_err(|error| format!("could not encode robot request: {error}"))?;
    line.push(b'\n');
    writer
        .write_all(&line)
        .await
        .map_err(|error| format!("could not write robot request: {error}"))?;
    writer
        .flush()
        .await
        .map_err(|error| format!("could not flush robot request: {error}"))?;

    read_response(reader, id, ACTION_TIMEOUT).await
}

async fn read_response<T: DeserializeOwned>(
    reader: &mut BufReader<OwnedReadHalf>, id: u64, response_timeout: Duration,
) -> Result<T, String> {
    let mut answer = String::new();
    let bytes = timeout(response_timeout, reader.read_line(&mut answer))
        .await
        .map_err(|_| "robotd reply timed out".to_owned())?
        .map_err(|error| format!("could not read robot reply: {error}"))?;
    if bytes == 0 {
        return Err("robotd closed the socket before replying".to_owned());
    }
    let answer: proto::Response = serde_json::from_str(&answer)
        .map_err(|error| format!("robotd returned invalid JSON: {error}"))?;
    if answer.id != Some(proto::Id::Number(id)) {
        return Err("robotd response ID does not match the pending request".into());
    }
    if let Some(error) = answer.error {
        return Err(error.message);
    }
    answer
        .result_as::<T>()
        .map_err(|error| format!("robotd returned an invalid response: {error}"))
}
