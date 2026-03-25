async function testPolygon() {
  const apiKey = process.env.MASSIVE_API_KEY;
  console.log('Testing Polygon.io (Massive API)...');
  if (!apiKey) {
    console.error('❌ Failed: MASSIVE_API_KEY is not set.');
    return;
  }

  try {
    const res = await fetch(`https://api.polygon.io/v2/reference/news?limit=1&apiKey=${apiKey}`);
    if (res.ok) {
      console.log('✅ Polygon.io connected successfully!');
    } else {
      console.error(`❌ Polygon.io API error: ${res.status} ${res.statusText}`);
    }
  } catch (error: any) {
    console.error('❌ Polygon.io network error:', error.message);
  }
}

async function testDiscord() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  console.log('\nTesting Discord Webhook...');
  if (!webhookUrl) {
    console.error('❌ Failed: DISCORD_WEBHOOK_URL is not set.');
    return;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '🔄 **Integration Test**: Systems are online and responding!' }),
    });
    
    if (res.ok) {
      console.log('✅ Discord Webhook connected and message sent!');
    } else {
      console.error(`❌ Discord Webhook error: ${res.status} ${res.statusText}`);
    }
  } catch (error: any) {
    console.error('❌ Discord network error:', error.message);
  }
}

async function testMT5Bridge() {
  let bridgeUrl = process.env.MT5_BRIDGE_URL || 'http://localhost:8000';
  
  // If running this script directly on Windows, replace Docker's internal host with localhost
  if (bridgeUrl.includes('host.docker.internal')) {
    bridgeUrl = bridgeUrl.replace('host.docker.internal', 'localhost');
  }
  console.log(`\nTesting MT5 Bridge at ${bridgeUrl}...`);
  
  try {
    const res = await fetch(`${bridgeUrl}/health`);
    const data = await res.json();
    
    if (res.ok && data.connected) {
      console.log(`✅ MT5 Bridge connected successfully to account: ${data.login}`);
    } else {
      console.error(`❌ MT5 Bridge error: Not connected to MT5 terminal. Details:`, data);
    }
  } catch (error: any) {
    console.error(`❌ MT5 Bridge network error (Is the Python server running?):`, error.message);
  }
}

async function runAll() {
  console.log('=============================================');
  console.log('      STARTING INTEGRATIONS HEALTH CHECK     ');
  console.log('=============================================\n');
  
  await testPolygon();
  await testDiscord();
  await testMT5Bridge();
  
  console.log('\n=============================================');
  console.log('                 TESTS FINISHED              ');
  console.log('=============================================');
}

runAll();