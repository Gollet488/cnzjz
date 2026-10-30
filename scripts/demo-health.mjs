export const healthPath = '/__kinetic_demo_health__';
// A project-specific nonce prevents reusing an unrelated server with similar HTML.
export function demoHealth() {
  const install = (server) => {
    server.middlewares.use(healthPath, (_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Cache-Control', 'no-store');
      response.end(JSON.stringify({ token: process.env.KINETIC_DEMO_TOKEN, pid: process.pid }));
    });
  };
  return {
    name: 'kinetic-demo-health',
    configureServer: install,
    configurePreviewServer: install,
  };
}
