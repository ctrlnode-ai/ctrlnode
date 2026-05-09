const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '1bf846e83ca23e97e9a7b5edba22ff946c01a3b80587e2547248834ac815036d';

async function testHttpRpc() {
    console.log(`\n🚀 Testing RPC via HTTP POST to: ${GATEWAY_URL}/rpc`);
    
    try {
        const response = await fetch(`${GATEWAY_URL}/rpc`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GATEWAY_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                type: 'req', id: 'http-test-1', method: 'send',
                params: { key: 'main', agentId: 'main', message: 'Ping' }
            })
        });

        const text = await response.text();
        console.log('--- HTTP RESPONSE ---');
        console.log('Status:', response.status);
        console.log('Body:', text || '(EMPTY)');
        console.log('---------------------');
        
    } catch (err: any) {
        console.error('\n❌ HTTP Request failed:', err.message);
    }
}

testHttpRpc();
