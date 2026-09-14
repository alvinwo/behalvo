import { request } from 'node:http';

const MAXIMUM_RESPONSE_BYTES = 600 * 1024;

export function requestControl(origin, method, path, token, body) {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { Origin: origin, Connection: 'close' };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    if (payload !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(payload.byteLength);
    }
    return new Promise((resolve, reject) => {
        const endpoint = new URL(origin);
        const outgoing = request({ hostname: endpoint.hostname, port: endpoint.port, method, path, headers }, incoming => {
            const chunks = [];
            let size = 0;
            incoming.on('data', chunk => {
                size += chunk.byteLength;
                if (size > MAXIMUM_RESPONSE_BYTES) {
                    incoming.destroy(new Error('Control response exceeds test helper limit.'));
                    return;
                }
                chunks.push(chunk);
            });
            incoming.once('error', reject);
            incoming.once('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                const contentType = String(incoming.headers['content-type'] ?? '');
                let parsed = text;
                if (contentType.startsWith('application/json') && text.length > 0) {
                    try { parsed = JSON.parse(text); }
                    catch (error) { reject(error); return; }
                }
                resolve({ status: incoming.statusCode, headers: incoming.headers, body: parsed });
            });
        });
        outgoing.once('error', reject);
        if (payload !== undefined) outgoing.write(payload);
        outgoing.end();
    });
}
