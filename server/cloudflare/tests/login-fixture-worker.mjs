import { loginFetch } from '../src/login.mjs';
import { workerFetch } from '../src/worker.mjs';

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
    if (mode === 'other') return { state: 'authorized', github_id: '987654321', login: 'other-user' };
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
    if (['/__test/credential-near-limit', '/__test/credential-unmigrated'].includes(url.pathname) &&
        request.method === 'POST') {
      const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '');
      if (!match) return new Response(null, { status: 401 });
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(match[1]))),
        byte => byte.toString(16).padStart(2, '0')).join('');
      const timestamp = Math.floor(Date.now() / 1000);
      const result = url.pathname === '/__test/credential-unmigrated'
        ? await env.DB.prepare('UPDATE probe_credentials SET renew_until=NULL WHERE digest=? AND revoked=0')
          .bind(digest).run()
        : await env.DB.prepare('UPDATE probe_credentials SET expires_at=?,renew_until=? WHERE digest=? AND revoked=0')
          .bind(timestamp + 2 * 86400, timestamp + 4 * 86400, digest).run();
      return Response.json({ changed: result.meta.changes });
    }
    const response = await loginFetch(request, env, url.pathname, github);
    return response ?? workerFetch(request, env);
  },
};
