//! Robot status subscriptions and health updates.

use super::*;

pub(super) async fn policy_status_worker(socket: PathBuf, status_tx: watch::Sender<BrowserStatus>) {
    loop {
        if let Err(error) = run_policy_status_stream(&socket, &status_tx).await {
            tracing::debug!(%error, "could not refresh rest and policy state");
        }
        status_tx.send_modify(|status| {
            status.rest_phase = None;
            status.motion_enabled = None;
            status.motion_homed = None;
        });
        tokio::time::sleep(CONNECT_RETRY).await;
    }
}

async fn run_policy_status_stream(socket: &Path, status_tx: &watch::Sender<BrowserStatus>) -> Result<(), String> {
    let stream = UnixStream::connect(socket).await.map_err(|error| error.to_string())?;
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let mut id = 40_000;
    loop {
        let policies: proto::PoliciesResult = timeout(
            Duration::from_millis(400),
            send_request(&mut reader, &mut write, id, &proto::Call::RobotPolicies),
        ).await.map_err(|_| "policy status timed out".to_owned())??;
        id += 1;
        status_tx.send_modify(|status| {
            status.rest_phase = policies.rest_phase;
            status.motion_enabled = policies.motion_enabled;
            status.motion_homed = policies.homed;
            status.power_status_sequence = status.power_status_sequence.wrapping_add(1);
        });
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

pub(super) async fn status_stream_worker(socket: PathBuf, status_tx: watch::Sender<BrowserStatus>) {
    loop {
        let reason = match run_status_stream(&socket, &status_tx).await {
            Ok(()) => "robotd status stream stopped".to_owned(),
            Err(error) => error,
        };
        status_tx.send_modify(|status| {
            status.robotd_connected = false;
            status.connection_error = Some(reason);
            status.skills.clear();
            status.loop_hz = None;
            status.loop_missed = None;
            status.bus_read_timeouts = None;
            status.tracking_phase = None;
            status.head_feedback = None;
        });
        tokio::time::sleep(CONNECT_RETRY).await;
    }
}

pub(super) async fn obstacle_status_worker(socket: PathBuf, status_tx: watch::Sender<BrowserStatus>, control: Arc<Mutex<ControlState>>, lock: Arc<Mutex<()>>) {
    loop {
        if let Err(error) = run_obstacle_status_stream(&socket, &status_tx, &control, &lock).await {
            tracing::debug!(%error, "could not refresh single-zone distance");
        }
        let _guard = lock.lock().await;
        control.lock().await.obstacle = None;
        status_tx.send_modify(|status| {
            status.tof_distance_mm = None;
            status.tof_sensor_status = None;
            status.obstacle_active = None;
        });
        drop(_guard);
        tokio::time::sleep(CONNECT_RETRY).await;
    }
}

pub(super) async fn low_voltage_status_worker(socket: PathBuf, status_tx: watch::Sender<BrowserStatus>, lock: Arc<Mutex<()>>) {
    loop {
        if let Err(error) = run_low_voltage_status_stream(&socket, &status_tx, &lock).await {
            tracing::debug!(%error, "could not refresh low-voltage settings");
        }
        tokio::time::sleep(CONNECT_RETRY).await;
    }
}

async fn run_low_voltage_status_stream(socket: &Path, status_tx: &watch::Sender<BrowserStatus>, lock: &Mutex<()>) -> Result<(), String> {
    let guard = lock.lock().await;
    let stream = match UnixStream::connect(socket).await {
        Ok(stream) => stream,
        Err(error) => {
            status_tx.send_modify(|status| status.low_voltage = None);
            return Err(format!("cannot reach robotd: {error}"));
        }
    };
    drop(guard);
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let mut id = 30_000;
    loop {
        let guard = lock.lock().await;
        let result: proto::LowVoltageStatus = match timeout(
            Duration::from_millis(400),
            send_request(&mut reader, &mut write, id, &proto::Call::RobotLowVoltageStatus),
        ).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => {
                status_tx.send_modify(|status| status.low_voltage = None);
                return Err(error);
            }
            Err(_) => {
                status_tx.send_modify(|status| status.low_voltage = None);
                return Err("low voltage status timed out".into());
            }
        };
        id += 1;
        status_tx.send_modify(|status| status.low_voltage = Some(result.settings));
        drop(guard);
        tokio::time::sleep(HEALTH_PERIOD).await;
    }
}

async fn run_obstacle_status_stream(
    socket: &Path,
    status_tx: &watch::Sender<BrowserStatus>,
    control: &Mutex<ControlState>,
    lock: &Mutex<()>,
) -> Result<(), String> {
    let stream = UnixStream::connect(socket)
        .await
        .map_err(|error| format!("cannot reach robotd: {error}"))?;
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let mut id = 20_000;
    loop {
        let _guard = lock.lock().await;
        let obstacle: proto::ObstacleStatus = timeout(Duration::from_millis(400), send_request(
            &mut reader,
            &mut write,
            id,
            &proto::Call::RobotObstacleStatus,
        )).await.map_err(|_| "obstacle status timed out".to_string())??;
        id += 1;
        control.lock().await.obstacle = Some(proto::ObstacleParams {
            enabled: obstacle.enabled,
            threshold_mm: obstacle.threshold_mm,
            clear_delay_ms: obstacle.clear_delay_ms,
        });
        status_tx.send_modify(|status| {
            status.tof_distance_mm = obstacle.distance_mm;
            status.tof_sensor_status = Some(obstacle.sensor_status);
            status.obstacle_active = Some(obstacle.active);
        });
        drop(_guard);
        tokio::time::sleep(OBSTACLE_PERIOD).await;
    }
}

pub(super) async fn run_status_stream(
    socket: &Path,
    status_tx: &watch::Sender<BrowserStatus>,
) -> Result<(), String> {
    let stream = UnixStream::connect(socket)
        .await
        .map_err(|error| format!("cannot reach robotd at {}: {error}", socket.display()))?;
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);

    let generation = status_tx.borrow().mode_generation;
    let mode: proto::ModeResult =
        send_request(&mut reader, &mut write, 10_001, &proto::Call::RobotMode).await?;
    status_tx.send_modify(|status| {
        if status.mode_generation == generation {
            status.last_robot_mode = Some(mode.mode);
            status.mode_generation += 1;
        }
    });
    let subscription: proto::SubscribeResult = send_request(
        &mut reader,
        &mut write,
        10_002,
        &proto::Call::RobotSubscribe(proto::SubscribeParams {
            hz: Some(STATUS_STREAM_HZ),
            ..Default::default()
        }),
    )
    .await?;
    if !subscription.accepted {
        return Err("robotd refused the status subscription".to_owned());
    }

    let skills = subscription_skills(&subscription);
    status_tx.send_modify(|status| {
        status.robotd_connected = true;
        status.connection_error = None;
        status.policy_unavailable = subscription.unavailable;
        status.skills = skills;
    });

    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .await
            .map_err(|error| format!("could not read robot state: {error}"))?;
        if bytes == 0 {
            return Err("robotd closed the status stream".to_owned());
        }
        let Ok(request) = serde_json::from_str::<proto::Request>(&line) else {
            continue;
        };
        let Some(state) = request.as_state() else {
            continue;
        };
        status_tx.send_modify(|status| update_status_from_state(status, &state));
    }
}

pub(super) fn subscription_skills(subscription: &proto::SubscribeResult) -> Vec<String> {
    let mut skills = subscription.skills.clone();
    skills.retain(|skill| !skill.is_empty());
    if subscription.ground_pick.is_some() && !skills.iter().any(|skill| skill == "ground_pick") {
        skills.push("ground_pick".into());
    }
    if subscription.sitstand.is_some() && !skills.iter().any(|skill| skill == "sit_toggle") {
        skills.push("sit_toggle".into());
    }
    skills
}

pub(super) fn update_status_from_state(status: &mut BrowserStatus, state: &proto::RobotState) {
    status.head_feedback_sequence = status.head_feedback_sequence.wrapping_add(1);
    status.head_feedback = state.joints.get(6).zip(state.targets.get(6)).and_then(|(&measured, &target)| {
        Some((duck_control::hx::encode_position(6, measured).ok()?, duck_control::hx::encode_position(6, target).ok()?))
    });
    status.policy = Some(state.policy.clone());
    status.tracking_phase = state.tracking_phase;
    status.loop_hz = Some(state.control_loop.hz);
    status.loop_missed = Some(state.control_loop.missed);
    status.imu_gyro = state.imu.map(|imu| imu.gyro);
    status.imu_quat = state.imu.map(|imu| imu.quat);
    status.fallen = Some(state.safety.fallen);
    status.limp = Some(state.safety.limp);
    status.current_velocity = Some(state.movement.applied);
}

pub(super) async fn health_worker(socket: PathBuf, status_tx: watch::Sender<BrowserStatus>) {
    loop {
        match read_health(&socket).await {
            Ok((health, mode)) => {
                if let Err(error) = &mode {
                    tracing::debug!(%error, "could not refresh robot mode");
                }
                status_tx.send_modify(|status| {
                    update_status_from_health(status, &health);
                    update_status_mode(status, mode.ok().map(|value| value.mode));
                });
            }
            Err(error) => {
                status_tx.send_modify(|status| {
                    clear_status_health(status);
                    status.robot_mode = None;
                });
                tracing::debug!(error = %error, "could not refresh robot health");
            }
        }
        tokio::time::sleep(HEALTH_PERIOD).await;
    }
}

async fn read_health(socket: &Path) -> Result<(proto::HealthResult, Result<proto::ModeResult, String>), String> {
    let stream = UnixStream::connect(socket)
        .await
        .map_err(|error| format!("cannot reach robotd at {}: {error}", socket.display()))?;
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let health = send_request(&mut reader, &mut write, 10_003, &proto::Call::RobotHealth).await?;
    let mode = send_request(&mut reader, &mut write, 10_004, &proto::Call::RobotMode).await;
    Ok((health, mode))
}

pub(super) fn update_status_from_health(status: &mut BrowserStatus, health: &proto::HealthResult) {
    status.healthy = Some(health.healthy);
    status.health_degraded = Some(health.degraded);
    status.health_reason = health.reason.clone();
    status.battery_volts = health.battery.map(|battery| battery.volts);
    status.battery_percent = health.battery.map(|battery| battery.percent);
    status.motor_name = health.motors.as_ref().map(|motors| motors.hottest.clone());
    status.motor_id = health.motors.as_ref().and_then(|motors| {
        duck_control::model::joint_index(&motors.hottest).map(|index| duck_control::JOINT_IDS[index])
    });
    status.motor_temp_c = health.motors.as_ref().map(|motors| motors.max_c);
    status.cpu_temp_c = health.cpu_temp_c;
    status.health_loop_hz = health.control_loop.as_ref().and_then(|control| control.achieved_hz);
    status.health_loop_missed = health.control_loop.as_ref().map(|control| control.missed);
    status.bus_read_timeouts = health.bus.read_timeouts;
}

pub(super) fn update_status_mode(status: &mut BrowserStatus, mode: Option<String>) {
    status.robot_mode = mode.clone();
    if let Some(mode) = mode {
        status.last_robot_mode = Some(mode);
        status.mode_generation += 1;
    }
}

pub(super) fn clear_status_health(status: &mut BrowserStatus) {
    status.healthy = None;
    status.health_degraded = None;
    status.health_reason = None;
    status.battery_volts = None;
    status.battery_percent = None;
    status.motor_name = None;
    status.motor_id = None;
    status.motor_temp_c = None;
    status.cpu_temp_c = None;
    status.health_loop_hz = None;
    status.health_loop_missed = None;
    status.bus_read_timeouts = None;
}
