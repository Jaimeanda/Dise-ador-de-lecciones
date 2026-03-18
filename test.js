const http = require('http');

console.log('Iniciando Test 2...');
const data = JSON.stringify({ prompt: 'Test de API Gemini' });
const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/buscador',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
    }
};

const req = http.request(options, (res) => {
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
        console.log('STATUS:', res.statusCode);
        try {
            console.log('JSON:', JSON.parse(body));
        } catch (e) {
            console.log('RAW BODY:', body);
        }
    });
});

req.on('error', (e) => console.error('REQUEST ERROR:', e));
req.write(data);
req.end();
