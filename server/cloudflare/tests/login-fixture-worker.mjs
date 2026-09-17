import { loginFetch } from '../src/login.mjs';

let mode = 'authorized';
let polls = 0;
const github = {
  async begin() {
    return { device_code: 'a'.repeat(40), user_code: 'ABCD-1234', expires_in: 900, interval: 1 };
  },
  async poll() {
    polls += 1;
    if (mode === 'pending' && polls === 1) return { state: 'pending' };
    if (mode === 'denied') return { state: 'denied' };
    if (mode === 'slow_down' && polls === 1) return { state: 'slow_down', interval: 6 };
    return { state: 'authorized', github_id: '123456789', login: 'fixture-user' };
  },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/__test/mode' && request.method === 'POST') {
      mode = await request.text();
      polls = 0;
      return Response.json({ mode });
    }
    const expire = /^\/__test\/expire\/([a-f0-9]{32})$/.exec(url.pathname);
    if (expire && request.method === 'POST') {
      await env.DB.prepare('UPDATE probe_login_attempts SET expires_at=0 WHERE id=?').bind(expire[1]).run();
      return Response.json({ expired: true });
    }
    const response = await loginFetch(request, env, url.pathname, github);
    return response ?? new Response(null, { status: 404 });
  },
};
