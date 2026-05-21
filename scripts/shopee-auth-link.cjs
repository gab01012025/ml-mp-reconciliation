#!/usr/bin/env node
/**
 * Gera link de autorização Shopee Open Platform v2 (produção)
 *
 * Uso: node scripts/shopee-auth-link.js
 */

const crypto = require('crypto');

// === CREDENCIAIS LIVE ===
const PARTNER_ID = '2034866';
const PARTNER_KEY = 'shpk48715946546f67476d52765447477268684246654f4b6650794c724e4343';
const REDIRECT_URL = 'https://synchub.webmedula.com.br/shopee/callback';

// === CONFIG ===
const AUTH_HOST = 'https://partner.shopeemobile.com'; // produção
const API_PATH = '/api/v2/shop/auth_partner';

const timestamp = Math.floor(Date.now() / 1000);

// Método 1: HMAC-SHA256(key=partner_key, msg=partner_id+path+timestamp)
function signHMAC() {
  const baseString = `${PARTNER_ID}${API_PATH}${timestamp}`;
  return crypto.createHmac('sha256', PARTNER_KEY).update(baseString).digest('hex');
}

// Método 2: SHA256(partner_key + path + timestamp) - concatenação simples
function signSHA256() {
  const raw = `${PARTNER_KEY}${API_PATH}${timestamp}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Método 3: HMAC-SHA256(key=partner_key, msg=path+timestamp) sem partner_id
function signHMACNoId() {
  const baseString = `${API_PATH}${timestamp}`;
  return crypto.createHmac('sha256', PARTNER_KEY).update(baseString).digest('hex');
}

const redirect = encodeURIComponent(REDIRECT_URL);

console.log('=== Shopee Auth Link Generator (PRODUÇÃO) ===\n');
console.log(`Partner ID: ${PARTNER_ID}`);
console.log(`Timestamp:  ${timestamp}`);
console.log(`Redirect:   ${REDIRECT_URL}`);
console.log(`Gerado em:  ${new Date().toLocaleString('pt-BR')}`);
console.log(`Expira em:  ~5 minutos\n`);

const sign1 = signHMAC();
const sign2 = signSHA256();
const sign3 = signHMACNoId();

console.log('--- LINK PRINCIPAL (HMAC partner_id+path+ts) ---');
console.log(`${AUTH_HOST}${API_PATH}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign1}&redirect=${redirect}\n`);

console.log('--- LINK ALTERNATIVO 1 (SHA256 key+path+ts) ---');
console.log(`${AUTH_HOST}${API_PATH}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign2}&redirect=${redirect}\n`);

console.log('--- LINK ALTERNATIVO 2 (HMAC path+ts sem id) ---');
console.log(`${AUTH_HOST}${API_PATH}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign3}&redirect=${redirect}\n`);

console.log('=== Instruções ===');
console.log('1. Copie o LINK PRINCIPAL e envie ao João');
console.log('2. Se der "Wrong sign", tente o ALTERNATIVO 1');
console.log('3. Se ambos falharem, tente o ALTERNATIVO 2');
console.log('4. João clica → login com conta da LOJA → Confirm Authorization');
console.log('5. Redireciona para synchub.webmedula.com.br/?code=XXX&shop_id=YYY');
console.log('6. João copia a URL inteira e envia');
