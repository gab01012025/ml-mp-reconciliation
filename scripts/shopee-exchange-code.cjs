#!/usr/bin/env node
/**
 * Troca o code OAuth da Shopee por access_token + refresh_token.
 * Uso: node scripts/shopee-exchange-code.cjs <code> <shop_id>
 */
const crypto = require('crypto');

const PARTNER_ID = '2034866';
const PARTNER_KEY = 'shpk48715946546f67476d52765447477268684246654f4b6650794c724e4343';

const code = process.argv[2];
const shopId = process.argv[3] || '985573664';

if (!code) {
  console.error('Uso: node scripts/shopee-exchange-code.cjs <code> [shop_id]');
  process.exit(1);
}

async function exchangeCode() {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = '/api/v2/auth/token/get';
  const baseString = `${PARTNER_ID}${path}${timestamp}`;
  const sign = crypto.createHmac('sha256', PARTNER_KEY).update(baseString).digest('hex');

  const url = `https://partner.shopeemobile.com${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`;
  const body = JSON.stringify({
    code,
    shop_id: Number(shopId),
    partner_id: Number(PARTNER_ID),
  });

  console.log(`Trocando code=${code.slice(0, 10)}... shop_id=${shopId}`);
  console.log(`URL: ${url}`);
  console.log(`Body: ${body}`);
  console.log('');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await res.json();
    console.log('Resposta:', JSON.stringify(data, null, 2));

    if (data.access_token) {
      console.log('\n✅ SUCESSO! Tokens obtidos.');
      console.log(`access_token: ${data.access_token}`);
      console.log(`refresh_token: ${data.refresh_token}`);
      console.log(`expire_in: ${data.expire_in}s`);

      // Salva arquivo de tokens que pode ser copiado para o container
      const tokenInfo = {
        shop_id: shopId,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expire_in: data.expire_in,
        obtained_at: new Date().toISOString(),
      };
      const fs = require('fs');
      const outPath = require('path').join(__dirname, '..', 'shopee_tokens.json');
      fs.writeFileSync(outPath, JSON.stringify(tokenInfo, null, 2));
      console.log(`\nTokens salvos em: ${outPath}`);
      console.log('Copie este arquivo para /app/data/shopee_tokens.json no container Docker.');
    } else {
      console.log('\n❌ Falha. Verifique o erro acima.');
    }
  } catch (err) {
    console.error('Erro:', err.message || err);
  }
}

exchangeCode();
