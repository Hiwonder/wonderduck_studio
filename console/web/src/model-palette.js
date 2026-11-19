// The device owns this preference, so it follows the robot to another browser.
export function createModelPaletteControl({ select, valid, apply, request, onError, onLoadError }) {
  let revision = 0, confirmed = null, writes = Promise.resolve();

  select.addEventListener('change', () => {
    const value = select.value, change = ++revision;
    apply();
    writes = writes.then(async () => {
      const result = await request('model-palette', { palette: value });
      if (!valid(result?.palette)) throw new Error('设备返回的模型配色无效');
      confirmed = result.palette;
    }).catch(error => {
      if (change !== revision) return;
      if (valid(confirmed)) { select.value = confirmed; apply(); }
      onError(error);
    });
  });

  return {
    async load() {
      const before = revision;
      try {
        const result = await request('model-palette');
        if (!valid(result?.palette)) throw new Error('设备返回的模型配色无效');
        if (before !== revision) return;
        confirmed = result.palette;
        select.value = result.palette;
        apply();
      } catch (error) {
        onLoadError(error);
      }
    },
  };
}
