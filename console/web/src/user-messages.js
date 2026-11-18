// Keep hardware diagnostics in logs while presenting actionable messages in the UI.
export function friendlyErrorMessage(message) {
  const text = String(message || '').trim();
  if (/卸力.{0,20}未确认|无法确认.{0,10}卸力/.test(text)) {
    return '无法确认关节是否已卸力。请扶好机器人，并检查舵机供电和连接。';
  }
  if (/bus transaction|HX read timeout|missing IDs|串口已隔离|rx_bytes=|host_reads=/i.test(text)) {
    return '舵机通信异常，请检查舵机供电和连接后重试。';
  }
  if (!text || text.length > 200) return '操作未完成，请检查设备状态后重试。';
  return text;
}
