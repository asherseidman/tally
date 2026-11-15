// Prepares /tmp/planner-smoke-google for the Google client-file smoke test (demo database only): FAKE client files and no saved client.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
const dir = '/tmp/planner-smoke-google';
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const client = (id) => JSON.stringify({ installed: { client_id: id, project_id: 'fake', auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token', client_secret: 'FAKE-secret-for-the-smoke-test', redirect_uris: ['http://localhost'] } });
writeFileSync(`${dir}/good.json`, client('111111111111-smokefake1234.apps.googleusercontent.com'));
writeFileSync(`${dir}/other.json`, client('222222222222-smokefake9876.apps.googleusercontent.com'));
writeFileSync(`${dir}/web.json`, JSON.stringify({ web: { client_id: 'x', client_secret: 'FAKE-secret-for-the-smoke-test', redirect_uris: ['https://example.invalid/cb'] } }));
writeFileSync(`${dir}/notjson.json`, 'this is not json');
console.log(dir);
