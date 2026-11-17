import './release-confirm.css';

const SKIP_KEY = 'skip-torque-release-confirmation';

export function createReleaseConfirmation() {
  const dialog = document.createElement('dialog');
  dialog.className = 'release-confirm';
  dialog.setAttribute('aria-labelledby', 'release-confirm-title');
  dialog.setAttribute('aria-describedby', 'release-confirm-text');
  dialog.innerHTML = '<form method="dialog"><h2 id="release-confirm-title">确认卸力</h2>'
    + '<p id="release-confirm-text">舵机卸力后机器人可能失去支撑，请先扶好机器人。</p>'
    + '<label class="release-confirm-option"><input type="checkbox">不再显示</label>'
    + '<div class="dialog-actions"><button value="cancel">取消</button>'
    + '<button value="ok" class="primary">确认卸力</button></div></form>';
  document.body.append(dialog);
  const skip = dialog.querySelector('input');
  return async () => {
    try { if (localStorage.getItem(SKIP_KEY) === '1') return true; } catch { /* Keep the prompt. */ }
    if (dialog.open) return false;
    skip.checked = false;
    dialog.returnValue = '';
    dialog.showModal();
    return new Promise(resolve => dialog.addEventListener('close', () => {
      const confirmed = dialog.returnValue === 'ok';
      if (confirmed && skip.checked) {
        try { localStorage.setItem(SKIP_KEY, '1'); } catch { /* This confirmation remains valid. */ }
      }
      resolve(confirmed);
    }, { once: true }));
  };
}
