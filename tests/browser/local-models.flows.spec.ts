import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';

test('Agent discovers native Ollama and compatible services on multiple loopback ports', async ({
  page,
}) => {
  await page.route(
    /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(?:11434|1234|8080|8000)\//,
    (route) => route.abort(),
  );
  await page.route('http://localhost:11434/api/tags', (route) =>
    route.fulfill({
      json: {
        models: [
          null,
          { model: 'local-cloud-study:latest' },
          { name: 'remote:cloud' },
          { name: 'alias', remote_host: 'example.org' },
        ],
      },
    }),
  );
  await page.route('http://127.0.0.1:11434/api/tags', (route) =>
    route.fulfill({ json: { models: [] } }),
  );
  await page.route('http://127.0.0.1:1234/v1/models', (route) =>
    route.fulfill({
      json: { object: 'list', data: [{ id: 'shared/model' }, { id: 'shared/model' }, null] },
    }),
  );
  await page.route('http://127.0.0.1:8000/v1/models', (route) =>
    route.fulfill({
      json: { object: 'list', data: [{ id: 'shared/model' }] },
    }),
  );
  await page.route('**/__local-model', (route) => route.fulfill({ status: 502 }));

  await page.goto('/');
  await page.getByRole('button', { name: 'AI Agent 分析' }).click();
  const model = page.getByRole('combobox', { name: '模型', exact: true });
  const choices = model.locator('optgroup[label="本地"] option');
  await expect(choices).toHaveCount(3);
  await expect(page.getByText('从 3 个本地服务发现 3 个模型。')).toBeVisible();
  const key = JSON.stringify(['ollama', 'local-cloud-study:latest', 'http://localhost:11434']);
  await model.selectOption(key);
  await page.reload();
  await page.getByRole('button', { name: 'AI Agent 分析' }).click();
  await expect(model).toHaveValue(key);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
});

test('Agent can use a custom authenticated local service without upstream CORS', async ({
  page,
  request,
}) => {
  const token = 'fixture-local-token';
  const seen: string[] = [];
  let exposeList = true;
  let reviewedToolOutput = false;
  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return res.writeHead(403).end();
    seen.push(`${req.method} ${req.url}`);
    const send = (status: number, data: object) =>
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, {});
    if (req.url === '/v1/models')
      return send(exposeList ? 200 : 404, { data: [{ id: 'custom/model' }] });
    if (req.url !== '/v1/chat/completions') return send(404, {});
    const body = JSON.parse(
      await Array.fromAsync(req).then((chunks) => Buffer.concat(chunks).toString()),
    );
    if (!['custom/model', 'manual/model'].includes(body.model)) return send(400, {});
    const feedback = body.messages.find((message) => message.role === 'tool');
    let name: string;
    let args: object;
    if (body.tools[0].function.name === 'connection_check') {
      name = 'connection_check';
      args = { echo: 'kinetic' };
    } else if (feedback) {
      reviewedToolOutput = feedback.tool_call_id === 'call_1' && JSON.parse(feedback.content).ok;
      name = 'finish_analysis';
      args = { outcome: 'needs_input', messageCode: 'no_samples', citations: [] };
    } else {
      name = 'get_session_info';
      args = {};
    }
    return send(200, {
      id: 'local-test',
      model: body.model,
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name,
                  arguments: JSON.stringify(args),
                },
              },
            ],
          },
        },
      ],
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const bound = server.address();
    if (!bound || typeof bound === 'string') throw new Error('No TCP listener');
    const address = `http://127.0.0.1:${bound.port}`;
    const forbidden = await request.post('/__local-model', {
      headers: { Origin: 'https://example.org' },
      data: { address, path: '/v1/models' },
    });
    expect(forbidden.status()).toBe(403);
    expect(seen).toEqual([]);
    await page.goto('/');
    await page.getByRole('button', { name: 'AI Agent 分析' }).click();
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    const settings = page.getByRole('region', { name: '模型设置' });
    await settings.getByLabel('模型设置供应商').selectOption('local-openai');
    const endpoint = settings.getByLabel('本地兼容服务地址');
    await endpoint.fill(`127.0.0.1:${bound.port}/v1/`);
    await settings.getByRole('button', { name: '应用地址' }).click();
    await expect(settings.getByText(`${address} 拒绝访问`, { exact: false })).toBeVisible();
    await settings.getByLabel('本地服务令牌（可选）').fill(token);
    await settings.getByRole('button', { name: '应用地址' }).click();
    const model = page.getByRole('combobox', { name: '模型', exact: true });
    const key = JSON.stringify(['local-openai', 'custom/model', address]);
    await expect(model.locator('option').filter({ hasText: 'custom/model' })).toHaveCount(1);
    await model.selectOption(key);
    await settings.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(settings.getByText('结构化工具调用通过 · custom/model')).toBeVisible();

    exposeList = false;
    await settings.getByLabel('手动填写本地模型 ID').fill('manual/model');
    await settings.getByRole('button', { name: '选择此模型' }).click();
    await expect(model).toHaveValue(JSON.stringify(['local-openai', 'manual/model', address]));
    await settings.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(settings.getByText('结构化工具调用通过 · manual/model')).toBeVisible();
    expect(seen.filter((path) => path === 'POST /v1/chat/completions')).toHaveLength(2);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.run-status')).toHaveText('需要信息');
    expect(reviewedToolOutput).toBe(true);
    const storage = await page.evaluate(() => JSON.stringify(localStorage));
    expect(storage).toContain(address);
    expect(storage).not.toContain(token);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});

test('compatible chat uses the local relay when only the model list allows CORS', async ({
  page,
}) => {
  const chatRequests: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      });
      return res.end(JSON.stringify({ data: [{ id: 'split-cors' }] }));
    }
    chatRequests.push(req.method!);
    if (req.method !== 'POST') return res.writeHead(405).end();
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'split-cors',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_probe',
                  type: 'function',
                  function: { name: 'connection_check', arguments: '{"echo":"kinetic"}' },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const bound = server.address();
    if (!bound || typeof bound === 'string') throw new Error('No TCP listener');
    const address = `http://127.0.0.1:${bound.port}`;
    const inventory = page.waitForResponse(`${address}/v1/models`);
    await page.goto('/');
    await page.getByRole('button', { name: 'AI Agent 分析' }).click();
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    const settings = page.getByRole('region', { name: '模型设置' });
    await settings.getByLabel('模型设置供应商').selectOption('local-openai');
    await settings.getByLabel('本地兼容服务地址').fill(address);
    await settings.getByRole('button', { name: '应用地址' }).click();
    expect((await inventory).ok()).toBe(true);
    const model = page.getByRole('combobox', { name: '模型', exact: true });
    await model.selectOption(JSON.stringify(['local-openai', 'split-cors', address]));
    await settings.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(settings.getByText('结构化工具调用通过 · split-cors')).toBeVisible();
    expect(chatRequests).toEqual(['POST']);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});
