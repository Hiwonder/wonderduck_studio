export function createNetworkControls({ request, confirmAction, iconsRefresh, toast }) {
  const element = id => document.getElementById(`network-${id}`);
  let active = false;
  let timer;
  let updating = false;
  let operation = false;
  let generation = 0;
  let listVersion = 0;
  let lastStatusError = '', lastListError = '';
  const current = value => active && generation === value;

  function message(text, error = false) {
    if (text) toast(text, error);
  }

  function renderNetworks(networks) {
    const list = element('list');
    const previous = new Map([...list.children].map(button => [button.dataset.ssid, button]));
    networks.forEach((network, index) => {
      let button = previous.get(network.ssid);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'network-row';
        button.dataset.ssid = network.ssid;
        button.append(document.createElement('strong'), document.createElement('span'));
        button.addEventListener('click', () => {
          element('ssid').value = button.dataset.ssid;
          element('password').value = '';
          updateSelection();
          element('password').focus();
        });
      }
      previous.delete(network.ssid);
      button.disabled = operation;
      const name = button.querySelector('strong'), details = button.querySelector('span');
      const text = `${network.active ? '已连接 · ' : ''}${network.security} · 信号 ${network.signal}%`;
      if (name.textContent !== network.ssid) name.textContent = network.ssid;
      if (details.textContent !== text) details.textContent = text;
      if (list.children[index] !== button) list.insertBefore(button, list.children[index] || null);
    });
    for (const button of previous.values()) button.remove();
    element('empty').hidden = networks.length > 0;
    updateSelection();
  }

  function updateSelection() {
    const selected = element('ssid').value;
    for (const button of element('list').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(!!selected && button.dataset.ssid === selected));
    }
  }

  async function refresh() {
    if (!active || updating || operation) return;
    const requestGeneration = generation;
    const requestListVersion = listVersion;
    updating = true;
    try {
      const status = await request('network');
      if (!current(requestGeneration)) return;
      if (lastStatusError) toast('网络状态已恢复');
      lastStatusError = '';
      const listError = status.networks_error ? `网络列表不可用：${status.networks_error}` : '';
      if (listError && listError !== lastListError) toast(listError, true);
      lastListError = listError;
      element('mode').textContent = ({ station: '局域网模式', ap: '直连模式', disconnected: '未连接', unavailable: '无线网卡不可用' })[status.mode] || '未知';
      const hotspotSsid = status.mode === 'ap' && status.ssid;
      element('ap-name').toggleAttribute('data-i18n-skip', !!hotspotSsid);
      element('ap-name').textContent = hotspotSsid || '未读取';
      element('hotspot-state').textContent = status.mode === 'ap' ? '已启用' : status.mode === 'unavailable' ? '状态未知' : '未启用';
      element('wireless-ip').textContent = status.wireless_addresses.join('、') || '未分配';
      element('wired-ip').textContent = status.wired.flatMap(device => device.addresses).join('、') || (status.wired.length ? '未连接' : '未检测到网卡');
      const frequency = status.frequency_mhz;
      element('band').textContent = frequency ? `${frequency < 3000 ? '2.4 GHz' : frequency < 5925 ? '5 GHz' : '6 GHz'} · ${frequency} MHz` : '未检测到';
      element('bluetooth-address').textContent = 'bluetooth_address' in status ? status.bluetooth_address || '未检测到' : '待重启生效';
      if (requestListVersion === listVersion) {
        element('empty').textContent = '尚无扫描结果';
        renderNetworks(status.networks);
      }
    } catch (error) {
      if (current(requestGeneration)) {
        const text = `网络状态读取失败：${error.message}`;
        if (text !== lastStatusError) toast(text, true);
        lastStatusError = text;
        element('mode').textContent = '状态不可用';
        for (const id of ['wireless-ip', 'wired-ip', 'band', 'bluetooth-address', 'ap-name', 'hotspot-state']) element(id).textContent = '--';
        if (requestListVersion === listVersion) {
          element('empty').textContent = '尚无扫描结果';
          renderNetworks([]);
        }
      }
    } finally {
      updating = false;
      if (active && requestGeneration !== generation) refresh();
    }
  }

  function busy(on) {
    operation = on;
    for (const id of ['scan', 'connect', 'hotspot', 'ssid', 'password', 'password-toggle']) element(id).disabled = on;
    for (const button of element('list').querySelectorAll('button')) button.disabled = on;
  }

  element('scan').addEventListener('click', async () => {
    if (!active || operation) return;
    const requestGeneration = generation;
    listVersion++;
    busy(true);
    element('scan').querySelector('span').textContent = '扫描中';
    message('正在扫描附近网络');
    try {
      const result = await request('network/scan', {});
      if (!current(requestGeneration)) return;
      element('empty').textContent = '未扫描到网络';
      renderNetworks(result.networks);
      message(result.networks.length ? '扫描完成' : '未扫描到网络，可手动填写名称');
    } catch (error) {
      if (current(requestGeneration)) message(`扫描失败：${error.message}。可手动填写网络名称。`, true);
    } finally {
      element('scan').querySelector('span').textContent = '扫描';
      busy(false);
      if (active && requestGeneration !== generation) refresh();
    }
  });

  async function switchNetwork(path, body) {
    if (!active || operation) return;
    const requestGeneration = generation;
    busy(true);
    message('正在发送请求');
    try {
      await request(path, body);
      if (!current(requestGeneration)) return;
      message('请求已发送；网络切换后请重新连接并查看当前状态。');
      element('password').value = '';
      showPassword(false);
    } catch (error) {
      if (current(requestGeneration)) message(error.status ? error.message : '连接已中断或请求未完成，请重新连接后查看当前状态。', true);
    } finally {
      busy(false);
      if (active && requestGeneration !== generation) refresh();
    }
  }

  element('connect-form').addEventListener('submit', async event => {
    event.preventDefault();
    const ssid = element('ssid').value;
    const requestGeneration = generation;
    if (!ssid || !active || operation) return;
    if (await confirmAction('连接无线网络', '切换无线网络会断开当前网页连接。请在切换后连接同一网络，再使用设备的新地址访问。') && current(requestGeneration)) {
      await switchNetwork('network/connect', { ssid, password: element('password').value });
    }
  });

  element('hotspot').addEventListener('click', async () => {
    const requestGeneration = generation;
    if (!active || operation) return;
    if (await confirmAction('切换至设备热点', '切换热点会断开当前网页连接。请在切换后连接设备热点，再使用设备热点地址访问。') && current(requestGeneration)) {
      await switchNetwork('network/hotspot', {});
    }
  });

  function showPassword(visible) {
    const input = element('password');
    input.type = visible ? 'text' : 'password';
    const label = visible ? '隐藏密码' : '显示密码';
    const button = element('password-toggle');
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = `<i data-lucide="${visible ? 'eye-off' : 'eye'}"></i>`;
    iconsRefresh();
  }
  element('password-toggle').addEventListener('click', () => showPassword(element('password').type === 'password'));
  element('ssid').addEventListener('input', updateSelection);

  return {
    setActive(value) {
      if (active === value) return;
      generation++;
      active = value;
      clearInterval(timer);
      if (active) {
        lastStatusError = lastListError = '';
        refresh();
        timer = setInterval(refresh, 10000);
      } else {
        element('password').value = '';
        showPassword(false);
        message('');
      }
    },
  };
}
