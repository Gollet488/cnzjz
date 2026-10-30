// Exercise the ordinary page's actual export path. The adapter only selects an
// OPFS file; it records calls to the real writable, with no fake sink/delay.
export async function runProductControls(page, report, save) {
  const nav = (name) =>
    page
      .locator('nav')
      .getByRole('button', { name, exact: name !== '采集与分析' })
      .click();
  for (let i = report.controls.length; i < 20; i++) {
    await page.reload();
    await page.getByText('已达到 18,000 帧上限', { exact: false }).waitFor({ timeout: 180000 });
    await page.evaluate(() => window.restoreClock());
    const kind = ['cancel', 'reset', 'source'][i % 3];
    await nav('数据导出');
    await page.getByRole('button', { name: '下载 CSV 数据', exact: true }).click();
    await page.waitForFunction(
      () => window.sinks.at(-1)?.state === 'writing' && window.sinks.at(-1).writes.length > 0,
    );
    if (kind !== 'cancel') await nav('采集与分析');
    await page.evaluate(() => {
      window.control = null;
      document.addEventListener(
        'click',
        () => {
          const sink = window.sinks.at(-1);
          window.control = {
            at: performance.now(),
            foreground: document.visibilityState === 'visible',
            sinkState: sink.state,
            writesAtEvent: sink.writes.length,
            inFlightAtEvent: sink.inFlight,
          };
        },
        { capture: true, once: true },
      );
    });
    await page
      .getByRole('button', {
        name: { cancel: '取消导出', reset: '重置会话', source: '上传视频' }[kind],
        exact: true,
      })
      .click();
    await page.waitForFunction(() => window.sinks.at(-1)?.state !== 'writing');
    // Keep observing real write invocations after cancellation has settled.
    await page.waitForTimeout(1000);
    const measured = await page.evaluate(() => {
      const sink = window.sinks.at(-1),
        event = window.control;
      const lateWrites = sink.writes.filter((w) => w.start > event.at);
      const completionsAfterEvent = sink.writes.filter((w) => w.end > event.at);
      const completionsAfterStop = sink.writes.filter((w) => w.end > sink.stopped);
      return {
        ...event,
        stopped: sink.stopped,
        state: sink.state,
        stopWritingMs: sink.stopped - event.at,
        lateWrites: lateWrites.length,
        completionsAfterEvent: completionsAfterEvent.length,
        completionsAfterStop: completionsAfterStop.length,
        observedUntil: performance.now(),
        writes: sink.writes,
      };
    });
    measured.kind = kind;
    measured.index = i;
    measured.correct =
      measured.sinkState === 'writing' &&
      measured.state === 'aborted' &&
      measured.lateWrites === 0 &&
      measured.completionsAfterStop === 0 &&
      measured.foreground;
    report.controls.push(measured);
    await save('controls-partial.json', report.controls);
    console.log(
      `product control ${i + 1}/20 ${kind}: ${measured.stopWritingMs.toFixed(1)}ms, late writes ${measured.lateWrites}`,
    );
  }
}
