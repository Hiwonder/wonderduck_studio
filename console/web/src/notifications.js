import { setLocalizedAttribute, setLocalizedText } from '../../../webpadd/web/language.js';
import { friendlyErrorMessage } from './user-messages.js';

export function createNotifications(container) {
  const notices = new Map();
  let nextId = 0;

  function dismiss(id) {
    const notice = notices.get(id);
    if (!notice) return;
    clearTimeout(notice.timer);
    notice.row.remove();
    notices.delete(id);
    container.hidden = notices.size === 0;
  }

  function toast(message, error = false, { routine = false, source = null, workspace = null } = {}) {
    if (!message || message === '工作区已切换，请重新操作') return;
    if (error) message = friendlyErrorMessage(message);

    let notice = [...notices.values()].find(item => item.workspace === workspace && (source
      ? item.source === source
      : !item.source && item.message === message && item.error === error));
    if (notice) {
      // A renewed row gets its own timeout and dismissal ID.
      clearTimeout(notice.timer);
      notices.delete(notice.id);
    } else {
      const row = document.createElement('div');
      row.className = 'toast-row';
      const label = document.createElement('span');
      label.className = 'toast-message';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'toast-close';
      close.textContent = '×';
      setLocalizedAttribute(close, 'aria-label', '关闭提示');
      row.append(label, close);
      notice = { row, label, source, workspace };
      close.addEventListener('click', () => dismiss(notice.id));
    }

    const id = ++nextId;
    notice.id = id;
    notice.message = message;
    notice.error = error;
    setLocalizedText(notice.label, message);
    notice.row.classList.toggle('error', error);
    notice.row.toggleAttribute('data-routine', routine && !error);
    notices.set(id, notice);
    container.hidden = false;
    if (!notice.row.parentElement) {
      container.append(notice.row);
      container.scrollTop = container.scrollHeight;
    }
    notice.timer = setTimeout(() => dismiss(id), error ? 7000 : 3000);
    return id;
  }

  toast.dismiss = dismiss;
  toast.clearSource = (source, workspace = null) => {
    const notice = [...notices.values()].find(item => item.source === source && item.workspace === workspace);
    if (notice) dismiss(notice.id);
  };
  toast.clearWorkspace = workspace => {
    for (const notice of notices.values()) {
      if (notice.workspace === workspace) dismiss(notice.id);
    }
  };
  return toast;
}
