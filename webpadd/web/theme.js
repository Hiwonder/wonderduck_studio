// Theme preferences belong to the browser, independently of robot controls.
(() => {
  const key = 'control-console-theme';
  const root = document.documentElement;
  let preferenceError = false;
  function readTheme() {
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null && saved !== 'dark' && saved !== 'light') {
        console.warn('主题偏好无效，使用默认暗色主题');
      }
      return saved === 'light' ? 'light' : 'dark';
    } catch (error) {
      preferenceError = true;
      console.warn('无法读取浏览器主题偏好', error);
      return 'dark';
    }
  }
  const embeddedTheme = root.dataset.studioEmbedded === 'true'
    ? new URLSearchParams(location.search).get('theme') : null;
  root.dataset.theme = ['light', 'dark'].includes(embeddedTheme) ? embeddedTheme : readTheme();
  function bind() {
    const button = document.querySelector('#theme-toggle');
    function showTheme() {
      const light = root.dataset.theme === 'light';
      const label = light ? '切换到暗色主题' : '切换到亮色主题';
      button.setAttribute('aria-label', label);
      button.title = preferenceError ? `${label}（当前浏览器无法保存主题偏好）` : label;
      button.querySelectorAll('[data-theme-icon]').forEach(icon => {
        icon.toggleAttribute('hidden', icon.dataset.themeIcon !== root.dataset.theme);
      });
    }
    button.addEventListener('click', () => {
      root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
      try {
        localStorage.setItem(key, root.dataset.theme);
        preferenceError = false;
      } catch (error) {
        preferenceError = true;
        console.warn('无法保存浏览器主题偏好', error);
      }
      showTheme();
    });
    showTheme();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, {once: true});
  else bind();
})();
