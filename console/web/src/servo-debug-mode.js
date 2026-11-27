export function createServoDebugMode({ request, toast, confirmAction, context }) {
  const toggle = document.getElementById('servo-debug-mode');
  let status = 'off', pending = false;

  function update() {
    const { info, state, armed, workspace, switchingWorkspace, ready } = context();
    if (!pending && ['off', 'on', 'restore_failed'].includes(state?.servo_debug)) status = state.servo_debug;
    toggle.checked = status !== 'off';
    toggle.disabled = pending || switchingWorkspace || !info || info.readonly || !ready || workspace !== 'action' ||
      !state?.servo_debug || (info.studio && !state.maintenance_owner) || (status === 'off' && !armed);
    toggle.parentElement.dataset.status = status;
    toggle.parentElement.title = status === 'restore_failed' ? '恢复 P=15 失败，关闭开关可重试' : '舵机调试模式';
  }

  toggle.addEventListener('change', async () => {
    const enabled = toggle.checked;
    pending = true;
    update();
    try {
      if (enabled && !await confirmAction('开启舵机调试模式',
        '开启后会将所有舵机的位置 P 调大至 66，方便调整偏差。请谨慎操作，调完偏差后务必关闭。关闭或切换到其他选项时，P 会恢复为 15。')) return;
      const current = context();
      if (enabled && (!current.armed || current.workspace !== 'action' || current.switchingWorkspace || !current.ready)) {
        throw new Error('当前控制不可用，未开启调试模式');
      }
      const result = await request('command', { action: 'servo_debug', enabled });
      const expected = enabled ? 'on' : 'off';
      const skipped = [...new Set([...Object.keys(result.errors || {}), ...(result.unavailable_ids || []).map(String)])];
      const warning = skipped.length ? `，ID ${skipped.join('、')} 未确认` : '';
      if (result.servo_debug !== expected) throw new Error(`舵机调试模式状态未确认${warning}`);
      status = result.servo_debug;
      if (context().state) context().state.servo_debug = status;
      toast((enabled ? '舵机调试模式已开启，P=66' : '舵机调试模式已关闭，P=15') + warning, !!warning);
    } catch (error) {
      try {
        const current = await request('state');
        status = ['off', 'on', 'restore_failed'].includes(current.servo_debug) ? current.servo_debug : 'restore_failed';
      } catch {
        status = 'restore_failed';
      }
      if (context().state) context().state.servo_debug = status;
      toast(error.message, true);
    } finally {
      pending = false;
      update();
    }
  });

  async function closeOnLeave() {
    if (status === 'off') return;
    try {
      const result = await request('command', { action: 'servo_debug', enabled: false });
      if (result.servo_debug !== 'off') throw new Error('舵机调试模式未关闭');
      status = 'off';
    } catch (error) {
      status = 'restore_failed';
      if (context().state) context().state.servo_debug = status;
      throw error;
    }
    if (context().state) context().state.servo_debug = status;
  }

  return { update, closeOnLeave, busy: () => pending };
}
